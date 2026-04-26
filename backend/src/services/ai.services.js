import Groq from "groq-sdk";
import { getGroqModelComponents, getGroqModelIdeation } from "../config/groq-models.js";
import { buildWokwiEvidenceText } from "./wokwi-runner.service.js";
import { formatWokwiComponentCatalogForPrompt, findUnsupportedPartTypesInText } from "../lib/wokwi-components.js";
import { getAIContext, getRegistry } from "./registry.service.js";

let groqClient = null;

const getGroqClient = () => {
  if (groqClient) {
    return groqClient;
  }

  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is missing (required only when calling AI).");
  }

  groqClient = new Groq({ apiKey });
  return groqClient;
};

// Board canonicalization:
// - Persist meta.board / generationProfile.board as registry keys (e.g., ARDUINO_MEGA)
// - Accept legacy slugs for backward compatibility, but normalize on write.
const LEGACY_BOARD_SLUG_TO_REGISTRY = {
  "arduino-mega": "ARDUINO_MEGA",
  "arduino-uno": "ARDUINO_UNO",
  "arduino-nano": "ARDUINO_NANO",
  "esp32-devkit-v1": "ESP32_DEVKIT_V1",
  "raspberry-pi-pico": "RASPBERRY_PI_PICO",
  "attiny85": "ATTINY85"
};

const normalizeBoardToRegistryKey = (boardValue) => {
  const raw = String(boardValue || "").trim();
  if (!raw) return null;
  if (Object.prototype.hasOwnProperty.call(LEGACY_BOARD_SLUG_TO_REGISTRY, raw)) {
    return LEGACY_BOARD_SLUG_TO_REGISTRY[raw];
  }
  return raw;
};

const getAllowedBoardKeysFromRegistry = () => {
  const registry = getRegistry();
  return Object.entries(registry || {})
    .filter(([, def]) => String(def?.category || "").toLowerCase() === "controller")
    .map(([k]) => k);
};

const pickDefaultBoardKeyFromRegistry = () => {
  const allowed = getAllowedBoardKeysFromRegistry();
  return allowed[0] || null;
};

const cleanArray = (value) => {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .map(item => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
  )];
};

const cleanText = (value = "") => String(value || "").trim();

const dedupeByKey = (items, getKey) => {
  const seen = new Set();

  return items.filter((item) => {
    const key = cleanText(getKey(item)).toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const normalizeArchitectureFiles = (value) => {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .map((item) => {
      if (typeof item === "string") {
        return {
          path: cleanText(item),
          role: "",
          responsibility: ""
        };
      }

      if (!item || typeof item !== "object") {
        return null;
      }

      return {
        path: cleanText(item.path),
        role: cleanText(item.role),
        responsibility: cleanText(item.responsibility)
      };
    })
    .filter((item) => item?.path);

  return dedupeByKey(normalized, (item) => item.path);
};

const normalizeArchitectureLibraries = (value) => {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .map((item) => {
      if (typeof item === "string") {
        return {
          name: cleanText(item),
          purpose: ""
        };
      }

      if (!item || typeof item !== "object") {
        return null;
      }

      return {
        name: cleanText(item.name),
        purpose: cleanText(item.purpose)
      };
    })
    .filter((item) => item?.name);

  return dedupeByKey(normalized, (item) => item.name);
};

const normalizeArchitecturePins = (value) => {
  if (!Array.isArray(value)) return [];

  const normalized = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      return {
        component: cleanText(item.component),
        signal: cleanText(item.signal),
        boardPin: cleanText(item.boardPin),
        notes: cleanText(item.notes)
      };
    })
    .filter((item) => item?.component || item?.signal || item?.boardPin);

  return dedupeByKey(normalized, (item) => `${item.component}|${item.signal}|${item.boardPin}`);
};

const inferArchitectureLibraries = (text = "") => {
  const source = String(text || "").toLowerCase();
  const inferred = [];

  if (/\bkeypad\b/.test(source)) {
    inferred.push({ name: "Keypad", purpose: "Scan matrix keypad input" });
  }
  if (/\blcd\b|liquidcrystal/.test(source)) {
    inferred.push({ name: "LiquidCrystal", purpose: "Drive character LCD output" });
  }
  if (/\bservo\b/.test(source)) {
    inferred.push({ name: "Servo", purpose: "Control servo movement" });
  }
  if (/\bneopixel\b|\bws2812\b/.test(source)) {
    inferred.push({ name: "Adafruit NeoPixel", purpose: "Drive addressable LEDs" });
  }

  return dedupeByKey(inferred, (item) => item.name);
};

const isComplexArchitectureProject = ({ text = "", requirements = [], project = {} }) => {
  const source = String(text || "").toLowerCase();
  const componentCount = Number(project?.meta?.componentCount || requirements.length || 0);

  return componentCount >= 5
    || requirements.length >= 5
    || /(keypad|lcd|display|servo|screen|menu|mode|state machine|lock|password|sensor)/i.test(source);
};

const buildFallbackArchitectureFiles = ({ sourceStrategy = "single-sketch" }) => {
  if (sourceStrategy === "multi-file-modular") {
    return [
      {
        path: "sketch.ino",
        role: "entrypoint",
        responsibility: "Own setup()/loop() and delegate orchestration to focused modules."
      },
      {
        path: "Pins.h",
        role: "pin-map",
        responsibility: "Centralize all board pin assignments and shared hardware constants."
      },
      {
        path: "AppController.h",
        role: "module-interface",
        responsibility: "Declare the main orchestration interface and shared control API."
      },
      {
        path: "AppController.cpp",
        role: "module-logic",
        responsibility: "Implement state transitions, input handling, and actuator coordination."
      },
      {
        path: "diagram.json",
        role: "simulation",
        responsibility: "Define the Wokwi circuit parts and wiring."
      },
      {
        path: "libraries.txt",
        role: "dependencies",
        responsibility: "List required Arduino/Wokwi libraries for simulator parity."
      }
    ];
  }

  return [
    {
      path: "sketch.ino",
      role: "entrypoint",
      responsibility: "Contain the main Arduino logic in one compact sketch."
    },
    {
      path: "diagram.json",
      role: "simulation",
      responsibility: "Define the Wokwi circuit parts and wiring."
    }
  ];
};

const buildFallbackArchitectureState = ({
  project = {},
  summary = "",
  requirements = [],
  unknowns = [],
  current = {}
}) => {
  const text = [
    project?.description || "",
    summary,
    ...(Array.isArray(requirements) ? requirements : []),
    project?.componentsState?.architecture || ""
  ].join(" ");

  const sourceStrategy = cleanText(current?.sourceStrategy)
    || (isComplexArchitectureProject({ text, requirements, project }) ? "multi-file-modular" : "single-sketch");

  const pattern = cleanText(current?.pattern)
    || (/state machine|mode|menu|lock|password/i.test(text) ? "finite-state-machine" : "single-loop");

  const inferredLibraries = inferArchitectureLibraries(text);
  const runtimeFlow = cleanArray(current?.runtimeFlow).length > 0
    ? cleanArray(current.runtimeFlow)
    : (pattern === "finite-state-machine"
        ? ["Read inputs", "Evaluate state transitions", "Drive outputs", "Refresh user feedback"]
        : ["Read inputs", "Run core behavior", "Update outputs"]);

  const assumptions = cleanArray(current?.assumptions).length > 0
    ? cleanArray(current.assumptions)
    : [
        "Board family stays locked unless the user explicitly changes it.",
        "Pin assignments can start as provisional and be refined in Components AI."
      ];

  const openDecisions = cleanArray(current?.openDecisions).length > 0
    ? cleanArray(current.openDecisions)
    : cleanArray(unknowns);

  return {
    summary: cleanText(current?.summary) || (summary ? `Execution blueprint for ${summary}` : "Execution blueprint pending."),
    pattern,
    sourceStrategy,
    entryFile: cleanText(current?.entryFile) || "sketch.ino",
    files: normalizeArchitectureFiles(current?.files).length > 0
      ? normalizeArchitectureFiles(current.files)
      : buildFallbackArchitectureFiles({ sourceStrategy }),
    libraries: normalizeArchitectureLibraries(current?.libraries).length > 0
      ? normalizeArchitectureLibraries(current.libraries)
      : inferredLibraries,
    pinAssignments: normalizeArchitecturePins(current?.pinAssignments),
    runtimeFlow,
    assumptions,
    openDecisions
  };
};

export const normalizeArchitectureState = (raw, { project = {}, summary = "", requirements = [], unknowns = [] } = {}) => {
  const current = project?.architectureState && typeof project.architectureState === "object"
    ? project.architectureState
    : {};

  const fallback = buildFallbackArchitectureState({
    project,
    summary,
    requirements,
    unknowns,
    current
  });

  const source = raw && typeof raw === "object" ? raw : {};
  const currentFiles = normalizeArchitectureFiles(current?.files);
  const currentLibraries = normalizeArchitectureLibraries(current?.libraries);
  const currentPins = normalizeArchitecturePins(current?.pinAssignments);
  const sourceFiles = normalizeArchitectureFiles(source?.files);
  const sourceLibraries = normalizeArchitectureLibraries(source?.libraries);
  const sourcePins = normalizeArchitecturePins(source?.pinAssignments);
  const currentRuntimeFlow = cleanArray(current?.runtimeFlow);
  const currentAssumptions = cleanArray(current?.assumptions);
  const currentOpenDecisions = cleanArray(current?.openDecisions);
  const sourceRuntimeFlow = cleanArray(source?.runtimeFlow);
  const sourceAssumptions = cleanArray(source?.assumptions);
  const sourceOpenDecisions = cleanArray(source?.openDecisions);

  return {
    summary: cleanText(source?.summary) || cleanText(current?.summary) || fallback.summary,
    pattern: cleanText(source?.pattern) || cleanText(current?.pattern) || fallback.pattern,
    sourceStrategy: cleanText(source?.sourceStrategy) || cleanText(current?.sourceStrategy) || fallback.sourceStrategy,
    entryFile: cleanText(source?.entryFile) || cleanText(current?.entryFile) || fallback.entryFile,
    files: sourceFiles.length > 0 ? sourceFiles : (currentFiles.length > 0 ? currentFiles : fallback.files),
    libraries: sourceLibraries.length > 0 ? sourceLibraries : (currentLibraries.length > 0 ? currentLibraries : fallback.libraries),
    pinAssignments: sourcePins.length > 0 ? sourcePins : (currentPins.length > 0 ? currentPins : fallback.pinAssignments),
    runtimeFlow: sourceRuntimeFlow.length > 0 ? sourceRuntimeFlow : (currentRuntimeFlow.length > 0 ? currentRuntimeFlow : fallback.runtimeFlow),
    assumptions: sourceAssumptions.length > 0 ? sourceAssumptions : (currentAssumptions.length > 0 ? currentAssumptions : fallback.assumptions),
    openDecisions: sourceOpenDecisions.length > 0 ? sourceOpenDecisions : (currentOpenDecisions.length > 0 ? currentOpenDecisions : fallback.openDecisions),
    updatedAt: new Date()
  };
};

const stripThinking = (value = "") => {
  return String(value)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
};

const normalizeQuestionText = (value = "") => {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const isIdeaOnlyRequest = (text = "") => {
  const value = String(text).toLowerCase();
  return /(what can i do|just idea|just ideas|give me ideas|suggest ideas|only idea|high level|high level only|just tell me high level|in short|summarize)/i.test(value);
};

const isTransitionToComponentsRequest = (text = "") => {
  return /(go to components|components section|move to components|switch to components)/i.test(String(text).toLowerCase());
};

const buildFallbackIdeationReply = ({ summary, requirements, unknowns, question, userInput }) => {
  if (isTransitionToComponentsRequest(userInput)) {
    if (unknowns.length === 0) {
      return "Ideation is finalized. Open the Components section to get wiring, connections, and expected output details.";
    }

    const topUnknowns = unknowns.slice(0, 3).join(", ");
    return `Before Components section, I still need: ${topUnknowns}. If you want, I can assume safe defaults and continue.`;
  }

  if (isIdeaOnlyRequest(userInput)) {
    if (summary) {
      return `High level: ${summary}`;
    }

    if (requirements.length > 0) {
      return `High level idea: ${requirements.slice(0, 4).join("; ")}`;
    }

    if (unknowns.length > 0) {
      return `High level idea: use the known parts to build a simple, safe concept and defer implementation details until later.`;
    }
  }

  if (question) {
    return question;
  }

  if (unknowns.length > 0) {
    return `We can continue with assumptions. The most important open detail is: ${unknowns[0]}.`;
  }

  return "Ideation is updated with practical assumptions. Continue in Components section for implementation details.";
};

const buildIdeationParseFallback = ({ project, userInput, rawText = "" }) => {
  const summary = cleanText(project?.ideaState?.summary);
  const requirements = cleanArray(project?.ideaState?.requirements);
  const unknowns = cleanArray(project?.ideaState?.unknowns);
  const assistantReply = cleanText(stripThinking(rawText))
    || buildFallbackIdeationReply({
      summary,
      requirements,
      unknowns,
      question: "",
      userInput
    });

  return {
    summary,
    requirements,
    unknowns,
    question: "",
    assistantReply,
    architectureState: project?.architectureState || {}
  };
};

const applyIdeationGuards = (project, userInput, output) => {
  const sanitized = { ...output };

  const recentAiMessages = (project.messages || [])
    .filter(m => m.role === "ai")
    .slice(-3)
    .map(m => normalizeQuestionText(m.content));

  const normalizedQuestion = normalizeQuestionText(sanitized.question);
  const repeatedQuestion = Boolean(normalizedQuestion) && recentAiMessages.includes(normalizedQuestion);

  if (repeatedQuestion) {
    sanitized.question = "";
  }

  const genericReply = /^ideation state updated\.?$/i.test(sanitized.assistantReply || "");
  if (!sanitized.assistantReply || genericReply || repeatedQuestion) {
    sanitized.assistantReply = buildFallbackIdeationReply({
      summary: sanitized.summary,
      requirements: sanitized.requirements,
      unknowns: sanitized.unknowns,
      question: sanitized.question,
      userInput
    });
  }

  sanitized.architectureState = normalizeArchitectureState(sanitized.architectureState, {
    project,
    summary: sanitized.summary,
    requirements: sanitized.requirements,
    unknowns: sanitized.unknowns
  });

  return sanitized;
};

/*
UTIL: safe JSON parse
*/
export const safeParse = (text) => {
  const cleaned = normalizeJsonCandidate(text);

  const direct = parseJsonIfPossible(cleaned);
  if (direct && typeof direct === "object") {
    return direct;
  }

  const fencedCandidates = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)]
    .map((match) => parseJsonIfPossible(match?.[1] || ""))
    .filter((value) => value && typeof value === "object");
  const fenced = pickBestJsonCandidate(fencedCandidates);
  if (fenced) {
    return fenced;
  }

  const balanced = pickBestJsonCandidate(extractBalancedJsonObjects(cleaned));
  if (balanced) {
    return balanced;
  }

  throw new Error(`AI response parsing failed. Excerpt: ${cleaned.replace(/\s+/g, " ").trim().slice(0, 400) || "(empty)"}`);
};

