import { compileWokwiSketch } from "../services/wokwi-local.service.js";
import { listArduinoPorts, uploadArduinoSketch } from "../services/arduino-cli.service.js";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Project from "../models/project.model.js";

const stripComments = (value = "") => {
  const text = String(value || "");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
};

const repairBrokenStringLiterals = (value = "") => {
  let sketch = String(value || "");
  if (!sketch) return sketch;

  // Fix common LLM formatting issue:
  // Serial.print(" C
  // ");
  sketch = sketch.replace(/\r?\n[ \t]*"\s*\);/g, '");');
  sketch = sketch.replace(/\r?\n[ \t]*"\s*([,;])/g, '"$1');

  return sketch;
};

const normalizeSketchForCompile = (value = "") => {
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

/**
 * Compile a sketch to hex code for embedded Wokwi simulator
 * POST /api/compile/sketch
 * 
 * Request body:
 * {
 *   "projectId": "ObjectId",
 *   "sketchCode": "string",
 *   "fqbn": "arduino:avr:uno" (optional)
 * }
 * 
 * Response:
 * {
 *   "hexCode": "string",
 *   "compileResult": { ... }
 * }
 */
export const compileSketchToHex = async (req, res) => {
  try {
    const { projectId, sketchCode, fqbn = "arduino:avr:uno" } = req.body;
    const normalizedSketchCode = normalizeSketchForCompile(sketchCode);

    if (!normalizedSketchCode || !normalizedSketchCode.trim()) {
      return res.status(400).json({ error: "sketchCode is required" });
    }

    // Optional: verify project ownership
    if (projectId) {
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }
      if (project.owner.toString() !== req.user._id.toString()) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    // Reuse a stable workspace so repeated Verify calls can benefit from
    // incremental build artifacts instead of compiling from scratch each time.
    const userKey = String(req.user?._id || "anonymous");
    const projectKey = String(projectId || "no-project");
    const fqbnKey = String(fqbn || "arduino_avr_uno").replace(/[^a-zA-Z0-9._-]/g, "_");
    const compileRoot = path.join(os.tmpdir(), "hardcode-compile-cache", userKey, projectKey, fqbnKey);
    const sketchName = "hardcode_sketch";
    const sketchDir = path.join(compileRoot, sketchName);
    const sketchPath = path.join(sketchDir, `${sketchName}.ino`);

    await mkdir(sketchDir, { recursive: true });
    await writeFile(sketchPath, normalizedSketchCode, "utf8");

    // Compile using Arduino CLI
    const compileResult = await compileWokwiSketch({
      projectPath: sketchDir,
      sketchFile: `${sketchName}.ino`,
      fqbn,
      timeoutMs: 180000
    });

    if (!compileResult.ok) {
      return res.status(400).json({
        error: compileResult.error || compileResult.stderrTail || compileResult.stdoutTail || "Compilation failed",
        compileResult
      });
    }

    // Read the compiled hex file
    const hexPath = compileResult.metadata?.firmwarePath;
    
    if (!hexPath) {
      return res.status(500).json({
        error: "Could not locate compiled sketch. Arduino CLI may not have completed successfully.",
        compileResult
      });
    }

    let hexContent;
    try {
      hexContent = await readFile(hexPath, "utf8");
    } catch (readErr) {
      return res.status(500).json({
        error: `Compiled sketch exists but cannot be read: ${readErr.message}`,
        compileResult
      });
    }

    res.json({
      hexCode: hexContent,
      compileResult
    });

  } catch (err) {
    console.error("Compile sketch error:", err);
    res.status(500).json({
      error: err.message || "Failed to compile sketch"
    });
  }
};

export const listArduinoBoardPorts = async (req, res) => {
  try {
    const portResult = await listArduinoPorts();

    if (!portResult.ok && (portResult?.ports?.length ?? 0) === 0) {
      return res.status(502).json({
        error: "Unable to read Arduino CLI board ports",
        details: portResult.stderr || portResult.stdout
      });
    }

    res.json({ ports: portResult.ports });
  } catch (err) {
    console.error("List Arduino ports error:", err);
    res.status(500).json({ error: err.message || "Failed to list Arduino ports" });
  }
};

export const uploadSketchToBoard = async (req, res) => {
  try {
    const { projectId, sketchCode, fqbn = "arduino:avr:uno", port } = req.body;
    const normalizedSketchCode = normalizeSketchForCompile(sketchCode);

    if (!normalizedSketchCode || !normalizedSketchCode.trim()) {
      return res.status(400).json({ error: "sketchCode is required" });
    }
    if (!port || !String(port).trim()) {
      return res.status(400).json({ error: "Upload port is required" });
    }

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }
    if (project.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "hardcode-upload-"));
    try {
      const sketchPath = path.join(tmpRoot, "sketch.ino");
      await writeFile(sketchPath, normalizedSketchCode, "utf8");

      const uploadResult = await uploadArduinoSketch({
        projectPath: tmpRoot,
        sketchFile: "sketch.ino",
        fqbn,
        port,
        timeoutMs: 240000
      });

      if (!uploadResult.ok) {
        return res.status(400).json({
          error: uploadResult.stderrTail || uploadResult.stdoutTail || "Upload failed",
          uploadResult
        });
      }

      res.json({ uploadResult });
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    console.error("Upload sketch error:", err);
    res.status(500).json({ error: err.message || "Failed to upload sketch" });
  }
};
