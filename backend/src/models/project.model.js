import mongoose from "mongoose";
import { getRegistry } from "../services/registry.service.js";

const LEGACY_BOARD_SLUGS = [
  "arduino-uno",
  "arduino-nano",
  "esp32-devkit-v1",
  "raspberry-pi-pico",
  "attiny85"
];

const getAllowedBoardValues = () => {
  const registry = getRegistry();
  const registryBoardKeys = Object.entries(registry || {})
    .filter(([, def]) => String(def?.category || "").toLowerCase() === "controller")
    .map(([key]) => key);

  // Keep legacy slugs so existing documents can still save during transition.
  return [...new Set([...LEGACY_BOARD_SLUGS, ...registryBoardKeys, null])];
};

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ["user", "ai"],
    required: true
  },
  content: {
    type: String,
    required: true
  }
}, { _id: false });

const ideaStateSchema = new mongoose.Schema({
  summary: {
    type: String,
    default: ""
  },
  requirements: {
    type: [String],
    default: []
  },
  unknowns: {
    type: [String],
    default: []
  }
}, { _id: false });

const architectureFileSchema = new mongoose.Schema({
  path: {
    type: String,
    default: ""
  },
  role: {
    type: String,
    default: ""
  },
  responsibility: {
    type: String,
    default: ""
  }
}, { _id: false });

const architectureLibrarySchema = new mongoose.Schema({
  name: {
    type: String,
    default: ""
  },
  purpose: {
    type: String,
    default: ""
  }
}, { _id: false });

const architecturePinSchema = new mongoose.Schema({
  component: {
    type: String,
    default: ""
  },
  signal: {
    type: String,
    default: ""
  },
  boardPin: {
    type: String,
    default: ""
  },
  notes: {
    type: String,
    default: ""
  }
}, { _id: false });

const architectureStateSchema = new mongoose.Schema({
  summary: {
    type: String,
    default: ""
  },
  pattern: {
    type: String,
    default: ""
  },
  sourceStrategy: {
    type: String,
    default: ""
  },
  entryFile: {
    type: String,
    default: ""
  },
  files: {
    type: [architectureFileSchema],
    default: []
  },
  libraries: {
    type: [architectureLibrarySchema],
    default: []
  },
  pinAssignments: {
    type: [architecturePinSchema],
    default: []
  },
  runtimeFlow: {
    type: [String],
    default: []
  },
  assumptions: {
    type: [String],
    default: []
  },
  openDecisions: {
    type: [String],
    default: []
  },
  updatedAt: {
    type: Date,
    default: null
  }
}, { _id: false });

// COMPONENTS
const componentsStateSchema = new mongoose.Schema({
  architecture: {
    type: String,
    default: ""
  },
  components: {
    type: [String],
    default: []
  },
  apiEndpoints: {
    type: [String],
    default: []
  }
}, { _id: false });

// DESIGN
const designScreenSchema = new mongoose.Schema({
  name: {
    type: String,
    default: ""
  },
  elements: {
    type: [String],
    default: []
  },
  actions: {
    type: [String],
    default: []
  }
}, { _id: false });

const designStateSchema = new mongoose.Schema({
  screens: {
    type: [designScreenSchema],
    default: []
  },
  theme: {
    type: String,
    default: ""
  },
  uxFlow: {
    type: [String],
    default: []
  }
}, { _id: false });

const projectAiMessageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ["user", "ai"],
    required: true
  },
  content: {
    type: String,
    required: true
  }
}, { _id: false });