function stripJsonComments(value = "") {
  return String(value || "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
}

function normalizeJsonishText(value = "") {
  return String(value || "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[â€œâ€]/g, "\"")
    .replace(/[â€˜â€™]/g, "'")
    .trim();
}

function stripTrailingCommas(value = "") {
  return String(value || "").replace(/,(\s*[}\]])/g, "$1");
}

function normalizeJsonCandidate(value = "") {
  return stripTrailingCommas(
    stripJsonComments(
      normalizeJsonishText(
        stripThinking(value)
      )
    )
  );
}

function parseJsonIfPossible(value = "") {
  const cleaned = normalizeJsonCandidate(value);
  if (!cleaned) {
    return null;
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function scoreJsonCandidate(value) {
  if (!value || typeof value !== "object") {
    return -1;
  }

  const expectedKeys = [
    "summary",
    "requirements",
    "unknowns",
    "question",
    "assistantReply",
    "architectureState",
    "architecture",
    "components",
    "reply",
    "screens",
    "chipName",
    "sketchIno",
    "diagramJson"
  ];

  let score = 0;
  for (const key of expectedKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      score += 1;
    }
  }

  return score;
}

function pickBestJsonCandidate(candidates = []) {
  const valid = candidates.filter((value) => value && typeof value === "object");
  if (valid.length === 0) {
    return null;
  }

  return [...valid].sort((left, right) => {
    const scoreDiff = scoreJsonCandidate(right) - scoreJsonCandidate(left);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    return JSON.stringify(right).length - JSON.stringify(left).length;
  })[0];
}

function extractBalancedJsonObjects(text = "") {
  const source = String(text || "");
  const results = [];

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;

      if (depth === 0 && start >= 0) {
        const candidate = source.slice(start, i + 1);
        const parsed = parseJsonIfPossible(candidate);
        if (parsed && typeof parsed === "object") {
          results.push(parsed);
        }
        start = -1;
      }
    }
  }

  return results;
}

const recoverGeneratedAssetsFromText = (text = "") => {
  const cleaned = stripThinking(text);
  if (!cleaned) return null;

  let recoveredSketch = "";
  const codeBlocks = [...cleaned.matchAll(/```(?:cpp|c\+\+|arduino)?\s*([\s\S]*?)```/gi)]
    .map((match) => String(match?.[1] || "").trim())
    .filter(Boolean);

  recoveredSketch = codeBlocks.find((block) => hasValidSketchEntryPoints(block)) || "";

  if (!recoveredSketch) {
    const setupIndex = cleaned.search(/void\s+setup\s*\(/i);
    const loopIndex = cleaned.search(/void\s+loop\s*\(/i);
    if (setupIndex >= 0 && loopIndex >= 0) {
      const start = Math.min(setupIndex, loopIndex);
      recoveredSketch = cleaned.slice(start).trim();
    }
  }

  let recoveredDiagram = null;

  const jsonBlocks = [...cleaned.matchAll(/```json\s*([\s\S]*?)```/gi)]
    .map((match) => parseJsonIfPossible(match?.[1] || ""))
    .filter((value) => value && typeof value === "object");

  recoveredDiagram = jsonBlocks.find((value) => Array.isArray(value?.parts) && Array.isArray(value?.connections)) || null;

  if (!recoveredDiagram) {
    const objects = extractBalancedJsonObjects(cleaned);
    recoveredDiagram = objects.find((value) => Array.isArray(value?.parts) && Array.isArray(value?.connections)) || null;
  }

  if (!recoveredSketch && !recoveredDiagram) {
    return null;
  }

  return {
    sketchIno: recoveredSketch,
    diagramJson: recoveredDiagram,
    notes: ["Recovered assets from non-JSON AI output."]
  };
};

/*
COMMON CALL
- pipeline "ideation": GROQ_MODEL_IDEATION (default qwen/qwen3-32b)
- pipeline "components": GROQ_MODEL_COMPONENTS (default meta-llama/llama-4-scout-17b-16e-instruct)
*/
const callAI = async (prompt, { pipeline = "ideation" } = {}) => {
  const groq = getGroqClient();
  const model = pipeline === "components" ? getGroqModelComponents() : getGroqModelIdeation();
  const baseArgs = {
    model,
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No markdown. No prose. No <think>." },
      { role: "user", content: prompt }
    ],
    temperature: 0.2
  };

  let res;
  try {
    res = await groq.chat.completions.create({
      ...baseArgs,
      response_format: { type: "json_object" }
    });
  } catch {
    res = await groq.chat.completions.create(baseArgs);
  }

  return res.choices[0].message.content.trim();
};

const sanitizeChipName = (value = "") => {
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!cleaned) return "custom-chip";
  return cleaned;
};

