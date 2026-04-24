export const ARDUINO_UNO_PIN_DEFINITIONS = {
  board: "Arduino Uno (ATmega328P)",
  pins: [
    { name: "D0", type: "digital", features: ["RX"] },
    { name: "D1", type: "digital", features: ["TX"] },
    { name: "D2", type: "digital", features: ["INT0"] },
    { name: "D3", type: "digital", features: ["PWM", "INT1"] },
    { name: "D4", type: "digital" },
    { name: "D5", type: "digital", features: ["PWM"] },
    { name: "D6", type: "digital", features: ["PWM"] },
    { name: "D7", type: "digital" },
    { name: "D8", type: "digital" },
    { name: "D9", type: "digital", features: ["PWM"] },
    { name: "D10", type: "digital", features: ["PWM", "SPI_SS"] },
    { name: "D11", type: "digital", features: ["PWM", "SPI_MOSI"] },
    { name: "D12", type: "digital", features: ["SPI_MISO"] },
    { name: "D13", type: "digital", features: ["SPI_SCK", "LED_BUILTIN"] },
    { name: "A0", type: "analog" },
    { name: "A1", type: "analog" },
    { name: "A2", type: "analog" },
    { name: "A3", type: "analog" },
    { name: "A4", type: "analog", features: ["I2C_SDA"] },
    { name: "A5", type: "analog", features: ["I2C_SCL"] },
    { name: "5V", type: "power" },
    { name: "VIN", type: "power" },
    { name: "GND", type: "ground" }
  ]
};

export const ESP32_DEVKIT_V1_PIN_DEFINITIONS = {
  board: "ESP32 DevKit V1",
  pins: [
    { name: "GPIO0", type: "digital", features: ["ADC2", "touch", "PWM", "strapping"] },
    { name: "GPIO1", type: "digital", features: ["UART_TX0", "PWM"] },
    { name: "GPIO2", type: "digital", features: ["ADC2", "touch", "PWM", "strapping"] },
    { name: "GPIO3", type: "digital", features: ["UART_RX0", "PWM"] },
    { name: "GPIO4", type: "digital", features: ["ADC2", "touch", "PWM", "strapping"] },
    { name: "GPIO5", type: "digital", features: ["SPI_CS", "PWM", "strapping"] },
    { name: "GPIO6", type: "digital", features: ["reserved-flash"] },
    { name: "GPIO7", type: "digital", features: ["reserved-flash"] },
    { name: "GPIO8", type: "digital", features: ["reserved-flash"] },
    { name: "GPIO9", type: "digital", features: ["reserved-flash"] },
    { name: "GPIO10", type: "digital", features: ["reserved-flash"] },
    { name: "GPIO11", type: "digital", features: ["reserved-flash"] },
    { name: "GPIO12", type: "digital", features: ["ADC2", "touch", "PWM", "strapping"] },
    { name: "GPIO13", type: "digital", features: ["ADC2", "touch", "PWM"] },
    { name: "GPIO14", type: "digital", features: ["ADC2", "touch", "PWM"] },
    { name: "GPIO15", type: "digital", features: ["ADC2", "touch", "PWM", "strapping"] },
    { name: "GPIO16", type: "digital", features: ["PWM"] },
    { name: "GPIO17", type: "digital", features: ["PWM"] },
    { name: "GPIO18", type: "digital", features: ["SPI_SCK", "PWM"] },
    { name: "GPIO19", type: "digital", features: ["SPI_MISO", "PWM"] },
    { name: "GPIO20", type: "unavailable", features: ["not-bonded"] },
    { name: "GPIO21", type: "digital", features: ["I2C_SDA", "PWM"] },
    { name: "GPIO22", type: "digital", features: ["I2C_SCL", "PWM"] },
    { name: "GPIO23", type: "digital", features: ["SPI_MOSI", "PWM"] },
    { name: "GPIO24", type: "unavailable", features: ["not-bonded"] },
    { name: "GPIO25", type: "digital", features: ["ADC2", "DAC", "PWM"] },
    { name: "GPIO26", type: "digital", features: ["ADC2", "DAC", "PWM"] },
    { name: "GPIO27", type: "digital", features: ["ADC2", "touch", "PWM"] },
    { name: "GPIO28", type: "unavailable", features: ["not-bonded"] },
    { name: "GPIO29", type: "unavailable", features: ["not-bonded"] },
    { name: "GPIO30", type: "unavailable", features: ["not-bonded"] },
    { name: "GPIO31", type: "unavailable", features: ["not-bonded"] },
    { name: "GPIO32", type: "digital", features: ["ADC1", "touch", "PWM"] },
    { name: "GPIO33", type: "digital", features: ["ADC1", "touch", "PWM"] },
    { name: "GPIO34", type: "input-only", features: ["ADC1"] },
    { name: "GPIO35", type: "input-only", features: ["ADC1"] },
    { name: "GPIO36", type: "input-only", features: ["ADC1"] },
    { name: "GPIO37", type: "input-only", features: ["ADC1"] },
    { name: "GPIO38", type: "input-only", features: ["ADC1"] },
    { name: "GPIO39", type: "input-only", features: ["ADC1"] },
    { name: "3.3V", type: "power" },
    { name: "GND", type: "ground" }
  ]
};

const getBoardSignalText = (project = {}, userInput = "") => {
  return [
    project?.description,
    project?.ideaState?.summary,
    project?.ideaState?.requirements,
    project?.componentsState?.components,
    project?.componentsState?.architecture,
    userInput,
    ...(Array.isArray(project?.messages) ? project.messages.map((item) => item?.content) : []),
    ...(Array.isArray(project?.componentsMessages) ? project.componentsMessages.map((item) => item?.content) : []),
    ...(Array.isArray(project?.designMessages) ? project.designMessages.map((item) => item?.content) : [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
};

export const selectBoardPinDefinition = (project = {}, userInput = "") => {
  const signalText = getBoardSignalText(project, userInput);

  if (/\besp32\b|\bdevkit\b|\bwroom\b|\bgpio\d+/i.test(signalText)) {
    return ESP32_DEVKIT_V1_PIN_DEFINITIONS;
  }

  return ARDUINO_UNO_PIN_DEFINITIONS;
};

export const formatBoardPinsForPrompt = (definition = ARDUINO_UNO_PIN_DEFINITIONS) => {
  const pins = Array.isArray(definition?.pins) ? definition.pins : [];
  const rows = pins.map((pin) => {
    const features = Array.isArray(pin.features) && pin.features.length > 0
      ? `, features: ${pin.features.join("|")}`
      : "";
    return `- ${pin.name} (${pin.type}${features})`;
  });

  return [`Board: ${definition.board}`, ...rows].join("\n");
};

export const formatArduinoBoardPinsForPrompt = (definition = ARDUINO_UNO_PIN_DEFINITIONS) => {
  return formatBoardPinsForPrompt(definition);
};