const projectAiStateSchema = new mongoose.Schema({
  summary: {
    type: String,
    default: ""
  },
  hardwarePath: {
    type: String,
    default: ""
  },
  files: {
    type: [String],
    default: []
  },
  notes: {
    type: [String],
    default: []
  },
  lastContextAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const workspaceFilesSchema = new mongoose.Schema({
  mainIno: {
    type: String,
    default: ""
  },
  diagramJson: {
    type: String,
    default: ""
  },
  pinsCsv: {
    type: String,
    default: ""
  },
  componentsJson: {
    type: String,
    default: ""
  },
  assemblyMd: {
    type: String,
    default: ""
  }
}, { _id: false });

const wokwiEvidenceResultSchema = new mongoose.Schema({
  ok: {
    type: Boolean,
    default: false
  },
  command: {
    type: String,
    default: ""
  },
  exitCode: {
    type: Number,
    default: 0
  },
  durationMs: {
    type: Number,
    default: 0
  },
  stdoutTail: {
    type: String,
    default: ""
  },
  stderrTail: {
    type: String,
    default: ""
  },
  serialTail: {
    type: String,
    default: ""
  },
  summary: {
    type: String,
    default: ""
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({})
  },
  ranAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const wokwiEvidenceSchema = new mongoose.Schema({
  lastLint: {
    type: wokwiEvidenceResultSchema,
    default: null
  },
  lastRun: {
    type: wokwiEvidenceResultSchema,
    default: null
  },
  lastScenario: {
    type: wokwiEvidenceResultSchema,
    default: null
  },
  lastSerialCapture: {
    type: wokwiEvidenceResultSchema,
    default: null
  },
  updatedAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const projectSchema = new mongoose.Schema({

  // 🔥 REQUIRED: USER LINK
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  description: {
    type: String,
    required: true
  },

  wokwiUrl: {
    type: String,
    default: ""
  },

  wokwiProjectPath: {
    type: String,
    default: ""
  },

  // IDEATION
  messages: {
    type: [messageSchema],
    default: []
  },

  ideaState: {
    type: ideaStateSchema,
    default: () => ({
      summary: "",
      requirements: [],
      unknowns: []
    })
  },

  architectureState: {
    type: architectureStateSchema,
    default: () => ({
      summary: "",
      pattern: "",
      sourceStrategy: "",
      entryFile: "",
      files: [],
      libraries: [],
      pinAssignments: [],
      runtimeFlow: [],
      assumptions: [],
      openDecisions: [],
      updatedAt: null
    })
  },

  // COMPONENTS
  componentsMessages: {
    type: [messageSchema],
    default: []
  },

  componentsState: {
    type: componentsStateSchema,
    default: () => ({
      architecture: "",
      components: [],
      apiEndpoints: []
    })
  },

  // DESIGN
  designMessages: {
    type: [messageSchema],
    default: []
  },

  designState: {
    type: designStateSchema,
    default: () => ({
      screens: [],
      theme: "",
      uxFlow: []
    })
  },

  projectAiMessages: {
    type: [projectAiMessageSchema],
    default: []
  },

  projectAiState: {
    type: projectAiStateSchema,
    default: () => ({
      summary: "",
      hardwarePath: "",
      files: [],
      notes: [],
      lastContextAt: null
    })
  },

  workspaceFiles: {
    type: workspaceFilesSchema,
    default: () => ({
      mainIno: "",
      diagramJson: "",
      pinsCsv: "",
      componentsJson: "",
      assemblyMd: ""
    })
  },

  wokwiEvidence: {
    type: wokwiEvidenceSchema,
    default: () => ({
      lastLint: null,
      lastRun: null,
      lastScenario: null,
      lastSerialCapture: null,
      updatedAt: null
    })
  },

  meta: {
    stage: {
      type: String,
      enum: ["idea", "components", "design", "build"],
      default: "idea"
    },
    board: {
      type: String,
      enum: getAllowedBoardValues(),
      default: null
    },
    powerSource: {
      type: String,
      enum: ["usb", "lipo", "9v", "aa-batteries", "unknown", null],
      default: null
    },
    language: {
      type: String,
      enum: ["cpp", "micropython"],
      default: "cpp"
    },
    componentCount: {
      type: Number,
      default: 0
    },
    detectedAt: {
      type: Date,
      default: null
    }
  },

  generationProfile: {
    board: {
      type: String,
      enum: getAllowedBoardValues(),
      default: null
    },
    boardPartType: {
      type: String,
      default: "wokwi-arduino-uno"
    },
    powerSource: {
      type: String,
      enum: ["usb", "lipo", "9v", "aa-batteries", "unknown", null],
      default: null
    },
    language: {
      type: String,
      enum: ["cpp", "micropython"],
      default: "cpp"
    },
    firmwareTarget: {
      type: String,
      default: "arduino-cpp-sketch-ino"
    },
    simulationTarget: {
      type: String,
      default: "wokwi-json-ino"
    },
    runtimeHints: {
      type: [String],
      default: []
    },
    profileVersion: {
      type: Number,
      default: 1
    },
    updatedAt: {
      type: Date,
      default: null
    }
  }

}, { timestamps: true });

export default mongoose.model("Project", projectSchema);
