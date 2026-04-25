class VoiceProviderError extends Error {
  constructor(message, { code = "voice_provider_error", statusCode = 500, provider = "voice", details = "" } = {}) {
    super(message);
    this.name = "VoiceProviderError";
    this.code = code;
    this.statusCode = statusCode;
    this.provider = provider;
    this.details = details;
  }
}

const parseJsonSafe = (value = "") => {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
};

const isLibraryStyleVoice = (voice) => {
  if (!voice || typeof voice !== "object") return false;

  // Voices coming from library/share flows usually include sharing metadata.
  if (voice.sharing && typeof voice.sharing === "object") {
    return true;
  }

  const category = String(voice.category || "").toLowerCase();
  return category === "library";
};

const fetchElevenLabsVoices = async (apiKey) => {
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    method: "GET",
    headers: {
      "xi-api-key": apiKey
    }
  });

  if (!response.ok) {
    const raw = await response.text();
    return {
      ok: false,
      voices: [],
      details: `Voice list lookup failed (${response.status}): ${String(raw || "").slice(0, 180)}`
    };
  }

  const json = await response.json();
  return {
    ok: true,
    voices: Array.isArray(json?.voices) ? json.voices : [],
    details: ""
  };
};

const choosePreferredVoiceId = (voices, blockedVoiceIds = new Set()) => {
  if (!Array.isArray(voices) || voices.length === 0) return "";

  const notBlocked = voices.filter((voice) => {
    const id = String(voice?.voice_id || "").trim();
    return id && !blockedVoiceIds.has(id);
  });

  if (notBlocked.length === 0) return "";

  const nonLibrary = notBlocked.filter((voice) => !isLibraryStyleVoice(voice));
  const chosen = nonLibrary[0] || notBlocked[0];
  return String(chosen?.voice_id || "").trim();
};

const requestElevenLabsTts = async ({ apiKey, resolvedVoiceId, outputFormat, trimmedText, modelId }) => {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${resolvedVoiceId}?output_format=${encodeURIComponent(outputFormat)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: trimmedText,
        model_id: modelId
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    return {
      ok: false,
      status: response.status,
      errorText
    };
  }

  const arrayBuffer = await response.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuffer);

  return {
    ok: true,
    audioBase64: audioBuffer.toString("base64"),
    contentType: response.headers.get("content-type") || "audio/mpeg"
  };
};

const assertEnv = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new VoiceProviderError(`${name} is not configured`, {
      code: "missing_env",
      statusCode: 500,
      provider: "config",
      details: `Set ${name} in backend/.env and restart backend`
    });
  }
  return value;
};

const parseDeepgramPayload = (json) => {
  const alternatives = json?.results?.channels?.[0]?.alternatives || [];
  const top = alternatives[0] || {};

  return {
    transcript: String(top.transcript || "").trim(),
    confidence: Number.isFinite(top.confidence) ? top.confidence : 0,
    words: Array.isArray(top.words) ? top.words : [],
    raw: json
  };
};

const cleanMimeType = (value = "") => String(value || "").split(";")[0].trim().toLowerCase();

const buildMimeCandidates = (mimeType = "audio/webm") => {
  const base = cleanMimeType(mimeType);
  const candidates = [
    String(mimeType || "").trim(),
    base,
    "audio/webm",
    "audio/ogg",
    "application/octet-stream"
  ].filter(Boolean);

  return [...new Set(candidates)];
};

const parseDeepgramError = (errorText = "") => {
  const trimmed = String(errorText || "").trim();
  if (!trimmed) {
    return { message: "Unknown error", requestId: "" };
  }

  try {
    const json = JSON.parse(trimmed);
    return {
      message: String(json?.err_msg || trimmed),
      requestId: String(json?.request_id || "").trim()
    };
  } catch {
    return { message: trimmed, requestId: "" };
  }
};

const postDeepgramListen = async ({ apiKey, params, audioBuffer, contentType }) => {
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": contentType
    },
    body: audioBuffer
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      ok: false,
      status: response.status,
      errorText
    };
  }

  const json = await response.json();
  return {
    ok: true,
    json
  };
};

