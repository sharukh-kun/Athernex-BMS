import { getVoiceRuntimeHealth, synthesizeWithElevenLabs, synthesizeWithMurf, transcribeWithDeepgram } from "../services/voice.service.js";

const buildRequestId = () => `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const sendVoiceError = (res, error, fallbackMessage) => {
  const requestId = buildRequestId();
  const statusCode = Number(error?.statusCode) || 500;

  console.error(`[${requestId}] voice error`, {
    message: error?.message,
    code: error?.code,
    provider: error?.provider,
    details: error?.details
  });

  res.status(statusCode).json({
    error: error?.message || fallbackMessage,
    code: error?.code || "voice_unknown_error",
    provider: error?.provider || "voice",
    details: error?.details || "",
    requestId
  });
};

export const transcribeAudio = async (req, res) => {
  try {
    const {
      audioBase64,
      mimeType = "audio/webm",
      language = "en",
      model = "nova-2",
      smartFormat = true
    } = req.body || {};

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res.status(400).json({
        error: "audioBase64 is required",
        code: "missing_audio_base64"
      });
    }

    // Guard against oversized base64 payloads that can degrade STT latency.
    if (audioBase64.length > 10 * 1024 * 1024) {
      return res.status(413).json({
        error: "Audio payload too large. Stop and restart mic to send shorter chunks.",
        code: "audio_payload_too_large"
      });
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");

    const result = await transcribeWithDeepgram({
      audioBuffer,
      mimeType,
      language,
      model,
      smartFormat: Boolean(smartFormat)
    });

    res.json({
      provider: "deepgram",
      transcript: result.transcript,
      confidence: result.confidence,
      words: result.words
    });
  } catch (error) {
    sendVoiceError(res, error, "Failed to transcribe audio");
  }
};

export const synthesizeAudio = async (req, res) => {
  try {
    const {
      text,
      provider = "",
      voiceId = "",
      locale = "en-US",
      model = "FALCON",
      format = "MP3",
      sampleRate = 24000,
      channelType = "MONO",
      modelId = "eleven_multilingual_v2",
      outputFormat = "mp3_44100_128"
    } = req.body || {};

    const resolvedProvider = String(
      provider || process.env.TTS_PROVIDER || (process.env.MURF_API_KEY?.trim() ? "murf" : "elevenlabs")
    ).trim().toLowerCase();

    const result = resolvedProvider === "murf"
      ? await synthesizeWithMurf({
          text,
          voiceId,
          locale,
          model,
          format,
          sampleRate,
          channelType
        })
      : await synthesizeWithElevenLabs({
          text,
          voiceId,
          modelId,
          outputFormat
        });

    res.json({
      provider: resolvedProvider,
      contentType: result.contentType,
      audioBase64: result.audioBase64
    });
  } catch (error) {
    sendVoiceError(res, error, "Failed to synthesize audio");
  }
};

export const getVoiceHealth = (_req, res) => {
  res.json({
    ok: true,
    ...getVoiceRuntimeHealth()
  });
};