const buildFallbackCustomChipTemplate = ({ chipName, purpose }) => {
  const normalizedName = sanitizeChipName(chipName || "custom-chip");
  const prettyName = normalizedName.replace(/-/g, " ");

  const chipJson = {
    name: normalizedName,
    author: "NovaAI AI",
    pins: ["VCC", "GND", "IN", "OUT"],
    controls: []
  };

  const chipC = `// Wokwi Custom Chip - generated by NovaAI\n// Purpose: ${purpose || "Custom simulation component"}\n\n#include \"wokwi-api.h\"\n#include <stdio.h>\n#include <stdlib.h>\n\ntypedef struct {\n  pin_t pin_in;\n  pin_t pin_out;\n} chip_state_t;\n\nstatic void pin_in_changed(void *user_data, pin_t pin, uint32_t value) {\n  chip_state_t *chip = (chip_state_t *)user_data;\n  pin_write(chip->pin_out, value);\n}\n\nvoid chip_init() {\n  chip_state_t *chip = malloc(sizeof(chip_state_t));\n\n  chip->pin_in = pin_init(\"IN\", INPUT);\n  chip->pin_out = pin_init(\"OUT\", OUTPUT);\n\n  const pin_watch_config_t watch = {\n    .edge = BOTH,\n    .pin = chip->pin_in,\n    .user_data = chip,\n    .callback = pin_in_changed,\n  };\n  pin_watch(&watch);\n\n  printf(\"${normalizedName} initialized\\n\");\n}\n`;

  return {
    chipName: normalizedName,
    partType: `chip-${normalizedName}`,
    files: {
      chipJsonFileName: `${normalizedName}.chip.json`,
      chipCFileName: `${normalizedName}.chip.c`,
      chipJson,
      chipC
    },
    snippets: {
      diagramPart: {
        type: `chip-${normalizedName}`,
        id: `${normalizedName}1`,
        top: 0,
        left: 0,
        attrs: {}
      },
      wokwiTomlChipEntry: `[[chip]]\nname = '${normalizedName}'\nbinary = 'chips/${normalizedName}.chip.wasm'`
    },
    guidance: [
      `Generated fallback template for ${prettyName}.`,
      "Compile the .chip.c source into .chip.wasm with wokwi-cli chip compile.",
      "Keep .chip.json and .chip.wasm names aligned with the chip name.",
      "Use the diagram part snippet to place the custom chip in diagram.json."
    ]
  };
};

const normalizeCustomChipTemplateOutput = (raw, fallback) => {
  const chipName = sanitizeChipName(raw?.chipName || fallback.chipName);
  const partType = `chip-${chipName}`;

  const chipJson = raw?.files?.chipJson && typeof raw.files.chipJson === "object"
    ? raw.files.chipJson
    : fallback.files.chipJson;

  const chipC = typeof raw?.files?.chipC === "string" && raw.files.chipC.trim()
    ? raw.files.chipC
    : fallback.files.chipC;

  const diagramPart = raw?.snippets?.diagramPart && typeof raw.snippets.diagramPart === "object"
    ? {
        ...raw.snippets.diagramPart,
        type: partType,
        id: String(raw.snippets.diagramPart.id || `${chipName}1`)
      }
    : {
        ...fallback.snippets.diagramPart,
        type: partType,
        id: `${chipName}1`
      };

  const guidance = cleanArray(raw?.guidance);

  return {
    chipName,
    partType,
    files: {
      chipJsonFileName: `${chipName}.chip.json`,
      chipCFileName: `${chipName}.chip.c`,
      chipJson,
      chipC
    },
    snippets: {
      diagramPart,
      wokwiTomlChipEntry: `[[chip]]\nname = '${chipName}'\nbinary = 'chips/${chipName}.chip.wasm'`
    },
    guidance: guidance.length > 0 ? guidance : fallback.guidance
  };
};

export const generateCustomChipTemplate = async ({ project, chipName = "", purpose = "", userPrompt = "" }) => {
  const fallback = buildFallbackCustomChipTemplate({ chipName, purpose: purpose || userPrompt });

  const prompt = `
You are an embedded simulation assistant.

GOAL:
Generate a strict Wokwi custom chip template using a fixed structure.

RULES:
- Return ONLY JSON.
- chipName must be lowercase kebab-case, no spaces.
- partType must be chip-<chipName>.
- files.chipJson must follow Wokwi chip definition shape: name, author, pins, controls.
- files.chipC must compile as a basic Wokwi chip C source and include chip_init().
- snippets.diagramPart.type must be chip-<chipName>.
- snippets.wokwiTomlChipEntry must include [[chip]], name, and binary path.
- Keep template practical and minimal.

OUTPUT JSON SHAPE:
{
  "chipName": "",
  "partType": "",
  "files": {
    "chipJson": {},
    "chipC": ""
  },
  "snippets": {
    "diagramPart": {},
    "wokwiTomlChipEntry": ""
  },
  "guidance": []
}

PROJECT DESCRIPTION:
${project?.description || ""}

CHIP NAME REQUEST:
${chipName || "custom-chip"}

PURPOSE:
${purpose || ""}

USER PROMPT:
${userPrompt || ""}
`;

  try {
    const text = await callAI(prompt, { pipeline: "components" });
    const parsed = safeParse(text);
    return normalizeCustomChipTemplateOutput(parsed, fallback);
  } catch {
    return fallback;
  }
};

const fallbackGeneratedSketch = `/**
 * Generic Arduino starter generated by NovaAI AI
 * Replace behavior according to the project requirements.
 */

const int LED_PIN = 9;
const int BUTTON_PIN = 2;
const int BUZZER_PIN = 8;

void setup() {
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  const bool pressed = digitalRead(BUTTON_PIN) == LOW;

  digitalWrite(LED_PIN, pressed ? HIGH : LOW);
  if (pressed) {
    tone(BUZZER_PIN, 880, 120);
  }

  delay(40);
}
`;

const fallbackGeneratedDiagram = {
  version: 1,
  author: "NovaAI AI",
  editor: "wokwi",
  parts: [
    { type: "wokwi-arduino-uno", id: "uno", top: 183, left: 18.6, attrs: {} },
    { type: "wokwi-pushbutton", id: "btn", top: 25, left: 280, attrs: { color: "green", key: "space", label: "TRIGGER" } },
    { type: "wokwi-led", id: "led", top: 32, left: 350, attrs: { color: "red" } },
    { type: "wokwi-buzzer", id: "buzzer", top: 72, left: 360, attrs: { volume: "0.1" } }
  ],
  connections: [
    ["uno:2", "btn:1.l", "yellow", ["v8", "h80"]],
    ["uno:GND.1", "btn:2.l", "black", ["v12", "h84"]],
    ["uno:9", "led:A", "green", ["v-14", "h122"]],
    ["uno:GND.2", "led:C", "black", ["v-2", "h120"]],
    ["uno:8", "buzzer:2", "purple", ["v18", "h132"]],
    ["uno:GND.3", "buzzer:1", "black", ["v22", "h130"]]
  ],
  dependencies: {}
};

const DEFAULT_BOARD_KEY = "arduino-uno";

const BOARD_PROFILE_MAP = {
  "arduino-uno": {
    boardPartType: "wokwi-arduino-uno",
    boardId: "uno",
    defaultTop: 183,
    defaultLeft: 18.6,
    codeTarget: "arduino-cpp"
  },
  "arduino-mega": {
    boardPartType: "wokwi-arduino-mega",
    boardId: "mega",
    defaultTop: 270,
    defaultLeft: 185,
    codeTarget: "arduino-cpp"
  },
  "arduino-nano": {
    boardPartType: "wokwi-arduino-nano",
    boardId: "nano",
    defaultTop: 183,
    defaultLeft: 18.6,
    codeTarget: "arduino-cpp"
  },
  "esp32-devkit-v1": {
    boardPartType: "wokwi-esp32-devkit-v1",
    boardId: "esp32",
    defaultTop: 183,
    defaultLeft: 18.6,
    codeTarget: "arduino-cpp"
  },
  "raspberry-pi-pico": {
    boardPartType: "wokwi-pi-pico",
    boardId: "pico",
    defaultTop: 183,
    defaultLeft: 18.6,
    codeTarget: "arduino-cpp"
  },
  "attiny85": {
    boardPartType: "wokwi-attiny85",
    boardId: "attiny85",
    defaultTop: 183,
    defaultLeft: 18.6,
    codeTarget: "arduino-cpp"
  }
};

const getBoardProfileFromMeta = (meta = {}) => {
  const key = String(meta?.board || DEFAULT_BOARD_KEY);
  return BOARD_PROFILE_MAP[key] || BOARD_PROFILE_MAP[DEFAULT_BOARD_KEY];
};

export const buildGenerationProfileFromMeta = (meta = {}) => {
  const allowedBoardKeys = getAllowedBoardKeysFromRegistry();
  const requestedBoardKey = normalizeBoardToRegistryKey(meta?.board);
  const board = requestedBoardKey && allowedBoardKeys.includes(requestedBoardKey)
    ? requestedBoardKey
    : pickDefaultBoardKeyFromRegistry();

  const registry = getRegistry();
  const registryBoard = board ? registry[board] : null;
  const boardPartType = String(registryBoard?.wokwiType || "");
  const language = meta?.language === "micropython" ? "micropython" : "cpp";
  const powerSource = meta?.powerSource || null;
  const runtimeHints = [];

  if (powerSource) {
    runtimeHints.push(`power:${powerSource}`);
  }

  runtimeHints.push(`board:${board || "null"}`);
  runtimeHints.push(`language:${language}`);

  if (language === "micropython") {
    runtimeHints.push("pipeline-fallback:sketch-ino");
  }

  return {
    board,
    boardPartType: boardPartType || "wokwi-arduino-uno",
    powerSource,
    language,
    firmwareTarget: language === "micropython" ? "micropython-with-sketch-fallback" : "arduino-cpp-sketch-ino",
    simulationTarget: "wokwi-json-ino",
    runtimeHints: [...new Set(runtimeHints)],
    profileVersion: 1,
    updatedAt: new Date()
  };
};

const hasValidSketchEntryPoints = (sketchIno = "") => {
  return /void\s+setup\s*\(\s*\)/.test(sketchIno) && /void\s+loop\s*\(\s*\)/.test(sketchIno);
};

const getConnectionPartId = (endpoint = "") => {
  return String(endpoint || "").split(":")[0].trim();
};

