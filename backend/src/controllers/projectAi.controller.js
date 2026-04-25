import mongoose from "mongoose";
import Groq from "groq-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import Project from "../models/project.model.js";

let groqClient = null;

const getGroqClient = () => {
  if (groqClient) {
    return groqClient;
  }

  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY. Add it to backend/.env before using ProjectAI.");
  }

  groqClient = new Groq({ apiKey });
  return groqClient;
};

const RELEVANT_EXTENSIONS = new Set([
  ".ino",
  ".json",
  ".toml",
  ".ini",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".md",
  ".txt"
]);

const MAX_FILES = 24;
const MAX_SNIPPET_CHARS = 3500;
const MAX_HISTORY_MESSAGES = 10;
const stripThinking = (value = "") => {
  return String(value)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
};

const safeText = (value = "") => stripThinking(String(value || ""));

const isEditIntent = (value = "") => {
  const text = String(value || "").toLowerCase();
  return /\b(edit|update|modify|change|rewrite|replace|refactor|fix|add|remove|implement|generate|write|create|patch)\b/.test(text)
    || /\bmain\.ino|diagram\.json|pins\.csv|components\.json|assembly\.md|code|sketch|firmware\b/.test(text);
};

const normalizeWorkspaceFiles = (value = {}) => {
  const source = value && typeof value === "object" ? value : {};
  return {
    "main.ino": safeText(source["main.ino"] || source.mainIno || ""),
    "diagram.json": safeText(source["diagram.json"] || source.diagramJson || ""),
    "pins.csv": safeText(source["pins.csv"] || source.pinsCsv || ""),
    "components.json": safeText(source["components.json"] || source.componentsJson || ""),
    "assembly.md": safeText(source["assembly.md"] || source.assemblyMd || "")
  };
};

const projectWorkspaceFiles = (project) => normalizeWorkspaceFiles({
  mainIno: project?.workspaceFiles?.mainIno,
  diagramJson: project?.workspaceFiles?.diagramJson,
  pinsCsv: project?.workspaceFiles?.pinsCsv,
  componentsJson: project?.workspaceFiles?.componentsJson,
  assemblyMd: project?.workspaceFiles?.assemblyMd
});

const persistWorkspaceFiles = (project, files = {}) => {
  const normalized = normalizeWorkspaceFiles(files);
  project.workspaceFiles = {
    mainIno: normalized["main.ino"],
    diagramJson: normalized["diagram.json"],
    pinsCsv: normalized["pins.csv"],
    componentsJson: normalized["components.json"],
    assemblyMd: normalized["assembly.md"]
  };
};

const safeParseJson = (text = "") => {
  const cleaned = safeText(text);

  try {
    return JSON.parse(cleaned);
  } catch {
    const block = cleaned.match(/```json\s*([\s\S]*?)\s*```/i);
    if (block?.[1]) {
      return JSON.parse(block[1]);
    }

    const inline = cleaned.match(/\{[\s\S]*\}/);
    if (inline?.[0]) {
      return JSON.parse(inline[0]);
    }
  }

  throw new Error("Failed to parse ProjectAI JSON");
};

const isRelevantFile = (filePath) => {
  const lowered = filePath.toLowerCase();
  return lowered.endsWith("diagram.json")
    || lowered.endsWith("wokwi.toml")
    || lowered.endsWith("wokwi.ini")
    || lowered.endsWith("sketch.ino")
    || lowered.endsWith("main.c")
    || lowered.endsWith("main.cpp")
    || lowered.endsWith("main.ino")
    || RELEVANT_EXTENSIONS.has(path.extname(lowered));
};

const collectFiles = async (rootPath) => {
  const queue = [rootPath];
  const output = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== ".vscode") {
          queue.push(fullPath);
        }
      } else {
        output.push(fullPath);
      }
    }
  }

  return output;
};

const readSnippet = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return "";
    }

    const content = await fs.readFile(filePath, "utf8");
    if (content.length > MAX_SNIPPET_CHARS) {
      return `${content.slice(0, MAX_SNIPPET_CHARS)}\n...`;
    }

    return content;
  } catch {
    return "";
  }
};

