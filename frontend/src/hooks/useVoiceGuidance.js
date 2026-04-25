import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { axiosInstance } from "../lib/axios.js";

const MAX_CHUNK_BYTES = 5 * 1024 * 1024;
const MAX_STT_SESSION_BYTES = 4 * 1024 * 1024;
const STT_RECORDER_ROTATE_MS = 2200;
const DEFAULT_AUTO_SEND_DELAY_MS = 3000;
const HOLD_ONE_DELAY_MS = 10000;
const MIC_AUTO_STOP_SILENCE_MS = 7000;
const HOLD_ONE_PATTERN = /\bhold one\b/i;

const hasMediaRecorder = () => {
  if (typeof window === "undefined") return false;
  return Boolean(window.MediaRecorder) && Boolean(navigator?.mediaDevices?.getUserMedia);
};

const hasAudioPlayback = () => {
  if (typeof window === "undefined") return false;
  return typeof window.Audio !== "undefined";
};

const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const value = String(reader.result || "");
      const commaIndex = value.indexOf(",");
      if (commaIndex === -1) {
        resolve(value);
        return;
      }

      resolve(value.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to encode audio payload"));
    reader.readAsDataURL(blob);
  });
};

const normalizeLanguage = (value = "en-US") => {
  const text = String(value || "").trim();
  if (!text) return "en";
  return text.split("-")[0] || "en";
};

const getRecorderMimeType = () => {
  if (typeof window === "undefined" || !window.MediaRecorder?.isTypeSupported) {
    return "";
  }

  const preferred = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4"
  ];

  for (const type of preferred) {
    if (window.MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }

  return "";
};

const extractErrorDetails = (event) => {
  const status = Number(event?.response?.status || 0);
  const message = String(
    event?.response?.data?.details ||
    event?.response?.data?.error ||
    event?.message ||
    "Unknown voice error"
  ).trim();

  return {
    status,
    message,
    code: String(event?.response?.data?.code || "voice_error")
  };
};

const normalizeSpeechText = (value = "") => {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
};

const mergeTranscriptWindows = (previousText = "", nextText = "") => {
  const previous = normalizeSpeechText(previousText);
  const next = normalizeSpeechText(nextText);

  if (!previous) return next;
  if (!next) return previous;
  if (previous === next) return previous;

  // If one window fully contains the other, prefer the longer one.
  if (next.includes(previous)) return next;
  if (previous.includes(next)) return previous;

  // Otherwise join by the largest suffix/prefix overlap.
  const maxOverlap = Math.min(previous.length, next.length);
  for (let size = maxOverlap; size >= 1; size -= 1) {
    if (previous.slice(-size) === next.slice(0, size)) {
      return `${previous}${next.slice(size)}`.trim();
    }
  }

  return `${previous} ${next}`.trim();
};

const stripControlPhrases = (value = "") => {
  const next = String(value || "")
    .replace(/\bhold one\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,.;:!?\-\s]+|[,.;:!?\-\s]+$/g, "")
    .trim();

  return next;
};

