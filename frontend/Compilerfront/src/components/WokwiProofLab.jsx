import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";
import { useThemeStore } from "../store/useThemeStore";

const getProofStorageKey = (projectId) => `hardcode:wokwi:prooflab:${projectId}`;

const pretty = (value) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const parseJsonSafe = (text, fallback = {}) => {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const EvidenceCard = ({ title, item, isDark }) => {
  if (!item) {
    return (
      <div className={`rounded-xl border p-4 ${isDark ? "border-white/10 bg-[#252525]" : "border-black/10 bg-white"}`}>
        <p className="text-sm font-semibold">{title}</p>
        <p className={`mt-2 text-xs ${isDark ? "text-[#999]" : "text-[#666]"}`}>No data yet.</p>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border p-4 ${isDark ? "border-white/10 bg-[#252525]" : "border-black/10 bg-white"}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${item.ok ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}`}>
          {item.ok ? "PASS" : "FAIL"}
        </span>
      </div>
      <p className={`mt-2 text-xs ${isDark ? "text-[#b3b3b3]" : "text-[#555]"}`}>
        {item.summary || "No summary"}
      </p>
      <p className={`mt-1 text-[11px] ${isDark ? "text-[#8a8a8a]" : "text-[#777]"}`}>
        {item.ranAt ? new Date(item.ranAt).toLocaleString() : "Unknown run time"}
      </p>
      {item.serialTail ? (
        <pre className={`mt-3 max-h-28 overflow-auto rounded-lg border p-2 text-[11px] leading-relaxed ${isDark ? "border-white/10 bg-[#1f1f1f] text-[#d9d9d9]" : "border-black/10 bg-[#f7f7f7] text-[#222]"}`}>
          {item.serialTail}
        </pre>
      ) : null}
    </div>
  );
};

export default function WokwiProofLab({ projectId, projectSnapshot, onProjectUpdate }) {
  const { theme } = useThemeStore();
  const isDark = theme === "dark";

  const [savingPath, setSavingPath] = useState(false);
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [runningAction, setRunningAction] = useState("");

  const [localProjectPath, setLocalProjectPath] = useState(projectSnapshot?.wokwiProjectPath || "");
  const [diagramFile, setDiagramFile] = useState("diagram.json");
  const [sketchFile, setSketchFile] = useState("sketch.ino");
  const [fqbn, setFqbn] = useState("arduino:avr:uno");
  const [compileTimeoutMs, setCompileTimeoutMs] = useState(180000);
  const [scenarioPath, setScenarioPath] = useState("smoke.test.yaml");
  const [timeoutMs, setTimeoutMs] = useState(20000);
  const [expectText, setExpectText] = useState("");
  const [failText, setFailText] = useState("");
  const [serialTimeoutMs, setSerialTimeoutMs] = useState(12000);
  const [diagramText, setDiagramText] = useState("{\n  \"version\": 1,\n  \"author\": \"HardCode\",\n  \"editor\": \"wokwi\",\n  \"parts\": [],\n  \"connections\": []\n}\n");
  const [sketchText, setSketchText] = useState("void setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n  delay(500);\n}\n");
  const [diagramDirty, setDiagramDirty] = useState(false);
  const [sketchDirty, setSketchDirty] = useState(false);
  const [customChipName, setCustomChipName] = useState("battery");
  const [customChipPurpose, setCustomChipPurpose] = useState("9V battery source with stable output rails");

  const [evidence, setEvidence] = useState(null);
  const [lastResult, setLastResult] = useState(null);

  const [mcpSessionId, setMcpSessionId] = useState("");
  const [mcpSessions, setMcpSessions] = useState([]);
  const [sessionTools, setSessionTools] = useState([]);
  const [selectedTool, setSelectedTool] = useState("wokwi_get_status");
  const [toolArgsText, setToolArgsText] = useState("{}\n");
  const [draftRestored, setDraftRestored] = useState(false);

  useEffect(() => {
    setLocalProjectPath(projectSnapshot?.wokwiProjectPath || "");
  }, [projectSnapshot?.wokwiProjectPath]);

  useEffect(() => {
    if (!projectId) return;

    try {
      const raw = localStorage.getItem(getProofStorageKey(projectId));
      if (!raw) return;

      const parsed = JSON.parse(raw);

      if (typeof parsed?.localProjectPath === "string") setLocalProjectPath(parsed.localProjectPath);
      if (typeof parsed?.diagramFile === "string") setDiagramFile(parsed.diagramFile);
      if (typeof parsed?.sketchFile === "string") setSketchFile(parsed.sketchFile);
      if (typeof parsed?.fqbn === "string") setFqbn(parsed.fqbn);
      if (typeof parsed?.compileTimeoutMs === "number") setCompileTimeoutMs(parsed.compileTimeoutMs);
      if (typeof parsed?.scenarioPath === "string") setScenarioPath(parsed.scenarioPath);
      if (typeof parsed?.timeoutMs === "number") setTimeoutMs(parsed.timeoutMs);
      if (typeof parsed?.expectText === "string") setExpectText(parsed.expectText);
      if (typeof parsed?.failText === "string") setFailText(parsed.failText);
      if (typeof parsed?.serialTimeoutMs === "number") setSerialTimeoutMs(parsed.serialTimeoutMs);
      if (typeof parsed?.diagramText === "string") setDiagramText(parsed.diagramText);
      if (typeof parsed?.sketchText === "string") setSketchText(parsed.sketchText);
      if (typeof parsed?.mcpSessionId === "string") setMcpSessionId(parsed.mcpSessionId);
      if (typeof parsed?.selectedTool === "string") setSelectedTool(parsed.selectedTool);
      if (typeof parsed?.toolArgsText === "string") setToolArgsText(parsed.toolArgsText);

      setDraftRestored(true);
    } catch {
      // Ignore malformed local draft.
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;

    try {
      const payload = {
        localProjectPath,
        diagramFile,
        sketchFile,
        fqbn,
        compileTimeoutMs,
        scenarioPath,
        timeoutMs,
        expectText,
        failText,
        serialTimeoutMs,
        diagramText,
        sketchText,
        mcpSessionId,
        selectedTool,
        toolArgsText,
        updatedAt: Date.now()
      };

      localStorage.setItem(getProofStorageKey(projectId), JSON.stringify(payload));
    } catch {
      // localStorage may fail in strict browser modes.
    }
  }, [
    projectId,
    localProjectPath,
    diagramFile,
    sketchFile,
    fqbn,
    compileTimeoutMs,
    scenarioPath,
    timeoutMs,
    expectText,
    failText,
    serialTimeoutMs,
    diagramText,
    sketchText,
    mcpSessionId,
    selectedTool,
    toolArgsText
  ]);

  useEffect(() => {
    if (!projectId) return;

    const handleBeforeUnload = () => {
      try {
        const payload = {
          localProjectPath,
          diagramFile,
          sketchFile,
          fqbn,
          compileTimeoutMs,
          scenarioPath,
          timeoutMs,
          expectText,
          failText,
          serialTimeoutMs,
          diagramText,
          sketchText,
          mcpSessionId,
          selectedTool,
          toolArgsText,
          updatedAt: Date.now()
        };

        localStorage.setItem(getProofStorageKey(projectId), JSON.stringify(payload));
      } catch {
        // Best effort save before refresh/close.
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [
    projectId,
    localProjectPath,
    diagramFile,
    sketchFile,
    fqbn,
    compileTimeoutMs,
    scenarioPath,
    timeoutMs,
    expectText,
    failText,
    serialTimeoutMs,
    diagramText,
    sketchText,
    mcpSessionId,
    selectedTool,
    toolArgsText
  ]);

  const baseConfig = useMemo(() => ({ withCredentials: true }), []);

  const refreshEvidence = async () => {
    if (!projectId) return;

    try {
      setLoadingEvidence(true);
      const res = await axios.get(
        `http://localhost:5000/api/wokwi/evidence/${projectId}`,
        baseConfig
      );

      setEvidence(res.data?.evidence || null);
      if (!localProjectPath && res.data?.wokwiProjectPath) {
        setLocalProjectPath(res.data.wokwiProjectPath || "");
      }
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to load Wokwi evidence");
    } finally {
      setLoadingEvidence(false);
    }
  };

  const refreshSessions = async () => {
    try {
      const res = await axios.get("http://localhost:5000/api/wokwi/mcp/sessions", baseConfig);
      setMcpSessions(res.data?.sessions || []);
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to list MCP sessions");
    }
  };

  useEffect(() => {
    refreshEvidence();
    refreshSessions();
  }, [projectId]);

  const loadLocalFiles = async () => {
    if (!projectId) return;

    try {
      setRunningAction("Load local files");
      const res = await axios.post(
        "http://localhost:5000/api/wokwi/local/files",
        {
          projectId,
          projectPath: localProjectPath.trim(),
          diagramFile: diagramFile.trim() || "diagram.json",
          sketchFile: sketchFile.trim() || "sketch.ino"
        },
        baseConfig
      );

      if (typeof res.data?.diagramJson === "string" && res.data.diagramJson) {
        setDiagramText(res.data.diagramJson);
        setDiagramDirty(false);
      }

      if (typeof res.data?.sketchCode === "string" && res.data.sketchCode) {
        setSketchText(res.data.sketchCode);
        setSketchDirty(false);
      }

      setLastResult(res.data);
      toast.success("Loaded local diagram/sketch");
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to load local files");
      setLastResult(err?.response?.data || { error: "Failed to load local files" });
    } finally {
      setRunningAction("");
    }
  };

  const syncCompileRun = async () => {
    if (!projectId) return;

    let diagramPayload = diagramText;
    let sketchPayload = sketchText;

    // Use latest on-disk files unless user explicitly edited that textarea.
    if (!diagramDirty || !sketchDirty) {
      try {
        const localRes = await axios.post(
          "http://localhost:5000/api/wokwi/local/files",
          {
            projectId,
            projectPath: localProjectPath.trim(),
            diagramFile: diagramFile.trim() || "diagram.json",
            sketchFile: sketchFile.trim() || "sketch.ino"
          },
          baseConfig
        );

        if (!diagramDirty && typeof localRes.data?.diagramJson === "string" && localRes.data.diagramJson) {
          diagramPayload = localRes.data.diagramJson;
          setDiagramText(localRes.data.diagramJson);
          setDiagramDirty(false);
        }

        if (!sketchDirty && typeof localRes.data?.sketchCode === "string" && localRes.data.sketchCode) {
          sketchPayload = localRes.data.sketchCode;
          setSketchText(localRes.data.sketchCode);
          setSketchDirty(false);
        }
      } catch {
        // Best effort sync from disk; continue with in-memory payload.
      }
    }

    const parsedDiagram = parseJsonSafe(diagramPayload, null);
    if (!parsedDiagram) {
      toast.error("diagram.json is not valid JSON");
      return;
    }

    try {
      setRunningAction("Sync+Compile+Run");
      const res = await axios.post(
        "http://localhost:5000/api/wokwi/local/sync-run",
        {
          projectId,
          projectPath: localProjectPath.trim(),
          diagramFile: diagramFile.trim() || "diagram.json",
          sketchFile: sketchFile.trim() || "sketch.ino",
          diagramJson: parsedDiagram,
          sketchCode: sketchPayload,
          fqbn: fqbn.trim() || "arduino:avr:uno",
          timeoutMs: Number(timeoutMs) || 20000,
          compileTimeoutMs: Number(compileTimeoutMs) || 180000,
          expectText: expectText.trim(),
          failText: failText.trim()
        },
        baseConfig
      );

      setLastResult(res.data);
      toast.success("Sync+Compile+Run completed");
      await refreshEvidence();
    } catch (err) {
      const responseData = err?.response?.data || {};
      const compileSummary = responseData?.compileResult?.summary || "";
      const runSummary = responseData?.runResult?.summary || "";
      const stage = responseData?.stage ? `stage=${responseData.stage}` : "";
      const message =
        responseData?.error ||
        compileSummary ||
        runSummary ||
        stage ||
        "Sync+Compile+Run failed";
      toast.error(message);
      const hasPayload = responseData && Object.keys(responseData).length > 0;
      setLastResult(
        hasPayload
          ? responseData
          : {
              error: message,
              stage: "network-or-empty-response",
              axiosMessage: err?.message || "",
              axiosCode: err?.code || "",
              requestUrl: "http://localhost:5000/api/wokwi/local/sync-run"
            }
      );
    } finally {
      setRunningAction("");
    }
  };

  const saveLocalPath = async () => {
    if (!projectId) return;

    try {
      setSavingPath(true);
      const res = await axios.put(
        `http://localhost:5000/api/project/${projectId}`,
        { wokwiProjectPath: localProjectPath.trim() },
        baseConfig
      );
      onProjectUpdate?.(res.data);
      toast.success("Wokwi local path saved");
      await refreshEvidence();
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to save local path");
    } finally {
      setSavingPath(false);
    }
  };

  const runAction = async (label, request) => {
    try {
      setRunningAction(label);
      const res = await request();
      setLastResult(res.data);
      toast.success(`${label} completed`);
      await refreshEvidence();
    } catch (err) {
      const message = err?.response?.data?.error || `${label} failed`;
      toast.error(message);
      setLastResult({ error: message, details: err?.response?.data || null });
    } finally {
      setRunningAction("");
    }
  };

  const runLint = () => runAction("Lint", () =>
    axios.post(
      "http://localhost:5000/api/wokwi/lint",
      {
        projectId,
        projectPath: localProjectPath.trim(),
        diagramFile: diagramFile.trim() || "diagram.json",
        timeoutMs: Number(timeoutMs) || 20000
      },
      baseConfig
    )
  );

  const runProject = () => runAction("Run", () =>
    axios.post(
      "http://localhost:5000/api/wokwi/run",
      {
        projectId,
        projectPath: localProjectPath.trim(),
        timeoutMs: Number(timeoutMs) || 20000,
        expectText: expectText.trim(),
        failText: failText.trim()
      },
      baseConfig
    )
  );

  const runScenario = () => runAction("Scenario", () =>
    axios.post(
      "http://localhost:5000/api/wokwi/scenario",
      {
        projectId,
        projectPath: localProjectPath.trim(),
        scenarioPath: scenarioPath.trim(),
        timeoutMs: Number(timeoutMs) || 20000,
        expectText: expectText.trim(),
        failText: failText.trim()
      },
      baseConfig
    )
  );

  const captureSerial = () => runAction("Serial capture", () =>
    axios.post(
      "http://localhost:5000/api/wokwi/serial/capture",
      {
        projectId,
        projectPath: localProjectPath.trim(),
        timeoutMs: Number(serialTimeoutMs) || 12000
      },
      baseConfig
    )
  );

  const startMcpSession = async () => {
    try {
      setRunningAction("Start MCP");
      const res = await axios.post(
        "http://localhost:5000/api/wokwi/mcp/session/start",
        {
          projectId,
          projectPath: localProjectPath.trim(),
          quiet: true
        },
        baseConfig
      );

      const session = res.data?.session;
      if (session?.sessionId) {
        setMcpSessionId(session.sessionId);
      }
      setSessionTools(session?.availableTools || []);
      setLastResult(res.data);
      toast.success("MCP session started");
      await refreshSessions();
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to start MCP session");
    } finally {
      setRunningAction("");
    }
  };

  const callMcpTool = async () => {
    if (!mcpSessionId.trim()) {
      toast.error("Session ID is required");
      return;
    }

    const args = parseJsonSafe(toolArgsText, {});

    try {
      setRunningAction("MCP call");
      const res = await axios.post(
        `http://localhost:5000/api/wokwi/mcp/session/${mcpSessionId.trim()}/tool`,
        { tool: selectedTool, argumentsInput: args },
        baseConfig
      );
      setLastResult(res.data);
      toast.success("MCP tool call completed");
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed MCP tool call");
      setLastResult(err?.response?.data || { error: "MCP tool call failed" });
    } finally {
      setRunningAction("");
    }
  };

  const stopMcpSession = async () => {
    if (!mcpSessionId.trim()) {
      toast.error("Session ID is required");
      return;
    }

    try {
      setRunningAction("Stop MCP");
      const res = await axios.post(
        `http://localhost:5000/api/wokwi/mcp/session/${mcpSessionId.trim()}/stop`,
        {},
        baseConfig
      );
      setLastResult(res.data);
      toast.success("MCP session stopped");
      await refreshSessions();
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to stop MCP session");
    } finally {
      setRunningAction("");
    }
  };

  const generateCustomChip = async () => {
    if (!projectId) return;

    try {
      setRunningAction("Generate custom chip");
      const res = await axios.post(
        "http://localhost:5000/api/wokwi/custom-chip/generate",
        {
          projectId,
          chipName: customChipName,
          purpose: customChipPurpose,
          userPrompt: customChipPurpose
        },
        baseConfig
      );

      setLastResult(res.data);
      toast.success("Custom chip template generated");
    } catch (err) {
      const message = err?.response?.data?.error || "Failed to generate custom chip template";
      toast.error(message);
      setLastResult(err?.response?.data || { error: message });
    } finally {
      setRunningAction("");
    }
  };

  return (
    <div className={`h-full overflow-y-auto px-5 py-5 ${isDark ? "bg-[#222]" : "bg-[#fafafa]"}`}>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className={`rounded-xl border p-4 ${isDark ? "border-white/10 bg-[#2a2a2a]" : "border-black/10 bg-white"}`}>
          <p className="text-sm font-semibold">Proof Controls</p>
          <p className={`mt-1 text-xs ${isDark ? "text-[#a3a3a3]" : "text-[#666]"}`}>
            Run real Wokwi commands live in front of judges.
          </p>
          {draftRestored && (
            <p className={`mt-1 text-xs font-semibold ${isDark ? "text-green-400" : "text-green-700"}`}>
              Proof Lab draft restored after refresh/close.
            </p>
          )}

          <label className="mt-4 block text-xs font-semibold">Local Wokwi project path</label>
          <input
            value={localProjectPath}
            onChange={(e) => setLocalProjectPath(e.target.value)}
            placeholder="C:/.../backend/wokwi-smoke"
            className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={saveLocalPath}
              disabled={savingPath}
              className={`rounded-lg px-3 py-2 text-xs font-semibold ${isDark ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]" : "bg-black text-white hover:bg-[#222]"} ${savingPath ? "opacity-60" : ""}`}
            >
              {savingPath ? "Saving..." : "Save Path"}
            </button>
            <button
              onClick={refreshEvidence}
              disabled={loadingEvidence}
              className={`rounded-lg border px-3 py-2 text-xs font-semibold ${isDark ? "border-white/10 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}
            >
              Refresh Evidence
            </button>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold">Diagram file</label>
              <input
                value={diagramFile}
                onChange={(e) => setDiagramFile(e.target.value)}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold">Sketch file</label>
              <input
                value={sketchFile}
                onChange={(e) => setSketchFile(e.target.value)}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold">Board FQBN</label>
              <input
                value={fqbn}
                onChange={(e) => setFqbn(e.target.value)}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold">Scenario path</label>
              <input
                value={scenarioPath}
                onChange={(e) => setScenarioPath(e.target.value)}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold">Timeout (ms)</label>
              <input
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value || 0))}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold">Compile timeout (ms)</label>
              <input
                type="number"
                value={compileTimeoutMs}
                onChange={(e) => setCompileTimeoutMs(Number(e.target.value || 0))}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold">Serial timeout (ms)</label>
              <input
                type="number"
                value={serialTimeoutMs}
                onChange={(e) => setSerialTimeoutMs(Number(e.target.value || 0))}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
              />
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-semibold">Expect text</label>
              <input
                value={expectText}
                onChange={(e) => setExpectText(e.target.value)}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold">Fail text</label>
              <input
                value={failText}
                onChange={(e) => setFailText(e.target.value)}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={runLint} disabled={Boolean(runningAction)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${isDark ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]" : "bg-black text-white hover:bg-[#222]"}`}>
              Lint
            </button>
            <button onClick={runProject} disabled={Boolean(runningAction)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${isDark ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]" : "bg-black text-white hover:bg-[#222]"}`}>
              Run
            </button>
            <button onClick={runScenario} disabled={Boolean(runningAction)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${isDark ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]" : "bg-black text-white hover:bg-[#222]"}`}>
              Scenario
            </button>
            <button onClick={captureSerial} disabled={Boolean(runningAction)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${isDark ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]" : "bg-black text-white hover:bg-[#222]"}`}>
              Serial Capture
            </button>
          </div>

          <div className="mt-5 rounded-lg border p-3">
            <p className="text-xs font-semibold">Local File Sync</p>
            <p className={`mt-1 text-[11px] ${isDark ? "text-[#9a9a9a]" : "text-[#666]"}`}>
              Paste diagram.json + sketch.ino, then one click writes files locally, compiles, and runs Wokwi.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={loadLocalFiles}
                disabled={Boolean(runningAction)}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold ${isDark ? "border-white/10 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}
              >
                Load From Local Path
              </button>
              <button
                onClick={syncCompileRun}
                disabled={Boolean(runningAction)}
                className={`rounded-lg px-3 py-2 text-xs font-semibold ${isDark ? "bg-green-700 hover:bg-green-600" : "bg-green-600 text-white hover:bg-green-700"}`}
              >
                Sync + Compile + Run
              </button>
            </div>

            <label className="mt-3 block text-xs font-semibold">diagram.json</label>
            <textarea
              value={diagramText}
              onChange={(e) => {
                setDiagramText(e.target.value);
                setDiagramDirty(true);
              }}
              rows={8}
              className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs ${isDark ? "border-white/10 bg-[#1f1f1f] text-[#ddd]" : "border-black/10 bg-[#f7f7f7] text-[#222]"}`}
            />

            <label className="mt-3 block text-xs font-semibold">sketch.ino</label>
            <textarea
              value={sketchText}
              onChange={(e) => {
                setSketchText(e.target.value);
                setSketchDirty(true);
              }}
              rows={8}
              className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs ${isDark ? "border-white/10 bg-[#1f1f1f] text-[#ddd]" : "border-black/10 bg-[#f7f7f7] text-[#222]"}`}
            />
          </div>

          <div className="mt-5 rounded-lg border p-3">
            <p className="text-xs font-semibold">AI Custom Component Designer</p>
            <p className={`mt-1 text-[11px] ${isDark ? "text-[#9a9a9a]" : "text-[#666]"}`}>
              Generates strict chip blueprint output: .chip.json, .chip.c, diagram part snippet, and wokwi.toml chip entry.
            </p>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold">Chip codename</label>
                <input
                  value={customChipName}
                  onChange={(e) => setCustomChipName(e.target.value)}
                  placeholder="battery"
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold">Purpose</label>
                <input
                  value={customChipPurpose}
                  onChange={(e) => setCustomChipPurpose(e.target.value)}
                  placeholder="9V battery source"
                  className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
                />
              </div>
            </div>

            <button
              onClick={generateCustomChip}
              disabled={Boolean(runningAction) || !customChipName.trim()}
              className={`mt-3 rounded-lg px-3 py-2 text-xs font-semibold ${isDark ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]" : "bg-black text-white hover:bg-[#222]"} ${(!customChipName.trim() || Boolean(runningAction)) ? "opacity-60" : ""}`}
            >
              Generate Custom Chip Blueprint
            </button>
          </div>

          <p className={`mt-3 text-xs ${isDark ? "text-[#999]" : "text-[#666]"}`}>
            {runningAction ? `${runningAction} in progress...` : "Idle"}
          </p>
        </div>

        <div className={`rounded-xl border p-4 ${isDark ? "border-white/10 bg-[#2a2a2a]" : "border-black/10 bg-white"}`}>
          <p className="text-sm font-semibold">Interactive MCP Console</p>
          <p className={`mt-1 text-xs ${isDark ? "text-[#a3a3a3]" : "text-[#666]"}`}>
            Step-by-step control for start, status, serial, pin read, controls, screenshot, and VCD.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button onClick={startMcpSession} disabled={Boolean(runningAction)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${isDark ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]" : "bg-black text-white hover:bg-[#222]"}`}>
              Start MCP Session
            </button>
            <button onClick={refreshSessions} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${isDark ? "border-white/10 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}>
              Refresh Sessions
            </button>
            <button onClick={stopMcpSession} disabled={Boolean(runningAction)} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${isDark ? "border-red-500/30 text-red-300 hover:bg-red-500/10" : "border-red-200 text-red-600 hover:bg-red-50"}`}>
              Stop Session
            </button>
          </div>

          <label className="mt-4 block text-xs font-semibold">Session ID</label>
          <input
            value={mcpSessionId}
            onChange={(e) => setMcpSessionId(e.target.value)}
            placeholder="paste session id"
            className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
          />

          {mcpSessions.length > 0 ? (
            <div className={`mt-2 max-h-24 overflow-auto rounded-lg border p-2 text-[11px] ${isDark ? "border-white/10 bg-[#1f1f1f] text-[#ccc]" : "border-black/10 bg-[#f7f7f7] text-[#333]"}`}>
              {mcpSessions.map((session) => (
                <button
                  key={session.sessionId}
                  onClick={() => setMcpSessionId(session.sessionId)}
                  className="mb-1 block w-full rounded px-2 py-1 text-left hover:bg-black/10"
                >
                  {session.sessionId} | {session.projectPath}
                </button>
              ))}
            </div>
          ) : null}

          <label className="mt-4 block text-xs font-semibold">Tool</label>
          <select
            value={selectedTool}
            onChange={(e) => setSelectedTool(e.target.value)}
            className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f7f7f7]"}`}
          >
            {sessionTools.length > 0 ? sessionTools.map((tool) => (
              <option key={tool.name} value={tool.name}>{tool.name}</option>
            )) : (
              <>
                <option value="wokwi_get_status">wokwi_get_status</option>
                <option value="wokwi_start_simulation">wokwi_start_simulation</option>
                <option value="wokwi_read_serial">wokwi_read_serial</option>
                <option value="wokwi_write_serial">wokwi_write_serial</option>
                <option value="wokwi_read_pin">wokwi_read_pin</option>
                <option value="wokwi_set_control">wokwi_set_control</option>
                <option value="wokwi_take_screenshot">wokwi_take_screenshot</option>
                <option value="wokwi_export_vcd">wokwi_export_vcd</option>
              </>
            )}
          </select>

          <label className="mt-4 block text-xs font-semibold">Tool args JSON</label>
          <textarea
            value={toolArgsText}
            onChange={(e) => setToolArgsText(e.target.value)}
            rows={5}
            className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs ${isDark ? "border-white/10 bg-[#1f1f1f] text-[#ddd]" : "border-black/10 bg-[#f7f7f7] text-[#222]"}`}
          />

          <button onClick={callMcpTool} disabled={Boolean(runningAction)} className={`mt-3 rounded-lg px-3 py-2 text-xs font-semibold ${isDark ? "bg-[#3a3a3a] hover:bg-[#4a4a4a]" : "bg-black text-white hover:bg-[#222]"}`}>
            Call MCP Tool
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <EvidenceCard title="Latest Lint" item={evidence?.lastLint} isDark={isDark} />
        <EvidenceCard title="Latest Run" item={evidence?.lastRun} isDark={isDark} />
        <EvidenceCard title="Latest Scenario" item={evidence?.lastScenario} isDark={isDark} />
        <EvidenceCard title="Latest Serial Capture" item={evidence?.lastSerialCapture} isDark={isDark} />
      </div>

      <div className={`mt-4 rounded-xl border p-4 ${isDark ? "border-white/10 bg-[#2a2a2a]" : "border-black/10 bg-white"}`}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">Live API Output</p>
          <button
            onClick={() => setLastResult(null)}
            className={`rounded-lg border px-3 py-1 text-xs font-semibold ${isDark ? "border-white/10 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}
          >
            Clear
          </button>
        </div>
        <pre className={`mt-3 max-h-80 overflow-auto rounded-lg border p-3 text-[12px] leading-relaxed ${isDark ? "border-white/10 bg-[#1f1f1f] text-[#ddd]" : "border-black/10 bg-[#f7f7f7] text-[#222]"}`}>
          {lastResult ? pretty(lastResult) : "No API result yet."}
        </pre>
      </div>
    </div>
  );
}