const buildLocalHardwareContext = async (projectPath = "") => {
  if (!projectPath?.trim()) {
    return {
      selected: false,
      projectPath: "",
      fileCount: 0,
      files: [],
      relevantFiles: [],
      snippets: [],
      reason: "No local hardware project path configured"
    };
  }

  const resolvedPath = path.resolve(projectPath.trim());
  const allFiles = await collectFiles(resolvedPath);
  const relevantFiles = allFiles.filter(isRelevantFile);
  const filesToRead = (relevantFiles.length > 0 ? relevantFiles : allFiles)
    .slice(0, MAX_FILES);

  const snippets = [];
  for (const filePath of filesToRead) {
    const content = await readSnippet(filePath);
    if (content) {
      snippets.push({
        path: filePath,
        content
      });
    }
  }

  return {
    selected: true,
    projectPath: resolvedPath,
    fileCount: allFiles.length,
    files: allFiles,
    relevantFiles,
    snippets,
    sketchPath: allFiles.find((filePath) => filePath.toLowerCase().endsWith(".ino")),
    diagramPath: allFiles.find((filePath) => filePath.toLowerCase().endsWith("diagram.json")),
    configPath: allFiles.find((filePath) => {
      const lowered = filePath.toLowerCase();
      return lowered.endsWith("wokwi.toml") || lowered.endsWith("wokwi.ini") || lowered.endsWith("diagram.ini");
    })
  };
};

const buildHistoryText = (project) => {
  return (project?.projectAiMessages || [])
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
};

const buildProjectAIPrompt = ({ project, userInput, context, historyText, mode, workspaceFiles, editIntent }) => {
  return `
You are ProjectAI for the HardCode extension.

Purpose:
- Inspect the selected hardware repository and the project record.
- Help the user reason about the .ino firmware, diagram.json wiring, config files, and any companion files.
- Give direct implementation guidance and edit workspace files when the user asks for code or file changes.
- Reuse the current project context instead of inventing new structure.

Rules:
- Keep the answer concise, concrete, and hardware-focused.
- Mention exact file names when they matter.
- If the repo path is missing, ask the user to select one.
- If the context shows multiple possible entry files, call out the one you think is primary.
- If the user asks to change code, fix code, add a feature, or edit files, update the relevant workspace file content.
- Only edit files when the user intent implies a change.
- Prefer editing main.ino unless another file is clearly requested.
- If edit intent is false, all values in updates must be empty strings.
- If edit intent is true, only changed files should be returned. Leave untouched files as empty strings.
- If user asks for pin explanation, include a clear structured explanation in reply and optionally update pins.csv.
- If user asks for assembly help, include a detailed assembly explanation in reply and optionally update assembly.md.
- For pins.csv updates, include rich descriptive columns and explanations for each mapping.
- For assembly.md updates, produce a detailed guide suitable for real assembly across project types.
- Never put conversational explanation, project ideation text, or prose inside source files.
- main.ino must contain Arduino sketch code only.
- Return strict JSON only.
- Do not mention internal chain-of-thought.

Required structure when updating pins.csv:
- Header must include at least: component,pin,board_pin,direction,signal_type,voltage,explanation
- Include one row per practical connection.
- explanation must briefly explain why the mapping is used.

Required structure when updating assembly.md:
- Include sections for: project intent, required hardware, pre-checks, pin map summary, step-by-step wiring, upload steps, validation, troubleshooting, and safety.
- Steps must be specific and actionable, not generic one-liners.
- Ensure wording works for different project categories (sensor, actuator, communication, automation).

Mode:
${mode}

Edit intent:
${editIntent ? "true" : "false"}

Project description:
${project?.description || ""}

Idea state:
${JSON.stringify(project?.ideaState || {})}

Components state:
${JSON.stringify(project?.componentsState || {})}

Design state:
${JSON.stringify(project?.designState || {})}

Hardware context:
${JSON.stringify(context, null, 2)}

Current workspace files:
${JSON.stringify(workspaceFiles, null, 2)}

Recent ProjectAI history:
${historyText}

User input:
${userInput}

OUTPUT STRICT JSON:
{
  "reply": "",
  "updates": {
    "main.ino": "",
    "diagram.json": "",
    "pins.csv": "",
    "components.json": "",
    "assembly.md": ""
  }
}
`;
};

const callProjectAI = async ({ project, userInput, context, mode, workspaceFiles, editIntent }) => {
  const historyText = buildHistoryText(project);
  const prompt = buildProjectAIPrompt({ project, userInput, context, historyText, mode, workspaceFiles, editIntent });
  const groq = getGroqClient();

  const response = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_completion_tokens: 2200
  });

  const rawText = response.choices?.[0]?.message?.content || "";
  let parsed = null;

  try {
    parsed = safeParseJson(rawText);
  } catch {
    parsed = {
      reply: safeText(rawText),
      updates: {}
    };
  }

  const updates = editIntent ? normalizeWorkspaceFiles(parsed?.updates || {}) : normalizeWorkspaceFiles({});

  return {
    reply: safeText(parsed?.reply || rawText || "ProjectAI updated the workspace context."),
    updates
  };
};