export const transcribeWithDeepgram = async ({
  audioBuffer,
  mimeType = "audio/webm",
  language = "en",
  model = "nova-2",
  smartFormat = true
}) => {
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new VoiceProviderError("Audio payload is empty", {
      code: "empty_audio",
      statusCode: 400,
      provider: "deepgram"
    });
  }

  const apiKey = assertEnv("DEEPGRAM_API_KEY");
  const params = new URLSearchParams({
    model,
    language,
    smart_format: smartFormat ? "true" : "false"
  });

  const mimeCandidates = buildMimeCandidates(mimeType);
  let lastFailure = null;

  for (const candidate of mimeCandidates) {
    const result = await postDeepgramListen({
      apiKey,
      params,
      audioBuffer,
      contentType: candidate
    });

    if (result.ok) {
      return parseDeepgramPayload(result.json);
    }

    lastFailure = {
      status: result.status,
      candidate,
      errorText: String(result.errorText || "").slice(0, 300)
    };

    // Retry only for bad payload/media cases where alternate content types may help.
    if (![400, 415, 422].includes(result.status)) {
      break;
    }
  }

  throw new VoiceProviderError(`Deepgram STT failed (${lastFailure?.status || 500})`, {
    code: "deepgram_stt_failed",
    statusCode: 502,
    provider: "deepgram",
    details: (() => {
      const parsed = parseDeepgramError(lastFailure?.errorText || "");
      const requestLabel = parsed.requestId ? ` Deepgram request_id: ${parsed.requestId}.` : "";
      return `Tried Content-Type values: ${mimeCandidates.join(", ")}. Last response: ${parsed.message}.${requestLabel}`;
    })()
  });
};

export const synthesizeWithElevenLabs = async ({
  text,
  voiceId,
  modelId = "eleven_multilingual_v2",
  outputFormat = "mp3_44100_128"
}) => {
  const trimmedText = String(text || "").trim();
  if (!trimmedText) {
    throw new VoiceProviderError("Text is required for TTS", {
      code: "missing_text",
      statusCode: 400,
      provider: "elevenlabs"
    });
  }

  const apiKey = assertEnv("ELEVENLABS_API_KEY");
  let resolvedVoiceId = String(
    voiceId || process.env.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_DEFAULT_VOICE_ID || ""
  ).trim();

  let voicesLookupDetails = "";
  let voiceCatalog = [];

  if (!resolvedVoiceId) {
    const lookup = await fetchElevenLabsVoices(apiKey);
    voiceCatalog = lookup.voices;
    voicesLookupDetails = lookup.details;

    if (lookup.ok) {
      resolvedVoiceId = choosePreferredVoiceId(lookup.voices);
    }
  }

  if (!resolvedVoiceId) {
    throw new VoiceProviderError("No ElevenLabs voice available", {
      code: "missing_voice",
      statusCode: 500,
      provider: "elevenlabs",
      details: voicesLookupDetails || "Set ELEVENLABS_VOICE_ID in backend/.env or create a voice in ElevenLabs account"
    });
  }

  let attempt = await requestElevenLabsTts({
    apiKey,
    resolvedVoiceId,
    outputFormat,
    trimmedText,
    modelId
  });

  if (!attempt.ok && attempt.status === 402) {
    const parsed = parseJsonSafe(attempt.errorText);
    const detailCode = String(parsed?.detail?.code || "").trim();
    if (detailCode === "paid_plan_required") {
      if (voiceCatalog.length === 0) {
        const lookup = await fetchElevenLabsVoices(apiKey);
        voiceCatalog = lookup.voices;
        if (lookup.details) {
          voicesLookupDetails = lookup.details;
        }
      }

      const alternativeVoiceId = choosePreferredVoiceId(
        voiceCatalog,
        new Set([resolvedVoiceId])
      );

      if (alternativeVoiceId) {
        resolvedVoiceId = alternativeVoiceId;
        attempt = await requestElevenLabsTts({
          apiKey,
          resolvedVoiceId,
          outputFormat,
          trimmedText,
          modelId
        });
      }
    }
  }

  if (!attempt.ok) {
    const parsed = parseJsonSafe(attempt.errorText);
    const providerMessage = String(parsed?.detail?.message || attempt.errorText || "Unknown ElevenLabs error").slice(0, 300);
    const providerRequestId = String(parsed?.detail?.request_id || "").trim();
    const requestInfo = providerRequestId ? ` request_id=${providerRequestId}` : "";

    throw new VoiceProviderError(`ElevenLabs TTS failed (${attempt.status})`, {
      code: "elevenlabs_tts_failed",
      statusCode: 502,
      provider: "elevenlabs",
      details: `${providerMessage}${requestInfo}${voicesLookupDetails ? ` | ${voicesLookupDetails}` : ""}`
    });
  }

  return {
    audioBase64: attempt.audioBase64,
    contentType: attempt.contentType
  };
};

