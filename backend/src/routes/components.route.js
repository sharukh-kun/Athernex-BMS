import express from "express";
import {
  chatComponents,
  generateWokwiFilesFromAI,
  initComponents
} from "../controllers/components.controller.js";
import { protectRoute } from "../middleware/auth.middleware.js";

const router = express.Router();

// optional init (first time load)
router.post("/components/init", protectRoute, initComponents);

// main chat
router.post("/components/chat", protectRoute, chatComponents);
router.post("/components/generate-files", protectRoute, generateWokwiFilesFromAI);

export default router;