const validateGeneratedAssets = ({ sketchIno = "", diagramJson = {}, meta = {} }) => {
  const issues = [];
  const parts = Array.isArray(diagramJson?.parts) ? diagramJson.parts : [];
  const connections = Array.isArray(diagramJson?.connections) ? diagramJson.connections : [];
  const partIds = new Set(parts.map((part) => String(part?.id || "").trim()).filter(Boolean));

  if (!hasValidSketchEntryPoints(sketchIno)) {
    issues.push("sketch.ino is missing setup() and/or loop() entry points");
  }

  if (parts.length === 0) {
    issues.push("diagram.json has no parts");
  }

  if (connections.length === 0) {
    issues.push("diagram.json has no connections");
  }

  if (meta?.board) {
    const boardProfile = getBoardProfileFromMeta(meta);
    const hasExpectedBoard = parts.some((part) => String(part?.type || "") === boardProfile.boardPartType);
    if (!hasExpectedBoard) {
      issues.push(`diagram.json is missing selected board part type ${boardProfile.boardPartType}`);
    }
  }

  connections.forEach((entry, index) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      issues.push(`connection at index ${index} is malformed`);
      return;
    }

    const fromId = getConnectionPartId(entry[0]);
    const toId = getConnectionPartId(entry[1]);

    if (!fromId || !toId || !partIds.has(fromId) || !partIds.has(toId)) {
      issues.push(`connection at index ${index} references unknown part id`);
    }
  });

  return {
    ok: issues.length === 0,
    issues
  };
};

const applyDeterministicBoardProfile = ({ assets, meta }) => {
  const boardProfile = getBoardProfileFromMeta(meta);
  const notes = [...(Array.isArray(assets?.notes) ? assets.notes : [])];
  const nextDiagram = {
    ...(assets?.diagramJson || {}),
    parts: Array.isArray(assets?.diagramJson?.parts) ? [...assets.diagramJson.parts] : [],
    connections: Array.isArray(assets?.diagramJson?.connections) ? [...assets.diagramJson.connections] : []
  };

  const boardIndex = nextDiagram.parts.findIndex((part) => /(arduino|esp32|pi-pico|attiny)/i.test(String(part?.type || "")));

  if (boardIndex >= 0) {
    const current = nextDiagram.parts[boardIndex] || {};
    nextDiagram.parts[boardIndex] = {
      ...current,
      type: boardProfile.boardPartType,
      id: String(current?.id || boardProfile.boardId),
      top: Number.isFinite(current?.top) ? current.top : boardProfile.defaultTop,
      left: Number.isFinite(current?.left) ? current.left : boardProfile.defaultLeft,
      attrs: current?.attrs && typeof current.attrs === "object" ? current.attrs : {}
    };
  } else {
    nextDiagram.parts.unshift({
      type: boardProfile.boardPartType,
      id: boardProfile.boardId,
      top: boardProfile.defaultTop,
      left: boardProfile.defaultLeft,
      attrs: {}
    });
    notes.push(`Added deterministic board part ${boardProfile.boardPartType}.`);
  }

  if (!Array.isArray(nextDiagram.connections) || nextDiagram.connections.length === 0) {
    nextDiagram.connections = buildAutoConnections(nextDiagram.parts);
    if (nextDiagram.connections.length > 0) {
      notes.push("Auto-repaired wiring by generating deterministic fallback connections.");
    }
  }

  let nextSketch = String(assets?.sketchIno || "").trim();
  if (!hasValidSketchEntryPoints(nextSketch)) {
    nextSketch = fallbackGeneratedSketch;
    notes.push("Auto-repaired sketch.ino using deterministic fallback template.");
  }

  if (String(meta?.language || "cpp") === "micropython") {
    notes.push("Language is micropython, but sketch.ino fallback is emitted for current Wokwi C++ handoff pipeline.");
  }

  notes.push(`Board profile locked: ${boardProfile.boardPartType}.`);

  return {
    sketchIno: nextSketch,
    diagramJson: nextDiagram,
    notes: [...new Set(cleanArray(notes))]
  };
};

const normalizeRouteArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((step) => String(step || "").trim().replace(/\s+/g, ""))
    .filter(Boolean);
};

const canonicalRouteStyle = ["v-19.2", "h-14.4"];

const normalizeConnectionEntry = (entry) => {
  if (!Array.isArray(entry) || entry.length < 3) return null;

  const from = String(entry[0] || "").trim();
  const to = String(entry[1] || "").trim();
  const color = String(entry[2] || "green").trim() || "green";
  const route = normalizeRouteArray(entry[3]);

  if (!from || !to) return null;
  return [from, to, color, route.length > 0 ? route : canonicalRouteStyle];
};

const normalizeConnectionStyle = (connections = []) => {
  const normalized = Array.isArray(connections)
    ? connections.map(normalizeConnectionEntry).filter(Boolean)
    : [];

  const seen = new Set();

  return normalized.filter(([from, to, color, route]) => {
    const key = JSON.stringify([from, to, color, route]);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  }).map(([from, to, color, route]) => [
    from,
    to,
    color,
    Array.isArray(route) && route.length > 0 ? route : canonicalRouteStyle
  ]);
};

const findPart = (parts, pattern) => {
  return parts.find((part) => pattern.test(String(part?.type || "")));
};

const pinForBoard = (boardPart, pinNumber) => {
  const type = String(boardPart?.type || "").toLowerCase();
  if (type.includes("nano")) {
    return `D${pinNumber}`;
  }
  return String(pinNumber);
};

const buildAutoConnections = (parts) => {
  const board = findPart(parts, /(arduino|esp32|pi-pico|attiny)/i);
  if (!board?.id) return [];

  const boardId = String(board.id);
  const output = [];

  const pir = findPart(parts, /(pir-motion-sensor|\bpir\b)/i);
  const buzzer = findPart(parts, /buzzer/i);
  if (pir?.id && buzzer?.id) {
    output.push([`${boardId}:5V`, `${pir.id}:+`, "red", ["v24", "h-40"]]);
    output.push([`${boardId}:GND`, `${pir.id}:-`, "black", ["v20", "h-44"]]);
    output.push([`${boardId}:${pinForBoard(board, 2)}`, `${pir.id}:D`, "green", ["v16", "h-32"]]);
    output.push([`${boardId}:${pinForBoard(board, 8)}`, `${buzzer.id}:2`, "purple", ["v12", "h28"]]);
    output.push([`${boardId}:GND`, `${buzzer.id}:1`, "black", ["v24", "h24"]]);
  }

  const leds = parts.filter((part) => /wokwi-led/i.test(String(part?.type || "")));
  const ledPins = [9, 10, 11, 12];
  leds.slice(0, ledPins.length).forEach((led, index) => {
    output.push([`${boardId}:${pinForBoard(board, ledPins[index])}`, `${led.id}:A`, "green", ["v-20", "h20"]]);
    output.push([`${boardId}:GND`, `${led.id}:C`, "black", ["v-12", "h-20"]]);
  });

  if (output.length > 0) {
    return normalizeConnectionStyle(output);
  }

  return [];
};

const normalizeGeneratedAssetsOutput = (raw) => {
  const sketchIno = typeof raw?.sketchIno === "string" && raw.sketchIno.trim()
    ? raw.sketchIno.trim()
    : "";

  const diagramJson = raw?.diagramJson && typeof raw.diagramJson === "object"
    ? raw.diagramJson
    : null;

  const notes = cleanArray(raw?.notes);

  const normalizedParts = Array.isArray(diagramJson?.parts) ? diagramJson.parts : [];
  const normalizedConnections = normalizeConnectionStyle(diagramJson?.connections || []);

  const ensuredConnections = normalizedConnections.length > 0
    ? normalizedConnections
    : buildAutoConnections(normalizedParts);

  const ensuredNotes = [...notes];
  if (normalizedConnections.length === 0 && ensuredConnections.length > 0) {
    ensuredNotes.push("Auto-generated wiring connections because AI response had no valid wires.");
  }

  const safeDiagram = diagramJson && typeof diagramJson === "object"
    ? {
        version: Number(diagramJson?.version || 1),
        author: String(diagramJson?.author || "NovaAI AI"),
        editor: String(diagramJson?.editor || "wokwi"),
        parts: normalizedParts,
        connections: ensuredConnections,
        dependencies: diagramJson?.dependencies && typeof diagramJson.dependencies === "object"
          ? diagramJson.dependencies
          : {}
      }
    : {
        version: 1,
        author: "NovaAI AI",
        editor: "wokwi",
        parts: [],
        connections: [],
        dependencies: {}
      };

  return {
    sketchIno: sketchIno || fallbackGeneratedSketch,
    diagramJson: safeDiagram,
    notes: [...new Set(ensuredNotes)]
  };
};

const collectProjectDataText = (project = {}) => {
  return [
    project?.description || "",
    project?.ideaState?.summary || "",
    ...(project?.ideaState?.requirements || []),
    project?.componentsState?.architecture || "",
    ...(project?.componentsState?.components || []),
    ...(project?.componentsState?.apiEndpoints || [])
  ].join(" ").toLowerCase();
};

const countComponentMentions = (project = {}, regex) => {
  const components = Array.isArray(project?.componentsState?.components)
    ? project.componentsState.components
    : [];

  return components.filter((item) => regex.test(String(item || ""))).length;
};

const isSimonProjectFromData = (project = {}) => {
  const text = collectProjectDataText(project);

  const ledCount = countComponentMentions(project, /\bled\b/gi);
  const buttonCount = countComponentMentions(project, /pushbutton|button/i);
  const shiftRegisterCount = countComponentMentions(project, /74hc595/i);
  const segmentCount = countComponentMentions(project, /7-?segment|seven segment/i);
  const buzzerCount = countComponentMentions(project, /buzzer|piezo/i);

  return /simon|score display|memory game/i.test(text)
    || (ledCount >= 4 && buttonCount >= 4 && shiftRegisterCount >= 2 && segmentCount >= 2 && buzzerCount >= 1);
};

