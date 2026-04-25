/** Groq chat models per NovaAI pipeline (override via env). */
export const DEFAULT_GROQ_MODEL_IDEATION = "qwen/qwen3-32b";
export const DEFAULT_GROQ_MODEL_COMPONENTS = "meta-llama/llama-4-scout-17b-16e-instruct";

export function getGroqModelIdeation() {
  const m = String(process.env.GROQ_MODEL_IDEATION || DEFAULT_GROQ_MODEL_IDEATION).trim();
  return m || DEFAULT_GROQ_MODEL_IDEATION;
}

export function getGroqModelComponents() {
  const m = String(process.env.GROQ_MODEL_COMPONENTS || DEFAULT_GROQ_MODEL_COMPONENTS).trim();
  return m || DEFAULT_GROQ_MODEL_COMPONENTS;
}
