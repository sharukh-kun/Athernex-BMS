import express from "express";
import { checkAuth, firebaseAuth, logout } from "../controllers/auth.controller.js";
import { protectRoute } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/firebase", firebaseAuth);
router.post("/logout", logout);

router.get("/check", protectRoute, checkAuth);

export default router;