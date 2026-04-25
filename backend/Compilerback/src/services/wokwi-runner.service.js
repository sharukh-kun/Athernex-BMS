import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, unlink, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchWokwiDiagram } from "../lib/wokwi-context.js";

const MAX_TAIL = 6000;

const trimTail = (value = "", max = MAX_TAIL) => {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
};

const resolveWokwiCliPath = () => {
  if (process.env.WOKWI_CLI_PATH?.trim()) {
    return process.env.WOKWI_CLI_PATH.trim();
  }

  const home = process.env.USERPROFILE || process.env.HOME || "";
  const windowsDefault = path.join(home, ".wokwi", "bin", "wokwi-cli.exe");
  const unixDefault = path.join(home, ".wokwi", "bin", "wokwi-cli");

  if (existsSync(windowsDefault)) return windowsDefault;
  if (existsSync(unixDefault)) return unixDefault;

  return "wokwi-cli";
};

const runCli = ({ args, cwd, timeoutMs = 30000, env = process.env }) => {
  return new Promise((resolve) => {
    const cliPath = resolveWokwiCliPath();
    const start = Date.now();

    const child = spawn(cliPath, args, {
      cwd,
      env,
      shell: process.platform === "win32"
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -1,
        timedOut,
        durationMs: Date.now() - start,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        command: `${cliPath} ${args.join(" ")}`
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code ?? -1,
        timedOut,
        durationMs: Date.now() - start,
        stdout,
        stderr,
        command: `${cliPath} ${args.join(" ")}`
      });
    });
  });
};

const serialOnly = (stdout = "") => {
  return String(stdout)
    .split(/\r?\n/)
    .filter((line) => !/^Wokwi CLI|^Connected to Wokwi|^Starting simulation|^Simulation finished|^Simulation timed out/i.test(line.trim()))
    .join("\n")
    .trim();
};

const normalizeResult = (result, metadata = {}) => {
  const serial = serialOnly(result.stdout);
  const summaryParts = [];

  if (result.timedOut) {
    summaryParts.push("Simulation timed out");
  }

  summaryParts.push(result.ok ? "Command succeeded" : "Command failed");
  if (typeof result.exitCode === "number") {
    summaryParts.push(`exitCode=${result.exitCode}`);
  }

  return {
    ok: result.ok,
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutTail: trimTail(result.stdout),
    stderrTail: trimTail(result.stderr),
    serialTail: trimTail(serial),
    summary: summaryParts.join(" | "),
    metadata: {
      ...metadata,
      timedOut: result.timedOut
    },
    ranAt: new Date()
  };
};