const buildSimonGameSketchFromData = (project = {}) => {
  const title = project?.ideaState?.summary?.trim() || "Simon Game for Arduino with Score display";

  return `/**
   ${title}

   Copyright (C) 2022, Uri Shaked

   Released under the MIT License.
*/

#include "pitches.h"

/* Constants - define pin numbers for LEDs,
   buttons and speaker, and also the game tones: */
const uint8_t ledPins[] = {9, 10, 11, 12};
const uint8_t buttonPins[] = {2, 3, 4, 5};
#define SPEAKER_PIN 8

// These are connected to 74HC595 shift register (used to show game score):
const int LATCH_PIN = A1;  // 74HC595 pin 12
const int DATA_PIN = A0;  // 74HC595pin 14
const int CLOCK_PIN = A2;  // 74HC595 pin 11

#define MAX_GAME_LENGTH 100

const int gameTones[] = { NOTE_G3, NOTE_C4, NOTE_E4, NOTE_G5};

/* Global variables - store the game state */
uint8_t gameSequence[MAX_GAME_LENGTH] = {0};
uint8_t gameIndex = 0;

/**
   Set up the Arduino board and initialize Serial communication
*/
void setup() {
  Serial.begin(9600);
  for (byte i = 0; i < 4; i++) {
    pinMode(ledPins[i], OUTPUT);
    pinMode(buttonPins[i], INPUT_PULLUP);
  }
  pinMode(SPEAKER_PIN, OUTPUT);
  pinMode(LATCH_PIN, OUTPUT);
  pinMode(CLOCK_PIN, OUTPUT);
  pinMode(DATA_PIN, OUTPUT);

  // The following line primes the random number generator.
  // It assumes pin A3 is floating (disconnected):
  randomSeed(analogRead(A3));
}

/* Digit table for the 7-segment display */
const uint8_t digitTable[] = {
  0b11000000,
  0b11111001,
  0b10100100,
  0b10110000,
  0b10011001,
  0b10010010,
  0b10000010,
  0b11111000,
  0b10000000,
  0b10010000,
};
const uint8_t DASH = 0b10111111;

void sendScore(uint8_t high, uint8_t low) {
  digitalWrite(LATCH_PIN, LOW);
  shiftOut(DATA_PIN, CLOCK_PIN, MSBFIRST, low);
  shiftOut(DATA_PIN, CLOCK_PIN, MSBFIRST, high);
  digitalWrite(LATCH_PIN, HIGH);
}

void displayScore() {
  int high = gameIndex % 100 / 10;
  int low = gameIndex % 10;
  sendScore(high ? digitTable[high] : 0xff, digitTable[low]);
}

/**
   Lights the given LED and plays a suitable tone
*/
void lightLedAndPlayTone(byte ledIndex) {
  digitalWrite(ledPins[ledIndex], HIGH);
  tone(SPEAKER_PIN, gameTones[ledIndex]);
  delay(300);
  digitalWrite(ledPins[ledIndex], LOW);
  noTone(SPEAKER_PIN);
}

/**
   Plays the current sequence of notes that the user has to repeat
*/
void playSequence() {
  for (int i = 0; i < gameIndex; i++) {
    byte currentLed = gameSequence[i];
    lightLedAndPlayTone(currentLed);
    delay(50);
  }
}

/**
    Waits until the user pressed one of the buttons,
    and returns the index of that button
*/
byte readButtons() {
  while (true) {
    for (byte i = 0; i < 4; i++) {
      byte buttonPin = buttonPins[i];
      if (digitalRead(buttonPin) == LOW) {
        return i;
      }
    }
    delay(1);
  }
}

/**
  Play the game over sequence, and report the game score
*/
void gameOver() {
  Serial.print("Game over! your score: ");
  Serial.println(gameIndex - 1);
  gameIndex = 0;
  delay(200);

  // Play a Wah-Wah-Wah-Wah sound
  tone(SPEAKER_PIN, NOTE_DS5);
  delay(300);
  tone(SPEAKER_PIN, NOTE_D5);
  delay(300);
  tone(SPEAKER_PIN, NOTE_CS5);
  delay(300);
  for (byte i = 0; i < 10; i++) {
    for (int pitch = -10; pitch <= 10; pitch++) {
      tone(SPEAKER_PIN, NOTE_C5 + pitch);
      delay(5);
    }
  }
  noTone(SPEAKER_PIN);

  sendScore(DASH, DASH);
  delay(500);
}

/**
   Get the user's input and compare it with the expected sequence.
*/
bool checkUserSequence() {
  for (int i = 0; i < gameIndex; i++) {
    byte expectedButton = gameSequence[i];
    byte actualButton = readButtons();
    lightLedAndPlayTone(actualButton);
    if (expectedButton != actualButton) {
      return false;
    }
  }

  return true;
}

/**
   Plays a hooray sound whenever the user finishes a level
*/
void playLevelUpSound() {
  tone(SPEAKER_PIN, NOTE_E4);
  delay(150);
  tone(SPEAKER_PIN, NOTE_G4);
  delay(150);
  tone(SPEAKER_PIN, NOTE_E5);
  delay(150);
  tone(SPEAKER_PIN, NOTE_C5);
  delay(150);
  tone(SPEAKER_PIN, NOTE_D5);
  delay(150);
  tone(SPEAKER_PIN, NOTE_G5);
  delay(150);
  noTone(SPEAKER_PIN);
}

/**
   The main game loop
*/
void loop() {
  displayScore();

  // Add a random color to the end of the sequence
  gameSequence[gameIndex] = random(0, 4);
  gameIndex++;
  if (gameIndex >= MAX_GAME_LENGTH) {
    gameIndex = MAX_GAME_LENGTH - 1;
  }

  playSequence();
  if (!checkUserSequence()) {
    gameOver();
  }

  delay(500);

  if (gameIndex > 0) {
    playLevelUpSound();
    delay(300);
  }
}`;
};

const buildSimonGameDiagramFromData = (project = {}) => {
  const colorFromButton = (id) => {
    if (id.includes("red")) return "orange";
    if (id.includes("green")) return "green";
    if (id.includes("blue")) return "blue";
    if (id.includes("yellow")) return "gold";
    return "green";
  };

  const parts = [
    { type: "wokwi-arduino-uno", id: "uno", top: 183, left: 18.6, attrs: {} },
    { type: "wokwi-buzzer", id: "buzzer", top: 16, left: 124, attrs: { volume: "0.1" } },
    { type: "wokwi-led", id: "led-red", top: 10, left: 6, attrs: { color: "red" } },
    { type: "wokwi-led", id: "led-green", top: 73, left: 6, attrs: { color: "green" } },
    { type: "wokwi-led", id: "led-blue", top: 10, left: 270, attrs: { color: "blue" } },
    { type: "wokwi-led", id: "led-yellow", top: 73, left: 270, attrs: { color: "yellow" } },
    { type: "wokwi-pushbutton", id: "btn-red", top: 10, left: 46, attrs: { color: "red", key: "1", label: "1" } },
    { type: "wokwi-pushbutton", id: "btn-green", top: 76, left: 46, attrs: { color: "green", key: "2", label: "2" } },
    { type: "wokwi-pushbutton", id: "btn-blue", top: 10, left: 200, attrs: { color: "blue", key: "3", label: "3" } },
    { type: "wokwi-pushbutton", id: "btn-yellow", top: 76, left: 200, attrs: { color: "yellow", key: "4", label: "4" } },
    { type: "wokwi-74hc595", id: "sr1", top: 171.8, left: 361.16, rotate: 180, attrs: {} },
    { type: "wokwi-74hc595", id: "sr2", top: 171.8, left: 457.16, rotate: 180, attrs: {} },
    { type: "wokwi-7segment", id: "sevseg1", top: 47.16, left: 379.48, attrs: {} },
    { type: "wokwi-7segment", id: "sevseg2", top: 47.16, left: 446.68, attrs: {} }
  ];

  return {
    version: 1,
    author: String(project?.description?.includes("Uri Shaked") ? "Uri Shaked" : "NovaAI AI"),
    editor: "wokwi",
    parts,
    connections: normalizeConnectionStyle([
      ["uno:GND.1", "buzzer:1", "black", ["v-12", "*", "h0"]],
      ["uno:2", "btn-yellow:1.l", "gold", ["v-48", "*", "h-6"]],
      ["uno:GND.1", "btn-yellow:2.r", "black", ["v-12", "*", "h6"]],
      ["uno:3", "btn-blue:1.l", "blue", ["v-44", "*", "h-10"]],
      ["uno:GND.1", "btn-blue:2.r", "black", ["v-12", "*", "h6"]],
      ["uno:4", "btn-green:2.r", "green", ["v-40", "*", "h6"]],
      ["uno:GND.1", "btn-green:1.l", "black", ["v-12", "*", "h-6"]],
      ["uno:5", "btn-red:2.r", "orange", ["v-36", "*", "h10"]],
      ["uno:GND.1", "btn-red:1.l", "black", ["v-12", "*", "h-6"]],
      ["uno:8", "buzzer:2", "purple", ["v-32", "*", "h0"]],
      ["uno:9", "led-yellow:A", "gold", ["v-28", "*", "h0"]],
      ["uno:GND.1", "led-yellow:C", "black", ["v-12", "*", "h-15", "v4"]],
      ["uno:10", "led-blue:A", "blue", ["v-24", "*", "h8"]],
      ["uno:GND.1", "led-blue:C", "black", ["v-12", "*", "h-15", "v4"]],
      ["uno:11", "led-green:A", "green", ["v-20", "*", "h0"]],
      ["uno:GND.1", "led-green:C", "black", ["v-12", "*", "h-8", "v4"]],
      ["uno:12", "led-red:A", "orange", ["v-16", "*", "h6"]],
      ["uno:GND.1", "led-red:C", "black", ["v-12", "*", "h-8", "v4"]],
      ["uno:5V", "sr1:VCC", "red", ["v57.5", "h253.4"]],
      ["uno:A2", "sr1:SHCP", "gray", ["v19.1", "h138.4"]],
      ["uno:A1", "sr1:STCP", "purple", ["v28.7", "h157.5"]],
      ["uno:A0", "sr1:DS", "blue", ["v38.3", "h186.2"]],
      ["sr1:SHCP", "sr2:SHCP", "gray", ["v47", "h106.12"]],
      ["sr1:STCP", "sr2:STCP", "purple", ["v37.4", "h96.52"]],
      ["sr1:Q7S", "sr2:DS", "blue", ["h0.52", "v56.6", "h144"]],
      ["sr1:VCC", "sr1:MR", "red", ["v17", "h-57.6"]],
      ["sr1:VCC", "sr2:MR", "red", ["v17", "h38.4"]],
      ["sr1:VCC", "sr2:VCC", "red", ["v17", "h96"]],
      ["sr1:OE", "sr2:OE", "black", ["v26.6", "h96"]],
      ["sr1:MR", "sevseg1:COM.1", "red", ["v17", "h-57.6", "v-96", "h76.8"]],
      ["sevseg1:COM.1", "sevseg2:COM.1", "red", ["h0", "v9.6", "h57.6"]],
      ["sr2:Q0", "sevseg2:A", "green", ["v7.4", "h28.8", "v-182.4", "h-67.2"]],
      ["sr2:Q1", "sevseg2:B", "green", ["v0", "h9.6", "v-134.4", "h-48"]],
      ["sr2:Q2", "sevseg2:C", "green", ["v-38.4", "h-38.4"]],
      ["sr2:Q3", "sevseg2:D", "green", ["v-33.6", "h-33.6", "v-9.6", "h-14.4"]],
      ["sr2:Q4", "sevseg2:E", "green", ["v-28.8", "h-28.8", "v-9.6", "h-14.4"]],
      ["sr2:Q5", "sevseg2:F", "green", ["v-24", "h-24", "v-9.6", "h-24", "v-110.4", "h19.2"]],
      ["sr2:Q6", "sevseg2:G", "green", ["v-19.2", "h-43.2", "v-115.2", "h14.4"]],
      ["sr1:GND", "sr2:GND", "black", ["v-9.6", "h96"]],
      ["sr1:Q1", "sevseg1:B", "green", ["v-134.4", "h-19.2"]],
      ["sr1:Q2", "sevseg1:C", "green", ["v-38.4", "h-19.2"]],
      ["sr1:Q3", "sevseg1:D", "green", ["v-33.6", "h-24"]],
      ["sr1:Q4", "sevseg1:E", "green", ["v-28.8", "h-28.8"]],
      ["uno:GND.3", "sr1:GND", "black", ["v47.9", "h157.6", "v-259.2", "h9.6"]],
      ["sr1:GND", "sr1:OE", "black", ["v-9.6", "h-9.6", "v67.2", "h172.8"]],
      ["sr1:Q0", "sevseg1:A", "green", ["v65", "h-76.8", "v-240", "h57.6"]],
      ["sr1:Q5", "sevseg1:F", "green", ["v-24", "h-19.2", "v-110.4", "h19.2"]],
      ["sr1:Q6", "sevseg1:G", "green", ["v-19.2", "h-14.4", "v-110.4", "h14.4"]]
    ]),
    dependencies: {}
  };
};

