import Groq from "groq-sdk";
import { buildWokwiEvidenceText } from "./wokwi-runner.service.js";
import { formatBoardPinsForPrompt, selectBoardPinDefinition } from "../lib/arduino-boards.js";

let groqClient = null;

const getGroqClient = () => {
  if (groqClient) {
    return groqClient;
  }

  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY. Add it to backend/.env before using AI endpoints.");
  }

  groqClient = new Groq({ apiKey });
  return groqClient;
};

const cleanArray = (value) => {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .map(item => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
  )];
};

const toKeywordText = (...values) => {
  return values
    .flat()
    .map((value) => (typeof value === "string" ? value.toLowerCase() : ""))
    .join(" ");
};

const inferComponentsFallback = (project = {}) => {
  const text = toKeywordText(
    project?.description,
    project?.ideaState?.summary,
    project?.ideaState?.requirements
  );

  const baseBoard = /\besp32\b|\bdevkit\b|\bwroom\b|\bgpio\d+/i.test(text)
    ? "ESP32 DevKit V1"
    : "Arduino Uno";

  const inferred = [
    baseBoard,
    "Breadboard",
    "Jumper wires"
  ];

  if (/\bled\b|\bblink\b|\blight\b/.test(text)) inferred.push("LED");
  if (/\bresistor\b|\bled\b/.test(text)) inferred.push("220 ohm resistor");
  if (/\bbuzzer\b|\balarm\b|\balert\b/.test(text)) inferred.push("Piezo buzzer");
  if (/\blcd\b|\boled\b|\bdisplay\b/.test(text)) inferred.push("I2C 16x2 LCD display module");
  if (/\bultrasonic\b|\bdistance\b/.test(text)) inferred.push("HC-SR04 ultrasonic sensor");
  if (/\btemperature\b|\bhumid/.test(text)) inferred.push("DHT11 sensor");
  if (/\bservo\b/.test(text)) inferred.push("SG90 servo motor");
  if (/\brelay\b/.test(text)) inferred.push("1-channel relay module");

  return cleanArray(inferred);
};

const ensureComponentsReply = ({ architecture = "", components = [], reply = "" }) => {
  const items = cleanArray(components);
  const baseReply = String(reply || "").trim();
  const componentsSection = [
    "**Components list**",
    ...items.map((item) => `- ${item}`)
  ].join("\n");

  if (!baseReply) {
    const architectureLine = architecture ? `Architecture: ${architecture}` : "Architecture: Basic microcontroller setup with clear wiring blocks.";
    return [
      componentsSection,
      "",
      architectureLine,
      "",
      "**Connections**",
      "- Connect each sensor/output module to Arduino power (5V) and GND.",
      "- Connect signal pins from modules to the required Arduino digital/analog pins.",
      "",
      "**Expected output**",
      "- System powers on and responds to input with the defined output behavior."
    ].join("\n");
  }

  if (/components?\s*list/i.test(baseReply)) {
    return baseReply;
  }

  return `${componentsSection}\n\n${baseReply}`;
};

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 2500;

const buildConversationText = (messages = []) => {
  const recent = Array.isArray(messages) ? messages.slice(-MAX_HISTORY_MESSAGES) : [];
  const text = recent
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  if (text.length <= MAX_HISTORY_CHARS) {
    return text;
  }

  return text.slice(text.length - MAX_HISTORY_CHARS);
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

const summarizeUserInput = (text = "") => {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= 90) return cleaned;
  return `${cleaned.slice(0, 87)}...`;
};

const BUILD_CONFIRMATION_UNKNOWN = "build-phase-confirmation";
const BUILD_CONFIRMATION_QUESTION = "Want me to generate the circuit and code for this?";

const getBoardPromptContext = (project = {}, userInput = "") => {
  const definition = selectBoardPinDefinition(project, userInput);

  return {
    boardName: definition?.board || "Arduino Uno (ATmega328P)",
    pinKnowledge: formatBoardPinsForPrompt(definition)
  };
};

