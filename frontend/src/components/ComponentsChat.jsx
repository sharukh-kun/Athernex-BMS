import { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { useThemeStore } from "../store/useThemeStore";
import toast from "react-hot-toast";
import useVoiceGuidance from "../hooks/useVoiceGuidance";

export default function ComponentsChat({ onWorkspaceSync, onProjectSync, onMainChatAppend } = {}) {
  const { id } = useParams();
  const lastVoiceErrorRef = useRef({ code: "", at: 0 });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isGeneratingFiles, setIsGeneratingFiles] = useState(false);
  const [showProfileViz, setShowProfileViz] = useState(true);
  const [generationProfile, setGenerationProfile] = useState({});
  const [activeArtifactTab, setActiveArtifactTab] = useState("notes");
  const [artifactPanelMode, setArtifactPanelMode] = useState("normal"); // normal | minimized | maximized
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [handsFreeMode, setHandsFreeMode] = useState(false);
  const [speechRate, setSpeechRate] = useState(0.9);
  const [latestGenerated, setLatestGenerated] = useState({
    sketch: "",
    diagram: "",
    notes: [],
    fallbackUsed: false
  });
  const scrollRef = useRef(null);

  const { theme } = useThemeStore();
  const isDark = theme === "dark";
  const normalizeMessages = (entries = []) =>
    (Array.isArray(entries) ? entries : [])
      .map((item) => ({
        role: item?.role === "user" ? "user" : "ai",
        content: String(item?.content || "").trim()
      }))
      .filter((item) => item.content.length > 0);

  const syncWorkspaceFiles = (nextWorkspace = null) => {
    if (!nextWorkspace || typeof onWorkspaceSync !== "function") return;
    onWorkspaceSync(nextWorkspace);
  };

  const syncProjectState = (patch = null) => {
    if (!patch || typeof onProjectSync !== "function") return;
    onProjectSync(patch);
  };

  const appendMainChat = (entries = []) => {
    if (typeof onMainChatAppend !== "function") return;
    const normalized = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (normalized.length === 0) return;
    onMainChatAppend(normalized);
  };

  const {
    isVoiceSupported,
    isRecognitionSupported,
    status: voiceStatus,
    diagnostics: voiceDiagnostics,
    speakText,
    startListening,
    stopListening,
    pauseForTyping,
  } = useVoiceGuidance({
    enabled: voiceEnabled,
    rate: speechRate,
    handsFree: handsFreeMode,
    onFinalTranscript: ({ text, autoSend }) => {
      if (!text) return;
      setInput(text);
      if (autoSend) {
        sendMessage(text);
      }
    },
    onInterimTranscript: (text) => {
      if (!text) return;
      setInput(text);
    },
    onError: (error) => {
      const payload =
        typeof error === "string"
          ? { code: "unknown_error", message: error, recoverable: false }
          : (error || { code: "unknown_error", message: "Voice error", recoverable: false });

      const now = Date.now();
      const recent = lastVoiceErrorRef.current;
      if (recent.code === payload.code && now - recent.at < 3500) {
        return;
      }

      lastVoiceErrorRef.current = { code: payload.code, at: now };
      toast.error(payload.message || "Voice guidance error");
    }
  });

  const voiceStatusLabel =
    voiceStatus === "duplex"
      ? "Speaking + Listening"
      : voiceStatus === "speaking"
        ? "AI Speaking"
        : voiceStatus === "listening"
          ? "Listening"
          : voiceStatus === "unavailable"
            ? "Voice Unavailable"
            : "Idle";

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  useEffect(() => {
    const loadHistoryOrInit = async () => {
      if (!id) return;

      try {
        setLoading(true);

        const historyRes = await axios.get(
          `http://localhost:5000/api/project/${id}/history/components`,
          { withCredentials: true }
        );

        const existingMessages = normalizeMessages(historyRes.data?.messages || []);
        if (existingMessages.length > 0) {
          setMessages(existingMessages);
          try {
            const projectRes = await axios.get(
              `http://localhost:5000/api/project/${id}`,
              { withCredentials: true }
            );
            const nextProfile = projectRes.data?.generationProfile || {};
            setGenerationProfile(nextProfile);
            syncProjectState({
              generationProfile: nextProfile,
              componentsState: projectRes.data?.componentsState || null,
              architectureState: projectRes.data?.architectureState || null
            });
            syncWorkspaceFiles(projectRes.data?.workspaceFiles || null);
          } catch (err) {
            console.error("Failed to fetch project profile:", err);
          }
          return;
        }

        const res = await axios.post(
          "http://localhost:5000/api/components/init",
          { projectId: id },
          { withCredentials: true }
        );

        const initReply = String(res.data?.reply || "").trim() || "Components workspace ready.";
        setMessages([{ role: "ai", content: initReply }]);
        setGenerationProfile(res.data?.generationProfile || {});
        syncProjectState({
          generationProfile: res.data?.generationProfile || null,
          componentsState: res.data?.componentsState || null,
          architectureState: res.data?.architectureState || null
        });
        syncWorkspaceFiles(res.data?.workspaceFiles || null);
      } catch (err) {
        const errorMessage = err?.response?.data?.error || "Unable to start Components AI";
        toast.error(errorMessage);
        setMessages([{ role: "ai", content: errorMessage }]);
      } finally {
        setLoading(false);
      }
    };

    loadHistoryOrInit();
  }, [id]);

  const sendMessage = async (overrideInput) => {
    const resolved = typeof overrideInput === "string" ? overrideInput : input;
    if (!resolved.trim() || loading) return;

    const userMsg = resolved;
    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    appendMainChat([{ role: "user", content: userMsg }]);
    setInput("");
    setLoading(true);

    try {
      const res = await axios.post(
        "http://localhost:5000/api/components/chat",
        { projectId: id, message: userMsg },
        { withCredentials: true }
      );

      const aiReply = String(res.data?.reply || "").trim() || "Components updated.";
      setMessages(prev => [...prev, { role: "ai", content: aiReply }]);
      setGenerationProfile(res.data?.generationProfile || {});
      syncProjectState({
        generationProfile: res.data?.generationProfile || null,
        componentsState: res.data?.componentsState || null,
        architectureState: res.data?.architectureState || null
      });
      syncWorkspaceFiles(res.data?.workspaceFiles || null);
      appendMainChat([{ role: "ai", content: aiReply }]);
      speakText(aiReply);
    } catch (err) {
      const errorMessage = err?.response?.data?.error || "Components chat failed";
      toast.error(errorMessage);
      setMessages(prev => [...prev, { role: "ai", content: errorMessage }]);
      appendMainChat([{ role: "ai", content: errorMessage }]);
      speakText(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (value) => {
    pauseForTyping();
    setInput(value);
  };

  const handleToggleVoice = () => {
    if (!isVoiceSupported) {
      toast.error("Voice is not supported in this browser");
      return;
    }

    setVoiceEnabled((prev) => {
      const next = !prev;

      if (!next) {
        stopListening();
      } else if (handsFreeMode && isRecognitionSupported) {
        startListening();
      }

      return next;
    });
  };

  const handleToggleHandsFree = () => {
    if (!isRecognitionSupported) {
      toast.error("Speech recognition is not supported in this browser");
      return;
    }

    if (!voiceEnabled) {
      setVoiceEnabled(true);
    }

    setHandsFreeMode((prev) => !prev);
  };

  const handleMicToggle = () => {
    if (!isRecognitionSupported) {
      toast.error("Speech recognition is not supported in this browser");
      return;
    }

    if (voiceStatus === "listening" || voiceStatus === "duplex") {
      stopListening();
      return;
    }

    setVoiceEnabled(true);
    startListening();
  };

  const copyText = async (text, label = "Copied") => {
    try {
      await navigator.clipboard.writeText(String(text || ""));
      toast.success(label);
      return true;
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = String(text || "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (ok) {
          toast.success(label);
          return true;
        }
      } catch {}
      toast.error("Copy failed");
      return false;
    }
  };

  const copyActiveArtifact = async () => {
    if (activeArtifactTab === "sketch") {
      return copyText(latestGenerated.sketch, "Copied sketch.ino");
    }
    if (activeArtifactTab === "diagram") {
      return copyText(latestGenerated.diagram, "Copied diagram.json");
    }
    return copyText((latestGenerated.notes || []).join("\n"), "Copied notes");
  };

  const copyAllArtifacts = async () => {
    const payload = [
      "sketch.ino",
      latestGenerated.sketch || "",
      "",
      "diagram.json",
      latestGenerated.diagram || "",
      "",
      "notes",
      Array.isArray(latestGenerated.notes) ? latestGenerated.notes.join("\n") : ""
    ].join("\n");
    return copyText(payload, "Copied all artifacts");
  };

  const generateFiles = async ({ strictMode = false } = {}) => {
    if (!id || isGeneratingFiles) return;

    try {
      setIsGeneratingFiles(true);
      const basePrompt = input.trim() || "Generate sketch.ino and diagram.json using ideation and components context";
      const generationPrompt = strictMode
        ? `${basePrompt}\nSTRICT MODE: Output must be a valid Plan JSON only (no markdown, no comments). Use ONLY registry component type keys and ONLY registry pin names.`
        : basePrompt;

      setArtifactPanelMode("maximized");

      const res = await axios.post(
        "http://localhost:5000/api/components/generate-files",
        {
          projectId: id,
          userPrompt: generationPrompt
        },
        { withCredentials: true }
      );

      const generated = res.data?.generated || {};
      setGenerationProfile(res.data?.generationProfile || {});
      syncProjectState({
        generationProfile: res.data?.generationProfile || null,
        componentsState: res.data?.componentsState || null,
        architectureState: res.data?.architectureState || null
      });
      syncWorkspaceFiles(res.data?.workspaceFiles || null);
      const sketch = String(generated.sketchIno || "");
      const diagram = JSON.stringify(generated.diagramJson || {}, null, 2);
      const noteList = Array.isArray(generated.notes) ? generated.notes : [];
      const fallbackUsed = noteList.some((note) => /fallback template used/i.test(String(note || "")));

      setLatestGenerated({
        sketch,
        diagram,
        notes: noteList,
        fallbackUsed
      });

      if (fallbackUsed) {
        toast.error("Fallback template detected. Try Regenerate Strict for a cleaner project-specific output.");
      } else {
        toast.success("Generated sketch.ino + diagram.json");
      }

      setActiveArtifactTab(fallbackUsed ? "notes" : "sketch");
    } catch (err) {
      const message = err?.response?.data?.error || "Failed to generate files";
      toast.error(message);
    } finally {
      setIsGeneratingFiles(false);
    }
  };

  const hintsCount = Array.isArray(generationProfile?.runtimeHints) ? generationProfile.runtimeHints.length : 0;
  const hasBoard = Boolean(generationProfile?.board);
  const hasFirmwareTarget = Boolean(generationProfile?.firmwareTarget);
  const hasSimulationTarget = Boolean(generationProfile?.simulationTarget);
  const profileReadiness = Math.max(
    0,
    Math.min(
      100,
      (hasBoard ? 35 : 0)
      + (hasFirmwareTarget ? 30 : 0)
      + (hasSimulationTarget ? 25 : 0)
      + (hintsCount > 0 ? 10 : 0)
    )
  );

  const statusBadge = profileReadiness >= 80
    ? { label: "Strong", color: "text-[#22c55e]" }
    : profileReadiness >= 50
      ? { label: "Partial", color: "text-[#f59e0b]" }
      : { label: "Weak", color: "text-[#ef4444]" };

  return (
    <div className={`flex h-full flex-col ${isDark ? "bg-[#252525] text-[#e5e5e5]" : "bg-[#f2efe9] text-[#1f2937]"}`}>
      <div className={`border-b px-5 py-4 ${isDark ? "border-white/10 bg-[#252525]" : "border-[#d6cdbf] bg-[#f7f3ec]"}`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className={`text-[11px] font-semibold uppercase tracking-[0.25em] ${isDark ? "text-[#9da3b3]" : "text-[#0f766e]"}`}>Build Stage</p>
            <h2 className="mt-1 text-lg font-semibold">Components Control Deck</h2>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${isDark ? "bg-white/5 text-[#7dd3fc]" : "bg-[#d1fae5] text-[#0f766e]"}`}>Readiness {profileReadiness}%</span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusBadge.color} ${isDark ? "bg-white/5" : "bg-[#e7e5e4]"}`}>{statusBadge.label}</span>

            <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
              voiceStatus === "duplex"
                ? "bg-emerald-500/20 text-emerald-300"
                : voiceStatus === "speaking"
                  ? "bg-blue-500/20 text-blue-300"
                  : voiceStatus === "listening"
                    ? "bg-amber-500/20 text-amber-300"
                    : voiceStatus === "unavailable"
                      ? "bg-red-500/20 text-red-300"
                      : (isDark ? "bg-white/5 text-[#9da3b3]" : "bg-[#e7e5e4] text-[#475569]")
            }`}>
              {voiceStatusLabel}
            </span>

            <button
              onClick={handleToggleVoice}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition ${isDark ? "border-white/15 bg-white/5 hover:bg-white/10" : "border-[#b8ab98] bg-white hover:bg-[#f3efe7]"} ${voiceEnabled ? (isDark ? "text-[#7dd3fc]" : "text-[#0f766e]") : ""}`}
            >
              {voiceEnabled ? "Voice On" : "Voice Off"}
            </button>

            <button
              onClick={handleToggleHandsFree}
              disabled={!isRecognitionSupported}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition ${isDark ? "border-white/15 bg-white/5 hover:bg-white/10" : "border-[#b8ab98] bg-white hover:bg-[#f3efe7]"} ${handsFreeMode ? (isDark ? "text-emerald-300" : "text-emerald-800") : ""} ${!isRecognitionSupported ? "cursor-not-allowed opacity-50" : ""}`}
            >
              Hands-free {handsFreeMode ? "On" : "Off"}
            </button>

            <button
              onClick={handleMicToggle}
              disabled={!isRecognitionSupported}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition ${isDark ? "border-white/15 bg-white/5 hover:bg-white/10" : "border-[#b8ab98] bg-white hover:bg-[#f3efe7]"} ${(voiceStatus === "listening" || voiceStatus === "duplex") ? (isDark ? "text-amber-300" : "text-amber-900") : ""} ${!isRecognitionSupported ? "cursor-not-allowed opacity-50" : ""}`}
            >
              {voiceStatus === "listening" || voiceStatus === "duplex" ? "Stop Mic" : "Start Mic"}
            </button>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <label className={`text-[11px] font-semibold uppercase tracking-[0.14em] ${isDark ? "text-[#9da3b3]" : "text-[#0f766e]"}`}>
            Speech Rate
          </label>
          <input
            type="range"
            min="0.7"
            max="1.2"
            step="0.05"
            value={speechRate}
            disabled={!voiceEnabled || !isVoiceSupported}
            onChange={(event) => setSpeechRate(Number(event.target.value))}
            className="w-40"
          />
          <span className={`text-xs font-semibold ${isDark ? "text-[#9da3b3]" : "text-[#475569]"}`}>
            {speechRate.toFixed(2)}x
          </span>
        </div>

        <p className={`mt-3 text-[10px] ${isDark ? "text-[#9da3b3]" : "text-[#64748b]"}`}>
          STT {voiceDiagnostics?.sttSuccess || 0}/{voiceDiagnostics?.sttAttempts || 0} |
          Failures {voiceDiagnostics?.sttFailures || 0} |
          Last chunk {Math.round((voiceDiagnostics?.lastChunkBytes || 0) / 1024)}KB |
          MIME {voiceDiagnostics?.recorderMimeType || "-"}
          {voiceDiagnostics?.lastError ? ` | Last error: ${voiceDiagnostics.lastError}` : ""}
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className={`min-h-0 overflow-y-auto border-r px-4 py-4 ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-[#d6cdbf] bg-[#f9f6f1]"}`}>
          <div className="space-y-3">
            <button
              onClick={() => generateFiles()}
              disabled={loading || isGeneratingFiles}
              className={`w-full rounded-xl px-3 py-2 text-sm font-semibold transition ${isDark ? "bg-[#2563eb] text-white hover:bg-[#1d4ed8]" : "bg-[#0f766e] text-white hover:bg-[#0d9488]"} ${(loading || isGeneratingFiles) ? "cursor-not-allowed opacity-60" : ""}`}
            >
              {isGeneratingFiles ? "Generating..." : "Generate Files"}
            </button>

            <button
              onClick={() => generateFiles({ strictMode: true })}
              disabled={loading || isGeneratingFiles}
              className={`w-full rounded-xl border px-3 py-2 text-sm font-semibold transition ${isDark ? "border-white/15 bg-white/5 hover:bg-white/10" : "border-[#b8ab98] bg-white hover:bg-[#f3efe7]"} ${(loading || isGeneratingFiles) ? "cursor-not-allowed opacity-60" : ""}`}
            >
              Regenerate Strict JSON
            </button>

            <button
              onClick={() => setShowProfileViz(prev => !prev)}
              className={`w-full rounded-xl border px-3 py-2 text-sm font-semibold transition ${isDark ? "border-white/15 bg-white/5 hover:bg-white/10" : "border-[#b8ab98] bg-white hover:bg-[#f3efe7]"}`}
            >
              {showProfileViz ? "Hide Contract Insight" : "Show Contract Insight"}
            </button>
          </div>

          {showProfileViz && (
            <div className="mt-4 space-y-4">
              <div className={`rounded-xl border px-4 py-4 ${isDark ? "border-white/10 bg-[#252525]" : "border-[#c9bca8] bg-white"}`}>
                <p className={`text-[11px] font-semibold uppercase tracking-[0.2em] ${isDark ? "text-[#9da3b3]" : "text-[#0f766e]"}`}>Contract Graph</p>
                <div className="mt-3 space-y-3 text-xs">
                  <div>
                    <p className="mb-1">Board lock</p>
                    <div className={`h-2 rounded-full ${isDark ? "bg-white/10" : "bg-[#e6ddcf]"}`}>
                      <div className="h-2 rounded-full bg-[#22d3ee]" style={{ width: `${hasBoard ? 100 : 8}%` }} />
                    </div>
                  </div>
                  <div>
                    <p className="mb-1">Firmware target</p>
                    <div className={`h-2 rounded-full ${isDark ? "bg-white/10" : "bg-[#e6ddcf]"}`}>
                      <div className="h-2 rounded-full bg-[#60a5fa]" style={{ width: `${hasFirmwareTarget ? 100 : 8}%` }} />
                    </div>
                  </div>
                  <div>
                    <p className="mb-1">Simulation target</p>
                    <div className={`h-2 rounded-full ${isDark ? "bg-white/10" : "bg-[#e6ddcf]"}`}>
                      <div className="h-2 rounded-full bg-[#34d399]" style={{ width: `${hasSimulationTarget ? 100 : 8}%` }} />
                    </div>
                  </div>
                </div>
              </div>

              <div className={`rounded-xl border px-4 py-4 text-xs ${isDark ? "border-white/10 bg-[#252525]" : "border-[#c9bca8] bg-white"}`}>
                <p>Board: {generationProfile?.board || "pending"}</p>
                <p>Board part: {generationProfile?.boardPartType || "pending"}</p>
                <p>Firmware: {generationProfile?.firmwareTarget || "pending"}</p>
                <p>Sim target: {generationProfile?.simulationTarget || "pending"}</p>
                <p>Runtime hints: {hintsCount}</p>
              </div>
            </div>
          )}
        </aside>

        <main className="min-h-0 overflow-hidden">
          <div className="grid h-full min-h-0 grid-rows-[1fr_auto_auto]">
            <div ref={scrollRef} className="overflow-y-auto px-5 py-5">
              <div className="space-y-4">
                <AnimatePresence>
                  {messages.filter((m) => String(m?.content || "").trim()).map((m, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2 }}
                      className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${m.role === "user"
                        ? (isDark ? "bg-[#1d4ed8] text-white" : "bg-[#0f766e] text-white")
                        : (isDark ? "border border-white/10 bg-[#1f1f1f]" : "border border-[#d4c9b8] bg-white")}`}
                      >
                        <p className={`mb-1 text-[11px] font-semibold uppercase tracking-[0.15em] ${m.role === "user" ? "text-white/80" : (isDark ? "text-[#9da3b3]" : "text-[#0f766e]")}`}>
                          {m.role === "user" ? "Prompt" : "Builder"}
                        </p>
                        <div className="whitespace-pre-wrap text-sm leading-relaxed">{m.content}</div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>

                {(loading || isGeneratingFiles) && (
                  <div className="flex justify-start">
                    <div className={`rounded-2xl px-4 py-3 text-sm ${isDark ? "border border-white/10 bg-[#1f1f1f] text-[#9da3b3]" : "border border-[#d4c9b8] bg-white text-[#0f766e]"}`}>
                      {isGeneratingFiles ? "Generating project artifacts..." : "Thinking through architecture..."}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className={`border-t px-5 py-4 ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-[#d6cdbf] bg-[#f9f6f1]"}`}>
              <div className="flex flex-wrap items-center gap-3">
                {[
                  "Give me board + pin mapping",
                  "Generate compact wiring plan",
                  "Explain expected serial output"
                ].map((quick) => (
                  <button
                    key={quick}
                    onClick={() => handleInputChange(quick)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${isDark ? "bg-white/5 text-[#9da3b3] hover:bg-white/10" : "bg-white text-[#0f766e] hover:bg-[#f1ece2]"}`}
                  >
                    {quick}
                  </button>
                ))}
              </div>
            </div>

            <div className={`border-t px-5 py-4 ${isDark ? "border-white/10 bg-[#252525]" : "border-[#d6cdbf] bg-[#f7f3ec]"}`}>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
                <div className={`rounded-2xl border px-4 py-3 ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-[#d4c9b8] bg-white"}`}>
                  <div className="flex items-center gap-3">
                    <input
                      className={`w-full bg-transparent px-2 py-2 text-sm outline-none ${isDark ? "placeholder:text-[#7c7c7c]" : "placeholder:text-[#9b8f7d]"}`}
                      value={input}
                      onChange={(e) => handleInputChange(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                      placeholder={voiceEnabled ? "Type to pause voice, or speak using mic controls..." : "Ask for wiring logic, output behavior, or constraints..."}
                    />
                    <button
                      onClick={sendMessage}
                      disabled={loading || isGeneratingFiles}
                      className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${isDark ? "bg-[#1d4ed8] text-white hover:bg-[#2563eb]" : "bg-[#0f766e] text-white hover:bg-[#0d9488]"} ${(loading || isGeneratingFiles) ? "cursor-not-allowed opacity-60" : ""}`}
                    >
                      Send
                    </button>
                  </div>
                </div>

                <div className={`rounded-2xl border ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-[#d4c9b8] bg-white"}`}>
                  <div className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 ${isDark ? "border-white/10" : "border-[#e4dbce]"}`}>
                    <div className="flex items-center gap-3">
                      {[
                        ["notes", "Notes"],
                        ["sketch", "Sketch"],
                        ["diagram", "Diagram"]
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          onClick={() => setActiveArtifactTab(key)}
                          className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${activeArtifactTab === key
                            ? (isDark ? "bg-[#1d4ed8] text-white" : "bg-[#0f766e] text-white")
                            : (isDark ? "text-[#9da3b3] hover:bg-white/10" : "text-[#0f766e] hover:bg-[#f0ebe2]")}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        onClick={copyActiveArtifact}
                        disabled={!latestGenerated.sketch && !latestGenerated.diagram && (latestGenerated.notes || []).length === 0}
                        className={`rounded-md border px-3 py-1.5 text-[11px] font-semibold transition ${isDark ? "border-white/15 text-[#9da3b3] hover:bg-white/10" : "border-[#b8ab98] text-[#0f766e] hover:bg-[#f0ebe2]"} ${(!latestGenerated.sketch && !latestGenerated.diagram && (latestGenerated.notes || []).length === 0) ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        Copy
                      </button>
                      <button
                        onClick={copyAllArtifacts}
                        disabled={!latestGenerated.sketch && !latestGenerated.diagram}
                        className={`rounded-md border px-3 py-1.5 text-[11px] font-semibold transition ${isDark ? "border-white/15 text-[#9da3b3] hover:bg-white/10" : "border-[#b8ab98] text-[#0f766e] hover:bg-[#f0ebe2]"} ${(!latestGenerated.sketch && !latestGenerated.diagram) ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        Copy all
                      </button>
                      <button
                        onClick={() => setArtifactPanelMode((prev) => prev === "minimized" ? "normal" : "minimized")}
                        className={`rounded-md border px-3 py-1.5 text-[11px] font-semibold transition ${isDark ? "border-white/15 text-[#9da3b3] hover:bg-white/10" : "border-[#b8ab98] text-[#0f766e] hover:bg-[#f0ebe2]"}`}
                      >
                        {artifactPanelMode === "minimized" ? "Expand" : "Minimize"}
                      </button>
                      <button
                        onClick={() => setArtifactPanelMode((prev) => prev === "maximized" ? "normal" : "maximized")}
                        className={`rounded-md border px-3 py-1.5 text-[11px] font-semibold transition ${isDark ? "border-white/15 text-[#9da3b3] hover:bg-white/10" : "border-[#b8ab98] text-[#0f766e] hover:bg-[#f0ebe2]"}`}
                      >
                        {artifactPanelMode === "maximized" ? "Normal" : "Max"}
                      </button>
                    </div>
                  </div>

                  {artifactPanelMode !== "minimized" && (
                    <div className={`${artifactPanelMode === "maximized" ? "max-h-96" : "max-h-44"} overflow-y-auto px-4 py-3 text-xs`}>
                      {activeArtifactTab === "notes" && (
                        latestGenerated.notes.length > 0 ? (
                          <ul className="space-y-1">
                            {latestGenerated.notes.map((note, index) => (
                              <li key={`${note}-${index}`} className={`${/fallback template used/i.test(note) ? "text-[#ef4444]" : ""}`}>
                                • {note}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className={isDark ? "text-[#9da3b3]" : "text-[#7a6f5f]"}>No artifact notes yet.</p>
                        )
                      )}

                      {activeArtifactTab === "sketch" && (
                        <pre className="whitespace-pre-wrap text-[11px] leading-relaxed">
                          {latestGenerated.sketch || "No sketch generated yet."}
                        </pre>
                      )}

                      {activeArtifactTab === "diagram" && (
                        <pre className="whitespace-pre-wrap text-[11px] leading-relaxed">
                          {latestGenerated.diagram || "No diagram generated yet."}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