const enforceCatalogForIdeation = (output) => {
  const combinedText = [
    output.summary,
    ...(output.requirements || []),
    JSON.stringify(output.architectureState || {}),
    output.assistantReply,
    output.question
  ].join("\n");

  const unsupportedPartTypes = findUnsupportedPartTypesInText(combinedText);
  if (unsupportedPartTypes.length === 0) {
    return output;
  }

  const unsupportedLabel = unsupportedPartTypes.join(", ");

  return {
    ...output,
    unknowns: cleanArray([...(output.unknowns || []), `Unsupported Wokwi part types referenced: ${unsupportedLabel}`]),
    question: output.question || "Should I replace the unsupported parts with closest supported Wokwi alternatives?",
    assistantReply: `I found unsupported Wokwi part types in the plan (${unsupportedLabel}). I will only use supported Wokwi components, or a custom chip with chip-<name> once you define it in wokwi.toml with matching .chip.json/.wasm files.`
  };
};

const enforceCatalogForComponents = (output) => {
  const combinedText = [
    output.architecture,
    ...(output.components || []),
    ...(output.apiEndpoints || []),
    JSON.stringify(output.architectureState || {}),
    output.reply
  ].join("\n");

  const unsupportedPartTypes = findUnsupportedPartTypesInText(combinedText);
  if (unsupportedPartTypes.length === 0) {
    return output;
  }

  const unsupportedLabel = unsupportedPartTypes.join(", ");

  return {
    ...output,
    reply: `${output.reply}\n\nConstraint check: unsupported Wokwi part types detected (${unsupportedLabel}). Please switch these to supported parts, or define custom chips as chip-<name> with wokwi.toml + .chip.json/.wasm.`
  };
};

const normalizeIdeationOutput = (raw, userInput, fallbackQuestion = "Please provide the most important missing detail so I can continue.") => {
  const summary = typeof raw?.summary === "string" ? raw.summary.trim() : "";
  const requirements = cleanArray(raw?.requirements);
  const unknowns = cleanArray(raw?.unknowns);

  let question = typeof raw?.question === "string" ? raw.question.trim() : "";
  let assistantReply = typeof raw?.assistantReply === "string" ? raw.assistantReply.trim() : "";

  if (!assistantReply) {
    const alternateReply = typeof raw?.reply === "string" ? raw.reply.trim() : "";
    assistantReply = alternateReply;
  }

  if (unknowns.length > 0 && !question) {
    question = fallbackQuestion;
  }

  if (!assistantReply) {
    assistantReply = question || "I updated the ideation context with practical defaults.";
  }

  if (isIdeaOnlyRequest(userInput)) {
    assistantReply = buildFallbackIdeationReply({
      summary,
      requirements,
      unknowns,
      question,
      userInput
    });
    question = "";
  } else if (unknowns.length === 0 && !question) {
    assistantReply = assistantReply || "Ideation is finalized. Switch to the Components section for wiring, implementation steps, and expected output behavior.";
  }

  return {
    summary,
    requirements,
    unknowns,
    question,
    assistantReply,
    architectureState: raw?.architectureState && typeof raw.architectureState === "object"
      ? raw.architectureState
      : {}
  };
};

export const detectBoardFromRequirements = (requirements = []) => {
  const text = Array.isArray(requirements)
    ? requirements.join(" ").toLowerCase()
    : "";

  // Return registry keys only.
  if (text.includes("mega")) return "ARDUINO_MEGA";
  if (text.includes("nano")) return "ARDUINO_NANO";
  if (text.includes("uno")) return "ARDUINO_UNO";
  if (text.includes("esp32")) return "ESP32_DEVKIT_V1";
  if (text.includes("pico")) return "RASPBERRY_PI_PICO";
  if (text.includes("attiny")) return "ATTINY85";

  return pickDefaultBoardKeyFromRegistry();
};

export const detectPowerSourceFromRequirements = (requirements = []) => {
  const text = Array.isArray(requirements)
    ? requirements.join(" ").toLowerCase()
    : "";

  if (text.includes("lipo") || text.includes("lithium")) return "lipo";
  if (text.includes("9v")) return "9v";
  if (text.includes("aa battery") || text.includes("aa batteries")) return "aa-batteries";

  return "usb";
};