const hasPrematureBuildDetails = (text = "") => {
  const value = String(text).toLowerCase();
  return /(pin\s*\d+|gpio|wiring|wire it|connect\s+to\s+pin|breadboard\s+layout|schematic|diagram|code\s*[:\n]|sketch\.ino|cpp|void\s+setup\s*\(|components?\s*list)/i.test(value);
};

const isBuildConfirmationAccepted = (text = "") => {
  const value = String(text).toLowerCase().trim();
  return /^(yes|yeah|yep|sure|ok|okay|go ahead|proceed|continue|start|build it|step by step|step-by-step|generate circuit and code|generate it)/i.test(value);
};

const buildShortConceptReply = ({ summary = "", requirements = [] }) => {
  const conciseSummary = summary || "Beginner-friendly hardware concept based on your idea.";
  const whatItDoes = conciseSummary;
  const howItWorks = "Sensor/input reads data, controller decides, then output shows or alerts.";
  const improvements = cleanArray(requirements).slice(0, 2);
  const improvementLines = improvements.length > 0
    ? improvements.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. Add buzzer alerts\n2. Add display feedback";

  return [
    "That’s a nice idea — here’s how it could work:",
    "",
    "Project: Smart Hardware Starter",
    "",
    "What it does:",
    whatItDoes,
    "",
    "How it works:",
    howItWorks,
    "",
    "You could also:",
    `- ${improvementLines.split("\n")[0].replace(/^\d+\.\s*/, "")}`,
    `- ${improvementLines.split("\n")[1]?.replace(/^\d+\.\s*/, "") || "Add display feedback"}`,
    "",
    BUILD_CONFIRMATION_QUESTION,
  ].join("\n");
};

const buildFallbackIdeationReply = ({ summary, requirements, unknowns, question, userInput }) => {
  const conciseUserInput = summarizeUserInput(userInput);

  if (isTransitionToComponentsRequest(userInput)) {
    if (unknowns.length === 0) {
      return "Ideation is finalized. Open the Components section to get wiring, connections, and expected output details.";
    }

    return `Before Components section, I need your confirmation. ${BUILD_CONFIRMATION_QUESTION}`;
  }

  if (isIdeaOnlyRequest(userInput)) {
    return buildShortConceptReply({ summary, requirements });
  }

  if (conciseUserInput) {
    return [
      `Plan updated from your input: ${conciseUserInput}`,
      buildShortConceptReply({ summary, requirements })
    ].join("\n");
  }

  if (unknowns.length > 0) {
    const base = buildShortConceptReply({ summary, requirements });
    return question ? `${base}\nClarification: ${question}` : base;
  }

  return buildShortConceptReply({ summary, requirements });
};

const applyIdeationGuards = (project, userInput, output) => {
  const sanitized = { ...output };
  const confirmed = isBuildConfirmationAccepted(userInput);

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

  const tooLong = sanitized.assistantReply.length > 500;
  if (tooLong) {
    sanitized.assistantReply = buildFallbackIdeationReply({
      summary: sanitized.summary,
      requirements: sanitized.requirements,
      unknowns: sanitized.unknowns,
      question: sanitized.question,
      userInput
    });
  }

  if (!confirmed && hasPrematureBuildDetails(sanitized.assistantReply)) {
    sanitized.assistantReply = buildFallbackIdeationReply({
      summary: sanitized.summary,
      requirements: sanitized.requirements,
      unknowns: sanitized.unknowns,
      question: sanitized.question,
      userInput
    });
  }

  if (!confirmed) {
    sanitized.unknowns = cleanArray([...sanitized.unknowns, BUILD_CONFIRMATION_UNKNOWN]);
    sanitized.question = BUILD_CONFIRMATION_QUESTION;

    if (!new RegExp(BUILD_CONFIRMATION_QUESTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(sanitized.assistantReply)) {
      sanitized.assistantReply = `${sanitized.assistantReply}\n${BUILD_CONFIRMATION_QUESTION}`.trim();
    }
  } else {
    sanitized.unknowns = cleanArray(sanitized.unknowns).filter((item) => item !== BUILD_CONFIRMATION_UNKNOWN);
    if (sanitized.question === BUILD_CONFIRMATION_QUESTION) {
      sanitized.question = "";
    }
  }

  return sanitized;
};

/*
UTIL: safe JSON parse
*/
const safeParse = (text) => {
  const cleaned = stripThinking(text);

  try {
    return JSON.parse(cleaned);
  } catch {
    // try to extract JSON block
    const jsonBlock = cleaned.match(/```json\s*([\s\S]*?)\s*```/i);
    if (jsonBlock?.[1]) {
      try {
        return JSON.parse(jsonBlock[1]);
      } catch {}
    }

    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    throw new Error("AI response parsing failed");
  }
};

/*
COMMON CALL
*/
const callAI = async (prompt, options = {}) => {
  const {
    maxCompletionTokens = 800,
    temperature = 0.2,
    topP = 0.9
  } = options;

  const groq = getGroqClient();
  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
    messages: [{ role: "user", content: prompt }],
    temperature,
    max_completion_tokens: maxCompletionTokens,
    top_p: topP
  });

  const text = completion.choices?.[0]?.message?.content || "";
  return String(text).trim();
};

