import express from "express";
import { protectRoute } from "../middleware/auth.middleware.js";
import {
  compileSketchToHex,
  listArduinoBoardPorts,
  uploadSketchToBoard
} from "../controllers/compile.controller.js";

const router = express.Router();

// POST /api/compile/sketch - Compile Arduino sketch to hex for embedded simulator
router.post("/sketch", protectRoute, compileSketchToHex);
// GET /api/compile/ports - List Arduino CLI-detected serial ports
router.get("/ports", protectRoute, listArduinoBoardPorts);
// POST /api/compile/upload - Upload compiled sketch to a connected board
router.post("/upload", protectRoute, uploadSketchToBoard);

export default router;
