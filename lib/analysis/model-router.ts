import type { ModelKey } from "../quota-manager";

export const MODEL_ROUTES = {
  DOCUMENT_ZONING: "gemma-3-27b-it",
  CLAUSE_SPLIT_VERIFY: "gemma-3-12b-it",
  METADATA_EXTRACTION: "gemma-3-12b-it",
  LANGUAGE_DETECTION: "gemma-3-4b-it",
  QUALITY_CHECK: "gemma-3-12b-it",
  TEXT_CLEANUP: "gemma-3-4b-it",

  RISK_ANALYSIS: "gemini-2.5-flash-lite",
  FIDIC_COMPARISON: "gemini-2.5-flash-lite",

  CROSS_VALIDATION: "gemini-2.5-flash",
  DEEP_ANALYSIS: "gemini-2.0-flash",
  FALLBACK_ANALYSIS: "gemini-2.5-flash-lite",

  EMBEDDING: "gemini-embedding-001",
} as const;

export type TaskType = keyof typeof MODEL_ROUTES;

const MODEL_ID_TO_KEY: Record<string, ModelKey> = {
  "gemini-2.5-flash-lite": "flash25Lite",
  "gemini-2.5-flash": "flash25",
  "gemini-2.0-flash": "flash3",
  "gemma-3-27b-it": "gemma27b",
  "gemma-3-12b-it": "gemma12b",
  "gemma-3-4b-it": "gemma4b",
  "gemini-embedding-001": "embedding",
};

export function getModelKeyForTask(task: TaskType): ModelKey {
  const modelId = MODEL_ROUTES[task];
  const key = MODEL_ID_TO_KEY[modelId];
  if (!key) {
    throw new Error(`Unknown model ID for task ${task}: ${modelId}`);
  }
  return key;
}

export function isGemmaTask(task: TaskType): boolean {
  return MODEL_ROUTES[task].startsWith("gemma-");
}
