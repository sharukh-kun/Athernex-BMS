import Project from "../models/project.model.js";
// Components chat + Wokwi plan generation use Groq model: GROQ_MODEL_COMPONENTS or default meta-llama/llama-4-scout-17b-16e-instruct (see config/groq-models.js).
import { processComponents } from "../services/ai.services.js";
import { generateArtifactsFromRegistry } from "../services/registry-codegen.service.js";

const isIdeaFinalized = (project) => {
  return Boolean(project?.ideaState?.summary?.trim()) && (project?.ideaState?.unknowns?.length ?? 0) === 0;
};

const canStartComponents = (project) => {
  return Boolean(project);
};

const safeText = (value = "") => String(value || "").trim();

const stringifyJson = (value = {}) => {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
};

const buildComponentsJsonFromState = (project, generated = {}) => {
  const board =
    safeText(generated?.plan?.board)
    || safeText(project?.generationProfile?.board)
    || safeText(project?.meta?.board)
    || "unknown";

  const componentsFromPlan = Array.isArray(generated?.plan?.instances)
    ? generated.plan.instances
      .map((item) => safeText(item?.id))
      .filter(Boolean)
    : [];

  const componentsFromState = Array.isArray(project?.componentsState?.components)
    ? project.componentsState.components.map((item) => safeText(item)).filter(Boolean)
    : [];

  const merged = [...new Set([...componentsFromPlan, ...componentsFromState])];

  return stringifyJson({
    board,
    components: merged
  });
};

const projectWorkspaceFiles = (project) => ({
  mainIno: safeText(project?.workspaceFiles?.mainIno || ""),
  diagramJson: safeText(project?.workspaceFiles?.diagramJson || ""),
  pinsCsv: safeText(project?.workspaceFiles?.pinsCsv || ""),
  componentsJson: safeText(project?.workspaceFiles?.componentsJson || ""),
  assemblyMd: safeText(project?.workspaceFiles?.assemblyMd || "")
});

const persistGeneratedArtifactsToWorkspace = (project, generated = {}) => {
  const current = projectWorkspaceFiles(project);
  const nextSketch = safeText(generated?.sketchIno || "");
  const nextDiagram = generated?.diagramJson ? stringifyJson(generated.diagramJson) : "";
  const nextComponentsJson = buildComponentsJsonFromState(project, generated);

  project.workspaceFiles = {
    mainIno: nextSketch || current.mainIno,
    diagramJson: nextDiagram || current.diagramJson,
    pinsCsv: current.pinsCsv,
    componentsJson: nextComponentsJson || current.componentsJson,
    assemblyMd: current.assemblyMd
  };
};

/*
INIT COMPONENTS (optional first call)
*/
export const initComponents = async (req, res) => {
  try {
    const { projectId } = req.body;

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!canStartComponents(project)) {
      return res.status(400).json({
        error: "Finalize Ideation AI before starting Components AI"
      });
    }

    // init structure if missing
    if (!project.componentsState) {
      project.componentsState = {
        architecture: "",
        components: [],
        apiEndpoints: []
      };
    }

    const ai = await processComponents(project, "Start components design");

    project.componentsState = {
      architecture: ai.architecture,
      components: ai.components,
      apiEndpoints: ai.apiEndpoints
    };
    project.architectureState = ai.architectureState;

    if (!project.componentsMessages) project.componentsMessages = [];

    project.componentsMessages.push({
      role: "ai",
      content: ai.reply
    });

    await project.save();

    res.json({
      reply: ai.reply,
      componentsState: project.componentsState,
      architectureState: project.architectureState,
      generationProfile: project.generationProfile || null,
      workspaceFiles: projectWorkspaceFiles(project)
    });

  } catch (err) {
    console.error("PROJECT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};


/*
CHAT LOOP - COMPONENTS
*/
export const chatComponents = async (req, res) => {
  try {
    const { projectId, message } = req.body;

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!canStartComponents(project)) {
      return res.status(400).json({
        error: "Finalize Ideation AI before starting Components AI"
      });
    }

    if (!project.componentsMessages) project.componentsMessages = [];

    // store user msg
    project.componentsMessages.push({
      role: "user",
      content: message
    });

    const ai = await processComponents(project, message);

    project.componentsState = {
      architecture: ai.architecture,
      components: ai.components,
      apiEndpoints: ai.apiEndpoints
    };
    project.architectureState = ai.architectureState;

    project.componentsMessages.push({
      role: "ai",
      content: ai.reply
    });

    await project.save();

    res.json({
      reply: ai.reply,
      componentsState: project.componentsState,
      architectureState: project.architectureState,
      generationProfile: project.generationProfile || null,
      workspaceFiles: projectWorkspaceFiles(project)
    });

  } catch (err) {
    console.error("PROJECT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
};

/*
GENERATE WOKWI FILES FROM IDEATION + COMPONENTS STATE
*/
export const generateWokwiFilesFromAI = async (req, res) => {
  try {
    const { projectId, userPrompt = "" } = req.body;

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    if (project.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!canStartComponents(project)) {
      return res.status(400).json({
        error: "Finalize Ideation AI before generating Wokwi files"
      });
    }

    const generated = await generateArtifactsFromRegistry({ project, userPrompt });
    persistGeneratedArtifactsToWorkspace(project, generated);
    await project.save();

    res.json({
      projectId,
      generated,
      architectureState: project.architectureState,
      generationProfile: project.generationProfile || null,
      workspaceFiles: projectWorkspaceFiles(project),
      componentsState: project.componentsState
    });
  } catch (err) {
    console.error("GENERATE WOKWI FILES ERROR:", err);
    res.status(500).json({ error: err.message || "Failed to generate Wokwi files" });
  }
};