const readResponseAudioBuffer = async (response) => {
  if (!response?.body || typeof response.body.getReader !== "function") {
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  const reader = response.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      chunks.push(Buffer.from(value));
    }
  }

  return Buffer.concat(chunks);
};

export const synthesizeWithMurf = async ({
  text,
  voiceId = "",
  locale = "en-US",
  model = "FALCON",
  format = "MP3",
  sampleRate = 24000,
  channelType = "MONO"
}) => {
  const trimmedText = String(text || "").trim();
  if (!trimmedText) {
    throw new VoiceProviderError("Text is required for TTS", {
      code: "missing_text",
      statusCode: 400,
      provider: "murf"
    });
  }

  const apiKey = assertEnv("MURF_API_KEY");
  const resolvedVoiceId = String(voiceId || process.env.MURF_VOICE_ID || "Matthew").trim();
  const resolvedLocale = String(locale || process.env.MURF_LOCALE || "en-US").trim();
  const resolvedModel = String(model || process.env.MURF_MODEL || "FALCON").trim();
  const resolvedFormat = String(format || process.env.MURF_FORMAT || "MP3").trim().toUpperCase();
  const resolvedChannelType = String(channelType || process.env.MURF_CHANNEL_TYPE || "MONO").trim().toUpperCase();
  const resolvedSampleRate = Number(sampleRate || process.env.MURF_SAMPLE_RATE || 24000);

  const response = await fetch("https://global.api.murf.ai/v1/speech/stream", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      voice_id: resolvedVoiceId,
      text: trimmedText,
      locale: resolvedLocale,
      model: resolvedModel,
      format: resolvedFormat,
      sampleRate: Number.isFinite(resolvedSampleRate) ? resolvedSampleRate : 24000,
      channelType: resolvedChannelType
    })
  });

  if (!response.ok) {
    const errorText = String(await response.text()).slice(0, 300);
    throw new VoiceProviderError(`Murf TTS failed (${response.status})`, {
      code: "murf_tts_failed",
      statusCode: 502,
      provider: "murf",
      details: errorText || "Unknown Murf error"
    });
  }

  const audioBuffer = await readResponseAudioBuffer(response);
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new VoiceProviderError("Murf returned empty audio", {
      code: "murf_empty_audio",
      statusCode: 502,
      provider: "murf"
    });
  }

  return {
    audioBase64: audioBuffer.toString("base64"),
    contentType: response.headers.get("content-type") || "audio/mpeg"
  };
};

export const getVoiceRuntimeHealth = () => {
  return {
    deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
    murfConfigured: Boolean(process.env.MURF_API_KEY?.trim()),
    elevenLabsConfigured: Boolean(process.env.ELEVENLABS_API_KEY?.trim()),
    elevenLabsVoiceConfigured: Boolean(
      process.env.ELEVENLABS_VOICE_ID?.trim() || process.env.ELEVENLABS_DEFAULT_VOICE_ID?.trim()
    )
  };
};
