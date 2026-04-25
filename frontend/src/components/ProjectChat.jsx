import { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { useThemeStore } from "../store/useThemeStore";
import toast from "react-hot-toast";
import ChatRichText from "./ChatRichText";

const extractAssistantOptions = (text = "") => {
  const source = String(text);
  const optionRegex = /\[(\d+)\]\s*([^\[\]\n]+?)(?=(?:,\s*\[\d+\])|$)/g;
  const options = [];

  for (const match of source.matchAll(optionRegex)) {
    const id = Number(match[1]);
    const label = String(match[2] || "").trim();

    if (!id || !label) continue;
    options.push({ id, label });
  }

  if (options.length > 0) {
    return options;
  }

  const numberedLineRegex = /^\s*(\d+)\)\s+(.+)$/gm;
  for (const match of source.matchAll(numberedLineRegex)) {
    const id = Number(match[1]);
    const label = String(match[2] || "").trim();

    if (!id || !label) continue;
    if (/pick one|pick components|reply with component numbers/i.test(label)) continue;
    options.push({ id, label });
  }

  return options;
};

const formatAssistantText = (text = "", hasOptions = false) => {
  const source = String(text);
  if (!hasOptions) return source;

  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+\)\s*\[[0-9]+\]/.test(line))
    .filter((line) => !/^\[[0-9]+\]/.test(line));

  if (lines.length === 0) return "Choose one option:";
  if (lines.length === 1) return lines[0];

  return `${lines[0]}\n${lines[lines.length - 1]}`;
};

const splitOptionLabel = (label = "") => {
  const value = String(label).trim();
  const match = value.match(/^(.+?)\s*\((.+)\)$/);
  if (!match) return { title: value, meta: "" };

  return {
    title: match[1].trim(),
    meta: match[2].trim(),
  };
};

const toSafeFileText = (value = "") => String(value || "").replace(/\r\n/g, "\n").trim();

const normalizeWorkspaceFiles = (value = {}) => {
  const source = value && typeof value === "object" ? value : {};
  return {
    mainIno: toSafeFileText(source.mainIno || source["main.ino"] || ""),
    diagramJson: toSafeFileText(source.diagramJson || source["diagram.json"] || ""),
    pinsCsv: toSafeFileText(source.pinsCsv || source["pins.csv"] || ""),
    componentsJson: toSafeFileText(source.componentsJson || source["components.json"] || ""),
    assemblyMd: toSafeFileText(source.assemblyMd || source["assembly.md"] || "")
  };
};

const isCorruptedSketchText = (value = "") => {
  const text = String(value || "");
  if (!text.trim()) return false;

  return /what it does:|how it works:|want me to generate|hey there!|project:\s|you could also/i.test(text);
};

const normalizeSketchForCompile = (value = "") => {
  let sketch = String(value || "");
  if (!sketch.trim()) return sketch;

  const usesStatusLed = /\bSTATUS_LED\b/.test(sketch);
  if (!usesStatusLed) return sketch;

  const hasStatusLedDeclaration =
    /^[ \t]*const\s+(?:unsigned\s+)?(?:int|uint8_t|byte|long)\s+STATUS_LED\s*=/m.test(sketch)
    || /^[ \t]*#define\s+STATUS_LED\b/m.test(sketch);

  if (!hasStatusLedDeclaration) {
    sketch = `const int STATUS_LED = LED_BUILTIN;\n${sketch}`;
  }

  return sketch;
};

const combineChatHistory = (ideationMessages = [], aiMessages = []) => {
  const normalizedIdeation = Array.isArray(ideationMessages) ? ideationMessages : [];
  const normalizedAi = Array.isArray(aiMessages) ? aiMessages : [];

  if (normalizedAi.length === 0) {
    return normalizedIdeation;
  }

  return [...normalizedIdeation, ...normalizedAi];
};

const BOARD_SCHEMAS = {
  arduino: {
    id: "arduino",
    label: "Arduino Uno R3",
    subtitle: "ATmega328P development board",
    codeSensorPin: "A0",
    codeLedPin: "13",
    powerPin: "5V",
    groundPin: "GND",
    signalPins: {
      data: "A0",
      dhtData: "D4",
      trig: "D9",
      echo: "D10",
      relay: "D7",
      buzzer: "D8",
      servo: "D9",
      i2cSda: "A4",
      i2cScl: "A5",
      led: "D13"
    }
  },
  esp32: {
    id: "esp32",
    label: "ESP32 DevKit V1",
    subtitle: "ESP32-WROOM-32 development board",
    codeSensorPin: "34",
    codeLedPin: "2",
    powerPin: "3.3V",
    groundPin: "GND",
    signalPins: {
      data: "GPIO34",
      dhtData: "GPIO4",
      trig: "GPIO5",
      echo: "GPIO18",
      relay: "GPIO23",
      buzzer: "GPIO25",
      servo: "GPIO19",
      i2cSda: "GPIO21",
      i2cScl: "GPIO22",
      led: "GPIO2"
    }
  }
};

const inferBoardKey = (project = null, messages = []) => {
  const text = toSafeFileText([
    project?.description,
    project?.ideaState?.summary,
    project?.ideaState?.requirements,
    project?.componentsState?.components,
    project?.componentsState?.architecture,
    ...messages.map((message) => message?.content)
  ].filter(Boolean).join(" ")).toLowerCase();

  if (/\besp32\b|\bdevkit\b|\bwroom\b|\bgpio\d+/i.test(text)) {
    return "esp32";
  }

  return "arduino";
};

const deriveProjectTitle = (messages = []) => {
  const firstUserMessage = messages.find((item) => item.role === "user")?.content || "hardware project";
  const words = firstUserMessage
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(" ");

  return words || "Hardware Project";
};

const deriveSummary = (messages = []) => {
  const lastAi = [...messages].reverse().find((item) => item.role === "ai")?.content || "";
  const compact = lastAi.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "This project reads sensor values and shows useful output in real time.";
  }

  return compact.length > 150 ? `${compact.slice(0, 147)}...` : compact;
};

const buildMainCode = (messages = [], boardSchema = BOARD_SCHEMAS.arduino) => {
  const projectTitle = deriveProjectTitle(messages);
  const summary = deriveSummary(messages);
  const sensorPin = boardSchema.codeSensorPin;
  const ledPin = boardSchema.codeLedPin;

  return toSafeFileText(`// ${projectTitle}
// ${summary}

#include <Wire.h>

const int SENSOR_PIN = ${sensorPin};
const int STATUS_LED = ${ledPin};

int lastValue = 0;
unsigned long lastReadAt = 0;
const unsigned long READ_INTERVAL = 1000;

void setup() {
  pinMode(STATUS_LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  const unsigned long now = millis();

  if (now - lastReadAt >= READ_INTERVAL) {
    lastReadAt = now;
    lastValue = analogRead(SENSOR_PIN);

    Serial.print("Sensor: ");
    Serial.println(lastValue);

    if (lastValue > 500) {
      digitalWrite(STATUS_LED, HIGH);
    } else {
      digitalWrite(STATUS_LED, LOW);
    }
  }
}
`);
};

const buildPinsCsv = (boardSchema = BOARD_SCHEMAS.arduino) => toSafeFileText(`component,pin,board_pin
sensor,VCC,${boardSchema.powerPin}
sensor,GND,GND
sensor,DATA,${boardSchema.signalPins.data}
status_led,ANODE,${boardSchema.signalPins.led}
status_led,CATHODE,GND
`);

const buildComponentsJson = (boardSchema = BOARD_SCHEMAS.arduino) => toSafeFileText(`{
  "board": "${boardSchema.label}",
  "components": [
    "${boardSchema.label}",
    "Sensor module",
    "Status LED",
    "220 ohm resistor",
    "Jumper wires"
  ]
}`);

const buildAssemblyMd = (messages = [], boardSchema = BOARD_SCHEMAS.arduino) => {
  const projectTitle = deriveProjectTitle(messages);

  return toSafeFileText(`# ${projectTitle}

1. Place ${boardSchema.label} and your sensor on the workspace.
2. Connect sensor power pins to ${boardSchema.powerPin} and GND.
3. Connect sensor data pin to ${boardSchema.signalPins.data}.
4. Connect LED to ${boardSchema.signalPins.led} with a 220 ohm resistor.
5. Upload main.ino and open Serial Monitor.
`);
};

const tokenizeProjectText = (project = null, messages = []) => {
  return toSafeFileText([
    project?.description,
    project?.ideaState?.summary,
    project?.ideaState?.requirements,
    project?.componentsState?.architecture,
    project?.componentsState?.components,
    project?.componentsState?.apiEndpoints,
    ...messages.map((message) => message?.content)
  ].filter(Boolean).join(" ")).toLowerCase();
};

const createArduinoUnoPins = () => ([
  { name: "IOREF", x: 18, y: 56, side: "left" },
  { name: "RESET", x: 18, y: 96, side: "left" },
  { name: "3.3V", x: 18, y: 136, side: "left" },
  { name: "5V", x: 18, y: 176, side: "left" },
  { name: "GND", x: 18, y: 216, side: "left" },
  { name: "GND", x: 18, y: 256, side: "left" },
  { name: "VIN", x: 18, y: 296, side: "left" },
  ...Array.from({ length: 14 }, (_, index) => ({
    name: `D${index}`,
    x: 314,
    y: 64 + index * 24,
    side: "right"
  })),
  { name: "A0", x: 74, y: 556, side: "bottom" },
  { name: "A1", x: 128, y: 556, side: "bottom" },
  { name: "A2", x: 182, y: 556, side: "bottom" },
  { name: "A3", x: 236, y: 556, side: "bottom" },
  { name: "A4", x: 290, y: 556, side: "bottom" },
  { name: "A5", x: 344, y: 556, side: "bottom" }
]);