const createTempProjectFromWokwiUrl = async (wokwiUrl) => {
  const fetched = await fetchWokwiDiagram(wokwiUrl);
  if (!fetched.ok) {
    throw new Error(fetched.reason || "Unable to fetch Wokwi diagram");
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wokwi-lint-"));
  const diagramPath = path.join(tempDir, "diagram.json");
  await writeFile(diagramPath, JSON.stringify(fetched.diagram, null, 2), "utf8");

  return {
    tempDir,
    diagramPath,
    projectId: fetched.projectId,
    source: fetched.source
  };
};

const ensurePathExists = (label, value) => {
  if (!value || !existsSync(value)) {
    throw new Error(`${label} does not exist: ${value || "(empty)"}`);
  }
};

export const lintWokwiProject = async ({ projectPath = "", diagramFile = "diagram.json", wokwiUrl = "", timeoutMs = 20000 }) => {
  let tempProject = null;

  try {
    let targetPath = projectPath;

    if (!targetPath) {
      if (!wokwiUrl) {
        throw new Error("Either projectPath or wokwiUrl is required for lint");
      }

      tempProject = await createTempProjectFromWokwiUrl(wokwiUrl);
      targetPath = tempProject.tempDir;
      diagramFile = "diagram.json";
    }

    ensurePathExists("Project path", targetPath);

    const cliResult = await runCli({
      args: ["lint", targetPath, "--diagram-file", diagramFile, "--quiet"],
      cwd: targetPath,
      timeoutMs
    });

    return normalizeResult(cliResult, {
      operation: "lint",
      projectPath: targetPath,
      diagramFile,
      wokwiUrl,
      fetchedProjectId: tempProject?.projectId || "",
      fetchedSource: tempProject?.source || ""
    });
  } finally {
    if (tempProject?.diagramPath) {
      await unlink(tempProject.diagramPath).catch(() => {});
    }
  }
};

const runWithCommonArgs = async ({
  operation,
  projectPath,
  timeoutMs = 30000,
  expectText = "",
  failText = "",
  scenarioPath = "",
  serialLogFile = "",
  screenshotPart = "",
  screenshotTime,
  screenshotFile = "",
  vcdFile = ""
}) => {
  ensurePathExists("Project path", projectPath);

  if (scenarioPath) {
    ensurePathExists("Scenario file", path.isAbsolute(scenarioPath) ? scenarioPath : path.join(projectPath, scenarioPath));
  }

  const args = [projectPath, "--timeout", String(timeoutMs)];

  if (expectText) args.push("--expect-text", expectText);
  if (failText) args.push("--fail-text", failText);
  if (scenarioPath) args.push("--scenario", scenarioPath);
  if (serialLogFile) args.push("--serial-log-file", serialLogFile);
  if (screenshotPart) args.push("--screenshot-part", screenshotPart);
  if (typeof screenshotTime === "number") args.push("--screenshot-time", String(screenshotTime));
  if (screenshotFile) args.push("--screenshot-file", screenshotFile);
  if (vcdFile) args.push("--vcd-file", vcdFile);

  const cliResult = await runCli({ args, cwd: projectPath, timeoutMs: timeoutMs + 15000 });
  return normalizeResult(cliResult, {
    operation,
    projectPath,
    timeoutMs,
    expectText,
    failText,
    scenarioPath,
    serialLogFile,
    screenshotPart,
    screenshotTime: typeof screenshotTime === "number" ? screenshotTime : null,
    screenshotFile,
    vcdFile
  });
};

export const runWokwiProject = async (params) => {
  return runWithCommonArgs({
    ...params,
    operation: "run"
  });
};

export const runWokwiScenario = async (params) => {
  return runWithCommonArgs({
    ...params,
    operation: "scenario"
  });
};

export const captureWokwiSerial = async ({ projectPath, timeoutMs = 12000 }) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "wokwi-serial-"));
  const serialLogFile = path.join(tempDir, "serial.log");

  const result = await runWithCommonArgs({
    operation: "serial-capture",
    projectPath,
    timeoutMs,
    serialLogFile
  });

  let serialLogTail = "";
  try {
    const content = await readFile(serialLogFile, "utf8");
    serialLogTail = trimTail(content);
  } catch {
    serialLogTail = result.serialTail;
  }

  return {
    ...result,
    serialTail: serialLogTail,
    metadata: {
      ...result.metadata,
      serialLogFile
    }
  };
};

export const buildWokwiEvidenceText = (project) => {
  const evidence = project?.wokwiEvidence || {};
  const lines = [];

  const addBlock = (name, value) => {
    if (!value) return;

    lines.push(`${name}:`);
    lines.push(`- ok: ${value.ok ? "yes" : "no"}`);
    lines.push(`- summary: ${value.summary || "n/a"}`);

    if (value.metadata?.operation) {
      lines.push(`- operation: ${value.metadata.operation}`);
    }

    if (value.metadata?.timedOut === true) {
      lines.push("- timedOut: true");
    }

    if (value.serialTail) {
      lines.push(`- serialTail:\n${trimTail(value.serialTail, 1200)}`);
    }

    if (value.stderrTail) {
      lines.push(`- stderrTail:\n${trimTail(value.stderrTail, 900)}`);
    }
  };

  addBlock("Latest lint", evidence.lastLint);
  addBlock("Latest run", evidence.lastRun);
  addBlock("Latest scenario", evidence.lastScenario);
  addBlock("Latest serial capture", evidence.lastSerialCapture);

  if (lines.length === 0) {
    return "No runner evidence available.";
  }

  return lines.join("\n");
};
