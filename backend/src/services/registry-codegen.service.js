import Groq from "groq-sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getGroqModelComponents } from "../config/groq-models.js";
import { getRegistry, getAIContext } from "./registry.service.js";

let GROQ_CLIENT = null;
const getGroqClient = () => {
  if (GROQ_CLIENT) return GROQ_CLIENT;
  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    // Important: keep module importable for offline validation/tests.
    // We only require GROQ_API_KEY when actually calling the model.
    throw new Error("GROQ_API_KEY is missing (required only for plan generation).");
  }
  GROQ_CLIENT = new Groq({ apiKey });
  return GROQ_CLIENT;
};

const stripThinking = (value = "") => {
  return String(value || "")
    // Strip both closed and unclosed <think> blocks (some models omit </think>)
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "")
    .trim();
};

const stripJsonComments = (value = "") => {
  // AI sometimes returns "JSON" with JS-style comments. JSON doesn't allow them.
  // We strip full-line comments and block comments as a best-effort recovery.
  // (Not a full JSON tokenizer; good enough for our plan JSON contract.)
  return String(value || "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
};

const normalizeJsonishText = (value = "") => {
  return String(value || "")
    // smart quotes → normal quotes
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
};

const stripTrailingCommas = (value = "") => {
  // Common LLM mistake: trailing commas before } or ]
  return String(value || "").replace(/,(\s*[}\]])/g, "$1");
};

const extractFirstBalancedObject = (value = "") => {
  const text = String(value || "");
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

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
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
};

const safeParseJson = (text = "") => {
  const cleaned = stripTrailingCommas(stripJsonComments(normalizeJsonishText(stripThinking(text))));
  try {
    return JSON.parse(cleaned);
  } catch {
    const jsonBlock = cleaned.match(/```json\s*([\s\S]*?)\s*```/i);
    if (jsonBlock?.[1]) {
      const candidate = stripTrailingCommas(stripJsonComments(normalizeJsonishText(jsonBlock[1])));
      return JSON.parse(candidate);
    }
    const balanced = extractFirstBalancedObject(cleaned);
    if (balanced) {
      const candidate = stripTrailingCommas(stripJsonComments(normalizeJsonishText(balanced)));
      return JSON.parse(candidate);
    }
    throw new Error("AI response parsing failed");
  }
};

const callAI = async (prompt) => {
  const groq = getGroqClient();
  const model = getGroqModelComponents();

  // Prefer Groq structured outputs when available; otherwise fall back to prompt-only.
  const baseArgs = {
    model,
    messages: [
      { role: "system", content: "Return ONLY valid JSON. No markdown. No prose. No <think>." },
      { role: "user", content: prompt }
    ],
    temperature: 0
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

  return String(res.choices?.[0]?.message?.content || "").trim();
};

const getPresetDir = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../data/presets");
};

const buildServoOverdonePreset = () => {
  const presetDir = path.join(getPresetDir(), "servo-overdone");
  const sketchIno = readFileSync(path.join(presetDir, "servo.ino"), "utf8");
  const diagramRaw = readFileSync(path.join(presetDir, "diagram.json"), "utf8");
  const diagramJson = JSON.parse(diagramRaw);

  return {
    sketchIno,
    diagramJson,
    notes: ["NovaAId preset: 32 dancing servos (ServoOverdone)."],
    plan: null
  };
};

const defaultAttrsFor = (registryDef) => {
  const attrs = registryDef?.attrs && typeof registryDef.attrs === "object" ? registryDef.attrs : {};
  return Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, v?.default ?? null]));
};

const pickDefaultBoardKey = (registry) => {
  const entries = Object.entries(registry || {});
  const controllers = entries.filter(([, def]) => String(def?.category || "").toLowerCase() === "controller");
  if (controllers.length === 1) return controllers[0][0];
  if (controllers.length > 1) return controllers[0][0];
  if (entries.length > 0) return entries[0][0];
  return "";
};

const computeLayout = (count) => {
  const cols = Math.max(2, Math.min(4, Math.ceil(Math.sqrt(Math.max(1, count)))));
  const gapX = 170;
  const gapY = 140;
  const startX = 140;
  const startY = 90;
  return { cols, gapX, gapY, startX, startY };
};

/** Wokwi diagram import: omit simulator/runtime attrs (pressed, xray) and registry defaults; keep only explicit static fields from the plan. */
const minimalPushbuttonAttrs = (planAttrs) => {
  const src = planAttrs && typeof planAttrs === "object" ? planAttrs : {};
  const out = {};
  if (src.color != null && String(src.color).trim() !== "") out.color = src.color;
  if (src.key != null && String(src.key).trim() !== "") out.key = src.key;
  if (src.label != null && String(src.label).trim() !== "") out.label = String(src.label);
  return out;
};

/** Wokwi docs: common, digits ("1"–"4"), colon ("" | "1"), optional color. */
const sevenSegDigitsFromType = (compType) => {
  const m = String(compType || "").match(/^SEVEN_SEGMENT_([1-4])$/);
  return m ? m[1] : "1";
};

const minimalSevenSegmentAttrs = (def, comp) => {
  const defaults = defaultAttrsFor(def);
  const planA = comp?.attrs && typeof comp.attrs === "object" ? comp.attrs : {};

  const rawCommon = planA.common ?? planA.commonPin ?? defaults.common;
  const common = rawCommon === "cathode" || rawCommon === "anode" ? rawCommon : "anode";

  let digits =
    planA.digits != null && String(planA.digits).trim() !== ""
      ? String(planA.digits)
      : String(defaults.digits ?? sevenSegDigitsFromType(comp?.type));
  if (!/^[1-4]$/.test(digits)) digits = sevenSegDigitsFromType(comp?.type);

  const c = planA.colon;
  let colonOut = "";
  if (c === true || String(c) === "1") colonOut = "1";
  else {
    const d = defaults.colon;
    if (d === true || String(d) === "1") colonOut = "1";
  }

  const colorVal =
    planA.color != null && String(planA.color).trim() !== "" ? planA.color : defaults.color;

  const out = { common, digits, colon: colonOut };
  if (colorVal != null && String(colorVal).trim() !== "") out.color = String(colorVal);
  return out;
};

