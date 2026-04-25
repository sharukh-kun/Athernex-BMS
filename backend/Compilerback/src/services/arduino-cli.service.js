import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";

const MAX_TAIL = 6000;
const WINDOWS_POWERSHELL =
  process.env.PWSH_PATH?.trim()
  || "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

export const trimTail = (value = "", max = MAX_TAIL) => {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
};

const stripComments = (value = "") => {
  const text = String(value || "");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
};

const repairBrokenStringLiterals = (value = "") => {
  let sketch = String(value || "");
  if (!sketch) return sketch;

  sketch = sketch.replace(/\r?\n[ \t]*"\s*\);/g, '");');
  sketch = sketch.replace(/\r?\n[ \t]*"\s*([,;])/g, '"$1');

  return sketch;
};

const ensureStatusLedDeclaration = (value = "") => {
  let sketch = repairBrokenStringLiterals(value);
  if (!sketch.trim()) return sketch;

  let codeOnly = stripComments(sketch);
  if (/\bSTATUS_LED\b/.test(codeOnly)) {
    const hasStatusLedDeclaration =
      /^[ \t]*const\s+(?:unsigned\s+)?(?:int|uint8_t|byte|long)\s+STATUS_LED\s*=/m.test(codeOnly)
      || /^[ \t]*#define\s+STATUS_LED\b/m.test(codeOnly);

    if (!hasStatusLedDeclaration) {
      sketch = `const int STATUS_LED = LED_BUILTIN;\n${sketch}`;
      codeOnly = stripComments(sketch);
    }
  }

  if (!/\bvoid\s+setup\s*\(\s*\)\s*\{/.test(codeOnly)) {
    sketch = `void setup() {\n}\n\n${sketch}`;
    codeOnly = stripComments(sketch);
  }

  if (!/\bvoid\s+loop\s*\(\s*\)\s*\{/.test(codeOnly)) {
    sketch = `${sketch}\n\nvoid loop() {\n  delay(10);\n}\n`;
  }

  return sketch;
};

export const resolveArduinoCliPath = () => {
  if (process.env.ARDUINO_CLI_PATH?.trim()) {
    return process.env.ARDUINO_CLI_PATH.trim();
  }

  const home = process.env.USERPROFILE || process.env.HOME || "";
  const windowsLocal = path.join(home, ".arduino-cli", "bin", "arduino-cli.exe");
  const unixLocal = path.join(home, ".arduino-cli", "bin", "arduino-cli");

  if (existsSync(windowsLocal)) return windowsLocal;
  if (existsSync(unixLocal)) return unixLocal;

  return "arduino-cli";
};

export const runCommand = ({ command, args, cwd, timeoutMs = 120000, env = process.env }) => {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      // Run executables directly so Windows paths like
      // "C:\\Program Files\\Arduino CLI\\arduino-cli.exe" do not break.
      shell: false
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
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        command: `${command} ${args.join(" ")}`
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code ?? -1,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        command: `${command} ${args.join(" ")}`
      });
    });
  });
};

const normalizePortAddress = (value = "") => String(value || "").trim().toUpperCase();

const inferBoardFromText = (value = "") => {
  const text = String(value || "").toLowerCase();

  if (!text) {
    return { boardName: "", recommendedFqbn: "", confidence: "low" };
  }

  if (text.includes("arduino uno")) {
    return { boardName: "Arduino Uno", recommendedFqbn: "arduino:avr:uno", confidence: "high" };
  }

  if (text.includes("arduino nano")) {
    return { boardName: "Arduino Nano", recommendedFqbn: "arduino:avr:nano", confidence: "high" };
  }

  if (text.includes("wch") || text.includes("ch340") || text.includes("usb serial")) {
    return { boardName: "USB serial board", recommendedFqbn: "", confidence: "medium" };
  }

  return { boardName: "", recommendedFqbn: "", confidence: "low" };
};

const extractComAddress = (value = "") => {
  const match = String(value || "").match(/\((COM\d+)\)/i) || String(value || "").match(/\b(COM\d+)\b/i);
  return match ? normalizePortAddress(match[1]) : "";
};