const normalizeIdeationOutput = (raw, userInput, fallbackQuestion = BUILD_CONFIRMATION_QUESTION) => {
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
    assistantReply = question || "Project concept updated with practical defaults.";
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
    assistantReply
  };
};

/*
========================
IDEATION (your original upgraded)
========================
*/
export const processInput = async (project, userInput) => {

  const messagesText = buildConversationText(project.messages);
  const boardContext = getBoardPromptContext(project, userInput);

  const prompt = `
  You are a project designer AI that turns user ideas into structured hardware projects.
  You are NeuroBoard AI, a friendly and smart helper that guides users in building electronics projects from their ideas.
  Be friendly, clear, slightly conversational, and easy for beginners to follow.

  Primary goal:
  Guide users from idea -> clear project concept -> build flow.

  INTERACTION RULES (MANDATORY):
  1) Idea -> Project Concept first.
    - Start naturally, like a human helper.
    - Briefly acknowledge the idea.
    - Immediately shape the idea into a project concept.
    - Do NOT jump into components, wiring, or code.
    - Ask at most 1-2 simple follow-up questions only if absolutely necessary.

  2) Convert idea into a clear concept using this exact structure:
    - Project: <name>
    - What it does:
    - How it works:

  3) Suggest improvements without overwhelming:
    - Provide 1-2 useful upgrades only.
    - Keep them light and optional.

  4) Always confirm before build phase:
    - End with exactly: "Want me to generate the circuit and code for this?"
    - Do NOT move to components/circuit/code unless user agrees.

  5) Build phase ordering (for future only after confirmation):
    - Components -> Circuit -> Code

  6) Keep direction tight:
    - Keep responses short and structured.
    - Use easy words.
    - Avoid long paragraphs.
    - Avoid overly robotic or textbook language.

  TONE AND STYLE:
  - Friendly, clear, and slightly conversational
  - Beginner-friendly words
  - Keep responses short and practical

  OUTPUT CONSTRAINTS:
  - Keep assistantReply concise.
  - assistantReply must include this structure in order:
    1) Short friendly intro
    2) Project
    2) What it does
    3) How it works
    4) You could also
    5) Final confirmation question
  - Keep unknowns specific.
  - If user has not confirmed build, keep an unknown indicating pending build confirmation.
  - Never include component lists, pin mappings, wiring steps, or code while awaiting confirmation.
  - If user asks pin-related questions before confirmation, acknowledge only at high level and keep build confirmation pending.
  - NEVER output anything outside JSON.
  - DO NOT include <think> tags.

PIN DIAGRAM KNOWLEDGE (REFERENCE ONLY, DO NOT DUMP IN REPLY DURING IDEATION):
${boardContext.pinKnowledge}

OUTPUT STRICT JSON:

{
  "summary": "",
  "requirements": [],
  "unknowns": [],
  "question": "",
  "assistantReply": ""
}

PROJECT DESCRIPTION:
${project.description}

CURRENT STATE:
${JSON.stringify(project.ideaState)}

CONVERSATION:
${messagesText}

NEW USER INPUT:
${userInput}
`;

  const text = await callAI(prompt, { maxCompletionTokens: 320, temperature: 0.1, topP: 0.85 });
  const parsed = safeParse(text);

  const normalized = normalizeIdeationOutput(parsed, userInput);
  return applyIdeationGuards(project, userInput, normalized);

  
};