/** Wokwi wokwi-servo docs: only horn + hornColor; omit angle and other runtime/editor fields. */
const SERVO_HORN_VALUES = new Set(["single", "double", "cross"]);

const minimalServoAttrs = (def, comp) => {
  const defaults = defaultAttrsFor(def);
  const planA = comp?.attrs && typeof comp.attrs === "object" ? comp.attrs : {};

  const rawHorn =
    planA.horn != null && String(planA.horn).trim() !== ""
      ? String(planA.horn)
      : defaults.horn != null
        ? String(defaults.horn)
        : "single";
  const horn = SERVO_HORN_VALUES.has(rawHorn) ? rawHorn : "single";

  const hornColor =
    planA.hornColor != null && String(planA.hornColor).trim() !== ""
      ? String(planA.hornColor)
      : defaults.hornColor != null
        ? String(defaults.hornColor)
        : "#ccc";

  return { horn, hornColor };
};

const generateParts = (registry, plan) => {
  const items = Array.isArray(plan?.components) ? plan.components : [];
  const { cols, gapX, gapY, startX, startY } = computeLayout(items.length + 1);

  const parts = [];

  const boardKey = plan?.board?.type || "";
  const boardDef = registry[boardKey];
  if (!boardDef) {
    throw new Error(`Board type not found in registry: ${boardKey || "(empty)"}`);
  }

  parts.push({
    type: boardDef.wokwiType,
    id: String(plan?.board?.id || "board"),
    top: Number.isFinite(plan?.board?.top) ? plan.board.top : 270,
    left: Number.isFinite(plan?.board?.left) ? plan.board.left : 185,
    attrs: {
      ...defaultAttrsFor(boardDef),
      ...(plan?.board?.attrs && typeof plan.board.attrs === "object" ? plan.board.attrs : {})
    }
  });

  items.forEach((comp, idx) => {
    const def = registry[comp.type];
    if (!def) {
      throw new Error(`Component type not found in registry: ${comp.type || "(empty)"}`);
    }
    const row = Math.floor(idx / cols);
    const col = idx % cols;
    const isPushbutton = comp.type === "PUSHBUTTON" || comp.type === "PUSHBUTTON_6MM";
    const isSevenSeg = def.wokwiType === "wokwi-7segment";
    const isServo = def.wokwiType === "wokwi-servo";
    const attrs = isPushbutton
      ? minimalPushbuttonAttrs(comp.attrs)
      : isSevenSeg
        ? minimalSevenSegmentAttrs(def, comp)
        : isServo
          ? minimalServoAttrs(def, comp)
          : {
              ...defaultAttrsFor(def),
              ...(comp.attrs && typeof comp.attrs === "object" ? comp.attrs : {})
            };

    parts.push({
      type: def.wokwiType,
      id: String(comp.id || `${comp.type.toLowerCase()}${idx + 1}`),
      top: Number.isFinite(comp.top) ? comp.top : startY + row * gapY,
      left: Number.isFinite(comp.left) ? comp.left : startX + col * gapX,
      rotate: Number.isFinite(comp.rotate) ? comp.rotate : undefined,
      attrs
    });
  });

  return parts.map((p) => {
    const cleaned = { ...p, hide: false };
    if (cleaned.rotate === undefined) delete cleaned.rotate;
    return cleaned;
  });
};

export { generateParts };

const validatePinExists = (registry, compType, pinName) => {
  const def = registry[compType];
  if (!def) throw new Error(`Unknown component type: ${compType}`);
  const pins = Array.isArray(def.pins) ? def.pins.map((p) => p.name) : [];
  if (!pins.includes(pinName)) {
    throw new Error(`Invalid pin "${pinName}" for component "${compType}"`);
  }
};