const createEsp32DevKitPins = () => ([
  { name: "3.3V", x: 18, y: 68, side: "left" },
  { name: "GND", x: 18, y: 102, side: "left" },
  { name: "GPIO36", x: 18, y: 136, side: "left" },
  { name: "GPIO39", x: 18, y: 170, side: "left" },
  { name: "GPIO34", x: 18, y: 204, side: "left" },
  { name: "GPIO35", x: 18, y: 238, side: "left" },
  { name: "GPIO32", x: 18, y: 272, side: "left" },
  { name: "GPIO33", x: 18, y: 306, side: "left" },
  { name: "GPIO25", x: 18, y: 340, side: "left" },
  { name: "GPIO26", x: 18, y: 374, side: "left" },
  { name: "GPIO27", x: 18, y: 408, side: "left" },
  { name: "GPIO14", x: 18, y: 442, side: "left" },
  { name: "GPIO12", x: 18, y: 476, side: "left" },
  { name: "GPIO13", x: 18, y: 510, side: "left" },
  { name: "GPIO23", x: 342, y: 68, side: "right" },
  { name: "GPIO22", x: 342, y: 102, side: "right" },
  { name: "GPIO1", x: 342, y: 136, side: "right" },
  { name: "GPIO3", x: 342, y: 170, side: "right" },
  { name: "GPIO21", x: 342, y: 204, side: "right" },
  { name: "GPIO19", x: 342, y: 238, side: "right" },
  { name: "GPIO18", x: 342, y: 272, side: "right" },
  { name: "GPIO5", x: 342, y: 306, side: "right" },
  { name: "GPIO17", x: 342, y: 340, side: "right" },
  { name: "GPIO16", x: 342, y: 374, side: "right" },
  { name: "GPIO4", x: 342, y: 408, side: "right" },
  { name: "GPIO2", x: 342, y: 442, side: "right" },
  { name: "GPIO15", x: 342, y: 476, side: "right" },
  { name: "GND", x: 342, y: 510, side: "right" }
]);

const getBoardLayout = (boardKey) => {
  if (boardKey === "esp32") {
    const pinLayout = createEsp32DevKitPins();
    return {
      label: "ESP32 DevKit V1",
      subtitle: "ESP32-WROOM-32 development board",
      w: 380,
      h: 590,
      pins: pinLayout.map((pin) => pin.name),
      pinLayout
    };
  }

  const pinLayout = createArduinoUnoPins();
  return {
    label: "Arduino Uno R3",
    subtitle: "ATmega328P development board",
    w: 380,
    h: 620,
    pins: ["IOREF", "RESET", "3.3V", "5V", "GND", "GND", "VIN", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "A0", "A1", "A2", "A3", "A4", "A5"],
    pinLayout
  };
};

const getDiagramModel = (project = null, messages = []) => {
  const text = tokenizeProjectText(project, messages);
  const components = Array.isArray(project?.componentsState?.components) ? project.componentsState.components : [];
  const boardKey = inferBoardKey(project, messages);
  const boardSchema = BOARD_SCHEMAS[boardKey] || BOARD_SCHEMAS.arduino;
  const boardLayout = getBoardLayout(boardKey);
  const signalPins = boardSchema.signalPins;
  const powerPin = boardSchema.powerPin;
  const groundPin = boardSchema.groundPin;

  const inferred = {
    board: {
      id: "arduino",
      label: boardLayout.label,
      subtitle: boardLayout.subtitle,
      type: "board",
      x: 0.49,
      y: 0.08,
      w: boardLayout.w,
      h: boardLayout.h,
      pins: boardLayout.pins,
      pinLayout: boardLayout.pinLayout
    },
    nodes: [],
    wires: [],
    signature: text,
    layoutDescription: `${boardLayout.label} centered with sensors stacked on the left and outputs grouped below/right for clean curved wiring.`
  };

  const addNode = (node) => {
    inferred.nodes.push({
      id: node.id,
      label: node.label,
      subtitle: node.subtitle || "",
      lane: node.lane || "left",
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      color: node.color,
      pins: node.pins || [],
      pinLayout: node.pinLayout || []
    });
  };

  const addWire = (from, to, label, color) => {
    inferred.wires.push({ from, to, label, color });
  };

  const has = (...terms) => terms.some((term) => text.includes(term));

  const usesTemperature = has("temperature", "humid", "climate", "weather", "dht22", "dht11");
  const usesLight = has("light", "blink", "led", "lamp", "lamp", "brightness");
  const usesBuzzer = has("buzzer", "alarm", "alert", "sound");
  const usesUltrasonic = has("ultrasonic", "distance", "parking", "sonar");
  const usesServo = has("servo", "gate", "arm", "turn");
  const usesRelay = has("relay", "switch", "control appliance", "motor");

  if (usesTemperature) {
    addNode({
      id: "dht22",
      label: components.find((item) => /dht/i.test(item)) || "DHT22",
      subtitle: "Digital temperature and humidity sensor",
      lane: "left",
      x: 0.06,
      y: 0.16,
      w: 350,
      h: 160,
      color: "#dce9ff",
      pins: ["VCC", "GND", "DATA"],
      pinLayout: [
        { name: "VCC", x: 342, y: 52, side: "right" },
        { name: "GND", x: 342, y: 92, side: "right" },
        { name: "DATA", x: 342, y: 132, side: "right" }
      ]
    });

    addNode({
      id: "lcd",
      label: components.find((item) => /lcd|display/i.test(item)) || "LCD 16x2 I2C",
      subtitle: "16x2 character LCD display with I2C backpack",
      lane: "right",
      x: 0.64,
      y: 0.58,
      w: 380,
      h: 160,
      color: "#dff7e8",
      pins: ["VCC", "GND", "SDA", "SCL"],
      pinLayout: [
        { name: "VCC", x: 372, y: 48, side: "right" },
        { name: "GND", x: 372, y: 80, side: "right" },
        { name: "SDA", x: 372, y: 112, side: "right" },
        { name: "SCL", x: 372, y: 144, side: "right" }
      ]
    });

    addWire({ nodeId: "dht22", pin: "VCC" }, { nodeId: "arduino", pin: powerPin }, `VCC → ${powerPin}`, "#ff4444");
    addWire({ nodeId: "dht22", pin: "GND" }, { nodeId: "arduino", pin: groundPin }, `GND → ${groundPin}`, "#0f0f0f");
    addWire({ nodeId: "dht22", pin: "DATA" }, { nodeId: "arduino", pin: signalPins.dhtData }, `DATA → ${signalPins.dhtData}`, "#b54dff");
    addWire({ nodeId: "lcd", pin: "VCC" }, { nodeId: "arduino", pin: powerPin }, `VCC → ${powerPin}`, "#ff4444");
    addWire({ nodeId: "lcd", pin: "GND" }, { nodeId: "arduino", pin: groundPin }, `GND → ${groundPin}`, "#0f0f0f");
    addWire({ nodeId: "lcd", pin: "SDA" }, { nodeId: "arduino", pin: signalPins.i2cSda }, `SDA → ${signalPins.i2cSda}`, "#2563eb");
    addWire({ nodeId: "lcd", pin: "SCL" }, { nodeId: "arduino", pin: signalPins.i2cScl }, `SCL → ${signalPins.i2cScl}`, "#2563eb");
  }

  if (usesLight && !usesTemperature) {
    addNode({
      id: "led",
      label: components.find((item) => /led/i.test(item)) || "LED",
      subtitle: "Light output for blink or status",
      lane: "left",
      x: 0.08,
      y: 0.28,
      w: 270,
      h: 130,
      color: "#e0ecff",
      pins: ["ANODE", "CATHODE"],
      pinLayout: [
        { name: "ANODE", x: 262, y: 44, side: "right" },
        { name: "CATHODE", x: 262, y: 88, side: "right" }
      ]
    });

    addWire({ nodeId: "led", pin: "ANODE" }, { nodeId: "arduino", pin: signalPins.led }, `ANODE → ${signalPins.led}`, "#ff4444");
    addWire({ nodeId: "led", pin: "CATHODE" }, { nodeId: "arduino", pin: groundPin }, `CATHODE → ${groundPin}`, "#0f0f0f");
  }

  if (usesBuzzer) {
    addNode({
      id: "buzzer",
      label: components.find((item) => /buzzer/i.test(item)) || "Piezo buzzer",
      subtitle: "Audible alert output",
      lane: "right",
      x: 0.66,
      y: usesTemperature ? 0.28 : 0.48,
      w: 280,
      h: 130,
      color: "#fde9d7",
      pins: ["+", "-"],
      pinLayout: [
        { name: "+", x: 272, y: 44, side: "right" },
        { name: "-", x: 272, y: 88, side: "right" }
      ]
    });

    addWire({ nodeId: "buzzer", pin: "+" }, { nodeId: "arduino", pin: signalPins.buzzer }, `+ → ${signalPins.buzzer}`, "#ff4444");
    addWire({ nodeId: "buzzer", pin: "-" }, { nodeId: "arduino", pin: groundPin }, `- → ${groundPin}`, "#0f0f0f");
  }

  if (usesUltrasonic) {
    addNode({
      id: "ultrasonic",
      label: components.find((item) => /ultrasonic/i.test(item)) || "HC-SR04",
      subtitle: "Distance sensor",
      lane: "left",
      x: 0.06,
      y: 0.12,
      w: 300,
      h: 150,
      color: "#dbf4ff",
      pins: ["VCC", "GND", "TRIG", "ECHO"],
      pinLayout: [
        { name: "VCC", x: 292, y: 46, side: "right" },
        { name: "GND", x: 292, y: 78, side: "right" },
        { name: "TRIG", x: 292, y: 110, side: "right" },
        { name: "ECHO", x: 292, y: 142, side: "right" }
      ]
    });

    addWire({ nodeId: "ultrasonic", pin: "VCC" }, { nodeId: "arduino", pin: powerPin }, `VCC → ${powerPin}`, "#ff4444");
    addWire({ nodeId: "ultrasonic", pin: "GND" }, { nodeId: "arduino", pin: groundPin }, `GND → ${groundPin}`, "#0f0f0f");
    addWire({ nodeId: "ultrasonic", pin: "TRIG" }, { nodeId: "arduino", pin: signalPins.trig }, `TRIG → ${signalPins.trig}`, "#b54dff");
    addWire({ nodeId: "ultrasonic", pin: "ECHO" }, { nodeId: "arduino", pin: signalPins.echo }, `ECHO → ${signalPins.echo}`, "#b54dff");
  }

  if (usesServo) {
    addNode({
      id: "servo",
      label: components.find((item) => /servo/i.test(item)) || "Servo motor",
      subtitle: "Moves to a set angle",
      lane: "right",
      x: 0.68,
      y: usesTemperature ? 0.26 : 0.40,
      w: 280,
      h: 130,
      color: "#e9e0ff",
      pins: ["VCC", "GND", "SIGNAL"],
      pinLayout: [
        { name: "VCC", x: 272, y: 44, side: "right" },
        { name: "GND", x: 272, y: 88, side: "right" },
        { name: "SIGNAL", x: 272, y: 112, side: "right" }
      ]
    });

    addWire({ nodeId: "servo", pin: "VCC" }, { nodeId: "arduino", pin: powerPin }, `VCC → ${powerPin}`, "#ff4444");
    addWire({ nodeId: "servo", pin: "GND" }, { nodeId: "arduino", pin: groundPin }, `GND → ${groundPin}`, "#0f0f0f");
    addWire({ nodeId: "servo", pin: "SIGNAL" }, { nodeId: "arduino", pin: signalPins.servo }, `SIGNAL → ${signalPins.servo}`, "#2563eb");
  }

  if (usesRelay) {
    addNode({
      id: "relay",
      label: components.find((item) => /relay/i.test(item)) || "1-channel relay",
      subtitle: "Switches a higher-power load",
      lane: "right",
      x: 0.66,
      y: usesTemperature ? 0.50 : 0.52,
      w: 320,
      h: 150,
      color: "#ffe9e9",
      pins: ["VCC", "GND", "IN"],
      pinLayout: [
        { name: "VCC", x: 312, y: 48, side: "right" },
        { name: "GND", x: 312, y: 82, side: "right" },
        { name: "IN", x: 312, y: 116, side: "right" }
      ]
    });

    addWire({ nodeId: "relay", pin: "VCC" }, { nodeId: "arduino", pin: powerPin }, `VCC → ${powerPin}`, "#ff4444");
    addWire({ nodeId: "relay", pin: "GND" }, { nodeId: "arduino", pin: groundPin }, `GND → ${groundPin}`, "#0f0f0f");
    addWire({ nodeId: "relay", pin: "IN" }, { nodeId: "arduino", pin: signalPins.relay }, `IN → ${signalPins.relay}`, "#2563eb");
  }

  if (inferred.nodes.length === 0) {
    addNode({
      id: "sensor",
      label: components[0] || (has("temperature", "humid") ? "DHT22" : has("light", "blink") ? "LED" : "Sensor"),
      subtitle: "Primary input for this project",
      lane: "left",
      x: 0.08,
      y: 0.24,
      w: 300,
      h: 140,
      color: "#dce9ff",
      pins: ["VCC", "GND", "DATA"],
      pinLayout: [
        { name: "VCC", x: 292, y: 44, side: "right" },
        { name: "GND", x: 292, y: 82, side: "right" },
        { name: "DATA", x: 292, y: 120, side: "right" }
      ]
    });

    addWire({ nodeId: "sensor", pin: "VCC" }, { nodeId: "arduino", pin: powerPin }, `VCC → ${powerPin}`, "#ff4444");
    addWire({ nodeId: "sensor", pin: "GND" }, { nodeId: "arduino", pin: groundPin }, `GND → ${groundPin}`, "#0f0f0f");
    addWire({ nodeId: "sensor", pin: "DATA" }, { nodeId: "arduino", pin: signalPins.data }, `DATA → ${signalPins.data}`, "#b54dff");
  }

  const laneGroups = inferred.nodes.reduce((accumulator, node) => {
    const lane = node.lane || "left";
    accumulator[lane] = accumulator[lane] || [];
    accumulator[lane].push(node);
    return accumulator;
  }, { left: [], right: [], center: [] });

  const placeLane = (laneNodes, x, startY, gap) => {
    laneNodes.forEach((node, index) => {
      node.x = x;
      node.y = startY + index * gap;
    });
  };

  const leftGap = laneGroups.left.length > 1 ? Math.min(0.24, 0.64 / (laneGroups.left.length - 1)) : 0;
  const rightGap = laneGroups.right.length > 1 ? Math.min(0.24, 0.64 / (laneGroups.right.length - 1)) : 0;

  placeLane(laneGroups.left, 0.06, laneGroups.left.length > 1 ? 0.10 : 0.24, leftGap || 0.22);
  placeLane(laneGroups.right, 0.66, laneGroups.right.length > 1 ? 0.12 : 0.38, rightGap || 0.22);
  placeLane(laneGroups.center, 0.36, 0.24, 0.22);

  return inferred;
};

