import { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { useThemeStore } from "../store/useThemeStore";
import toast from "react-hot-toast";
import ChatRichText from "./ChatRichText";
import ComponentsChat from "./ComponentsChat";

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

const buildProjectContextText = (messages = [], project = null) => {
  return toSafeFileText([
    project?.description,
    project?.ideaState?.summary,
    project?.ideaState?.requirements,
    project?.componentsState?.components,
    project?.componentsState?.architecture,
    ...messages.map((message) => message?.content)
  ].filter(Boolean).join(" ")).toLowerCase();
};

const normalizeCodePinLiteral = (pinValue = "") => String(pinValue || "")
  .trim()
  .replace(/^D(\d+)$/i, "$1")
  .replace(/^GPIO(\d+)$/i, "$1");

const buildMainCode = (messages = [], boardSchema = BOARD_SCHEMAS.arduino, project = null) => {
  const projectTitle = deriveProjectTitle(messages);
  const summary = deriveSummary(messages);
  const projectText = buildProjectContextText(messages, project);
  const sensorPin = boardSchema.codeSensorPin;
  const ledPin = boardSchema.codeLedPin;
  const trigPin = normalizeCodePinLiteral(boardSchema.signalPins?.trig || "9");
  const echoPin = normalizeCodePinLiteral(boardSchema.signalPins?.echo || "10");
  const hasDistanceKeyword = /\bdistance\b|\brange\b|\bcm\b|\bcentimeter\b|\bultrasonic\b|\bhc[-\s]?sr0?4\b/.test(projectText);
  const hasIrSensorKeyword = /\bir\s*(sensor|distance)\b|\binfrared\s*(sensor|distance)\b/.test(projectText);
  const isIrRemoteContext = /\bir\s*receiver\b|\bremote\b/.test(projectText);
  const isDistanceIntent = hasDistanceKeyword || (hasIrSensorKeyword && !isIrRemoteContext);
  const isUltrasonicIntent = /\bultrasonic\b|\bhc[-\s]?sr0?4\b|\btrig\b|\becho\b/.test(projectText);

  if (isDistanceIntent && isUltrasonicIntent) {
    return toSafeFileText(`// ${projectTitle}
// ${summary}

const int TRIG_PIN = ${trigPin};
const int ECHO_PIN = ${echoPin};
const int STATUS_LED = ${ledPin};

unsigned long lastReadAt = 0;
const unsigned long READ_INTERVAL = 250;

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  const unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (duration == 0) return -1.0f;
  return (duration * 0.0343f) / 2.0f;
}

void setup() {
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(STATUS_LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  const unsigned long now = millis();
  if (now - lastReadAt < READ_INTERVAL) return;
  lastReadAt = now;

  const float distanceCm = readDistanceCm();
  if (distanceCm < 0.0f) {
    Serial.println("Distance: out of range");
    digitalWrite(STATUS_LED, LOW);
    return;
  }

  Serial.print("Distance: ");
  Serial.print(distanceCm, 1);
  Serial.println(" cm");

  digitalWrite(STATUS_LED, distanceCm <= 20.0f ? HIGH : LOW);
}
`);
  }

  if (isDistanceIntent) {
    const adcMax = boardSchema.id === "esp32" ? 4095.0 : 1023.0;
    const vRef = boardSchema.id === "esp32" ? 3.3 : 5.0;
    return toSafeFileText(`// ${projectTitle}
// ${summary}

#include <math.h>

const int IR_SENSOR_PIN = ${sensorPin};
const int STATUS_LED = ${ledPin};
const float ADC_MAX = ${adcMax};
const float VREF = ${vRef};

unsigned long lastReadAt = 0;
const unsigned long READ_INTERVAL = 250;

float estimateDistanceCmFromIr(float voltage) {
  // Approximation for common Sharp-style analog IR distance sensors.
  if (voltage < 0.2f) return 80.0f;
  float distance = 27.86f * pow(voltage, -1.15f);
  if (distance < 4.0f) distance = 4.0f;
  if (distance > 80.0f) distance = 80.0f;
  return distance;
}

void setup() {
  pinMode(STATUS_LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  const unsigned long now = millis();
  if (now - lastReadAt < READ_INTERVAL) return;
  lastReadAt = now;

  const int raw = analogRead(IR_SENSOR_PIN);
  const float voltage = (raw / ADC_MAX) * VREF;
  const float distanceCm = estimateDistanceCmFromIr(voltage);

  Serial.print("Distance: ");
  Serial.print(distanceCm, 1);
  Serial.println(" cm");

  digitalWrite(STATUS_LED, distanceCm <= 20.0f ? HIGH : LOW);
}
`);
  }

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

const buildPinsCsv = (boardSchema = BOARD_SCHEMAS.arduino) => toSafeFileText(`component,pin,board_pin,direction,signal_type,voltage,explanation
sensor,VCC,${boardSchema.powerPin},input,power,${boardSchema.powerPin},Supplies stable operating voltage to the sensor module
sensor,GND,GND,input,reference,0V,Provides common electrical reference shared by all modules
sensor,DATA,${boardSchema.signalPins.data},output,analog_or_digital,0-${boardSchema.powerPin},Carries measured sensor value into the MCU read pin
status_led,ANODE,${boardSchema.signalPins.led},input,digital_output,0-${boardSchema.powerPin},MCU drives this pin HIGH or LOW for visual status indication
status_led,CATHODE,GND,input,return_path,0V,Completes LED current path to ground
resistor_220ohm,LEG1,${boardSchema.signalPins.led},passive,current_limit,n/a,Limits LED current to protect MCU pin and LED
resistor_220ohm,LEG2,status_led:ANODE,passive,current_limit,n/a,In series with LED anode to avoid overcurrent
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

  return toSafeFileText(`# ${projectTitle} - Detailed Assembly Guide

## 1) Project intent
This build reads a sensor value and gives feedback through serial output plus a status LED.
Target board: ${boardSchema.label}

## 2) Required hardware
- 1 x ${boardSchema.label}
- 1 x Sensor module (analog or digital output pin)
- 1 x LED
- 1 x 220 ohm resistor
- Breadboard and jumper wires
- USB cable for power and upload

## 3) Pre-assembly checklist
1. Disconnect USB power before wiring.
2. Confirm sensor operating voltage is compatible with ${boardSchema.powerPin}.
3. Keep one clear ground rail on the breadboard.
4. Separate power wires from signal wires where possible.

## 4) Pin map summary
- Sensor VCC -> ${boardSchema.powerPin}
- Sensor GND -> GND
- Sensor DATA -> ${boardSchema.signalPins.data}
- LED control -> ${boardSchema.signalPins.led} through 220 ohm resistor
- LED return -> GND

## 5) Physical assembly steps
1. Place ${boardSchema.label} at the edge of the breadboard for easy pin access.
2. Place the sensor module so VCC GND and DATA pins are clearly visible.
3. Place the LED on the breadboard with long leg (anode) separated from short leg (cathode).
4. Insert a 220 ohm resistor in series between ${boardSchema.signalPins.led} and the LED anode.
5. Connect sensor VCC to ${boardSchema.powerPin}.
6. Connect sensor GND to board GND.
7. Connect sensor DATA to ${boardSchema.signalPins.data}.
8. Connect LED cathode to GND.
9. Re-check every connection against pins.csv before powering.

## 6) Power and signal verification before upload
1. With power off verify no wire is shifted by one row on breadboard.
2. Confirm there is no direct short between ${boardSchema.powerPin} and GND.
3. Confirm resistor is in series with LED and not bypassed.
4. Confirm sensor DATA is not tied directly to power.

## 7) Firmware upload procedure
1. Connect board by USB.
2. Select correct board profile in compiler.
3. Select correct COM port.
4. Click Verify and confirm successful compile.
5. Click Upload and wait for completion message.

## 8) Runtime validation
1. Open Serial Monitor at 9600 baud.
2. Observe repeating sensor values.
3. Change input condition on sensor and confirm values respond.
4. Verify LED threshold behavior: ON above threshold and OFF below threshold.

## 9) Troubleshooting
- No serial data: check baud rate, COM port, and USB cable.
- Constant zero/constant max reading: verify sensor DATA pin mapping and sensor voltage.
- LED always off: verify resistor path and LED polarity.
- LED always on: verify threshold logic and pin assignment in code.
- Intermittent output: improve ground connection and shorten loose jumper wires.

## 10) Safety and reliability notes
- Never exceed board pin voltage limits.
- Do not power high-current loads directly from MCU IO pins.
- Keep a single common ground for all low-voltage modules.
- Document any pin changes in both pins.csv and sketch constants.
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

  const handleTabSelect = (tabId) => {
    setActiveTab(tabId);
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

  const generatedCodeText = buildMainCode(messages, boardSchema, project);
  const generatedPinsCsvText = buildPinsCsv(boardSchema);
  const generatedComponentsJsonText = buildComponentsJson(boardSchema);
  const generatedAssemblyMdText = buildAssemblyMd(messages, boardSchema);

  const effectiveWorkspaceFiles = normalizeWorkspaceFiles({
    mainIno: workspaceFiles?.mainIno && !isCorruptedSketchText(workspaceFiles.mainIno) ? workspaceFiles.mainIno : generatedCodeText,
    pinsCsv: workspaceFiles?.pinsCsv || generatedPinsCsvText,
    componentsJson: workspaceFiles?.componentsJson || generatedComponentsJsonText,
    assemblyMd: workspaceFiles?.assemblyMd || generatedAssemblyMdText
  });

  const codeText = effectiveWorkspaceFiles.mainIno;
  const pinsCsvText = effectiveWorkspaceFiles.pinsCsv;
  const componentsJsonText = effectiveWorkspaceFiles.componentsJson;
  const assemblyMdText = effectiveWorkspaceFiles.assemblyMd;
  const outputText = serialConnected
    ? (liveOutput || "Waiting for Arduino serial data...")
    : "Connect Arduino to see real hardware output in realtime.";

  const filesByTab = {
    code: { name: "main.ino", content: codeText },
    pins: { name: "pins.csv", content: pinsCsvText },
    components: { name: "components.json", content: componentsJsonText },
    assembly: { name: "assembly.md", content: assemblyMdText },
    compiler: {
      name: "arduino-compiler",
      content: `Board: ${boardSchema.label}\nFQBN: ${compilerFqbn}\nSource: main.ino\nAction: Compile`
    },
  };

  const activeFile = filesByTab[activeTab] || filesByTab.code;
  const isComponentsView = activeTab === "components";

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

  const handleComponentsWorkspaceSync = (nextWorkspace = {}) => {
    setWorkspaceFiles(normalizeWorkspaceFiles(nextWorkspace || {}));
  };

  const handleComponentsProjectSync = (patch = {}) => {
    if (!patch || typeof patch !== "object") return;

    setProject((current) => {
      const base = current || {};
      return {
        ...base,
        ...(patch.componentsState ? { componentsState: patch.componentsState } : {}),
        ...(patch.architectureState ? { architectureState: patch.architectureState } : {}),
        ...(patch.generationProfile ? { generationProfile: patch.generationProfile } : {})
      };
    });
  };

  const handleComponentsChatAppend = (entries = []) => {
    const normalized = (Array.isArray(entries) ? entries : [])
      .map((item) => ({
        role: item?.role === "user" ? "user" : "ai",
        content: String(item?.content || "").trim()
      }))
      .filter((item) => item.content);

    if (normalized.length === 0) return;
    setMessages((prev) => [...prev, ...normalized]);
  };

  const sendMessage = async (messageOverride) => {
    const nextMessage = (messageOverride ?? input).trim();
    if (!nextMessage || loading) return;

    const userMsg = nextMessage;

    setMessages(prev => [...prev, { role: "user", content: userMsg }]);
    setInput("");
    setLoading(true);

    try {
      if (activeTab === "components") {
        const componentsRes = await axios.post(
          "http://localhost:5000/api/components/chat",
          {
            projectId: id,
            message: userMsg
          },
          { withCredentials: true }
        );

        setMessages(prev => [
          ...prev,
          { role: "ai", content: componentsRes.data?.reply || "Components updated." }
        ]);

        if (componentsRes.data?.componentsState) {
          setProject((current) => ({
            ...(current || {}),
            componentsState: componentsRes.data.componentsState
          }));
        }
        if (componentsRes.data?.architectureState || componentsRes.data?.generationProfile) {
          setProject((current) => ({
            ...(current || {}),
            ...(componentsRes.data?.architectureState ? { architectureState: componentsRes.data.architectureState } : {}),
            ...(componentsRes.data?.generationProfile ? { generationProfile: componentsRes.data.generationProfile } : {})
          }));
        }
        if (componentsRes.data?.workspaceFiles) {
          setWorkspaceFiles(normalizeWorkspaceFiles(componentsRes.data.workspaceFiles));
        }

        return;
      }

      const res = await axios.post(
        "http://localhost:5000/api/project-ai/chat",
          {
            projectId: id,
            message: userMsg,
            workspaceFiles: {
              "main.ino": codeText,
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
      <div className={`grid h-full min-h-0 grid-cols-1 gap-0 ${activeTab === "components" ? "lg:grid-cols-1" : "lg:grid-cols-[340px_minmax(0,1fr)]"}`}>
        <aside className={`${activeTab === "components" ? "hidden " : ""}flex h-full min-h-0 flex-col border-r ${isDark ? "border-white/10 bg-[#2a2a2a]" : "border-black/10 bg-white"}`}>
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

        <section className={`flex h-full min-h-0 flex-1 flex-col ${isDark ? "border-white/10 bg-[#252525]" : "border-black/10 bg-white"}`}>
          {!isComponentsView && (
            <>
              <div className={`flex items-start justify-between border-b px-5 py-4 ${isDark ? "border-white/10" : "border-black/10"}`}>
                <div>
                  <p className="text-xl font-semibold">Workspace</p>
                  <p className={`text-sm ${isDark ? "text-[#a1a1a1]" : "text-[#666]"}`}>Code, pins, components, assembly</p>
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
            </>
          )}

          <div className={`border-b px-5 py-3 ${isDark ? "border-white/10" : "border-black/10"}`}>
            <div className="flex flex-wrap items-center gap-2">
              {[
                { id: "code", label: "Code" },
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

          <div className={`min-h-0 flex-1 overflow-hidden ${isComponentsView ? "" : "px-5 py-4"}`}>
            {activeTab === "compiler" ? (
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
                <div className="workspace-scrollbar flex min-h-0 flex-1 gap-4 overflow-x-auto overflow-y-hidden p-4">
                  {/* Left Column: Sketch Preview */}
                  <div className={`min-h-0 min-w-0 flex flex-1 flex-col overflow-hidden rounded-xl border ${isDark ? "border-white/10 bg-[#2d2d38]" : "border-black/10 bg-white"}`}>
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
                  <div className="workspace-scrollbar flex min-h-0 w-64 shrink-0 flex-col gap-3 overflow-y-auto">
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
                  <div className="workspace-scrollbar min-h-0 min-w-0 flex flex-1 flex-col gap-3 overflow-y-auto pr-1">
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
            ) : activeTab === "components" ? (
              <div className="h-full overflow-hidden">
                <ComponentsChat
                  onWorkspaceSync={handleComponentsWorkspaceSync}
                  onProjectSync={handleComponentsProjectSync}
                  onMainChatAppend={handleComponentsChatAppend}
                />
              </div>
            ) : activeTab === "code" || activeTab === "pins" || activeTab === "assembly" ? (
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

      </div>
    </div>
  );
}