export const validatePlan = (registry, plan) => {
  const errors = [];

  const add = (msg) => errors.push(String(msg));
  if (!plan || typeof plan !== "object") {
    add("plan must be an object");
    return { ok: false, errors };
  }

  if (!plan.board || typeof plan.board !== "object") {
    add("plan.board is required");
  } else {
    if (!plan.board.type) add("plan.board.type is required");
    if (!plan.board.id) add("plan.board.id is required");
    if (plan.board.type && !registry[plan.board.type]) add(`board type not in registry: ${plan.board.type}`);
  }

  const components = Array.isArray(plan.components) ? plan.components : [];
  const ids = new Map();

  const register = (type, id) => {
    if (!type || !id) return;
    if (ids.has(id)) add(`duplicate id: ${id}`);
    ids.set(id, type);
  };

  if (plan.board?.type && plan.board?.id) register(plan.board.type, plan.board.id);

  components.forEach((c, idx) => {
    if (!c || typeof c !== "object") return add(`component at index ${idx} must be an object`);
    if (!c.type) add(`component[${idx}].type is required`);
    if (!c.id) add(`component[${idx}].id is required`);
    if (c.type && !registry[c.type]) add(`component type not in registry: ${c.type}`);
    if (c.type && c.id) register(c.type, c.id);
  });

  const wires = Array.isArray(plan.connections) ? plan.connections : [];

  const isNumericPin = (pin) => {
    const n = Number(pin);
    return Number.isFinite(n) && String(pin).trim() === String(n);
  };

  const isWireBetween = (a, b) => {
    // endpoints are {type,id,pin}
    if (!a || !b) return false;
    return (
      (a.type === b.type && a.id === b.id && a.pin === b.pin)
    );
  };

  const hasConnection = (end1, end2) => {
    for (const w of wires) {
      const from = w?.from;
      const to = w?.to;
      if (!from || !to) continue;
      const matchDirect = isWireBetween(from, end1) && isWireBetween(to, end2);
      const matchReverse = isWireBetween(from, end2) && isWireBetween(to, end1);
      if (matchDirect || matchReverse) return true;
    }
    return false;
  };

  const hasAnyConnectionToPin = (componentType, componentId, componentPin) => {
    for (const w of wires) {
      const from = w?.from;
      const to = w?.to;
      if (!from || !to) continue;
      const a = from.type === componentType && from.id === componentId && from.pin === componentPin;
      const b = to.type === componentType && to.id === componentId && to.pin === componentPin;
      if (a || b) return true;
    }
    return false;
  };

  const boardEndForPin = (pin) => ({
    type: plan.board?.type,
    id: plan.board?.id,
    pin
  });

  const findBoardPinFor = (componentType, componentId, componentPin) => {
    for (const w of wires) {
      const from = w?.from;
      const to = w?.to;
      if (!from || !to) continue;

      const aIsTarget = from.type === componentType && from.id === componentId && from.pin === componentPin;
      const bIsTarget = to.type === componentType && to.id === componentId && to.pin === componentPin;

      if (aIsTarget && to.type === plan.board?.type && to.id === plan.board?.id) return to.pin;
      if (bIsTarget && from.type === plan.board?.type && from.id === plan.board?.id) return from.pin;
    }
    return null;
  };
  wires.forEach((w, idx) => {
    const from = w?.from;
    const to = w?.to;
    if (!from || !to) return add(`connection[${idx}] must include from and to`);
    if (!from.type || !from.id || !from.pin) add(`connection[${idx}].from must include type,id,pin`);
    if (!to.type || !to.id || !to.pin) add(`connection[${idx}].to must include type,id,pin`);

    if (from?.id && ids.get(from.id) && from.type && ids.get(from.id) !== from.type) {
      add(`connection[${idx}].from type mismatch for id ${from.id}`);
    }
    if (to?.id && ids.get(to.id) && to.type && ids.get(to.id) !== to.type) {
      add(`connection[${idx}].to type mismatch for id ${to.id}`);
    }

    if (from?.type && from?.pin) {
      try { validatePinExists(registry, from.type, from.pin); } catch (e) { add(`connection[${idx}].from: ${e.message}`); }
    }
    if (to?.type && to?.pin) {
      try { validatePinExists(registry, to.type, to.pin); } catch (e) { add(`connection[${idx}].to: ${e.message}`); }
    }
  });

  // Stepper policy: STEPPER_MOTOR must be driven via A4988_DRIVER
  const planComponents = Array.isArray(plan.components) ? plan.components : [];
  const steppers = planComponents.filter((c) => c?.type === "STEPPER_MOTOR");
  const drivers = planComponents.filter((c) => c?.type === "A4988_DRIVER");

  if (steppers.length > 0 && drivers.length !== steppers.length) {
    add(`stepper policy: expected exactly 1 A4988_DRIVER per STEPPER_MOTOR (steppers=${steppers.length}, drivers=${drivers.length})`);
  }

  // Pair steppers to drivers by wiring signature (4 coil wires).
  const unusedDrivers = new Set(drivers.map((d) => d.id));
  const coilPairs = [
    ["2B", "A-"],
    ["2A", "A+"],
    ["1A", "B+"],
    ["1B", "B-"]
  ];

  for (const stepper of steppers) {
    const stepperId = stepper?.id;
    if (!stepperId) continue;

    let matchedDriverId = null;

    for (const driver of drivers) {
      if (!unusedDrivers.has(driver.id)) continue;
      const driverId = driver?.id;
      if (!driverId) continue;

      const ok = coilPairs.every(([driverPin, motorPin]) =>
        hasConnection(
          { type: "A4988_DRIVER", id: driverId, pin: driverPin },
          { type: "STEPPER_MOTOR", id: stepperId, pin: motorPin }
        )
      );

      if (ok) {
        matchedDriverId = driverId;
        break;
      }
    }

    if (!matchedDriverId) {
      add(`stepper policy: STEPPER_MOTOR "${stepperId}" is missing required A4988 coil wiring (1B/1A/2A/2B -> B-/B+/A+/A-)`);
      continue;
    }

    unusedDrivers.delete(matchedDriverId);

    // Ensure STEP/DIR are wired to board numeric pins.
    const stepPin = findBoardPinFor("A4988_DRIVER", matchedDriverId, "STEP");
    const dirPin = findBoardPinFor("A4988_DRIVER", matchedDriverId, "DIR");

    if (!stepPin || !isNumericPin(stepPin)) add(`stepper policy: driver "${matchedDriverId}" STEP must connect to a numeric board pin`);
    if (!dirPin || !isNumericPin(dirPin)) add(`stepper policy: driver "${matchedDriverId}" DIR must connect to a numeric board pin`);

    // Recommend RESET<->SLEEP; not required by validator, but we can enforce presence as a quality gate.
    const hasResetSleep = hasConnection(
      { type: "A4988_DRIVER", id: matchedDriverId, pin: "RESET" },
      { type: "A4988_DRIVER", id: matchedDriverId, pin: "SLEEP" }
    );
    if (!hasResetSleep) {
      add(`stepper policy: driver "${matchedDriverId}" should connect RESET to SLEEP`);
    }
  }

  // Seven-segment completeness policy (SEVEN_SEGMENT_4)
  const sevenSeg4s = planComponents.filter((c) => c?.type === "SEVEN_SEGMENT_4");
  const requiredSegPins = ["A", "B", "C", "D", "E", "F", "G"];
  const requiredDigPins = ["DIG1", "DIG2", "DIG3", "DIG4"];

  for (const seg of sevenSeg4s) {
    const segId = String(seg?.id || "").trim();
    if (!segId) continue;

    for (const pin of [...requiredDigPins, ...requiredSegPins, "COM"]) {
      if (!hasAnyConnectionToPin("SEVEN_SEGMENT_4", segId, pin)) {
        add(`seven-seg policy: SEVEN_SEGMENT_4 "${segId}" missing required connection for pin "${pin}"`);
      }
    }

    const attrs = seg?.attrs && typeof seg.attrs === "object" ? seg.attrs : {};
    const colonOn = attrs.colon === true || String(attrs.colon) === "1";
    const hasCln = hasAnyConnectionToPin("SEVEN_SEGMENT_4", segId, "CLN");
    if (colonOn && !hasCln) {
      add(`seven-seg policy: SEVEN_SEGMENT_4 "${segId}" colon=true requires CLN to be wired`);
    }
    if (!colonOn && hasCln) {
      add(`seven-seg policy: SEVEN_SEGMENT_4 "${segId}" colon is false/missing, so CLN must not be wired`);
    }
  }

  const boardDefForPower = plan.board?.type ? registry[plan.board.type] : null;
  const boardPinByName = new Map((boardDefForPower?.pins || []).map((p) => [p.name, p]));

  const isBoardGndPin = (pinName) => {
    if (pinName === "GND" || String(pinName).startsWith("GND.")) return true;
    const meta = boardPinByName.get(pinName);
    return Boolean(meta?.signals?.some((s) => s.type === "power" && s.role === "GND"));
  };

  const isBoard5VPin = (pinName) => {
    if (pinName === "5V" || String(pinName).startsWith("5V.")) return true;
    const meta = boardPinByName.get(pinName);
    return Boolean(
      meta?.signals?.some((s) => s.type === "power" && s.role === "VCC" && Number(s.voltage) === 5)
    );
  };

  const chipPowerWiredToBoard = (chipType, chipId, chipPin, boardPinOk) => {
    for (const w of wires) {
      const from = w?.from;
      const to = w?.to;
      if (!from || !to) continue;
      const chipFrom = from.type === chipType && from.id === chipId && from.pin === chipPin;
      const chipTo = to.type === chipType && to.id === chipId && to.pin === chipPin;
      if (chipFrom && to.type === plan.board?.type && to.id === plan.board?.id && boardPinOk(to.pin)) return true;
      if (chipTo && from.type === plan.board?.type && from.id === plan.board?.id && boardPinOk(from.pin)) return true;
    }
    return false;
  };

  const ds1307s = planComponents.filter((c) => c?.type === "DS1307");
  for (const rtc of ds1307s) {
    const id = String(rtc?.id || "").trim();
    if (!id) continue;
    if (!chipPowerWiredToBoard("DS1307", id, "GND", isBoardGndPin)) {
      add(`ds1307 policy: DS1307 "${id}" must connect GND to the board GND`);
    }
    if (!chipPowerWiredToBoard("DS1307", id, "5V", isBoard5VPin)) {
      add(`ds1307 policy: DS1307 "${id}" must connect 5V to the board 5V rail`);
    }
  }

  const pushbuttonTypes = new Set(["PUSHBUTTON", "PUSHBUTTON_6MM"]);
  const pushbuttons = planComponents.filter((c) => c?.type && pushbuttonTypes.has(c.type));
  for (const btn of pushbuttons) {
    const btnType = btn.type;
    const btnId = String(btn?.id || "").trim();
    if (!btnId) continue;
    const pinsToBoard = new Set();
    for (const w of wires) {
      const from = w?.from;
      const to = w?.to;
      if (!from || !to) continue;
      if (from.type === btnType && from.id === btnId && to.type === plan.board?.type && to.id === plan.board?.id) {
        pinsToBoard.add(from.pin);
      }
      if (to.type === btnType && to.id === btnId && from.type === plan.board?.type && from.id === plan.board?.id) {
        pinsToBoard.add(to.pin);
      }
    }
    if (pinsToBoard.size < 2) {
      add(
        `pushbutton policy: ${btnType} "${btnId}" must have at least two distinct pins wired to the board (e.g. input + GND)`
      );
    }
  }

  return { ok: errors.length === 0, errors };
};

