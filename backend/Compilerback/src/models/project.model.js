import mongoose from "mongoose";

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
    type: [messageSchema],
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
    }
  }

}, { timestamps: true });

export default mongoose.model("Project", projectSchema);