export default function useVoiceGuidance({
  enabled,
  rate,
  handsFree,
  language = "en-US",
  onFinalTranscript,
  onInterimTranscript,
  onError,
}) {
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [diagnostics, setDiagnostics] = useState({
    sttAttempts: 0,
    sttSuccess: 0,
    sttFailures: 0,
    lastChunkBytes: 0,
    lastSttStatus: 0,
    lastTtsStatus: 0,
    lastError: "",
    recorderMimeType: ""
  });

  const enabledRef = useRef(enabled);
  const handsFreeRef = useRef(handsFree);
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const chunksRef = useRef([]);
  const sessionBytesRef = useRef(0);
  const recorderRotateRequestedRef = useRef(false);
  const chunkTranscribeLockRef = useRef(false);
  const lastCaptionTranscribeAtRef = useRef(0);
  const autoSendTimerRef = useRef(null);
  const autoStopTimerRef = useRef(null);
  const latestInterimRef = useRef("");
  const shouldListenRef = useRef({ active: false, restartTimer: null, rotateTimer: null });
  const ttsRef = useRef({ audio: null, url: "" });
  const ttsTokenRef = useRef(0);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  const onInterimTranscriptRef = useRef(onInterimTranscript);
  const onErrorRef = useRef(onError);
  const lastChunkErrorAtRef = useRef(0);

  const patchDiagnostics = useCallback((partial) => {
    setDiagnostics((prev) => {
      if (typeof partial === "function") {
        return partial(prev);
      }
      return { ...prev, ...partial };
    });
  }, []);

  const clearRestartTimer = useCallback(() => {
    const timerId = shouldListenRef.current.restartTimer;
    if (timerId) {
      window.clearTimeout(timerId);
      shouldListenRef.current.restartTimer = null;
    }
  }, []);

  const clearRotateTimer = useCallback(() => {
    const timerId = shouldListenRef.current.rotateTimer;
    if (timerId) {
      window.clearTimeout(timerId);
      shouldListenRef.current.rotateTimer = null;
    }
  }, []);

  const clearAutoSendTimer = useCallback(() => {
    const timerId = autoSendTimerRef.current;
    if (timerId) {
      window.clearTimeout(timerId);
      autoSendTimerRef.current = null;
    }
  }, []);

  const clearAutoStopTimer = useCallback(() => {
    const timerId = autoStopTimerRef.current;
    if (timerId) {
      window.clearTimeout(timerId);
      autoStopTimerRef.current = null;
    }
  }, []);

  const finalizeBufferedTranscript = useCallback(() => {
    const bufferedText = normalizeSpeechText(latestInterimRef.current);
    if (!bufferedText) return;

    const cleaned = stripControlPhrases(bufferedText);
    latestInterimRef.current = "";
    onInterimTranscriptRef.current?.("");

    if (!cleaned) {
      return;
    }

    onFinalTranscriptRef.current?.({
      text: cleaned,
      autoSend: Boolean(enabledRef.current)
    });
  }, []);

  const scheduleAutoSendFromSilence = useCallback((currentTranscript) => {
    clearAutoSendTimer();
    clearAutoStopTimer();

    const delayMs = HOLD_ONE_PATTERN.test(String(currentTranscript || ""))
      ? HOLD_ONE_DELAY_MS
      : DEFAULT_AUTO_SEND_DELAY_MS;

    autoSendTimerRef.current = window.setTimeout(() => {
      finalizeBufferedTranscript();

    }, delayMs);

    // Stop mic much later than transcript finalize so natural pauses
    // don't cut the sentence while user is still speaking.
    const stopDelayMs = HOLD_ONE_PATTERN.test(String(currentTranscript || ""))
      ? HOLD_ONE_DELAY_MS + 4000
      : MIC_AUTO_STOP_SILENCE_MS;

    autoStopTimerRef.current = window.setTimeout(() => {
      if (enabledRef.current && !handsFreeRef.current) {
        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // Ignore stop errors during silence auto-stop.
          }
        }
      }
    }, stopDelayMs);
  }, [clearAutoSendTimer, clearAutoStopTimer, finalizeBufferedTranscript]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);

  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  useEffect(() => {
    onInterimTranscriptRef.current = onInterimTranscript;
  }, [onInterimTranscript]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  const isSpeechSupported = useMemo(() => hasAudioPlayback(), []);
  const isRecognitionSupported = useMemo(() => hasMediaRecorder(), []);
  const isVoiceSupported = isSpeechSupported || isRecognitionSupported;

  const stopSpeaking = useCallback(() => {
    ttsTokenRef.current += 1;
    const current = ttsRef.current;

    if (current.audio) {
      try {
        current.audio.pause();
      } catch {
        // Ignore pause errors during cleanup.
      }
    }

    if (current.url) {
      URL.revokeObjectURL(current.url);
    }

    ttsRef.current = { audio: null, url: "" };
    setIsSpeaking(false);
  }, []);

  const releaseStream = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (!stream) return;

    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Ignore stop errors.
      }
    }

    mediaStreamRef.current = null;
  }, []);

  const transcribeBlobForCaption = useCallback(async (payloadBlob, recorderMime = "audio/webm") => {
    if (!payloadBlob || payloadBlob.size === 0) return;
    if (chunkTranscribeLockRef.current) return;

    const now = Date.now();
    if (now - lastCaptionTranscribeAtRef.current < 1200) return;

    if (payloadBlob.size > MAX_CHUNK_BYTES) {
      patchDiagnostics((prev) => ({
        ...prev,
        sttFailures: prev.sttFailures + 1,
        lastChunkBytes: payloadBlob.size,
        lastSttStatus: 413,
        lastError: `Skipped oversized chunk (${Math.round(payloadBlob.size / 1024)} KB)`
      }));

      const now = Date.now();
      if (now - lastChunkErrorAtRef.current > 2000) {
        lastChunkErrorAtRef.current = now;
        onErrorRef.current?.({
          code: "payload_too_large",
          recoverable: true,
          message: "Microphone chunk was too large. Continuing with smaller chunks."
        });
      }
      return;
    }

    chunkTranscribeLockRef.current = true;
    lastCaptionTranscribeAtRef.current = now;
    patchDiagnostics((prev) => ({
      ...prev,
      sttAttempts: prev.sttAttempts + 1,
      lastChunkBytes: payloadBlob.size
    }));

    try {
      const audioBase64 = await blobToBase64(payloadBlob);
      const res = await axiosInstance.post("/voice/stt", {
        audioBase64,
        mimeType: recorderMime,
        language: normalizeLanguage(language),
        smartFormat: true
      });

      const transcript = normalizeSpeechText(res.data?.transcript || "");
      if (!transcript) return;

      const previous = latestInterimRef.current;
      const next = mergeTranscriptWindows(previous, transcript);
      latestInterimRef.current = next;
      onInterimTranscriptRef.current?.(next);
      scheduleAutoSendFromSilence(next);
      patchDiagnostics((prev) => ({
        ...prev,
        sttSuccess: prev.sttSuccess + 1,
        lastSttStatus: 200,
        lastError: ""
      }));
    } catch (event) {
      const details = extractErrorDetails(event);
      patchDiagnostics((prev) => ({
        ...prev,
        sttFailures: prev.sttFailures + 1,
        lastSttStatus: details.status,
        lastError: details.message
      }));

      const now = Date.now();
      if (now - lastChunkErrorAtRef.current > 1500) {
        lastChunkErrorAtRef.current = now;
        onErrorRef.current?.({
          code: details.code,
          recoverable: true,
          message: `STT failed${details.status ? ` (${details.status})` : ""}: ${details.message}`
        });
      }
    } finally {
      chunkTranscribeLockRef.current = false;
    }
  }, [language, patchDiagnostics, scheduleAutoSendFromSilence]);

  const internalStopListening = useCallback((permanent = true) => {
    clearRestartTimer();
    clearRotateTimer();
    clearAutoSendTimer();
    clearAutoStopTimer();

    if (permanent) {
      shouldListenRef.current.active = false;
    }

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Recorder may already be stopping.
      }
      return;
    }

    releaseStream();
    setIsListening(false);
  }, [clearAutoSendTimer, clearAutoStopTimer, clearRestartTimer, clearRotateTimer, releaseStream]);

  const startListening = useCallback(async () => {
    if (!enabledRef.current || !isRecognitionSupported) return;

    const activeRecorder = mediaRecorderRef.current;
    if (activeRecorder && activeRecorder.state !== "inactive") {
      return;
    }

    clearRestartTimer();
    shouldListenRef.current.active = true;
    chunksRef.current = [];
    sessionBytesRef.current = 0;
    recorderRotateRequestedRef.current = false;
    lastCaptionTranscribeAtRef.current = 0;
    latestInterimRef.current = "";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const recorderMimeType = getRecorderMimeType();
      const recorder = recorderMimeType
        ? new MediaRecorder(stream, { mimeType: recorderMimeType })
        : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      patchDiagnostics({ recorderMimeType: recorderMimeType || "browser-default" });

      recorder.onstart = () => {
        setIsListening(true);
        onInterimTranscriptRef.current?.("Listening...");
        // Only rotate continuously in hands-free mode.
        if (handsFreeRef.current) {
          clearRotateTimer();
          shouldListenRef.current.rotateTimer = window.setTimeout(() => {
            internalStopListening(false);
          }, STT_RECORDER_ROTATE_MS);
        }
      };

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        chunksRef.current.push(event.data);
        sessionBytesRef.current += event.data.size;

        if (
          sessionBytesRef.current > MAX_STT_SESSION_BYTES &&
          !recorderRotateRequestedRef.current
        ) {
          recorderRotateRequestedRef.current = true;
          internalStopListening(false);
        }
      };

      recorder.onerror = (event) => {
        onErrorRef.current?.({
          code: "mic_error",
          recoverable: true,
          message: `Microphone capture failed: ${event?.error?.name || "unknown"}`
        });
      };

      recorder.onstop = async () => {
        const forceRestart = recorderRotateRequestedRef.current;
        const shouldRestart = Boolean(
          enabledRef.current &&
          shouldListenRef.current.active &&
          (handsFreeRef.current || forceRestart)
        );

        mediaRecorderRef.current = null;
        releaseStream();
        setIsListening(false);
        clearRotateTimer();

        const finalMime = recorder.mimeType || "audio/webm";
        const finalBlob = chunksRef.current.length > 0
          ? new Blob(chunksRef.current, { type: finalMime })
          : null;

        if (finalBlob && finalBlob.size > 0) {
          await transcribeBlobForCaption(finalBlob, finalMime);
        }

        if (!forceRestart) {
          clearAutoSendTimer();
          finalizeBufferedTranscript();
        }

        chunksRef.current = [];
        sessionBytesRef.current = 0;
        recorderRotateRequestedRef.current = false;

        if (shouldRestart) {
          clearRestartTimer();
          shouldListenRef.current.restartTimer = window.setTimeout(() => {
            startListening();
          }, 250);
        }
      };

      // Collect chunks frequently to avoid huge memory spikes.
      recorder.start(900);
    } catch {
      shouldListenRef.current.active = false;
      setIsListening(false);
      releaseStream();
      patchDiagnostics({
        lastError: "Microphone access blocked"
      });
      onErrorRef.current?.({
        code: "not-allowed",
        recoverable: false,
        message: "Microphone access is blocked. Allow microphone permission and try again."
      });
    }
  }, [clearAutoSendTimer, clearRestartTimer, clearRotateTimer, finalizeBufferedTranscript, internalStopListening, isRecognitionSupported, releaseStream, transcribeBlobForCaption]);

  const stopListening = useCallback(() => {
    internalStopListening(true);
  }, [internalStopListening]);

  const pauseForTyping = useCallback(() => {
    stopSpeaking();
    internalStopListening(true);
  }, [internalStopListening, stopSpeaking]);

  const speakText = useCallback(async (text) => {
    const nextText = String(text || "").trim();

    if (!enabledRef.current || !isSpeechSupported || !nextText) return;

    stopSpeaking();
    const token = ttsTokenRef.current + 1;
    ttsTokenRef.current = token;
    setIsSpeaking(true);

    try {
      const res = await axiosInstance.post("/voice/tts", {
        text: nextText,
        provider: "murf",
        voiceId: "Matthew",
        locale: language || "en-US",
        model: "FALCON",
        format: "MP3",
        sampleRate: 24000,
        channelType: "MONO",
        language: normalizeLanguage(language),
        rate: Number.isFinite(rate) ? rate : 0.9
      });

      if (token !== ttsTokenRef.current) {
        return;
      }

      const base64 = String(res.data?.audioBase64 || "");
      const contentType = String(res.data?.contentType || "audio/mpeg");
      if (!base64) {
        throw new Error("TTS returned empty audio payload");
      }

      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      const blob = new Blob([bytes], { type: contentType });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      ttsRef.current = { audio, url };

      audio.onended = () => {
        if (ttsRef.current.url) {
          URL.revokeObjectURL(ttsRef.current.url);
        }
        ttsRef.current = { audio: null, url: "" };
        setIsSpeaking(false);
      };

      audio.onerror = () => {
        if (ttsRef.current.url) {
          URL.revokeObjectURL(ttsRef.current.url);
        }
        ttsRef.current = { audio: null, url: "" };
        setIsSpeaking(false);
        onErrorRef.current?.({
          code: "tts_failed",
          recoverable: true,
          message: "Voice playback failed"
        });
      };

      await audio.play();
    } catch (event) {
      const details = extractErrorDetails(event);
      setIsSpeaking(false);
      patchDiagnostics({
        lastTtsStatus: details.status,
        lastError: details.message
      });
      onErrorRef.current?.({
        code: "tts_failed",
        recoverable: true,
        message: details.message || "Speech synthesis failed"
      });
    }
  }, [isSpeechSupported, language, patchDiagnostics, rate, stopSpeaking]);

  useEffect(() => {
    if (!enabled) {
      shouldListenRef.current.active = false;
      internalStopListening(true);
      stopSpeaking();
      return;
    }

    if (handsFree && isRecognitionSupported) {
      startListening();
    }
  }, [enabled, handsFree, internalStopListening, isRecognitionSupported, startListening, stopSpeaking]);

  useEffect(() => {
    return () => {
      shouldListenRef.current.active = false;
      clearRestartTimer();
      clearRotateTimer();
      clearAutoSendTimer();
      clearAutoStopTimer();
      stopSpeaking();
      releaseStream();
    };
  }, [clearAutoSendTimer, clearAutoStopTimer, clearRestartTimer, clearRotateTimer, releaseStream, stopSpeaking]);

  const status = useMemo(() => {
    if (!isVoiceSupported) return "unavailable";
    if (isSpeaking && isListening) return "duplex";
    if (isSpeaking) return "speaking";
    if (isListening) return "listening";
    return "idle";
  }, [isListening, isSpeaking, isVoiceSupported]);

  return {
    isVoiceSupported,
    isSpeechSupported,
    isRecognitionSupported,
    isListening,
    isSpeaking,
    status,
    diagnostics,
    speakText,
    stopSpeaking,
    startListening,
    stopListening,
    pauseForTyping,
  };
}