export const processInput = async (project, userInput) => {
  const messagesText = project.messages
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const allowedBoardKeys = getAllowedBoardKeysFromRegistry();
  // #region agent log
  fetch('http://127.0.0.1:7453/ingest/b8da6778-f3ca-4c12-8d65-59ddc4130029',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6aa033'},body:JSON.stringify({sessionId:'6aa033',runId:'pre-fix',hypothesisId:'H1',location:'backend/src/services/ai.services.js:processInput:entry',message:'Ideation processInput entry',data:{userInput:String(userInput||''),metaBoard:project?.meta?.board||null,allowedBoardKeysCount:allowedBoardKeys.length,allowedBoardKeys:allowedBoardKeys.slice(0,10)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log

  const prompt = `
You are a hardware system design AI.

You MUST behave like a strict engineer.

GOAL:
Convert a vague idea into a COMPLETE, BUILDABLE hardware system.

ADDITIONAL BEHAVIOR:
- If user asks for ideas with specific parts (example: "3 LEDs, Arduino, small display"), propose concrete feasible ideas with those exact constraints.
- If constraints are unrealistic or too limited, clearly explain why and propose the smallest viable changes.
- If user says "you decide", choose practical defaults and explicitly document those defaults in requirements.
- If user asks "what can I do" or "just idea", provide 3 practical concept options based on known parts and avoid blocking on fine-grained electrical specs.
- Keep ideation conceptual. Do NOT provide step-by-step wiring, pin mapping, resistor calculations, or circuit completion instructions in ideation mode.
- If user asks implementation details in ideation mode, provide high-level behavior only and direct them to Components section for build details.
- If user asks to move to Components section:
  - If unknowns are empty: confirm ideation finalized and direct them to Components section.
  - If unknowns remain: clearly list top missing details instead of generic status text.
- Besides requirements, maintain an architectureState that captures execution structure:
  - pattern (example: finite-state-machine)
  - sourceStrategy (single-sketch or multi-file-modular)
  - entryFile
  - files with roles/responsibilities
  - libraries with purpose
  - planned pinAssignments when known
  - runtimeFlow, assumptions, and openDecisions
- Keep architectureState concrete enough for downstream codegen, but do not turn ideation into a full wiring tutorial.
- If unknowns are empty, architectureState should read like a deterministic execution blueprint, not a vague suggestion list.

PROCESS (MANDATORY):
1. Understand user input
2. Update structured state
3. Identify gaps (unknowns)
4. Remove resolved unknowns
5. Add new unknowns if needed
6. If unknowns remain, ask EXACTLY ONE next question (most critical gap)
7. If unknowns are empty, finalize and do not ask a question

SPECIAL INTENT:
- If the user asks for a high-level answer, idea only, or summary, do not ask a follow-up question unless absolutely required to avoid unsafe assumptions.
- In that case, return a short concept summary and keep the response inside ideation mode.

RULES:
- No assumptions without confirmation
- No multiple questions
- No vague questions
- Unknowns must be specific
- Requirements must be concrete
- Keep summary updated and precise
- Do not repeat the same question if it was already asked recently; either choose a different critical unknown or proceed with conservative defaults.
- Never use generic reply text such as "Ideation state updated."
- You must only use components from the approved Wokwi component catalog listed below.
- If user requests a component outside this catalog, mark it as unavailable in unknowns and suggest the closest in-catalog alternative.
- Custom parts are allowed only as chip-<name> (Wokwi Chips API) and must be treated as pending until user confirms custom chip files exist.
- NEVER output anything outside JSON
- DO NOT include <think> tags

APPROVED WOKWI COMPONENT CATALOG:
${formatWokwiComponentCatalogForPrompt()}

COMPONENT REGISTRY (CONTROLLERS ONLY):
You MUST treat this as the source of truth for which boards exist. Do not mention boards not listed here.
${JSON.stringify(allowedBoardKeys)}

IDEATION CONSTRAINTS (must follow):
- If COMPONENT REGISTRY (CONTROLLERS ONLY) contains exactly one value, you MUST assume that board and MUST NOT ask the user to choose a microcontroller.
- Never ask about stepper motor product models/sizes (e.g. NEMA). Treat motors as generic: 200 steps/rev default.
- Never ask about stepper resolution/microstepping unless the user explicitly asked for microstepping; otherwise assume full-step (MS1/MS2/MS3 low).
- Keep ideation at the system level; do not drift into vendor/part-shopping questions.

OUTPUT STRICT JSON:
{
  "summary": "",
  "requirements": [],
  "unknowns": [],
  "question": "",
  "assistantReply": "",
  "architectureState": {
    "summary": "",
    "pattern": "",
    "sourceStrategy": "",
    "entryFile": "sketch.ino",
    "files": [],
    "libraries": [],
    "pinAssignments": [],
    "runtimeFlow": [],
    "assumptions": [],
    "openDecisions": []
  }
}

PROJECT DESCRIPTION:
${project.description}

CURRENT STATE:
${JSON.stringify(project.ideaState)}

CURRENT ARCHITECTURE STATE:
${JSON.stringify(project.architectureState || {})}

CONVERSATION:
${messagesText}

NEW USER INPUT:
${userInput}
`;

  // #region agent log
  fetch('http://127.0.0.1:7453/ingest/b8da6778-f3ca-4c12-8d65-59ddc4130029',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6aa033'},body:JSON.stringify({sessionId:'6aa033',runId:'pre-fix',hypothesisId:'H2',location:'backend/src/services/ai.services.js:processInput:prompt',message:'Ideation prompt summary',data:{promptHasRegistry:prompt.includes('COMPONENT REGISTRY (CONTROLLERS ONLY)'),promptBoardsSample:allowedBoardKeys.slice(0,10),messagesChars:messagesText.length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log

  const text = await callAI(prompt, { pipeline: "ideation" });
  let parsed;
  try {
    parsed = safeParse(text);
  } catch (error) {
    console.error("Ideation parse fallback:", error?.message || error);
    parsed = buildIdeationParseFallback({
      project,
      userInput,
      rawText: text
    });
  }

  const normalized = normalizeIdeationOutput(parsed, userInput);
  const guarded = applyIdeationGuards(project, userInput, normalized);
  const catalogSafe = enforceCatalogForIdeation(guarded);

  const detectedBoardKeyRaw = detectBoardFromRequirements(catalogSafe.requirements);
  const detectedBoardKey = detectedBoardKeyRaw && allowedBoardKeys.includes(detectedBoardKeyRaw)
    ? detectedBoardKeyRaw
    : null;

  // #region agent log
  fetch('http://127.0.0.1:7453/ingest/b8da6778-f3ca-4c12-8d65-59ddc4130029',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'6aa033'},body:JSON.stringify({sessionId:'6aa033',runId:'pre-fix',hypothesisId:'H3',location:'backend/src/services/ai.services.js:processInput:output',message:'Ideation output + detectedMeta',data:{question:catalogSafe.question||'',assistantReply:(catalogSafe.assistantReply||'').slice(0,200),requirements:catalogSafe.requirements.slice(0,10),unknowns:catalogSafe.unknowns.slice(0,10),detectedBoardKeyRaw,detectedBoardKey},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log

  return {
    ...catalogSafe,
    architectureState: normalizeArchitectureState(catalogSafe.architectureState, {
      project,
      summary: catalogSafe.summary,
      requirements: catalogSafe.requirements,
      unknowns: catalogSafe.unknowns
    }),
    detectedMeta: {
      board: detectedBoardKey,
      powerSource: detectPowerSourceFromRequirements(guarded.requirements),
      language: guarded.requirements.join(" ").toLowerCase().includes("micropython") ? "micropython" : "cpp",
      componentCount: guarded.requirements.length,
      detectedAt: new Date()
    }
  };
};

export const processComponents = async (project, userInput) => {
  const messagesText = (project.componentsMessages || [])
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");
  const runnerEvidence = buildWokwiEvidenceText(project);
  const ideationMeta = project?.meta || {};
  const generationProfile = project?.generationProfile || buildGenerationProfileFromMeta(ideationMeta);
  const registryContext = getAIContext();

  const prompt = `
You are a hardware systems architect.

GOAL:
Convert finalized idea into system architecture and components.

RULES:
- Use ideaState as ground truth
- Treat existing architectureState as the execution contract; refine it instead of replacing it with a contradictory structure unless the user explicitly changes direction.
- Use IDEATION CAPTURED META as hard context for board/language/power defaults.
- Be precise and practical
- No vague components
- Output must be buildable
- Include concise implementation guidance in reply.
- You can ONLY reference component types listed in COMPONENT REGISTRY (AI CONTEXT) below.
- When you mention a pin name, it must exist in that component's pin list.
- If you need a part that is not listed, explicitly call it out as missing and suggest the closest listed alternative.
- Use only approved Wokwi components from the catalog below.
- If an unavailable part is needed, suggest nearest supported alternative.
- If user explicitly requests custom component behavior, describe it as chip-<name> and mention it requires wokwi.toml + .chip.json/.wasm setup.
- In reply, include two labeled sections:
  1) "Connections" (what connects to what)
  2) "Expected output" (what user sees/gets after connection)
- Treat WOKWI RUNNER EVIDENCE as hard evidence from previous simulation/lint runs.
- If evidence conflicts with assumptions, prefer evidence.
- If lint/run/scenario reports failures, mention the critical failure in reply and provide corrective wiring/build steps.
- If IDEATION CAPTURED META.board exists, keep architecture aligned to that board and avoid switching board families unless user explicitly overrides.
- If IDEATION CAPTURED META.language is micropython, mention micropython-compatible implementation notes in reply.
- If IDEATION CAPTURED META.language is cpp (or missing), produce Arduino C++ oriented guidance.

OUTPUT STRICT JSON:
{
  "architecture": "",
  "components": [],
  "apiEndpoints": [],
  "reply": "",
  "architectureState": {
    "summary": "",
    "pattern": "",
    "sourceStrategy": "",
    "entryFile": "sketch.ino",
    "files": [],
    "libraries": [],
    "pinAssignments": [],
    "runtimeFlow": [],
    "assumptions": [],
    "openDecisions": []
  }
}

IDEA STATE:
${JSON.stringify(project.ideaState)}

CURRENT COMPONENT STATE:
${JSON.stringify(project.componentsState)}

CURRENT ARCHITECTURE STATE:
${JSON.stringify(project.architectureState || {})}

IDEATION CAPTURED META:
${JSON.stringify({
  board: ideationMeta?.board || null,
  powerSource: ideationMeta?.powerSource || null,
  language: ideationMeta?.language || "cpp",
  componentCount: ideationMeta?.componentCount || 0,
  detectedAt: ideationMeta?.detectedAt || null
})}

GENERATION PROFILE:
${JSON.stringify(generationProfile)}

COMPONENT REGISTRY (AI CONTEXT):
You can ONLY use these component names/types/pins/capabilities.
${JSON.stringify(registryContext)}

APPROVED WOKWI COMPONENT CATALOG:
${formatWokwiComponentCatalogForPrompt()}

DETERMINISTIC BOARD PROFILES:
${JSON.stringify(BOARD_PROFILE_MAP)}

WOKWI RUNNER EVIDENCE:
${runnerEvidence}

CONVERSATION:
${messagesText}

USER INPUT:
${userInput}
`;

  const text = await callAI(prompt, { pipeline: "components" });

  try {
    const parsed = safeParse(text);
    const normalized = normalizeComponentsOutput(parsed, project, stripThinking(text));
    return enforceCatalogForComponents(normalized);
  } catch {
    // Keep chat flow alive when model returns plain text instead of strict JSON.
    const normalized = normalizeComponentsOutput({}, project, stripThinking(text));
    return enforceCatalogForComponents(normalized);
  }
};

export const processDesign = async (project, userInput, wokwiContext = null) => {
  const messagesText = (project.designMessages || [])
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");
  const runnerEvidence = buildWokwiEvidenceText(project);

  const prompt = `
You are a Wokwi hardware layout assistant.

GOAL:
Help the user manually build and debug the current Wokwi circuit/layout.

RULES:
- Use ideaState + componentsState + the project description as circuit context.
- Treat LIVE WOKWI CIRCUIT CONTEXT as the source of truth for parts and connections.
- Be practical, concise, and hardware-focused.
- Do not produce app UI/screens/pages/dashboard concepts.
- Do not drift into generic product design language.
- Always describe what to place, how to wire it, what to check, and what the expected simulator behavior is.
- If the project is a Simon Game or similar Arduino build, stay in that domain and keep the advice aligned to the circuit and score display.
- If a response includes multiple steps, keep them in a short sequence that a user can perform manually in Wokwi.
- If a Wokwi URL is provided, treat it as the active source project and align guidance to that project context.
- Never claim a component exists unless it appears in LIVE WOKWI CIRCUIT CONTEXT partTypes.
- If the user says a part does not exist (example: "there is no 9V battery"), acknowledge and correct the previous guidance based on LIVE WOKWI CIRCUIT CONTEXT.
- If a required part is missing from LIVE WOKWI CIRCUIT CONTEXT, say it is missing and provide the exact next manual step to add it.
- Treat WOKWI RUNNER EVIDENCE as hard evidence from real simulations/tests.
- If evidence indicates runtime/lint failure, mention the top failure and prioritize fixes before new feature steps.
- If serial evidence includes errors, include one verification step that proves the fix in simulator output.

OUTPUT STRICT JSON:
{
  "screens": [
    {
      "name": "Current layout",
      "elements": [],
      "actions": []
    }
  ],
  "theme": "Hardware guidance",
  "uxFlow": [],
  "reply": ""
}

PROJECT DESCRIPTION:
${project.description || ""}

WOKWI PROJECT URL:
${project.wokwiUrl || ""}

LIVE WOKWI CIRCUIT CONTEXT (HARDWARE ONLY):
${JSON.stringify(wokwiContext || { connected: false, reason: "No live circuit context" })}

IDEA STATE:
${JSON.stringify(project.ideaState)}

COMPONENT STATE:
${JSON.stringify(project.componentsState)}

CURRENT DESIGN STATE:
${JSON.stringify(project.designState)}

WOKWI RUNNER EVIDENCE:
${runnerEvidence}

CONVERSATION:
${messagesText}

USER INPUT:
${userInput}
`;

  const text = await callAI(prompt, { pipeline: "components" });
  const livePartTypes = (wokwiContext?.partTypes || []).map((item) => String(item).toLowerCase());

  const hasPartType = (pattern) => livePartTypes.some((part) => pattern.test(part));
  const missingMentions = [];

  const buildMissingPartsCorrection = () => {
    const partsLabel = livePartTypes.length > 0 ? livePartTypes.join(", ") : "unknown";
    return `Live Wokwi context does not include: ${missingMentions.join(", ")}. I will only guide using existing circuit parts. Current live part types: ${partsLabel}.`;
  };

  const enforceLiveParts = (replyText) => {
    if (!wokwiContext?.connected) return replyText;

    const textValue = String(replyText || "");
    missingMentions.length = 0;

    if (/\bservo\b/i.test(textValue) && !hasPartType(/servo/)) {
      missingMentions.push("servo");
    }
    if (/\bbattery\b|\b9v\b/i.test(textValue) && !hasPartType(/battery/)) {
      missingMentions.push("battery");
    }

    if (missingMentions.length > 0) {
      return buildMissingPartsCorrection();
    }

    return textValue;
  };

  try {
    const parsed = safeParse(text);
    const normalized = normalizeDesignOutput(parsed, stripThinking(text));

    if (/there\s+is\s+no|no\s+9v\s+battery|not\s+present/i.test(String(userInput))) {
      const hasBattery = livePartTypes.some((part) => part.includes("battery"));
      if (!hasBattery) {
        normalized.reply = "You are correct - there is no battery in the current live Wokwi circuit context. I will only use existing parts unless you explicitly ask to add new ones. Next step: tell me which current part you want to wire or debug.";
      }
    }

    normalized.reply = enforceLiveParts(normalized.reply);

    return normalized;
  } catch {
    // Keep chat flow alive even if the model emits non-JSON text.
    const fallback = normalizeDesignOutput({}, stripThinking(text));
    fallback.reply = enforceLiveParts(fallback.reply);
    return fallback;
  }
};

export const generateWokwiAssetsFromState = async ({ project, userPrompt = "" }) => {
  if (isSimonProjectFromData(project)) {
    return normalizeGeneratedAssetsOutput({
      sketchIno: buildSimonGameSketchFromData(project),
      diagramJson: buildSimonGameDiagramFromData(project),
      notes: ["Generated from project JSON data using the Simon hardware profile."]
    });
  }

  const ideationContext = JSON.stringify(project?.ideaState || {});
  const componentsContext = JSON.stringify(project?.componentsState || {});
  const ideationMeta = project?.meta || {};
  const ideationMessages = (project?.messages || []).slice(-6).map((m) => `${m.role}: ${m.content}`).join("\n");
  const componentsMessages = (project?.componentsMessages || []).slice(-10).map((m) => `${m.role}: ${m.content}`).join("\n");
  const registryContext = getAIContext();
  const generationProfile = project?.generationProfile || buildGenerationProfileFromMeta(ideationMeta);

  const prompt = `
You are a strict embedded systems code generator.

GOAL:
Generate two files for Wokwi based on ideation + components AI context:
1) sketch.ino
2) diagram.json

MANDATORY OUTPUT FORMAT:
Return ONLY valid JSON with this exact top-level shape:
{
  "sketchIno": "...",
  "diagramJson": {
    "version": 1,
    "author": "...",
    "editor": "wokwi",
    "parts": [],
    "connections": [],
    "dependencies": {}
  },
  "notes": []
}

HARD RULES:
- No markdown fences.
- No explanation outside JSON.
- sketchIno must be complete C++ Arduino code with setup() and loop().
- sketchIno style must follow this structure: header comment block, include pitches.h, constants, global state, helper functions, setup, loop.
- diagramJson must be valid Wokwi diagram schema.
- diagramJson.parts MUST be built using COMPONENT REGISTRY (AI CONTEXT) below.
- diagramJson.parts[*].type must be the registry item's "type" (wokwiType).
- Any pin used in diagramJson.connections must exist in that component's pin list from the registry.
- If you need a part not present in the registry, add a note describing the missing part and choose the closest available registry part.
- Use only supported Wokwi parts from this catalog:
${formatWokwiComponentCatalogForPrompt()}
- If context suggests custom chip, use type chip-<name> and include in parts only if clearly requested.
- Ensure pin mapping between sketch and diagram is consistent.
- diagramJson.connections must NOT be empty.
- Deterministic board profile lock must be followed when IDEATION CAPTURED META.board exists.
- IDEATION CAPTURED META is hard context:
  - If board exists, diagramJson.parts must include that board family as the primary controller part.
  - If language is cpp (or missing), keep full Arduino C++ sketch.ino output.
  - If language is micropython, still output a valid sketch.ino fallback plus a note explaining this repo currently targets sketch.ino for simulation handoff.
  - If powerSource exists, include it as practical assumptions in notes and wiring approach.
- Every connection entry must be in this exact format: ["fromPin", "toPin", "color", ["routeStep1", "routeStep2", ...]]
- Use route steps with the same style as Wokwi examples, for example:
  ["sr2:Q2", "sevseg2:C", "green", ["v-38.4", "h-38.4"]]
  ["sr1:Q5", "sevseg1:F", "green", ["v-24", "h-19.2", "v-110.4", "h19.2"]]

COMPONENT REGISTRY (AI CONTEXT):
You can ONLY use these component names/types/pins/capabilities.
${JSON.stringify(registryContext)}

PROJECT DESCRIPTION:
${project?.description || ""}

IDEATION STATE:
${ideationContext}

ARCHITECTURE STATE:
${JSON.stringify(project?.architectureState || {})}

COMPONENTS STATE:
${componentsContext}

IDEATION CAPTURED META:
${JSON.stringify({
  board: ideationMeta?.board || null,
  powerSource: ideationMeta?.powerSource || null,
  language: ideationMeta?.language || "cpp",
  componentCount: ideationMeta?.componentCount || 0,
  detectedAt: ideationMeta?.detectedAt || null
})}

GENERATION PROFILE:
${JSON.stringify(generationProfile)}

DETERMINISTIC BOARD PROFILES:
${JSON.stringify(BOARD_PROFILE_MAP)}

RECENT IDEATION MESSAGES:
${ideationMessages}

RECENT COMPONENTS MESSAGES:
${componentsMessages}

USER EXTRA INSTRUCTION:
${userPrompt || "Generate best-fit sketch and diagram from the existing project context."}
`;

  try {
    const text = await callAI(prompt, { pipeline: "components" });

    let parsedPayload;
    try {
      parsedPayload = safeParse(text);
    } catch {
      parsedPayload = recoverGeneratedAssetsFromText(text);
    }

    const normalized = normalizeGeneratedAssetsOutput(
      parsedPayload || {
        sketchIno: fallbackGeneratedSketch,
        diagramJson: fallbackGeneratedDiagram,
        notes: ["Fallback template used because AI output could not be parsed."]
      }
    );

    const deterministic = applyDeterministicBoardProfile({
      assets: normalized,
      meta: ideationMeta
    });

    const validated = validateGeneratedAssets({
      sketchIno: deterministic.sketchIno,
      diagramJson: deterministic.diagramJson,
      meta: ideationMeta
    });

    return {
      ...deterministic,
      notes: validated.ok
        ? deterministic.notes
        : [...new Set([...deterministic.notes, `Validation issues: ${validated.issues.join("; ")}`])]
    };
  } catch {
    const normalized = normalizeGeneratedAssetsOutput({
      sketchIno: fallbackGeneratedSketch,
      diagramJson: fallbackGeneratedDiagram,
      notes: ["Fallback template used because generation failed before parse."]
    });

    return applyDeterministicBoardProfile({
      assets: normalized,
      meta: ideationMeta
    });
  }
};

const normalizeComponentsOutput = (raw, project, fallbackReply = "I generated components guidance. Ask a follow-up for exact wiring and expected behavior.") => {
  const architecture = typeof raw?.architecture === "string" ? raw.architecture.trim() : "";
  const components = cleanArray(raw?.components);
  const apiEndpoints = cleanArray(raw?.apiEndpoints);

  const formatReplyValue = (value) => {
    if (typeof value === "string") {
      return value.trim();
    }

    if (Array.isArray(value)) {
      return cleanArray(value).join("\n");
    }

    if (!value || typeof value !== "object") {
      return "";
    }

    const sections = Object.entries(value)
      .map(([label, sectionValue]) => {
        if (typeof sectionValue === "string") {
          const text = sectionValue.trim();
          return text ? `${label}: ${text}` : "";
        }

        if (Array.isArray(sectionValue)) {
          const list = cleanArray(sectionValue);
          return list.length > 0 ? `${label}: ${list.join(", ")}` : "";
        }

        if (!sectionValue || typeof sectionValue !== "object") {
          return "";
        }

        const lines = Object.entries(sectionValue)
          .map(([k, v]) => {
            const text = typeof v === "string" ? v.trim() : "";
            return text ? `- ${k}: ${text}` : "";
          })
          .filter(Boolean);

        return lines.length > 0 ? `${label}:\n${lines.join("\n")}` : "";
      })
      .filter(Boolean);

    return sections.join("\n\n").trim();
  };

  let reply = formatReplyValue(raw?.reply);
  if (!reply) {
    reply = fallbackReply;
  }

  return {
    architecture,
    components,
    apiEndpoints,
    reply,
    architectureState: normalizeArchitectureState(raw?.architectureState, {
      project,
      summary: project?.ideaState?.summary || "",
      requirements: project?.ideaState?.requirements || [],
      unknowns: project?.ideaState?.unknowns || []
    })
  };
};

const normalizeDesignOutput = (raw, fallbackReply = "I analyzed the live circuit context. Ask for the next exact wiring/debug step.") => {
  const screens = Array.isArray(raw?.screens)
    ? raw.screens.map((screen) => ({
        name: typeof screen?.name === "string" ? screen.name.trim() : "",
        elements: cleanArray(screen?.elements),
        actions: cleanArray(screen?.actions)
      }))
    : [];

  const theme = typeof raw?.theme === "string" ? raw.theme.trim() : "Hardware guidance";
  const uxFlow = cleanArray(raw?.uxFlow);

  let reply = typeof raw?.reply === "string" ? raw.reply.trim() : "";
  if (!reply) {
    reply = fallbackReply;
  }

  return {
    screens,
    theme,
    uxFlow,
    reply
  };
};