const generateConnections = (registry, plan) => {
  const wires = Array.isArray(plan?.connections) ? plan.connections : [];
  return wires.map((w, idx) => {
    const from = w?.from;
    const to = w?.to;
    if (!from?.type || !from?.pin || !to?.type || !to?.pin) {
      throw new Error(`Invalid connection at index ${idx}`);
    }

    validatePinExists(registry, from.type, from.pin);
    validatePinExists(registry, to.type, to.pin);

    const color = String(w?.color || "green");
    const route = Array.isArray(w?.route) ? w.route : [];
    return [
      `${from.id}:${from.pin}`,
      `${to.id}:${to.pin}`,
      color,
      route
    ];
  });
};

/** Map Wokwi board pin names to a C++ expression valid inside `Servo::attach(...)`. */
const boardPinToServoAttachArg = (pin) => {
  const s = String(pin ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  if (Number.isFinite(n) && String(n) === s) return String(n);
  if (/^A\d+$/i.test(s)) return s.toUpperCase();
  return null;
};

/** `servo_minutes` -> `servoMinutes` (valid C++ identifier; avoids collisions). */
const servoIdToCppVarName = (id, usedNames) => {
  const rest = String(id ?? "")
    .trim()
    .replace(/^servo_?/i, "");
  const words = rest.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const pascal = words
    .map((w) => `${w.charAt(0).toUpperCase()}${w.slice(1).toLowerCase()}`)
    .join("");
  let base = pascal ? `servo${pascal}` : "servoMotor";
  if (!/^[A-Za-z_]/.test(base)) base = `servo_${base}`;
  let name = base;
  let n = 2;
  while (usedNames.has(name)) {
    name = `${base}${n}`;
    n += 1;
  }
  usedNames.add(name);
  return name;
};

/** Infer clock hand from component id (e.g. servo_seconds -> seconds). */
const inferServoClockRole = (id) => {
  const lower = String(id ?? "").toLowerCase();
  if (/\bsec(ond)?s?\b/.test(lower) || lower.includes("second")) return "seconds";
  if (/\bmin(ute)?s?\b/.test(lower) || lower.includes("minute")) return "minutes";
  if (/\bhour/.test(lower)) return "hours";
  return null;
};

/**
 * When the plan includes SERVO parts with PWM wired to the board, emit a runnable
 * `#include <Servo.h>` scaffold: clock-style demo when ids suggest second/minute hands,
 * otherwise a slow once-per-second position update (no fast sweep — avoids servo buzz).
 * @param {string} [wireComments] optional "// - from -> to" lines (same shape as other scaffolds).
 */
export const buildServoSketchFromPlan = (plan, wireComments = "") => {
  const boardId = String(plan?.board?.id || "").trim();
  const boardType = String(plan?.board?.type || "").trim();
  if (!boardId || !boardType) return null;

  const components = Array.isArray(plan?.components) ? plan.components : [];
  const servos = components.filter((c) => c?.type === "SERVO");
  if (servos.length === 0) return null;

  const wires = Array.isArray(plan?.connections) ? plan.connections : [];
  const isBoardEndpoint = (ep) => ep?.id === boardId && ep?.type === boardType;

  const getBoardPinConnectedTo = (componentId, componentType, componentPin) => {
    for (const w of wires) {
      const from = w?.from;
      const to = w?.to;
      if (!from || !to) continue;

      const aIsTarget = from.id === componentId && from.type === componentType && from.pin === componentPin;
      const bIsTarget = to.id === componentId && to.type === componentType && to.pin === componentPin;

      if (aIsTarget && isBoardEndpoint(to)) return to.pin;
      if (bIsTarget && isBoardEndpoint(from)) return from.pin;
    }
    return null;
  };

  const resolved = servos
    .map((c) => {
      const id = String(c?.id || "").trim();
      if (!id) return null;
      const pwmBoardPin = getBoardPinConnectedTo(id, "SERVO", "PWM");
      const attachArg = pwmBoardPin != null ? boardPinToServoAttachArg(pwmBoardPin) : null;
      if (attachArg == null) return { id, ok: false };
      return { id, ok: true, attachArg };
    })
    .filter(Boolean);

  const ok = resolved.filter((r) => r.ok);
  if (ok.length === 0) return null;

  ok.sort((a, b) => a.id.localeCompare(b.id));

  const usedNames = new Set();
  for (const r of ok) {
    r.varName = servoIdToCppVarName(r.id, usedNames);
    r.role = inferServoClockRole(r.id);
  }

  const countRole = (role) => ok.filter((r) => r.role === role).length;
  const dualClock =
    ok.length === 2 && countRole("seconds") === 1 && countRole("minutes") === 1;
  const tripleClock =
    ok.length === 3
    && countRole("hours") === 1
    && countRole("minutes") === 1
    && countRole("seconds") === 1;

  let globals = "";
  let loopBody = "";
  let behaviorNote = "Slow demo (1 Hz); replace with your control logic.";

  if (tripleClock) {
    const h = ok.find((r) => r.role === "hours");
    const m = ok.find((r) => r.role === "minutes");
    const s = ok.find((r) => r.role === "seconds");
    globals = "int hours = 0;\nint minutes = 0;\nint seconds = 0;\n";
    behaviorNote = "12h clock demo (1 Hz tick); map each hand 0..59 or 0..11 -> 0..180°.";
    loopBody = `  ${h.varName}.write(map(hours % 12, 0, 11, 0, 180));
  ${m.varName}.write(map(minutes, 0, 59, 0, 180));
  ${s.varName}.write(map(seconds, 0, 59, 0, 180));

  delay(1000);

  seconds++;
  if (seconds >= 60) {
    seconds = 0;
    minutes++;
  }
  if (minutes >= 60) {
    minutes = 0;
    hours++;
  }
  if (hours >= 12) {
    hours = 0;
  }`;
  } else if (dualClock) {
    const sec = ok.find((r) => r.role === "seconds");
    const min = ok.find((r) => r.role === "minutes");
    globals = "int seconds = 0;\nint minutes = 0;\n";
    behaviorNote = "Clock-style demo: second + minute hands, 1 Hz tick (no continuous sweep).";
    loopBody = `  ${sec.varName}.write(map(seconds, 0, 59, 0, 180));
  ${min.varName}.write(map(minutes, 0, 59, 0, 180));

  delay(1000);

  seconds++;
  if (seconds >= 60) {
    seconds = 0;
    minutes++;
  }
  if (minutes >= 60) {
    minutes = 0;
  }`;
  } else if (ok.length === 1) {
    const r = ok[0];
    if (r.role === "minutes") {
      globals = "int minutes = 0;\n";
      loopBody = `  ${r.varName}.write(map(minutes, 0, 59, 0, 180));

  delay(1000);
  minutes++;
  if (minutes >= 60) {
    minutes = 0;
  }`;
      behaviorNote = "Single minute hand demo (1 Hz).";
    } else if (r.role === "hours") {
      globals = "int hours = 0;\n";
      loopBody = `  ${r.varName}.write(map(hours % 12, 0, 11, 0, 180));

  delay(1000);
  hours++;
  if (hours >= 12) {
    hours = 0;
  }`;
      behaviorNote = "Single hour hand demo (1 Hz, 12h dial).";
    } else {
      // seconds or unknown — seconds counter keeps motion slow (1 Hz).
      globals = "int seconds = 0;\n";
      loopBody = `  ${r.varName}.write(map(seconds, 0, 59, 0, 180));

  delay(1000);
  seconds++;
  if (seconds >= 60) {
    seconds = 0;
  }`;
      behaviorNote = "Single-servo slow demo (1 Hz).";
    }
  } else {
    // N servos, no full clock layout — staggered positions, update once per second.
    globals = "int demoSec = 0;\n";
    const n = ok.length;
    const writeBlock = ok
      .map((r, i) => {
        const off = Math.floor((60 / n) * i);
        return `  ${r.varName}.write(map((demoSec + ${off}) % 60, 0, 59, 0, 180));`;
      })
      .join("\n");
    loopBody = `${writeBlock}

  delay(1000);
  demoSec = (demoSec + 1) % 60;`;
  }

  const servoDecls = ok.map((r) => `Servo ${r.varName};`).join("\n");
  const attachLines = ok.map((r) => `  ${r.varName}.attach(${r.attachArg}); // ${r.id}: PWM`).join("\n");

  const planHeader = wireComments.trim()
    ? `// Wiring plan:\n${wireComments.trim()}\n\n`
    : "";

  return `// Generated by NovaAI
${planHeader}// ${behaviorNote}

#include <Servo.h>

${servoDecls}
${globals ? `\n${globals}` : ""}
void setup() {
${attachLines ? `${attachLines}\n` : ""}
}

void loop() {
${loopBody}
}
`;
};

const buildPlanPrompt = ({ project, userPrompt, registryContext, defaultBoardKey }) => {
  return `
You are a strict hardware planning assistant.

Goal:
Return a SMALL JSON plan that selects components FROM THE REGISTRY and wires them.
Do not output sketch.ino or diagram.json directly.

Rules:
- You can ONLY use component "type" values that exist in the REGISTRY CONTEXT list (use the "name" field as the type key).
- Pins must be chosen from that component's pin list.
- If the user asks for a board, pick it if it exists in the registry. Otherwise choose a reasonable default.
- If the prompt is ambiguous, make safe defaults and write a note in notes[].
- ARCHITECTURE STATE is the execution contract from ideation/components. Prefer its pattern, files, libraries, and pinAssignments unless the user explicitly overrides them.
- Return ONLY valid JSON. No markdown. No prose. No trailing commas. NO COMMENTS (no // or /* */).

Component rules (must follow):
- STEPPER_MOTOR has NO power pins. Never connect STEPPER_MOTOR to VCC/5V/GND.
- If any STEPPER_MOTOR is present, you MUST include exactly one A4988_DRIVER per motor.
- Wire each driver to its motor coils:
  - A4988_DRIVER:2B -> STEPPER_MOTOR:A-
  - A4988_DRIVER:2A -> STEPPER_MOTOR:A+
  - A4988_DRIVER:1A -> STEPPER_MOTOR:B+
  - A4988_DRIVER:1B -> STEPPER_MOTOR:B-
- Wire each driver control pins to the board:
  - A4988_DRIVER:STEP -> board numeric pin
  - A4988_DRIVER:DIR -> board numeric pin
- For power, use the driver pins (optional but preferred):
  - A4988_DRIVER:VDD -> board 5V / 5V.1 / 5V.2
  - A4988_DRIVER:GND -> board GND.1 / GND.2 / GND.3 / etc.
- Connect A4988_DRIVER:RESET to A4988_DRIVER:SLEEP (no board pin required).
- SEVEN_SEGMENT_4 (Wokwi wokwi-7segment): attrs use registry shape — common "anode"|"cathode", digits "4", colon "" or boolean/string clock mode; diagram attrs follow Wokwi (string digits, colon "" or "1").
  - Wire ALL of: DIG1,DIG2,DIG3,DIG4 and segments A,B,C,D,E,F,G and COM. Pin COM (not COM.1 for this type). COM MUST appear in connections[] (board GND or 5V per common cathode/anode in COMPONENTS STATE / USER REQUEST).
  - If attrs.colon is true or "1" (clock/colon on), you MUST wire pin CLN on that display to the board. If colon is false/omitted/"", do NOT wire CLN.
- DS1307: each DS1307 MUST have pin GND wired to a board GND pin and pin 5V wired to a board 5V rail (5V, 5V.1, 5V.2, etc.).
- PUSHBUTTON and PUSHBUTTON_6MM: each button MUST have at least two different button pins each wired to the board (typically one to a digital/analog input and one to GND for INPUT_PULLUP sketches).
- SERVO (Wokwi wokwi-servo): optional attrs only horn ("single"|"double"|"cross") and hornColor (CSS color). Do not put angle or other simulator/runtime fields in attrs; motion is sketch-driven.

REGISTRY CONTEXT (compressed):
${JSON.stringify(registryContext)}

OUTPUT SHAPE (STRICT):
{
  "board": { "type": "${defaultBoardKey}", "id": "board", "top": 270, "left": 185, "attrs": {} },
  "components": [
    { "type": "", "id": "", "attrs": {}, "top": 0, "left": 0, "rotate": 0 }
  ],
  "connections": [
    {
      "from": { "type": "", "id": "", "pin": "" },
      "to": { "type": "", "id": "", "pin": "" },
      "color": "green",
      "route": []
    }
  ],
  "notes": []
}

PROJECT DESCRIPTION:
${project?.description || ""}

PROJECT META:
${JSON.stringify(project?.meta || {})}

IDEATION STATE:
${JSON.stringify(project?.ideaState || {})}

ARCHITECTURE STATE:
${JSON.stringify(project?.architectureState || {})}

COMPONENTS STATE:
${JSON.stringify(project?.componentsState || {})}

USER REQUEST:
${userPrompt || ""}
`;
};

const normalizeParsedPlan = (plan, defaultBoardKey) => {
  const boardType = plan?.board?.type || defaultBoardKey;
  const boardId = String(plan?.board?.id || "board");
  return {
    ...plan,
    board: {
      type: boardType,
      id: boardId,
      top: Number.isFinite(plan?.board?.top) ? plan.board.top : 270,
      left: Number.isFinite(plan?.board?.left) ? plan.board.left : 185,
      attrs: plan?.board?.attrs && typeof plan.board.attrs === "object" ? plan.board.attrs : {}
    },
    components: Array.isArray(plan?.components) ? plan.components : [],
    connections: Array.isArray(plan?.connections) ? plan.connections : [],
    notes: Array.isArray(plan?.notes) ? plan.notes.map((n) => String(n)) : []
  };
};

const buildRepairPlanPrompt = ({
  validationErrors,
  failedPlan,
  registryContext,
  defaultBoardKey
}) => {
  const errorsText = Array.isArray(validationErrors) ? validationErrors.map((e) => String(e)).join("\n") : String(validationErrors || "");
  return `
You are a strict hardware planning assistant. A previous JSON plan failed validation.

Task:
Return ONE corrected JSON plan that fixes ALL validation errors below. Preserve board.id and component ids where possible. Use only component types and pins from REGISTRY CONTEXT.

Validation errors (must all be resolved):
${errorsText}

Failed plan (fix this; same OUTPUT SHAPE as before):
${JSON.stringify(failedPlan)}

Rules (unchanged):
- Return ONLY valid JSON. No markdown. No prose. No trailing commas. NO COMMENTS.
- Pins must exist on the component in REGISTRY CONTEXT.
- SEVEN_SEGMENT_4: wire DIG1-DIG4, A-G, COM; if attrs.colon true or "1" also wire CLN; if colon off do not wire CLN. DS1307: GND+5V to board. Pushbuttons: two board connections per button. SERVO: attrs only horn + hornColor; no angle.

REGISTRY CONTEXT (compressed):
${JSON.stringify(registryContext)}

OUTPUT SHAPE (STRICT):
{
  "board": { "type": "${defaultBoardKey}", "id": "board", "top": 270, "left": 185, "attrs": {} },
  "components": [
    { "type": "", "id": "", "attrs": {}, "top": 0, "left": 0, "rotate": 0 }
  ],
  "connections": [
    {
      "from": { "type": "", "id": "", "pin": "" },
      "to": { "type": "", "id": "", "pin": "" },
      "color": "green",
      "route": []
    }
  ],
  "notes": []
}
`;
};

export async function generateArtifactsFromRegistry({ project, userPrompt = "" }) {
  // Deterministic preset(s): no AI call.
  const promptText = String(userPrompt || "");
  const ideationSummary = String(project?.ideaState?.summary || "");
  const meta = project?.meta || {};
  const looksLikeServoOverdone =
    /\b32 dancing servos\b/i.test(promptText)
    || /\bservooverdone\b/i.test(ideationSummary)
    || (
      String(meta?.board || "") === "ARDUINO_MEGA"
      && Number(meta?.componentCount) === 32
      && String(meta?.stage || "") !== "idea"
    );

  if (looksLikeServoOverdone) {
    return buildServoOverdonePreset();
  }

  const registry = getRegistry();
  const registryContext = getAIContext();
  const defaultBoardKey = pickDefaultBoardKey(registry);
  if (!defaultBoardKey) {
    throw new Error("componentRegistry is empty; add at least one controller component.");
  }

  const planPrompt = buildPlanPrompt({ project, userPrompt, registryContext, defaultBoardKey });
  const raw = await callAI(planPrompt);
  let plan;
  try {
    plan = safeParseJson(raw);
  } catch (err) {
    const excerpt = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 600);
    console.error("Plan AI raw output (excerpt):", excerpt);
    throw new Error(`AI response parsing failed. Excerpt: ${excerpt || "(empty)"}`);
  }

  let normalizedPlan = normalizeParsedPlan(plan, defaultBoardKey);
  let validation = validatePlan(registry, normalizedPlan);

  if (!validation.ok) {
    console.warn("Plan validation failed; attempting one repair pass:", validation.errors.join(" | "));
    const repairPrompt = buildRepairPlanPrompt({
      validationErrors: validation.errors,
      failedPlan: normalizedPlan,
      registryContext,
      defaultBoardKey
    });
    const repairRaw = await callAI(repairPrompt);
    let repairPlan;
    try {
      repairPlan = safeParseJson(repairRaw);
    } catch (repairErr) {
      const excerpt = String(repairRaw || "").replace(/\s+/g, " ").trim().slice(0, 600);
      console.error("Plan repair AI raw output (excerpt):", excerpt);
      throw new Error(
        `Plan validation failed: ${validation.errors.join(" | ")} | Repair response parsing failed: ${excerpt || "(empty)"}`
      );
    }
    normalizedPlan = normalizeParsedPlan(repairPlan, defaultBoardKey);
    validation = validatePlan(registry, normalizedPlan);
    if (!validation.ok) {
      throw new Error(`Plan validation failed: ${validation.errors.join(" | ")}`);
    }
  }

  // Generate diagram from plan + registry.
  const parts = generateParts(registry, normalizedPlan);
  const connections = generateConnections(registry, {
    ...normalizedPlan,
    // Ensure board id is consistent for connection building.
    board: { ...normalizedPlan.board, id: normalizedPlan.board.id }
  });

  // Minimal sketch: keep deterministic and prompt-agnostic.
  // If we recognize a supported actuator pattern (e.g., stepper motor), emit a runnable demo scaffold.
  const wireComments = (Array.isArray(normalizedPlan.connections) ? normalizedPlan.connections : [])
    .map((w) => {
      const from = w?.from ? `${w.from.id}:${w.from.pin}` : "";
      const to = w?.to ? `${w.to.id}:${w.to.pin}` : "";
      return from && to ? `// - ${from} -> ${to}` : "";
    })
    .filter(Boolean)
    .join("\n");

  const boardIdForSketch = normalizedPlan.board.id;
  const components = Array.isArray(normalizedPlan.components) ? normalizedPlan.components : [];
  const wires = Array.isArray(normalizedPlan.connections) ? normalizedPlan.connections : [];

  const isBoardEndpoint = (ep) => ep?.id === boardIdForSketch && ep?.type === normalizedPlan.board.type;

  const getBoardPinConnectedTo = (componentId, componentType, componentPin) => {
    // Find a wire between board and the component pin; return the board's pin name.
    for (const w of wires) {
      const from = w?.from;
      const to = w?.to;
      if (!from || !to) continue;

      const aIsTarget = from.id === componentId && from.type === componentType && from.pin === componentPin;
      const bIsTarget = to.id === componentId && to.type === componentType && to.pin === componentPin;

      if (aIsTarget && isBoardEndpoint(to)) return to.pin;
      if (bIsTarget && isBoardEndpoint(from)) return from.pin;
    }
    return null;
  };

  const drivers = components.filter((c) => c?.type === "A4988_DRIVER");
  const a4988Sketch = (() => {
    if (drivers.length === 0) return null;

    const resolved = drivers
      .map((d) => {
        const id = String(d.id || "").trim();
        if (!id) return null;
        const step = getBoardPinConnectedTo(id, "A4988_DRIVER", "STEP");
        const dir = getBoardPinConnectedTo(id, "A4988_DRIVER", "DIR");
        const en = getBoardPinConnectedTo(id, "A4988_DRIVER", "ENABLE"); // optional

        const stepN = step != null ? Number(step) : NaN;
        const dirN = dir != null ? Number(dir) : NaN;
        const enN = en != null ? Number(en) : NaN;

        if (!Number.isFinite(stepN) || !Number.isFinite(dirN)) return { id, ok: false, pins: { step, dir, en } };
        return { id, ok: true, pins: { step: stepN, dir: dirN, en: Number.isFinite(enN) ? enN : null } };
      })
      .filter(Boolean);

    const ok = resolved.filter((d) => d.ok);
    if (ok.length === 0) return null;

    const decls = ok
      .map((d, idx) => {
        const enLine = d.pins.en != null ? `const int D${idx}_EN = ${d.pins.en};\n` : "";
        return `const int D${idx}_STEP = ${d.pins.step};\nconst int D${idx}_DIR = ${d.pins.dir};\n${enLine}`;
      })
      .join("\n");

    const setupLines = ok
      .map((d, idx) => {
        const lines = [
          `  pinMode(D${idx}_STEP, OUTPUT);`,
          `  pinMode(D${idx}_DIR, OUTPUT);`,
          `  digitalWrite(D${idx}_STEP, LOW);`,
          `  digitalWrite(D${idx}_DIR, LOW);`
        ];
        if (d.pins.en != null) {
          lines.push(`  pinMode(D${idx}_EN, OUTPUT);`);
          lines.push(`  digitalWrite(D${idx}_EN, LOW); // ENABLE is active-low`);
        }
        return lines.join("\n");
      })
      .join("\n\n");

    const loopPulse = ok
      .map((_, idx) => `  digitalWrite(D${idx}_STEP, HIGH);\n  delayMicroseconds(400);\n  digitalWrite(D${idx}_STEP, LOW);`)
      .join("\n\n");

    const loopDirFlip = ok
      .map((_, idx) => `  if ((steps % 200) == 0) digitalWrite(D${idx}_DIR, !digitalRead(D${idx}_DIR));`)
      .join("\n");

    return `// Generated by NovaAI
// A4988 stepper-driver scaffold (derived from validated registry wiring).
${wireComments ? `\n// Wiring plan:\n${wireComments}\n` : ""}

${decls}
long steps = 0;

void setup() {
  Serial.begin(9600);
${setupLines ? `\n${setupLines}\n` : ""}
}

void loop() {
${loopPulse}
  steps++;
${loopDirFlip ? `\n${loopDirFlip}\n` : ""}
  delay(2);
}
`;
  })();

  const servoSketch = buildServoSketchFromPlan(normalizedPlan, wireComments);

  const sketchIno =
    a4988Sketch
    || servoSketch
    || `// Generated by NovaAI
// This is a minimal scaffold. Add behavior based on your wiring plan.
${wireComments ? `\n// Wiring plan:\n${wireComments}\n` : ""}
void setup() {
  Serial.begin(9600);
}

void loop() {
  delay(100);
}
`;

  return {
    sketchIno,
    diagramJson: {
      version: 1,
      author: "NovaAI AI",
      editor: "wokwi",
      parts,
      connections
    },
    notes: [
      ...normalizedPlan.notes,
      "Generated via registry-plan pipeline: AI produced a small plan, backend validated with full registry and generated diagram.json.",
      "Architecture state was provided to planning as an execution contract."
    ],
    plan: normalizedPlan
  };
}