const buildDiagramExport = (diagram) => {
  if (!diagram) return {};

  return {
    visualLayout: {
      theme: "dark-grid",
      style: "premium circuit builder",
      boardPosition: {
        x: Math.round(diagram.board.x * 100),
        y: Math.round(diagram.board.y * 100),
        width: diagram.board.w,
        height: diagram.board.h
      },
      description: diagram.layoutDescription
    },
    board: {
      label: diagram.board.label,
      subtitle: diagram.board.subtitle,
      pins: diagram.board.pinLayout.map((pin) => pin.name)
    },
    components: diagram.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      subtitle: node.subtitle,
      lane: node.lane,
      position: {
        x: Math.round(node.x * 100),
        y: Math.round(node.y * 100),
        width: node.w,
        height: node.h
      },
      pins: node.pins
    })),
    connections: diagram.wires.map((wire) => ({
      from: `${wire.from.nodeId}.${wire.from.pin}`,
      to: `${wire.to.nodeId}.${wire.to.pin}`,
      label: wire.label,
      color: wire.color
    })),
    interaction: {
      draggableComponents: true,
      hoverHighlight: true,
      curvedRouting: true,
      connectionLabels: true
    }
  };
};

const DiagramPreview = ({ isDark, diagram: incomingDiagram }) => {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef({ nodeId: null, offsetX: 0, offsetY: 0 });
  const panRef = useRef({ active: false, startX: 0, startY: 0, translateX: 0, translateY: 0 });
  const [hoveredWire, setHoveredWire] = useState(null);
  const [positions, setPositions] = useState({});
  const [viewport, setViewport] = useState({ scale: 1, translateX: 0, translateY: 0 });

  const diagram = incomingDiagram || getDiagramModel();

  const getCanvasSize = () => {
    const container = canvasRef.current;
    return {
      width: container?.clientWidth || 1,
      height: container?.clientHeight || 1
    };
  };

  const getWorldBounds = () => {
    const boardBox = getNodeBox(diagram.board);
    const boxes = [boardBox, ...diagram.nodes.map((node) => getNodeBox(node))];
    const padding = 48;

    const minX = Math.min(...boxes.map((box) => box.x)) - padding;
    const minY = Math.min(...boxes.map((box) => box.y)) - padding;
    const maxX = Math.max(...boxes.map((box) => box.x + box.w)) + padding;
    const maxY = Math.max(...boxes.map((box) => box.y + box.h)) + padding;

    return {
      x: minX,
      y: minY,
      width: Math.max(maxX - minX, 1),
      height: Math.max(maxY - minY, 1)
    };
  };

  const zoomTo = (nextScale, focusX = null, focusY = null) => {
    const container = canvasRef.current;
    if (!container) return;

    const bounds = container.getBoundingClientRect();
    const current = viewport;
    const clampedScale = Math.min(Math.max(nextScale, 0.45), 1.8);
    const anchorX = focusX ?? bounds.width / 2;
    const anchorY = focusY ?? bounds.height / 2;
    const worldX = (anchorX - current.translateX) / current.scale;
    const worldY = (anchorY - current.translateY) / current.scale;

    setViewport({
      scale: clampedScale,
      translateX: anchorX - worldX * clampedScale,
      translateY: anchorY - worldY * clampedScale
    });
  };

  const fitToView = () => {
    const container = canvasRef.current;
    if (!container) return;

    const bounds = container.getBoundingClientRect();
    const world = getWorldBounds();
    const scale = Math.min(bounds.width / world.width, bounds.height / world.height) * 0.92;
    const clampedScale = Math.min(Math.max(scale, 0.45), 1.2);
    const translateX = (bounds.width - world.width * clampedScale) / 2 - world.x * clampedScale;
    const translateY = (bounds.height - world.height * clampedScale) / 2 - world.y * clampedScale;

    setViewport({ scale: clampedScale, translateX, translateY });
  };

  useEffect(() => {
    const initial = {};
    if (diagram.nodes.length === 0) {
      return;
    }

    diagram.nodes.forEach((node) => {
      initial[node.id] = positions[node.id] || { x: node.x, y: node.y };
    });

    initial[diagram.board.id] = positions[diagram.board.id] || { x: diagram.board.x, y: diagram.board.y };

    setPositions(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram.signature]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      fitToView();
    });

    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram.signature]);

  const getNodeBox = (node) => {
    const size = node.id === diagram.board.id ? { w: node.w, h: node.h } : { w: node.w, h: node.h };
    const pos = positions[node.id] || { x: node.x, y: node.y };
    const container = canvasRef.current;
    const width = container?.clientWidth || 1;
    const height = container?.clientHeight || 1;

    return {
      x: pos.x * width,
      y: pos.y * height,
      w: size.w,
      h: size.h
    };
  };

  const getConnectorPoint = (node, pinIndex, side = "right") => {
    const layoutPin = (node.pinLayout || [])[pinIndex] || (node.pinLayout || []).find((pin) => pin.name === (node.pins || [])[pinIndex]);
    if (layoutPin) {
      const box = getNodeBox(node);
      const x = box.x + layoutPin.x;
      const y = box.y + layoutPin.y;
      return { x, y };
    }

    const box = getNodeBox(node);
    const pins = node.pins || [];
    const yStep = box.h / (pins.length + 1 || 1);
    const y = box.y + yStep * (pinIndex + 1);

    if (side === "left") {
      return { x: box.x, y };
    }

    if (side === "board") {
      return { x: box.x, y };
    }

    return { x: box.x + box.w, y };
  };

  const getNodeById = (nodeId) => {
    if (nodeId === diagram.board.id) return diagram.board;
    return diagram.nodes.find((node) => node.id === nodeId) || diagram.board;
  };

  const onPointerMove = (event) => {
    if (dragRef.current.nodeId && canvasRef.current) {
      const bounds = canvasRef.current.getBoundingClientRect();
      const width = bounds.width || 1;
      const height = bounds.height || 1;
      const nextX = (event.clientX - bounds.left - viewport.translateX - dragRef.current.offsetX) / (width * viewport.scale);
      const nextY = (event.clientY - bounds.top - viewport.translateY - dragRef.current.offsetY) / (height * viewport.scale);

      setPositions((prev) => ({
        ...prev,
        [dragRef.current.nodeId]: {
          x: Math.min(Math.max(nextX, 0.02), 0.92),
          y: Math.min(Math.max(nextY, 0.02), 0.88)
        }
      }));
      return;
    }

    if (panRef.current.active) {
      const deltaX = event.clientX - panRef.current.startX;
      const deltaY = event.clientY - panRef.current.startY;

      setViewport((prev) => ({
        ...prev,
        translateX: panRef.current.translateX + deltaX,
        translateY: panRef.current.translateY + deltaY
      }));
    }
  };

  const onPointerUp = () => {
    dragRef.current.nodeId = null;
    panRef.current.active = false;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  const onWheel = (event) => {
    if (!canvasRef.current) return;
    event.preventDefault();

    const rect = canvasRef.current.getBoundingClientRect();
    const focusX = event.clientX - rect.left;
    const focusY = event.clientY - rect.top;
    const delta = event.deltaY < 0 ? 0.12 : -0.12;
    zoomTo(viewport.scale + delta, focusX, focusY);
  };

  const startPan = (event) => {
    const target = event.target;
    const isNodeDrag = target.closest?.("[data-draggable-node='true']");
    const isButton = target.closest?.("button");

    if (isNodeDrag || isButton) {
      return;
    }

    panRef.current.active = true;
    panRef.current.startX = event.clientX;
    panRef.current.startY = event.clientY;
    panRef.current.translateX = viewport.translateX;
    panRef.current.translateY = viewport.translateY;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grab";
  };

  useEffect(() => {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  });

  const renderNode = (node, isBoard = false) => {
    const box = getNodeBox(node);
    const pinList = node.pins || [];
    const pinLayout = node.pinLayout || [];
    const panelClass = isBoard
      ? "border-white/20 bg-[#eaf0fa] text-[#0f172a]"
      : node.color === "#dff7e8"
        ? "border-black/10 bg-[#dff7e8] text-[#0f172a]"
        : node.color === "#e9e0ff"
          ? "border-black/10 bg-[#e9e0ff] text-[#0f172a]"
          : node.color === "#ffe9e9"
            ? "border-black/10 bg-[#ffe9e9] text-[#0f172a]"
            : node.color === "#fde9d7"
              ? "border-black/10 bg-[#fde9d7] text-[#0f172a]"
              : "border-black/10 bg-[#dce9ff] text-[#0f172a]";

    return (
      <div
        key={node.id}
        data-draggable-node="true"
        className={`absolute select-none overflow-hidden rounded-[24px] border px-5 py-4 shadow-[0_18px_50px_rgba(15,23,42,0.14)] backdrop-blur-[1px] ${panelClass} cursor-grab transition-transform duration-150 active:cursor-grabbing hover:-translate-y-0.5`}
        style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        onPointerDown={(event) => {
          const target = event.currentTarget;
          const bounds = target.getBoundingClientRect();
          dragRef.current.nodeId = node.id;
          dragRef.current.offsetX = event.clientX - bounds.left;
          dragRef.current.offsetY = event.clientY - bounds.top;
          document.body.style.userSelect = "none";
          document.body.style.cursor = "grabbing";
        }}
      >
        <div className={`absolute inset-x-0 top-0 h-1 ${isBoard ? "bg-gradient-to-r from-[#3b82f6] via-[#6366f1] to-[#8b5cf6]" : "bg-gradient-to-r from-[#0ea5e9] via-[#8b5cf6] to-[#f59e0b]"}`} />

        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[15px] font-semibold leading-tight">{node.label}</div>
            {node.subtitle && <div className="mt-1 text-[11px] leading-4 text-[#475569]">{node.subtitle}</div>}
          </div>
          <span className="rounded-full border border-black/10 bg-white/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#334155]">
            {isBoard ? "Board" : node.id}
          </span>
        </div>

        {isBoard && (
          <div className="mt-4 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#475569]">
            <span className="rounded-full bg-[#dbeafe] px-2 py-1 text-[#1d4ed8]">Power</span>
            <span className="rounded-full bg-[#ede9fe] px-2 py-1 text-[#6d28d9]">Digital</span>
            <span className="rounded-full bg-[#fef3c7] px-2 py-1 text-[#b45309]">Analog</span>
          </div>
        )}

        {pinList.map((pin, index) => {
          const layout = pinLayout[index] || pinLayout.find((entry) => entry.name === pin);
          const x = layout ? layout.x : box.w - 18;
          const y = layout ? layout.y : 52 + index * 34;
          const labelX = layout?.side === "left" ? x - 8 : layout?.side === "bottom" ? x - 12 : x - 62;
          const labelY = layout?.side === "left" ? y + 5 : layout?.side === "bottom" ? y - 22 : y + 5;

          return (
            <div key={`${pin}-${index}`}>
              <span
                className="absolute border border-white/80 bg-white shadow-[0_0_0_2px_rgba(59,130,246,0.2)] transition-transform duration-150 hover:scale-125"
                style={{ left: x - 5, top: y - 5, width: 10, height: 10, borderRadius: 999 }}
              />
              <span
                className="absolute rounded-md border border-black/10 bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-[#334155] shadow-sm"
                style={{ left: labelX, top: labelY }}
              >
                {pin}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      ref={canvasRef}
      className={`relative h-full w-full overflow-hidden rounded-[22px] border ${isDark ? "border-white/10 bg-[#0f1116]" : "border-black/10 bg-[#f8fafc]"}`}
      onWheel={onWheel}
      onPointerDown={startPan}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.14),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.12),transparent_26%)]" />
      <div
        ref={stageRef}
        className="absolute left-0 top-0 h-full w-full origin-top-left"
        style={{ transform: `translate(${viewport.translateX}px, ${viewport.translateY}px) scale(${viewport.scale})` }}
      >
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1000 700" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <pattern id="diagramGrid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M 48 0 L 0 0 0 48" fill="none" stroke={isDark ? "rgba(255,255,255,0.04)" : "rgba(15,23,42,0.06)"} strokeWidth="1" />
            </pattern>
            <pattern id="diagramDots" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1" fill={isDark ? "rgba(255,255,255,0.09)" : "rgba(15,23,42,0.08)"} />
            </pattern>
          </defs>
          <rect width="1000" height="700" fill="url(#diagramGrid)" />
          <rect width="1000" height="700" fill="url(#diagramDots)" />

          {diagram.wires.map((wire, index) => {
            const fromNode = getNodeById(wire.from.nodeId);
            const toNode = getNodeById(wire.to.nodeId);
            const fromPinIndex = (fromNode.pins || []).indexOf(wire.from.pin);
            const toPinIndex = (toNode.pins || []).indexOf(wire.to.pin);
            const fromPoint = getConnectorPoint(fromNode, Math.max(fromPinIndex, 0), fromNode.id === diagram.board.id ? "board" : "right");
            const toPoint = getConnectorPoint(toNode, Math.max(toPinIndex, 0), toNode.id === diagram.board.id ? "board" : "left");
            const direction = fromPoint.x < toPoint.x ? 1 : -1;
            const distance = Math.max(Math.abs(toPoint.x - fromPoint.x), 120);
            const bend = 72 + Math.min(distance * 0.22, 120);
            const curveLift = (index % 3 - 1) * 10;
            const path = `M ${fromPoint.x} ${fromPoint.y} C ${fromPoint.x + direction * bend} ${fromPoint.y + curveLift}, ${toPoint.x - direction * bend} ${toPoint.y - curveLift}, ${toPoint.x} ${toPoint.y}`;
            const labelX = (fromPoint.x + toPoint.x) / 2;
            const labelY = (fromPoint.y + toPoint.y) / 2 - 14;
            const wireKey = `${wire.from.nodeId}:${wire.from.pin}->${wire.to.nodeId}:${wire.to.pin}`;
            const active = hoveredWire === wireKey;

            return (
              <g key={`${wire.label}-${index}`}>
                <path
                  d={path}
                  fill="none"
                  stroke={wire.color}
                  strokeWidth={active ? 5 : 3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={active ? 1 : 0.9}
                  onPointerEnter={() => setHoveredWire(wireKey)}
                  onPointerLeave={() => setHoveredWire(null)}
                />
                <g transform={`translate(${labelX}, ${labelY})`}>
                  <rect x="-48" y="-13" width="96" height="26" rx="13" fill={isDark ? "rgba(15,23,42,0.95)" : "rgba(255,255,255,0.97)"} stroke={isDark ? "rgba(255,255,255,0.16)" : "rgba(15,23,42,0.16)"} />
                  <text x="0" y="4" textAnchor="middle" fontSize="11" fontWeight="700" fill={isDark ? "#e5e7eb" : "#0f172a"}>{wire.label}</text>
                </g>
              </g>
            );
          })}
        </svg>

        {renderNode(diagram.board, true)}
        {diagram.nodes.map((node) => renderNode(node))}
      </div>

      <div className={`absolute right-4 top-4 flex items-center gap-2 rounded-xl border px-2 py-2 shadow-sm ${isDark ? "border-white/10 bg-[#0b0d12]/90" : "border-black/10 bg-white/90"}`}>
        <button onClick={() => zoomTo(viewport.scale + 0.12)} className={`rounded-lg px-3 py-1 text-xs font-semibold ${isDark ? "bg-white/10 text-white hover:bg-white/15" : "bg-black/5 text-[#0f172a] hover:bg-black/10"}`}>+</button>
        <button onClick={() => zoomTo(viewport.scale - 0.12)} className={`rounded-lg px-3 py-1 text-xs font-semibold ${isDark ? "bg-white/10 text-white hover:bg-white/15" : "bg-black/5 text-[#0f172a] hover:bg-black/10"}`}>-</button>
        <button onClick={() => setViewport({ scale: 1, translateX: 0, translateY: 0 })} className={`rounded-lg px-3 py-1 text-xs font-semibold ${isDark ? "bg-white/10 text-white hover:bg-white/15" : "bg-black/5 text-[#0f172a] hover:bg-black/10"}`}>Reset</button>
        <button onClick={fitToView} className={`rounded-lg px-3 py-1 text-xs font-semibold ${isDark ? "bg-white/10 text-white hover:bg-white/15" : "bg-black/5 text-[#0f172a] hover:bg-black/10"}`}>Fit</button>
      </div>

      <div className={`absolute left-4 top-4 rounded-xl border px-3 py-2 text-[11px] leading-5 shadow-sm ${isDark ? "border-white/10 bg-[#0b0d12]/90 text-[#e5e7eb]" : "border-black/10 bg-white/90 text-[#0f172a]"}`}>
        <div className="font-semibold">Real circuit layout</div>
        <div className="text-[10px] text-[#64748b]">Zoom, pan, and drag components. Pin labels and wire boxes stay aligned to the selected board.</div>
      </div>

      <div className={`absolute left-4 bottom-4 rounded-xl border px-3 py-2 text-[11px] font-semibold ${isDark ? "border-white/10 bg-[#0b0d12]/90 text-[#e5e7eb]" : "border-black/10 bg-white/90 text-[#0f172a]"}`}>
        {diagram.layoutDescription}
      </div>
    </div>
  );
};

const downloadTextFile = (filename, content) => {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export default function ProjectChat({ onIdeationStateChange }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("code");
  const [project, setProject] = useState(null);
  const [compilerFqbn, setCompilerFqbn] = useState("arduino:avr:uno");
  const [compilerOutput, setCompilerOutput] = useState(null);
  const [compilerLoading, setCompilerLoading] = useState(false);
  const [hardwarePorts, setHardwarePorts] = useState([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [portLoading, setPortLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [outputLoading, setOutputLoading] = useState(false);
  const [liveOutput, setLiveOutput] = useState("");
  const [outputAutoRefresh, setOutputAutoRefresh] = useState(false);
  const [lastOutputAt, setLastOutputAt] = useState("");
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialBaudRate, setSerialBaudRate] = useState("9600");
  const [showProjectSidebar, setShowProjectSidebar] = useState(true);
  const [workspaceFiles, setWorkspaceFiles] = useState(null);
  const scrollRef = useRef(null);
  const outputRequestInFlightRef = useRef(false);
  const serialPortRef = useRef(null);
  const serialReaderRef = useRef(null);
  const serialReadActiveRef = useRef(false);

  const mapHardwarePorts = (items = []) => {
    return (Array.isArray(items) ? items : []).map((item, index) => ({
      id: item.address || item.label || `port-${index}`,
      address: item.address || item.label || `port-${index}`,
      label: item.label || item.address || `Port ${index + 1}`,
      boardName: item.boardName || "",
      recommendedFqbn: item.recommendedFqbn || "",
      confidence: item.confidence || "low",
      source: item.source || "unknown"
    }));
  };

  const { theme } = useThemeStore();
  const isDark = theme === "dark";

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, []);

  useEffect(() => {
    const loadHardwarePorts = async () => {
      try {
        setPortLoading(true);
        const res = await axios.get("http://localhost:5000/api/compile/ports", { withCredentials: true });
        const portList = Array.isArray(res.data?.ports) ? res.data.ports : [];
        setHardwarePorts(mapHardwarePorts(portList));

        const firstPort = portList[0]?.address || portList[0]?.label || "";
        const hasCurrentSelection = portList.some((item) => (item.address || item.label) === selectedPort);
        if (portList.length > 0 && (!selectedPort || !hasCurrentSelection)) {
          setSelectedPort(firstPort);
        }
      } catch (err) {
        setHardwarePorts([]);
      } finally {
        setPortLoading(false);
      }
    };

    loadHardwarePorts();
  }, []);

  const getSerialPortLabel = (port) => {
    if (!port) return "No USB port selected";
    if (typeof port === "string") {
      const matched = hardwarePorts.find((item) => item.address === port);
      if (matched) {
        return matched.boardName ? `${matched.address} - ${matched.boardName}` : matched.label || matched.address;
      }
      return port;
    }
    if (!port.getInfo) return "Unknown USB port";
    const info = port.getInfo();
    const vendorId = info.usbVendorId ? `VID:${info.usbVendorId.toString(16).padStart(4, "0")}` : "VID:?";
    const productId = info.usbProductId ? `PID:${info.usbProductId.toString(16).padStart(4, "0")}` : "PID:?";
    return `${vendorId} ${productId}`;
  };

  const refreshHardwarePorts = async () => {
    try {
      setPortLoading(true);
      const res = await axios.get("http://localhost:5000/api/compile/ports", { withCredentials: true });
      const portList = Array.isArray(res.data?.ports) ? res.data.ports : [];
      setHardwarePorts(mapHardwarePorts(portList));
      const firstPort = portList[0]?.address || portList[0]?.label || "";
      const hasCurrentSelection = portList.some((item) => (item.address || item.label) === selectedPort);
      if (portList.length > 0 && (!selectedPort || !hasCurrentSelection)) {
        setSelectedPort(firstPort);
      }
      toast.success(portList.length > 0 ? `Found ${portList.length} port(s).` : "No ports detected.");
    } catch (err) {
      toast.error("Failed to refresh Arduino ports.");
      setHardwarePorts([]);
    } finally {
      setPortLoading(false);
    }
  };

  const runUploadToBoard = async () => {
    if (!compilerOutput?.ok) {
      toast.error("Compile the sketch before uploading.");
      return;
    }

    if (!selectedPort) {
      toast.error("Select a hardware port first.");
      return;
    }

    toast.loading("Uploading sketch to board...");
    setUploadLoading(true);
    try {
      const uploadSketchCode = normalizeSketchForCompile(codeText);
      const res = await axios.post(
        "http://localhost:5000/api/compile/upload",
        {
          projectId: project._id,
          sketchCode: uploadSketchCode,
          fqbn: compilerFqbn,
          port: selectedPort
        },
        { withCredentials: true }
      );

      toast.dismiss();
      toast.success("Upload completed.");
      setCompilerOutput((current) => ({
        ...current,
        uploadResult: res.data.uploadResult
      }));
    } catch (err) {
      toast.dismiss();
      const errorMessage = err?.response?.data?.error || "Upload failed";
      toast.error(errorMessage);
      setCompilerOutput((current) => ({
        ...current,
        uploadResult: err?.response?.data?.uploadResult || null
      }));
    } finally {
      setUploadLoading(false);
    }
  };

  const captureProjectOutput = async ({ silent = false, timeoutMs = 12000 } = {}) => {
    if (!project?._id) {
      if (!silent) {
        toast.error("Project is not ready yet");
      }
      return;
    }

    if (outputRequestInFlightRef.current) {
      return;
    }

    outputRequestInFlightRef.current = true;

    try {
      if (!silent) {
        setOutputLoading(true);
      }
      const res = await axios.post(
        "http://localhost:5000/api/wokwi/serial/capture",
        {
          projectId: project._id,
          projectPath: project?.wokwiProjectPath || "",
          timeoutMs
        },
        { withCredentials: true }
      );

      const serial = res.data?.result?.serialTail || res.data?.result?.stdoutTail || "";
      setLastOutputAt(new Date().toLocaleTimeString());
      if (!silent) {
        toast.success(serial ? "Output captured" : "Capture finished (no serial text yet)");
      }
    } catch (err) {
      const errorMessage = err?.response?.data?.error || "Failed to capture output";
      if (!silent) {
        toast.error(errorMessage);
      }
    } finally {
      outputRequestInFlightRef.current = false;
      if (!silent) {
        setOutputLoading(false);
      }
    }
  };

  const appendLiveOutput = (chunk = "") => {
    const text = String(chunk || "");
    if (!text) return;
    setLiveOutput((prev) => {
      const combined = `${prev || ""}${text}`;
      return combined.length > 30000 ? combined.slice(-30000) : combined;
    });
    setLastOutputAt(new Date().toLocaleTimeString());
  };

  const disconnectArduinoSerial = async ({ silent = false } = {}) => {
    serialReadActiveRef.current = false;
    try {
      if (serialReaderRef.current) {
        await serialReaderRef.current.cancel().catch(() => {});
        serialReaderRef.current.releaseLock?.();
      }
    } catch {}
    serialReaderRef.current = null;

    try {
      if (serialPortRef.current) {
        await serialPortRef.current.close().catch(() => {});
      }
    } catch {}
    serialPortRef.current = null;
    setSerialConnected(false);
    if (!silent) {
      toast.success("Arduino serial disconnected");
    }
  };

  const connectArduinoSerial = async () => {
    if (typeof navigator === "undefined" || !("serial" in navigator)) {
      toast.error("Web Serial is not supported in this browser. Use Chrome/Edge.");
      return;
    }

    try {
      if (serialConnected) {
        await disconnectArduinoSerial({ silent: true });
      }

      const baudRate = Number(serialBaudRate) || 9600;
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate });
      serialPortRef.current = port;
      serialReadActiveRef.current = true;
      setSerialConnected(true);
      setLiveOutput("");
      toast.success(`Arduino serial connected @ ${baudRate}`);
      appendLiveOutput(`\n[Serial connected @ ${baudRate}]\n`);

      const reader = port.readable?.getReader?.();
      if (!reader) {
        toast.error("Unable to open serial reader.");
        return;
      }
      serialReaderRef.current = reader;
      const decoder = new TextDecoder();

      while (serialReadActiveRef.current) {
        const { value, done } = await reader.read();
        if (done || !serialReadActiveRef.current) break;
        if (value) {
          appendLiveOutput(decoder.decode(value, { stream: true }));
        }
      }
    } catch (err) {
      if (serialReadActiveRef.current) {
        toast.error(err?.message || "Failed to connect Arduino serial");
      }
    } finally {
      if (!serialReadActiveRef.current) return;
      await disconnectArduinoSerial({ silent: true });
    }
  };

  const boardKey = inferBoardKey(project, messages);
  const boardSchema = BOARD_SCHEMAS[boardKey] || BOARD_SCHEMAS.arduino;
  const diagram = getDiagramModel(project, messages);

  const handleTabSelect = (tabId) => {
    setActiveTab(tabId);
    if (tabId === "compiler") {
      setShowProjectSidebar(false);
    } else {
      setShowProjectSidebar(true);
    }
  };

  useEffect(() => {
    setCompilerFqbn(boardKey === "esp32" ? "arduino:avr:uno" : "arduino:avr:uno");
  }, [boardKey]);

  useEffect(() => {
    const matchedPort = hardwarePorts.find((item) => item.address === selectedPort);
    if (matchedPort?.recommendedFqbn && matchedPort.recommendedFqbn !== compilerFqbn) {
      setCompilerFqbn(matchedPort.recommendedFqbn);
    }
  }, [selectedPort, hardwarePorts, compilerFqbn]);

  const generatedCodeText = buildMainCode(messages, boardSchema);
  const generatedPinsCsvText = buildPinsCsv(boardSchema);
  const generatedComponentsJsonText = buildComponentsJson(boardSchema);
  const generatedAssemblyMdText = buildAssemblyMd(messages, boardSchema);
  const generatedDiagramText = toSafeFileText(JSON.stringify(buildDiagramExport(diagram), null, 2));

  const effectiveWorkspaceFiles = normalizeWorkspaceFiles({
    mainIno: workspaceFiles?.mainIno && !isCorruptedSketchText(workspaceFiles.mainIno) ? workspaceFiles.mainIno : generatedCodeText,
    diagramJson: workspaceFiles?.diagramJson || generatedDiagramText,
    pinsCsv: workspaceFiles?.pinsCsv || generatedPinsCsvText,
    componentsJson: workspaceFiles?.componentsJson || generatedComponentsJsonText,
    assemblyMd: workspaceFiles?.assemblyMd || generatedAssemblyMdText
  });

  const codeText = effectiveWorkspaceFiles.mainIno;
  const pinsCsvText = effectiveWorkspaceFiles.pinsCsv;
  const componentsJsonText = effectiveWorkspaceFiles.componentsJson;
  const assemblyMdText = effectiveWorkspaceFiles.assemblyMd;
  const diagramText = effectiveWorkspaceFiles.diagramJson;
  const outputText = serialConnected
    ? (liveOutput || "Waiting for Arduino serial data...")
    : "Connect Arduino to see real hardware output in realtime.";

  const filesByTab = {
    code: { name: "main.ino", content: codeText },
    diagram: { name: "diagram.json", content: diagramText },
    pins: { name: "pins.csv", content: pinsCsvText },
    components: { name: "components.json", content: componentsJsonText },
    assembly: { name: "assembly.md", content: assemblyMdText },
    compiler: {
      name: "arduino-compiler",
      content: `Board: ${boardSchema.label}\nFQBN: ${compilerFqbn}\nSource: main.ino\nAction: Compile`
    },
  };

  const activeFile = filesByTab[activeTab] || filesByTab.code;

  // auto scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const loadProjectWorkspace = async () => {
    if (!id) return;

    try {
      const [historyRes, projectAiHistoryRes, projectRes] = await Promise.all([
        axios.get(`http://localhost:5000/api/project/${id}/history/ideation`, { withCredentials: true }),
        axios.get(`http://localhost:5000/api/project-ai/history/${id}`, { withCredentials: true }),
        axios.get(`http://localhost:5000/api/project/${id}`, { withCredentials: true })
      ]);

      setMessages(combineChatHistory(historyRes.data?.messages || [], projectAiHistoryRes.data?.messages || []));
      setProject(projectRes.data || null);
      setWorkspaceFiles(normalizeWorkspaceFiles(projectAiHistoryRes.data?.workspaceFiles || projectRes.data?.workspaceFiles || {}));
    } catch (err) {
      const errorMessage = err?.response?.data?.error || "Unable to load project workspace";
      toast.error(errorMessage);
      setMessages([]);
    }
  };

  useEffect(() => {
    const init = async () => {
      if (!id) return;
      await loadProjectWorkspace();
    };

    init();
  }, [id]);

  useEffect(() => {
    const evidenceTime = project?.wokwiEvidence?.lastSerialCapture?.ranAt;
    if (evidenceTime && !serialConnected) {
      setLastOutputAt(new Date(evidenceTime).toLocaleTimeString());
    }
  }, [project?.wokwiEvidence?.lastSerialCapture?.ranAt, serialConnected]);

  useEffect(() => {
    const match = String(codeText || "").match(/Serial\.begin\s*\(\s*(\d+)\s*\)/);
    const baudFromCode = match?.[1];
    if (baudFromCode && baudFromCode !== serialBaudRate) {
      setSerialBaudRate(baudFromCode);
    }
  }, [codeText, serialBaudRate]);

  useEffect(() => {
    if (!outputAutoRefresh) return;
    if (activeTab !== "compiler") return;
    if (!project?._id) return;
    if (serialConnected) return;

    const interval = setInterval(() => {
      captureProjectOutput({ silent: true, timeoutMs: 1500 });
    }, 2200);

    return () => clearInterval(interval);
  }, [outputAutoRefresh, activeTab, project?._id, project?.wokwiProjectPath, serialConnected]);

  useEffect(() => {
    return () => {
      disconnectArduinoSerial({ silent: true });
    };
  }, []);

  const sendMessage = async (messageOverride) => {
    const nextMessage = (messageOverride ?? input).trim();
    if (!nextMessage || loading) return;

    const userMsg = nextMessage;

    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setInput("");
    setLoading(true);

    try {
      const res = await axios.post(
        "http://localhost:5000/api/project-ai/chat",
        {
          projectId: id,
          message: userMsg,
          workspaceFiles: {
            "main.ino": codeText,
            "diagram.json": diagramText,
            "pins.csv": pinsCsvText,
            "components.json": componentsJsonText,
            "assembly.md": assemblyMdText
          }
        },
        { withCredentials: true }
      );

      setMessages(prev => [
        ...prev,
        { role: "ai", content: res.data.reply }
      ]);
      setWorkspaceFiles(normalizeWorkspaceFiles(res.data?.workspaceFiles || {}));

      if (onIdeationStateChange) {
        onIdeationStateChange({
          ideationFinalized: true,
          ideaState: project?.ideaState,
        });
      }

    } catch (err) {
      console.error("Chat Error:", err);
      const status = err?.response?.status;
      const errorMessage = status === 404
        ? "Workspace chat route is unavailable. Restart the backend server to enable AI code editing."
        : (err?.response?.data?.error || "Workspace chat failed");
      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenDesign = () => {
    navigate(`/project/${id}/design`, {
      state: {
        projectSnapshot: project,
        projectId: id
      }
    });
  };

  const handleSetWokwiUrl = async () => {
    const currentUrl = project?.wokwiUrl || "https://wokwi.com/projects/328451800839488084";
    const nextInput = window.prompt("Paste Wokwi project URL", currentUrl);

    if (nextInput === null) return;

    const nextUrl = nextInput.trim();

    try {
      const res = await axios.put(
        `http://localhost:5000/api/project/${id}`,
        { wokwiUrl: nextUrl },
        { withCredentials: true }
      );

      setProject(res.data);
      toast.success(nextUrl ? "Wokwi URL saved" : "Wokwi URL cleared");
    } catch (err) {
      toast.error(err?.response?.data?.error || "Failed to save Wokwi URL");
    }
  };

  const handleSendFeedback = () => {
    window.location.href = "mailto:feedback@hardcore.app?subject=Project%20Workspace%20Feedback";
  };

  const runArduinoCompiler = async () => {
    if (!project?._id) {
      toast.error("Project is not ready yet");
      return;
    }

    try {
      setCompilerLoading(true);
      setCompilerOutput(null);
      const compileSketchCode = normalizeSketchForCompile(codeText);

      const res = await axios.post(
        "http://localhost:5000/api/compile/sketch",
        {
          projectId: project._id,
          sketchCode: compileSketchCode,
          fqbn: compilerFqbn
        },
        { withCredentials: true }
      );

      setCompilerOutput({
        ok: true,
        hexCode: res.data?.hexCode || "",
        compileResult: res.data?.compileResult || null
      });
      toast.success("Arduino code compiled successfully");
    } catch (err) {
      const compileResult = err?.response?.data?.compileResult || null;
      const errorMessage = err?.response?.data?.error || compileResult?.stderrTail || compileResult?.stdoutTail || err?.response?.data?.message || "Compilation failed";
      setCompilerOutput({
        ok: false,
        error: errorMessage,
        compileResult
      });
      toast.error(errorMessage);
    } finally {
      setCompilerLoading(false);
    }
  };

  return (
    <div className={`${isDark ? "bg-[#212121] text-[#e5e5e5]" : "bg-[#f4f6fb] text-[#111]"} h-[100svh] max-h-[100svh] min-h-0 w-full overflow-hidden`}>
      <div className={`grid h-full min-h-0 grid-cols-1 gap-0 ${showProjectSidebar ? "lg:grid-cols-[340px_minmax(0,1fr)_260px]" : "lg:grid-cols-[340px_minmax(0,1fr)]"}`}>
        <aside className={`flex h-full min-h-0 flex-col border-r ${isDark ? "border-white/10 bg-[#2a2a2a]" : "border-black/10 bg-white"}`}>
          <div className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-lg font-extrabold tracking-[0.08em]">Hardcore</p>
              <span className={`rounded border px-1.5 py-0.5 text-[10px] ${isDark ? "border-white/20 text-[#c4c4c4]" : "border-black/20 text-[#555]"}`}>Beta</span>
            </div>
            <button
              onClick={() => navigate("/home")}
              className={`rounded px-2 py-1 text-sm font-semibold ${isDark ? "hover:bg-white/10" : "hover:bg-black/5"}`}
            >
              Back
            </button>
          </div>

          <div ref={scrollRef} className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <AnimatePresence>
              {messages.map((m, i) => {
                const options = m.role === "ai" ? extractAssistantOptions(m.content) : [];
                const hasOptions = options.length > 0;
                const displayText = formatAssistantText(m.content, hasOptions);

                return (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18 }}
                    className={`mb-4 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div className={`max-w-[88%] rounded-xl px-4 py-3 text-sm leading-relaxed ${m.role === "user" ? (isDark ? "bg-[#6d63ff] text-white" : "bg-[#6d63ff] text-white") : (isDark ? "border border-white/10 bg-[#2f2f2f]" : "border border-black/10 bg-white")}`}>
                      <ChatRichText text={displayText} isDark={isDark} />

                      {hasOptions && (
                        <div className="mt-3 grid gap-2">
                          {options.map((option) => {
                            const parsed = splitOptionLabel(option.label);

                            return (
                              <button
                                key={`${i}-${option.id}`}
                                type="button"
                                onClick={() => sendMessage(String(option.id))}
                                disabled={loading}
                                className={`rounded-lg border px-3 py-2 text-left text-xs transition ${isDark ? "border-white/15 bg-[#252525] hover:bg-[#303030]" : "border-black/10 bg-[#f7f7ff] hover:bg-[#efefff]"} ${loading ? "cursor-not-allowed opacity-60" : ""}`}
                                title={option.label}
                              >
                                <span className="font-semibold">{option.id}.</span> {parsed.title}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>

            {loading && (
              <div className={`inline-flex rounded-xl border px-4 py-2 text-xs ${isDark ? "border-white/10 bg-[#2f2f2f] text-[#bdbdbd]" : "border-black/10 bg-white text-[#666]"}`}>
                Generating...
              </div>
            )}
          </div>

          <div className={`sticky bottom-0 border-t px-4 py-3 ${isDark ? "border-white/10 bg-[#2a2a2a]" : "border-black/10 bg-white"}`}>
            <div className={`flex items-center gap-2 rounded-lg border px-2 py-2 ${isDark ? "border-white/10 bg-[#1f1f1f]" : "border-black/10 bg-[#f8f8fb]"}`}>
              <input
                className={`h-9 w-full bg-transparent px-2 text-sm outline-none ${isDark ? "placeholder:text-[#7c7c7c]" : "placeholder:text-[#9a9a9a]"}`}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Type a message..."
              />
              <button
                onClick={() => sendMessage()}
                disabled={loading}
                className={`rounded-md px-3 py-2 text-xs font-semibold ${isDark ? "bg-[#5e58ff] text-white hover:bg-[#6f6aff]" : "bg-[#5e58ff] text-white hover:bg-[#4e47f2]"} ${loading ? "opacity-60" : ""}`}
              >
                Send
              </button>
            </div>
          </div>
        </aside>

        <section className={`flex h-full min-h-0 flex-col ${showProjectSidebar ? "border-r" : ""} ${isDark ? "border-white/10 bg-[#252525]" : "border-black/10 bg-white"}`}>
          <div className={`flex items-start justify-between border-b px-5 py-4 ${isDark ? "border-white/10" : "border-black/10"}`}>
            <div>
              <p className="text-xl font-semibold">Workspace</p>
              <p className={`text-sm ${isDark ? "text-[#a1a1a1]" : "text-[#666]"}`}>Code, diagram, pins, components, assembly</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSetWokwiUrl}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${isDark ? "border-white/15 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}
              >
                Set Wokwi URL
              </button>
              <button
                onClick={handleOpenDesign}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${isDark ? "border-white/15 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}
              >
                Open Design
              </button>
              {activeTab === "compiler" && !showProjectSidebar && (
                <button
                  onClick={() => setShowProjectSidebar(true)}
                  className="rounded-lg bg-[#2563eb] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1d4ed8]"
                >
                  Show project files
                </button>
              )}
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(activeFile.content);
                    toast.success(`${activeFile.name} copied`);
                  } catch {
                    toast.error("Copy failed");
                  }
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${isDark ? "border-white/15 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}
              >
                Copy
              </button>
              <button
                onClick={() => downloadTextFile(activeFile.name, activeFile.content)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${isDark ? "border-white/15 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}
              >
                Download
              </button>
            </div>
          </div>

          <div className={`border-b px-5 py-2 ${isDark ? "border-white/10" : "border-black/10"}`}>
            <p className={`text-xs ${isDark ? "text-[#9da3b3]" : "text-[#6b7280]"}`}>
              Current file: {activeFile.name}
            </p>
          </div>

          <div className={`border-b px-5 py-3 ${isDark ? "border-white/10" : "border-black/10"}`}>
            <div className="flex flex-wrap items-center gap-2">
              {[
                { id: "code", label: "Code" },
                { id: "diagram", label: "Diagram" },
                { id: "compiler", label: "Compiler" },
                { id: "pins", label: "Pins" },
                { id: "components", label: "Components" },
                { id: "assembly", label: "Assembly" }
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleTabSelect(tab.id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${activeTab === tab.id ? (isDark ? "bg-white text-[#111]" : "bg-[#111827] text-white") : (isDark ? "bg-white/5 text-[#d7d7d7] hover:bg-white/10" : "bg-black/5 text-[#374151] hover:bg-black/10")}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 px-5 py-4 overflow-hidden">
            {activeTab === "diagram" ? (
              <DiagramPreview isDark={isDark} diagram={diagram} />
            ) : activeTab === "compiler" ? (
              <div className={`flex h-full flex-col ${isDark ? "bg-[#252525]" : "bg-[#f8fafc]"}`}>
                {/* Header - Compact */}
                <div className={`border-b px-6 py-4 ${isDark ? "border-white/10 bg-[#2d2d38]" : "border-black/10 bg-white"}`}>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-bold">Arduino IDE Compiler</h2>
                      <p className={`text-xs ${isDark ? "text-[#b0b8c8]" : "text-[#6b7280]"}`}>Verify and upload your sketch</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className={`rounded-full px-3 py-1.5 text-xs font-semibold ${compilerOutput?.ok ? "bg-emerald-500/20 text-emerald-400" : compilerOutput?.error ? "bg-red-500/20 text-red-400" : "bg-slate-500/20 text-slate-400"}`}>
                        {compilerOutput?.ok ? "✓ Verified" : compilerOutput?.error ? "✗ Failed" : "○ Ready"}
                      </div>
                      <div className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${isDark ? "border-white/10 text-[#c0c8d8]" : "border-black/10 text-[#6b7280]"}`}>
                        {selectedPort ? getSerialPortLabel(selectedPort) : "No port"}
                      </div>
                    </div>
                  </div>
                  {compilerOutput?.error && (
                    <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">
                      {compilerOutput.error}
                    </div>
                  )}
                </div>

                {/* Main Content Grid - 3 Column Layout */}
                <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
                  {/* Left Column: Sketch Preview */}
                  <div className={`flex flex-col overflow-hidden rounded-xl border ${isDark ? "border-white/10 bg-[#2d2d38]" : "border-black/10 bg-white"}`}>
                    <div className={`border-b px-4 py-3 ${isDark ? "border-white/10" : "border-black/10"}`}>
                      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Sketch</p>
                      <p className="mt-1 font-semibold">main.ino</p>
                    </div>
                    <div className="workspace-scrollbar min-h-0 flex-1 overflow-auto">
                      <pre className="h-full whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-slate-400">
{codeText}
                      </pre>
                    </div>
                  </div>

                  {/* Middle Column: Port + Buttons */}
                  <div className="workspace-scrollbar flex w-64 flex-col gap-3 overflow-y-auto">
                    {/* Port Selection */}
                    <div className={`flex flex-col rounded-xl border p-4 ${isDark ? "border-white/10 bg-[#2d2d38]" : "border-black/10 bg-white"}`}>
                      <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Port</p>
                      <div className={`mb-2 rounded-lg border p-2 text-sm font-semibold ${isDark ? "border-white/10 bg-[#1f1f28] text-white" : "border-black/10 bg-[#f8fafc]"}`}>
                        {selectedPort || "--"}
                      </div>
                      <select
                        value={selectedPort}
                        onChange={(e) => setSelectedPort(e.target.value)}
                        disabled={portLoading}
                        className={`mb-2 rounded-lg border px-3 py-2 text-xs outline-none ${isDark ? "border-white/10 bg-[#1f1f28] text-[#e0e4eb]" : "border-black/10 bg-[#f8fafc] text-[#111827]"} ${portLoading ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        {hardwarePorts.length === 0 ? (
                          <option value="">{portLoading ? "Scanning..." : "No ports"}</option>
                        ) : (
                          hardwarePorts.map((port) => (
                            <option key={port.id} value={port.address}>
                              {port.label}
                            </option>
                          ))
                        )}
                      </select>
                      <button
                        onClick={refreshHardwarePorts}
                        disabled={portLoading}
                        className={`rounded-lg px-3 py-2 text-xs font-semibold ${portLoading ? "opacity-50 cursor-not-allowed bg-slate-600" : "bg-slate-600 text-white hover:bg-slate-700"}`}
                      >
                        {portLoading ? "Scanning..." : "Refresh"}
                      </button>
                    </div>

                    {/* Verify & Upload Buttons */}
                    <div className={`flex flex-col gap-2 rounded-xl border p-4 ${isDark ? "border-white/10 bg-[#2d2d38]" : "border-black/10 bg-white"}`}>
                      <button
                        onClick={runArduinoCompiler}
                        disabled={compilerLoading}
                        className={`rounded-lg px-3 py-2.5 font-semibold text-white transition ${compilerLoading ? "opacity-60 cursor-not-allowed bg-blue-500" : "bg-blue-600 hover:bg-blue-700"}`}
                      >
                        {compilerLoading ? "Verifying..." : "Verify"}
                      </button>
                      <button
                        onClick={runUploadToBoard}
                        disabled={!compilerOutput?.ok || !selectedPort || uploadLoading}
                        className={`rounded-lg px-3 py-2.5 font-semibold text-white transition ${!compilerOutput?.ok || !selectedPort || uploadLoading ? "opacity-50 cursor-not-allowed bg-slate-500" : "bg-emerald-600 hover:bg-emerald-700"}`}
                      >
                        {uploadLoading ? "Uploading..." : "Upload"}
                      </button>
                    </div>

                    {/* Workflow Info */}
                    <div className={`rounded-xl border p-3 text-xs leading-relaxed ${isDark ? "border-white/10 bg-[#1f1f28] text-[#b0b8c8]" : "border-black/10 bg-[#f8fafc] text-[#6b7280]"}`}>
                      <p className="mb-2 font-semibold">Steps:</p>
                      <ol className="space-y-1">
                        <li>1. Verify</li>
                        <li>2. Select port</li>
                        <li>3. Upload</li>
                      </ol>
                    </div>
                  </div>

                  {/* Right Column: Logs & Output */}
                  <div className="workspace-scrollbar flex flex-1 flex-col gap-3 overflow-y-auto pr-1">
                    {/* Hex Output */}
                    <div className={`flex min-h-[180px] shrink-0 flex-col overflow-hidden rounded-xl border ${isDark ? "border-white/10 bg-[#2d2d38]" : "border-black/10 bg-white"}`}>
                      <div className={`border-b px-4 py-2 ${isDark ? "border-white/10" : "border-black/10"}`}>
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Hex Output</p>
                      </div>
                      <div className="workspace-scrollbar min-h-0 flex-1 overflow-auto">
                        <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-4 text-slate-400">
{compilerOutput?.hexCode || "Ready after verify"}
                        </pre>
                      </div>
                    </div>

                    {/* Compile Log */}
                    <div className={`flex min-h-[180px] shrink-0 flex-col overflow-hidden rounded-xl border ${isDark ? "border-white/10 bg-[#2d2d38]" : "border-black/10 bg-white"}`}>
                      <div className={`border-b px-4 py-2 ${isDark ? "border-white/10" : "border-black/10"}`}>
                        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Log</p>
                      </div>
                      <div className="workspace-scrollbar min-h-0 flex-1 overflow-auto">
                        <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-4 text-slate-400">
{compilerOutput ? (compilerOutput.compileResult?.summary || "Check details above") : "Logs appear after verify"}
                        </pre>
                      </div>
                    </div>

                    {/* Arduino Output */}
                    <div className={`flex min-h-[220px] shrink-0 flex-col overflow-hidden rounded-xl border ${isDark ? "border-white/10 bg-[#2d2d38]" : "border-black/10 bg-white"}`}>
                      <div className={`border-b px-4 py-2 ${isDark ? "border-white/10" : "border-black/10"}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Arduino Output (Realtime)</p>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${serialConnected ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-500/20 text-slate-400"}`}>
                            {serialConnected ? "Live serial" : "Disconnected"}
                          </span>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <input
                            value={serialBaudRate}
                            onChange={(event) => setSerialBaudRate(event.target.value)}
                            placeholder="9600"
                            className={`h-8 w-24 rounded-md border px-2 text-xs outline-none ${isDark ? "border-white/15 bg-[#1f1f28] text-[#e5e7eb]" : "border-black/10 bg-white text-[#111827]"}`}
                          />
                          {!serialConnected ? (
                            <button
                              onClick={connectArduinoSerial}
                              className="h-8 rounded-md bg-emerald-600 px-3 text-xs font-semibold text-white hover:bg-emerald-700"
                            >
                              Connect Arduino
                            </button>
                          ) : (
                            <button
                              onClick={() => disconnectArduinoSerial()}
                              className="h-8 rounded-md bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700"
                            >
                              Disconnect
                            </button>
                          )}
                          <button
                            onClick={() => setLiveOutput("")}
                            className={`h-8 rounded-md px-3 text-xs font-semibold ${isDark ? "bg-white/10 text-[#d7d7d7] hover:bg-white/15" : "bg-slate-200 text-[#111827] hover:bg-slate-300"}`}
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="workspace-scrollbar min-h-0 flex-1 overflow-auto">
                        <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-4 text-slate-400">
{outputText || "No serial output yet. Connect Arduino and start Serial.print/println in your sketch."}
                        </pre>
                      </div>
                      <div className={`border-t px-3 py-1 text-[10px] ${isDark ? "border-white/10 text-slate-400" : "border-black/10 text-slate-500"}`}>
                        {lastOutputAt ? `Last update: ${lastOutputAt}` : "Last update: waiting"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : activeTab === "code" || activeTab === "pins" || activeTab === "components" || activeTab === "assembly" ? (
              <div className={`workspace-scrollbar h-full overflow-y-auto ${isDark ? "bg-[#252525]" : "bg-[#f8fafc]"}`}>
                <pre className={`h-full whitespace-pre-wrap break-words rounded-xl border p-4 text-xs leading-relaxed ${isDark ? "border-white/10 bg-[#1f1f1f] text-[#b8d97c]" : "border-black/10 bg-[#f8fafc] text-[#1f2937]"}`}>
                  {activeFile.content}
                </pre>
              </div>
            ) : (
              <div className={`workspace-scrollbar h-full overflow-y-auto ${isDark ? "bg-[#252525]" : "bg-[#f8fafc]"}`}>
                <pre className={`h-full whitespace-pre-wrap break-words rounded-xl border p-4 text-xs leading-relaxed ${isDark ? "border-white/10 bg-[#1f1f1f] text-[#b8d97c]" : "border-black/10 bg-[#f8fafc] text-[#1f2937]"}`}>
                  {activeFile.content}
                </pre>
              </div>
            )}
          </div>
        </section>

          <aside className={`workspace-scrollbar h-full overflow-y-auto px-4 py-4 ${showProjectSidebar ? (isDark ? "bg-[#2a2a2a]" : "bg-[#fbfcff]") : "hidden"}`}>
            <div className="flex items-center justify-between">
            <div>
              <p className="text-xl font-semibold">Project</p>
              <p className={`text-sm ${isDark ? "text-[#a1a1a1]" : "text-[#666]"}`}>Files</p>
            </div>
            <button
              onClick={handleSendFeedback}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${isDark ? "border-white/15 hover:bg-white/10" : "border-black/10 hover:bg-black/5"}`}
            >
              Send feedback
            </button>
          </div>

          <div className="mt-5 space-y-5 text-sm">
            <div>
              <p className={`mb-2 text-xs font-semibold uppercase tracking-[0.14em] ${isDark ? "text-[#8f96aa]" : "text-[#6b7280]"}`}>src</p>
              <button
                onClick={() => setActiveTab("code")}
                className={`w-full px-0 py-1 text-left font-semibold transition ${activeTab === "code" ? (isDark ? "text-white" : "text-black") : (isDark ? "text-[#c7c7c7] hover:text-white" : "text-[#374151] hover:text-black")}`}
              >
                main.ino
              </button>
            </div>

            <div>
              <p className={`mb-2 text-xs font-semibold uppercase tracking-[0.14em] ${isDark ? "text-[#8f96aa]" : "text-[#6b7280]"}`}>wiring</p>
              <button
                onClick={() => setActiveTab("diagram")}
                className={`w-full px-0 py-1 text-left font-semibold transition ${activeTab === "diagram" ? (isDark ? "text-white" : "text-black") : (isDark ? "text-[#c7c7c7] hover:text-white" : "text-[#374151] hover:text-black")}`}
              >
                diagram
              </button>
            </div>

            <div>
              <p className={`mb-2 text-xs font-semibold uppercase tracking-[0.14em] ${isDark ? "text-[#8f96aa]" : "text-[#6b7280]"}`}>specs</p>
              <button
                onClick={() => setActiveTab("pins")}
                className={`mb-1 w-full px-0 py-1 text-left font-semibold transition ${activeTab === "pins" ? (isDark ? "text-white" : "text-black") : (isDark ? "text-[#c7c7c7] hover:text-white" : "text-[#374151] hover:text-black")}`}
              >
                pins.csv
              </button>
              <button
                onClick={() => setActiveTab("components")}
                className={`w-full px-0 py-1 text-left font-semibold transition ${activeTab === "components" ? (isDark ? "text-white" : "text-black") : (isDark ? "text-[#c7c7c7] hover:text-white" : "text-[#374151] hover:text-black")}`}
              >
                components.json
              </button>
            </div>

            <div>
              <p className={`mb-2 text-xs font-semibold uppercase tracking-[0.14em] ${isDark ? "text-[#8f96aa]" : "text-[#6b7280]"}`}>docs</p>
              <button
                onClick={() => setActiveTab("assembly")}
                className={`w-full px-0 py-1 text-left font-semibold transition ${activeTab === "assembly" ? (isDark ? "text-white" : "text-black") : (isDark ? "text-[#c7c7c7] hover:text-white" : "text-[#374151] hover:text-black")}`}
              >
                assembly.md
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