const ensureAccess = async (projectId, userId) => {
  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    return { error: { status: 400, payload: { error: "Invalid projectId" } } };
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return { error: { status: 404, payload: { error: "Project not found" } } };
  }

  if (project.owner.toString() !== userId.toString()) {
    return { error: { status: 403, payload: { error: "Forbidden" } } };
  }

  return { project };
};

const persistProjectAIState = (project, context, reply) => {
  project.projectAiState = {
    summary: reply.slice(0, 300),
    hardwarePath: context.projectPath || project.wokwiProjectPath || "",
    files: (context.relevantFiles || context.files || []).slice(0, 24),
    notes: context.reason ? [context.reason] : [],
    lastContextAt: new Date()
  };
};

export const getProjectAiHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const access = await ensureAccess(id, req.user._id);

    if (access.error) {
      return res.status(access.error.status).json(access.error.payload);
    }

    res.json({
      messages: access.project.projectAiMessages || [],
      projectAiState: access.project.projectAiState || null,
      workspaceFiles: projectWorkspaceFiles(access.project)
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load ProjectAI history" });
  }
};

export const getProjectAiContext = async (req, res) => {
  try {
    const { id } = req.params;
    const access = await ensureAccess(id, req.user._id);

    if (access.error) {
      return res.status(access.error.status).json(access.error.payload);
    }

    const context = await buildLocalHardwareContext(access.project.wokwiProjectPath || "");
    res.json({
      projectId: id,
      context,
      projectAiState: access.project.projectAiState || null,
      workspaceFiles: projectWorkspaceFiles(access.project)
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to load ProjectAI context" });
  }
};

export const initProjectAi = async (req, res) => {
  try {
    const { projectId } = req.body;
    const access = await ensureAccess(projectId, req.user._id);

    if (access.error) {
      return res.status(access.error.status).json(access.error.payload);
    }

    const context = await buildLocalHardwareContext(access.project.wokwiProjectPath || "");
    const workspaceFiles = projectWorkspaceFiles(access.project);
    const result = await callProjectAI({
      project: access.project,
      userInput: "Initialize ProjectAI and summarize the available hardware project context.",
      context,
      mode: "init",
      workspaceFiles,
      editIntent: false
    });

    if (!access.project.projectAiMessages) {
      access.project.projectAiMessages = [];
    }

    access.project.projectAiMessages.push({ role: "ai", content: result.reply });
    persistWorkspaceFiles(access.project, { ...workspaceFiles, ...result.updates });
    persistProjectAIState(access.project, context, result.reply);
    await access.project.save();

    res.json({
      reply: result.reply,
      projectAiState: access.project.projectAiState,
      context,
      workspaceFiles: projectWorkspaceFiles(access.project)
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to initialize ProjectAI" });
  }
};

export const chatProjectAi = async (req, res) => {
  try {
    const { projectId, message, projectPath = "", workspaceFiles = {} } = req.body;
    const access = await ensureAccess(projectId, req.user._id);

    if (access.error) {
      return res.status(access.error.status).json(access.error.payload);
    }

    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "message is required" });
    }

    const project = access.project;
    if (!project.projectAiMessages) {
      project.projectAiMessages = [];
    }

    project.projectAiMessages.push({
      role: "user",
      content: String(message).trim()
    });

    const context = await buildLocalHardwareContext(projectPath || project.wokwiProjectPath || "");
    const currentWorkspaceFiles = {
      ...projectWorkspaceFiles(project),
      ...normalizeWorkspaceFiles(workspaceFiles)
    };
    const editIntent = isEditIntent(String(message).trim());
    const result = await callProjectAI({
      project,
      userInput: String(message).trim(),
      context,
      mode: "chat",
      workspaceFiles: currentWorkspaceFiles,
      editIntent
    });

    project.projectAiMessages.push({
      role: "ai",
      content: result.reply
    });

    persistWorkspaceFiles(project, { ...currentWorkspaceFiles, ...result.updates });
    persistProjectAIState(project, context, result.reply);
    await project.save();

    res.json({
      reply: result.reply,
      projectAiState: project.projectAiState,
      context,
      workspaceFiles: projectWorkspaceFiles(project)
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to chat with ProjectAI" });
  }
};
