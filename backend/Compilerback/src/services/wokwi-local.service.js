import { existsSync } from "node:fs";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveArduinoCliPath, runCommand } from "./arduino-cli.service.js";

const MAX_TAIL = 6000;

const trimTail = (value = "", max = MAX_TAIL) => {
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

const ensureWokwiToml = async (projectPath) => {
  const tomlPath = path.join(projectPath, "wokwi.toml");
  if (existsSync(tomlPath)) return;

  await writeFile(tomlPath, `[wokwi]\nversion = 1\nfirmware = "build/sketch.ino.hex"\n`, "utf8");
};

const copyCompiledHex = async ({ buildDir, projectPath, sketchFile = "sketch.ino" }) => {
  // Try multiple possible locations for the hex file
  const baseName = sketchFile.replace(/\.ino$/, "");
  const possiblePaths = [
    // Standard output location (buildDir)
    path.join(buildDir, `${baseName}.ino.hex`),
    // Alternative: Arduino's temp directory for Windows
    path.join(projectPath, "build", `${baseName}.ino.hex`),
    // Just the sketch directory
    path.join(projectPath, `${baseName}.ino.hex`)
  ];

  let foundHexPath = null;
  let hexContent = null;

  // Try to find the hex file in known locations
  for (const possiblePath of possiblePaths) {
    try {
      if (existsSync(possiblePath)) {
        hexContent = await readFile(possiblePath, "utf8");
        foundHexPath = possiblePath;
        break;
      }
    } catch (err) {
      // Continue to next possibility
    }
  }

  // If still not found, search the build directory
  if (!foundHexPath && existsSync(buildDir)) {
    try {
      const files = await readdir(buildDir);
      const hexCandidate = files.find((name) => name.endsWith(".hex"));
      if (hexCandidate) {
        foundHexPath = path.join(buildDir, hexCandidate);
        hexContent = await readFile(foundHexPath, "utf8");
      }
    } catch (err) {
      // Continue to error below
    }
  }

  if (!hexContent) {
    throw new Error(`Compile succeeded but no .hex output was found. Searched: ${possiblePaths.join(", ")}`);
  }

  // Return the standard target path
  const targetPath = path.join(buildDir, "sketch.ino.hex");
  if (foundHexPath !== targetPath) {
    await writeFile(targetPath, hexContent);
  }

  return targetPath;
};

export const writeWokwiProjectFiles = async ({
  projectPath,
  diagramJson,
  sketchCode,
  diagramFile = "diagram.json",
  sketchFile = "sketch.ino"
}) => {
  if (!projectPath?.trim()) {
    throw new Error("projectPath is required");
  }

  await mkdir(projectPath, { recursive: true });
  await ensureWokwiToml(projectPath);

  const diagramPath = path.join(projectPath, diagramFile);
  const sketchPath = path.join(projectPath, sketchFile);

  const normalizedDiagram = typeof diagramJson === "string"
    ? JSON.stringify(JSON.parse(diagramJson), null, 2)
    : JSON.stringify(diagramJson || {}, null, 2);

  await writeFile(diagramPath, normalizedDiagram, "utf8");
  await writeFile(sketchPath, sketchCode || "", "utf8");

  return {
    diagramPath,
    sketchPath
  };
};

export const compileWokwiSketch = async ({
  projectPath,
  sketchFile = "sketch.ino",
  fqbn = "arduino:avr:uno",
  timeoutMs = 180000
}) => {
  if (!projectPath?.trim()) {
    throw new Error("projectPath is required");
  }

  const sketchPath = path.join(projectPath, sketchFile);
  if (!existsSync(sketchPath)) {
    throw new Error(`Sketch file does not exist: ${sketchPath}`);
  }

  const arduinoCliPath = resolveArduinoCliPath();
  const buildDir = path.join(projectPath, "build");
  await mkdir(buildDir, { recursive: true });

  const sourceCode = await readFile(sketchPath, "utf8");
  const normalizedSourceCode = ensureStatusLedDeclaration(sourceCode);
  if (normalizedSourceCode !== sourceCode) {
    await writeFile(sketchPath, normalizedSourceCode, "utf8");
  }

  const compileResult = await runCommand({
    command: arduinoCliPath,
    args: ["compile", "--fqbn", fqbn, "--output-dir", buildDir, projectPath],
    cwd: projectPath,
    timeoutMs
  });

  const normalized = {
    ok: compileResult.ok,
    command: compileResult.command,
    exitCode: compileResult.exitCode,
    durationMs: compileResult.durationMs,
    stdoutTail: trimTail(compileResult.stdout),
    stderrTail: trimTail(compileResult.stderr),
    summary: compileResult.ok ? "Compile succeeded" : `Compile failed | exitCode=${compileResult.exitCode}`,
    metadata: {
      projectPath,
      sketchFile,
      fqbn,
      buildDir,
      timedOut: compileResult.timedOut
    },
    ranAt: new Date()
  };

  if (!compileResult.ok) {
    return normalized;
  }

  try {
    const firmwarePath = await copyCompiledHex({ buildDir, projectPath, sketchFile });
    return {
      ...normalized,
      metadata: {
        ...normalized.metadata,
        firmwarePath
      }
    };
  } catch (hexErr) {
    // Return the compilation result but include the hex error
    return {
      ...normalized,
      ok: false,
      error: hexErr.message,
      metadata: {
        ...normalized.metadata,
        hexError: hexErr.message
      }
    };
  }
};

export const readWokwiProjectFiles = async ({
  projectPath,
  diagramFile = "diagram.json",
  sketchFile = "sketch.ino"
}) => {
  if (!projectPath?.trim()) {
    throw new Error("projectPath is required");
  }

  const diagramPath = path.join(projectPath, diagramFile);
  const sketchPath = path.join(projectPath, sketchFile);

  return {
    diagramJson: existsSync(diagramPath) ? await readFile(diagramPath, "utf8") : "",
    sketchCode: existsSync(sketchPath) ? await readFile(sketchPath, "utf8") : ""
  };
};
