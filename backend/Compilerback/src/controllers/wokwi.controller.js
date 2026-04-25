import mongoose from "mongoose";
import Project from "../models/project.model.js";
import {
  lintWokwiProject,
  runWokwiProject,
  runWokwiScenario,
  captureWokwiSerial
} from "../services/wokwi-runner.service.js";
import {
  startWokwiMcpSession,
  listWokwiMcpSessions,
  callWokwiMcpTool,
  stopWokwiMcpSession
} from "../services/wokwi-mcp-client.service.js";

const ensureProjectAccess = async (projectId, userId) => {
  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    return { error: { status: 400, payload: { error: "Invalid projectId" } } };
  }

  const project = await Project.findById(projectId);
  if (!project) {
    return { error: { status: 404, payload: { error: "Project not found" } } };
  }

  if (project.owner.toString() !== userId.toString()) {
    return { error: { status: 403, payload: { error: "Forbidden" } } };
  }

  return { project };
};

const saveEvidence = async (project, key, value) => {
  if (!project.wokwiEvidence) {
    project.wokwiEvidence = {
      lastLint: null,
      lastRun: null,
      lastScenario: null,
      lastSerialCapture: null,
      updatedAt: null
    };
  }

  project.wokwiEvidence[key] = value;
  project.wokwiEvidence.updatedAt = new Date();
  await project.save();
};

export const lintProjectWokwi = async (req, res) => {
  try {
    const { projectId, projectPath = "", diagramFile = "diagram.json", wokwiUrl = "", timeoutMs = 20000 } = req.body;

    const access = await ensureProjectAccess(projectId, req.user._id);
    if (access.error) {
      return res.status(access.error.status).json(access.error.payload);
    }

    const project = access.project;
    const result = await lintWokwiProject({
      projectPath: projectPath || project.wokwiProjectPath || "",
      diagramFile,
      wokwiUrl: wokwiUrl || project.wokwiUrl || "",
      timeoutMs
    });

    await saveEvidence(project, "lastLint", result);

    res.json({
      projectId,
      evidenceType: "lint",
      result
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to lint Wokwi project" });
  }
};

export const runProjectWokwi = async (req, res) => {
  try {
    const {
      projectId,
      projectPath = "",
      timeoutMs = 30000,
      expectText = "",
      failText = "",
      serialLogFile = "",
      screenshotPart = "",
      screenshotTime,
      screenshotFile = "",
      vcdFile = ""
    } = req.body;

    const access = await ensureProjectAccess(projectId, req.user._id);
    if (access.error) {
      return res.status(access.error.status).json(access.error.payload);
    }

    const project = access.project;
    const result = await runWokwiProject({
      projectPath: projectPath || project.wokwiProjectPath || "",
      timeoutMs,
      expectText,
      failText,
      serialLogFile,
      screenshotPart,
      screenshotTime,
      screenshotFile,
      vcdFile
    });

    await saveEvidence(project, "lastRun", result);

    res.json({
      projectId,
      evidenceType: "run",
      result
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to run Wokwi project" });
  }
};

export const runScenarioWokwi = async (req, res) => {
  try {
    const {
      projectId,
      projectPath = "",
      scenarioPath,
      timeoutMs = 30000,
      expectText = "",
      failText = "",
      serialLogFile = "",
      screenshotPart = "",
      screenshotTime,
      screenshotFile = "",
      vcdFile = ""
    } = req.body;

    if (!scenarioPath) {
      return res.status(400).json({ error: "scenarioPath is required" });
    }

    const access = await ensureProjectAccess(projectId, req.user._id);
    if (access.error) {
      return res.status(access.error.status).json(access.error.payload);
    }

    const project = access.project;
    const result = await runWokwiScenario({
      projectPath: projectPath || project.wokwiProjectPath || "",
      scenarioPath,
      timeoutMs,
      expectText,
      failText,
      serialLogFile,
      screenshotPart,
      screenshotTime,
      screenshotFile,
      vcdFile
    });

    await saveEvidence(project, "lastScenario", result);

    res.json({
      projectId,
      evidenceType: "scenario",
      result
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to run Wokwi scenario" });
  }
};

export const captureSerialWokwi = async (req, res) => {
  try {
    const { projectId, projectPath = "", timeoutMs = 12000 } = req.body;

    const access = await ensureProjectAccess(projectId, req.user._id);
    if (access.error) {
      return res.status(access.error.status).json(access.error.payload);
    }

    const project = access.project;
    const result = await captureWokwiSerial({
      projectPath: projectPath || project.wokwiProjectPath || "",
      timeoutMs
    });

    await saveEvidence(project, "lastSerialCapture", result);

    res.json({
      projectId,
      evidenceType: "serial-capture",
      result
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to capture serial output" });
  }
};

export const getWokwiEvidence = async (req, res) => {
  try {
    const { projectId } = req.params;

    const access = await ensureProjectAccess(projectId, req.user._id);
    if (access.error) {
      return res.status(access.error.status).json(access.error.payload);
    }

    const project = access.project;
    res.json({
      projectId,
      wokwiUrl: project.wokwiUrl,
      wokwiProjectPath: project.wokwiProjectPath,
      evidence: project.wokwiEvidence || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to fetch Wokwi evidence" });
  }
};

export const startInteractiveMcpSession = async (req, res) => {
  try {
    const { projectId, projectPath = "", quiet = true } = req.body;

    let resolvedPath = projectPath;

    if (projectId) {
      const access = await ensureProjectAccess(projectId, req.user._id);
      if (access.error) {
        return res.status(access.error.status).json(access.error.payload);
      }

      resolvedPath = resolvedPath || access.project.wokwiProjectPath || "";
    }

    const session = await startWokwiMcpSession({
      projectPath: resolvedPath,
      quiet
    });

    res.json({
      mode: "interactive",
      session
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to start MCP session" });
  }
};

export const callInteractiveMcpTool = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { tool, argumentsInput = {} } = req.body;

    if (!tool) {
      return res.status(400).json({ error: "tool is required" });
    }

    const output = await callWokwiMcpTool({ sessionId, tool, argumentsInput });
    res.json(output);
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to call MCP tool" });
  }
};

export const stopInteractiveMcpSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await stopWokwiMcpSession(sessionId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to stop MCP session" });
  }
};

export const listInteractiveMcpSessions = async (_req, res) => {
  try {
    res.json({ sessions: listWokwiMcpSessions() });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to list MCP sessions" });
  }
};