const parseWindowsPorts = (stdout = "") => {
  const cleaned = String(stdout || "").trim();
  if (!cleaned) return [];

  try {
    const parsed = JSON.parse(cleaned);
    const entries = Array.isArray(parsed) ? parsed : [parsed];

    return entries
      .map((entry) => {
        const friendlyName = String(entry?.Name || entry?.FriendlyName || "").trim();
        const address = extractComAddress(friendlyName);
        if (!address) return null;

        const inferred = inferBoardFromText(`${friendlyName} ${entry?.PNPDeviceID || ""}`);
        return {
          address,
          label: friendlyName || address,
          boardName: inferred.boardName,
          recommendedFqbn: inferred.recommendedFqbn,
          confidence: inferred.confidence,
          properties: {
            pnpDeviceId: String(entry?.PNPDeviceID || "")
          },
          source: "windows"
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const mergePorts = (cliPorts = [], windowsPorts = []) => {
  const merged = new Map();

  const upsert = (port = {}) => {
    const address = normalizePortAddress(port.address || port.name);
    if (!address) return;

    const existing = merged.get(address) || {
      address,
      protocol: "serial",
      label: address,
      boardName: "",
      recommendedFqbn: "",
      confidence: "low",
      properties: {},
      source: port.source || "cli"
    };

    const next = {
      ...existing,
      ...port,
      address,
      protocol: port.protocol || existing.protocol || "serial",
      label: port.label || existing.label || address,
      boardName: port.boardName || existing.boardName || "",
      recommendedFqbn: port.recommendedFqbn || existing.recommendedFqbn || "",
      confidence: port.confidence || existing.confidence || "low",
      properties: {
        ...(existing.properties || {}),
        ...(port.properties || {})
      }
    };

    if (!next.boardName || !next.recommendedFqbn) {
      const inferred = inferBoardFromText(`${next.label} ${next.boardName} ${next.properties?.pnpDeviceId || ""}`);
      next.boardName = next.boardName || inferred.boardName;
      next.recommendedFqbn = next.recommendedFqbn || inferred.recommendedFqbn;
      next.confidence = next.confidence === "high" ? "high" : inferred.confidence;
    }

    merged.set(address, next);
  };

  cliPorts.forEach(upsert);
  windowsPorts.forEach(upsert);

  return [...merged.values()].sort((a, b) => a.address.localeCompare(b.address));
};

const parsePortList = (stdout) => {
  const ports = [];
  try {
    const json = JSON.parse(stdout);
    const entries = Array.isArray(json) ? json : [json];

    const pushPort = (port) => {
      if (!port?.address && !port?.name) return;
      const matchingBoard = Array.isArray(port?.matching_boards) ? port.matching_boards[0] : null;
      const inferred = inferBoardFromText(`${port?.label || ""} ${matchingBoard?.name || ""} ${matchingBoard?.fqbn || ""}`);
      ports.push({
        address: port.address || port.name,
        protocol: port.protocol || "serial",
        label: port.label || port.address || port.name,
        boardName: matchingBoard?.name || inferred.boardName,
        recommendedFqbn: matchingBoard?.fqbn || inferred.recommendedFqbn,
        confidence: matchingBoard?.fqbn ? "high" : inferred.confidence,
        properties: port.properties || {},
        source: "cli"
      });
    };

    for (const entry of entries) {
      // Format A (legacy): { ports: [...] }
      const directPorts = Array.isArray(entry?.ports) ? entry.ports : [];
      for (const port of directPorts) pushPort(port);

      // Format B (arduino-cli current): { detected_ports: [{ port: {...} }] }
      const detectedPorts = Array.isArray(entry?.detected_ports) ? entry.detected_ports : [];
      for (const item of detectedPorts) {
        if (item?.port) {
          pushPort({
            ...item.port,
            matching_boards: item.matching_boards
          });
        }
      }
    }
  } catch {
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^(Port|----)/i.test(line));

    for (const raw of lines) {
      ports.push({ address: raw, label: raw, protocol: "serial", properties: {} });
    }
  }

  return ports;
};

const listWindowsPorts = async ({ timeoutMs = 8000 } = {}) => {
  const script = "$ports = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'COM[0-9]+' } | Select-Object Name,PNPDeviceID; $ports | ConvertTo-Json -Compress";
  const result = await runCommand({
    command: existsSync(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : "powershell.exe",
    args: ["-NoProfile", "-Command", script],
    timeoutMs
  });

  return {
    ...result,
    ports: parseWindowsPorts(result.stdout)
  };
};

export const listArduinoPorts = async ({ timeoutMs = 15000 } = {}) => {
  const arduinoCliPath = resolveArduinoCliPath();
  const cliResult = await runCommand({
    command: arduinoCliPath,
    args: ["board", "list", "--format", "json"],
    timeoutMs
  });

  const cliPorts = parsePortList(cliResult.stdout || cliResult.stderr || "");
  const windowsResult = process.platform === "win32"
    ? await listWindowsPorts({ timeoutMs: Math.min(timeoutMs, 8000) })
    : { ok: false, stdout: "", stderr: "", ports: [] };
  const ports = mergePorts(cliPorts, windowsResult.ports || []);

  return {
    ok: cliResult.ok || windowsResult.ok || ports.length > 0,
    command: [cliResult.command, windowsResult.command].filter(Boolean).join(" | "),
    exitCode: cliResult.exitCode,
    durationMs: Math.max(cliResult.durationMs || 0, windowsResult.durationMs || 0),
    stdout: [cliResult.stdout, windowsResult.stdout].filter(Boolean).join("\n"),
    stderr: [cliResult.stderr, windowsResult.stderr].filter(Boolean).join("\n"),
    ports
  };
};

export const uploadArduinoSketch = async ({
  projectPath,
  sketchFile = "sketch.ino",
  fqbn,
  port,
  timeoutMs = 240000
}) => {
  if (!projectPath?.trim()) {
    throw new Error("projectPath is required");
  }
  if (!port || !port.trim()) {
    throw new Error("Upload port is required");
  }

  const arduinoCliPath = resolveArduinoCliPath();
  const tmpDir = path.join(projectPath, "arduino-upload-temp");
  const sketchName = "hardcode_sketch";
  const sketchDir = path.join(tmpDir, sketchName);
  const sketchPath = path.join(sketchDir, `${sketchName}.ino`);
  const buildDir = path.join(tmpDir, "build");

  await mkdir(sketchDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });
  const sourceCode = await readFile(path.join(projectPath, sketchFile), "utf8");
  const normalizedSourceCode = ensureStatusLedDeclaration(sourceCode);
  await writeFile(sketchPath, normalizedSourceCode, "utf8");

  try {
    // Compile into a deterministic build directory so upload doesn't depend
    // on Arduino CLI's volatile global cache folders.
    const compileResult = await runCommand({
      command: arduinoCliPath,
      args: ["compile", "--fqbn", fqbn, "--build-path", buildDir, sketchDir],
      cwd: projectPath,
      timeoutMs
    });

    if (!compileResult.ok) {
      return {
        ok: false,
        command: compileResult.command,
        exitCode: compileResult.exitCode,
        durationMs: compileResult.durationMs,
        stdoutTail: trimTail(compileResult.stdout),
        stderrTail: trimTail(compileResult.stderr),
        summary: `Compile before upload failed | exitCode=${compileResult.exitCode}`,
        metadata: {
          projectPath,
          sketchFile,
          fqbn,
          port,
          buildDir,
          timedOut: compileResult.timedOut,
          phase: "compile"
        }
      };
    }

    const uploadResult = await runCommand({
      command: arduinoCliPath,
      args: ["upload", "-p", port, "--fqbn", fqbn, "--input-dir", buildDir, sketchDir],
      cwd: projectPath,
      timeoutMs
    });

    return {
      ok: uploadResult.ok,
      command: uploadResult.command,
      exitCode: uploadResult.exitCode,
      durationMs: uploadResult.durationMs,
      stdoutTail: trimTail(uploadResult.stdout),
      stderrTail: trimTail(uploadResult.stderr),
      summary: uploadResult.ok ? "Upload succeeded" : `Upload failed | exitCode=${uploadResult.exitCode}`,
      metadata: {
        projectPath,
        sketchFile,
        fqbn,
        port,
        buildDir,
        timedOut: uploadResult.timedOut,
        phase: "upload"
      }
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
};