/*
========================
COMPONENTS AI
========================
*/
export const processComponents = async (project, userInput) => {

  const messagesText = buildConversationText(project.componentsMessages || []);
  const runnerEvidence = buildWokwiEvidenceText(project);
  const boardContext = getBoardPromptContext(project, userInput);

  const prompt = `
You are a hardware systems architect.

GOAL:
Convert finalized idea into system architecture and components.

RULES:
- Use ideaState as ground truth
- Be precise and practical
- No vague components
- Output must be buildable
- Use exact valid pin labels from the selected board reference. Never invent pins.
- Include concise implementation guidance in reply.
- Use short, clear sentences.
- Highlight important labels using markdown bold like **Connections** and **Expected output**.
- Keep the reply skimmable with small sections and bullet points.
- In reply, include two labeled sections:
  1) "Connections" (what connects to what)
  2) "Expected output" (what user sees/gets after connection)
- Treat WOKWI RUNNER EVIDENCE as hard evidence from previous simulation/lint runs.
- If evidence conflicts with assumptions, prefer evidence.
- If lint/run/scenario reports failures, mention the critical failure in reply and provide corrective wiring/build steps.

SELECTED BOARD PIN REFERENCE (SOURCE OF TRUTH):
${boardContext.pinKnowledge}

OUTPUT STRICT JSON:

{
  "architecture": "",
  "components": [],
  "apiEndpoints": [],
  "reply": ""
}

IDEA STATE:
${JSON.stringify(project.ideaState)}

CURRENT COMPONENT STATE:
${JSON.stringify(project.componentsState)}

WOKWI RUNNER EVIDENCE:
${runnerEvidence}

CONVERSATION:
${messagesText}

USER INPUT:
${userInput}
`;

  const text = await callAI(prompt, { maxCompletionTokens: 1100, temperature: 0.2, topP: 0.9 });

  try {
    const parsed = safeParse(text);
    return normalizeComponentsOutput(parsed, stripThinking(text), project);
  } catch {
    // Keep chat flow alive when model returns plain text instead of strict JSON.
    return normalizeComponentsOutput({}, stripThinking(text), project);
  }
};


/*
========================
DESIGN AI
========================
*/
export const processDesign = async (project, userInput, wokwiContext = null) => {

  const messagesText = buildConversationText(project.designMessages || []);
  const runnerEvidence = buildWokwiEvidenceText(project);
  const boardContext = getBoardPromptContext(project, userInput);

  const prompt = `
You are a Wokwi hardware layout assistant.

GOAL:
Help the user manually build and debug the current Wokwi circuit/layout.

RULES:
- Use ideaState + componentsState + the project description as circuit context.
- Treat LIVE WOKWI CIRCUIT CONTEXT as the source of truth for parts and connections.
- Be practical, concise, and hardware-focused.
- Use short, clear sentences.
- Highlight key steps/labels using markdown bold where helpful.
- Keep answers easy to scan with small bullets.
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
- Use exact valid pin labels from the selected board reference. Never invent pins.

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

SELECTED BOARD PIN REFERENCE (SOURCE OF TRUTH):
${boardContext.pinKnowledge}
`;

  const text = await callAI(prompt, { maxCompletionTokens: 700, temperature: 0.2, topP: 0.9 });
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

const normalizeComponentsOutput = (
  raw,
  fallbackReply = "I generated components guidance. Ask a follow-up for exact wiring and expected behavior.",
  project = {}
) => {
  const architecture = typeof raw?.architecture === "string" ? raw.architecture.trim() : "";
  const parsedComponents = cleanArray(raw?.components);
  const components = parsedComponents.length > 0 ? parsedComponents : inferComponentsFallback(project);
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
  reply = ensureComponentsReply({ architecture, components, reply });

  return {
    architecture,
    components,
    apiEndpoints,
    reply
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
