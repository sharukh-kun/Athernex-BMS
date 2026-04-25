import express from "express";
import cors from "cors";
import "dotenv/config";
import { connectDB } from "./lib/db.js";
import { checkWokwiCliReady } from "./lib/wokwi.js";
import cookieParser from "cookie-parser";


import projectRoutes from "./routes/project.route.js";
import ideationRoutes from "./routes/ideation.route.js";
import authRoutes from "./routes/auth.route.js";
import componentsRoutes from "./routes/components.route.js";
import designRoutes from "./routes/design.route.js";
import wokwiRoutes from "./routes/wokwi.route.js";
import compileRoutes from "./routes/compile.route.js";
import projectAiRoutes from "./routes/project-ai.route.js";
import voiceRoutes from "./routes/voice.route.js";



const app = express();
app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));
app.use(cookieParser());

app.use(express.json({ limit: "15mb" }));

app.use("/api", ideationRoutes);
app.use("/api", projectRoutes);
app.use("/api", componentsRoutes);
app.use("/api", designRoutes);
app.use("/api", projectAiRoutes);
app.use("/api/compile", compileRoutes);
app.use("/api", wokwiRoutes);
app.use("/api", voiceRoutes);
app.use("/api/auth", authRoutes);


app.listen(process.env.PORT, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
  checkWokwiCliReady();
  connectDB();
});
