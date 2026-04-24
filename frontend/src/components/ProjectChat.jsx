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
  const dragRef = useRef({ nodeId: null, offsetX: 0, offsetY: 0 });
  const [hoveredWire, setHoveredWire] = useState(null);
  const [positions, setPositions] = useState({});

  const diagram = incomingDiagram || getDiagramModel();

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
    if (!dragRef.current.nodeId || !canvasRef.current) return;
    const bounds = canvasRef.current.getBoundingClientRect();
    const width = bounds.width || 1;
    const height = bounds.height || 1;
    const nextX = (event.clientX - bounds.left - dragRef.current.offsetX) / width;
    const nextY = (event.clientY - bounds.top - dragRef.current.offsetY) / height;

    setPositions((prev) => ({
      ...prev,
      [dragRef.current.nodeId]: {
        x: Math.min(Math.max(nextX, 0.02), 0.92),
        y: Math.min(Math.max(nextY, 0.02), 0.88)
      }
    }));
  };

  const onPointerUp = () => {
    dragRef.current.nodeId = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
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
    <div ref={canvasRef} className={`relative h-full w-full overflow-hidden rounded-[22px] border ${isDark ? "border-white/10 bg-[#0f1116]" : "border-black/10 bg-[#f8fafc]"}`}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(99,102,241,0.14),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.12),transparent_26%)]" />
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
                <rect x="-36" y="-11" width="72" height="22" rx="11" fill={isDark ? "rgba(15,23,42,0.92)" : "rgba(255,255,255,0.95)"} stroke={isDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.12)"} />
                <text x="0" y="4" textAnchor="middle" fontSize="11" fontWeight="600" fill={isDark ? "#e5e7eb" : "#0f172a"}>{wire.label}</text>
              </g>
            </g>
          );
        })}
      </svg>

      {renderNode(diagram.board, true)}
      {diagram.nodes.map((node) => renderNode(node))}

      <div className={`absolute left-4 top-4 rounded-xl border px-3 py-2 text-[11px] leading-5 shadow-sm ${isDark ? "border-white/10 bg-[#0b0d12]/90 text-[#e5e7eb]" : "border-black/10 bg-white/90 text-[#0f172a]"}`}>
        <div className="font-semibold">Real circuit layout</div>
        <div className="text-[10px] text-[#64748b]">Premium SVG board, smooth wires, pin labels, and drag-to-rearrange cards.</div>
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
  const scrollRef = useRef(null);

  const { theme } = useThemeStore();
  const isDark = theme === "dark";

  const boardKey = inferBoardKey(project, messages);
  const boardSchema = BOARD_SCHEMAS[boardKey] || BOARD_SCHEMAS.arduino;
  const diagram = getDiagramModel(project, messages);

  const codeText = buildMainCode(messages, boardSchema);
  const pinsCsvText = buildPinsCsv(boardSchema);
  const componentsJsonText = buildComponentsJson(boardSchema);
  const assemblyMdText = buildAssemblyMd(messages, boardSchema);

  const diagramText = toSafeFileText(JSON.stringify(buildDiagramExport(diagram), null, 2));

  const filesByTab = {
    code: { name: "main.ino", content: codeText },
    diagram: { name: "diagram.json", content: diagramText },
    pins: { name: "pins.csv", content: pinsCsvText },
    components: { name: "components.json", content: componentsJsonText },
    assembly: { name: "assembly.md", content: assemblyMdText },
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
      const [historyRes, projectRes] = await Promise.all([
        axios.get(`http://localhost:5000/api/project/${id}/history/ideation`, { withCredentials: true }),
        axios.get(`http://localhost:5000/api/project/${id}`, { withCredentials: true })
      ]);

      setMessages(historyRes.data?.messages || []);
      setProject(projectRes.data || null);
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

  const sendMessage = async (messageOverride) => {
    const nextMessage = (messageOverride ?? input).trim();
    if (!nextMessage || loading) return;

    const userMsg = nextMessage;

    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setInput("");
    setLoading(true);

    try {
      const res = await axios.post(
        "http://localhost:5000/api/project/chat",
        {
          projectId: id, // ✅ REAL ID
          message: userMsg
        },
        { withCredentials: true }
      );

      setMessages(prev => [
        ...prev,
        { role: "ai", content: res.data.reply }
      ]);

      if (onIdeationStateChange) {
        onIdeationStateChange({
          ideationFinalized: res.data.ideationFinalized,
          ideaState: res.data.ideaState,
        });
      }

    } catch (err) {
      console.error("Chat Error:", err);
      const errorMessage = err?.response?.data?.error || "Ideation chat failed";
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

  return (
    <div className={`${isDark ? "bg-[#212121] text-[#e5e5e5]" : "bg-[#f4f6fb] text-[#111]"} h-[100dvh] w-full overflow-hidden`}>
      <div className="grid h-full min-h-0 grid-cols-1 gap-0 lg:grid-cols-[340px_minmax(0,1fr)_260px]">
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

        <section className={`flex h-full min-h-0 flex-col border-r ${isDark ? "border-white/10 bg-[#252525]" : "border-black/10 bg-white"}`}>
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

          <div className="min-h-0 flex-1 px-5 py-4 overflow-hidden">
            {activeTab === "diagram" ? (
              <DiagramPreview isDark={isDark} diagram={diagram} />
            ) : (
              <pre className={`workspace-scrollbar h-full max-h-full overflow-y-auto rounded-xl border p-4 text-xs leading-relaxed whitespace-pre-wrap break-words ${isDark ? "border-white/10 bg-[#1f1f1f] text-[#b8d97c]" : "border-black/10 bg-[#f8fafc] text-[#1f2937]"}`}>
                {activeFile.content}
              </pre>
            )}
          </div>
        </section>

        <aside className={`workspace-scrollbar h-full overflow-y-auto px-4 py-4 ${isDark ? "bg-[#2a2a2a]" : "bg-[#fbfcff]"}`}>
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