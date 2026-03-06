import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  type ModelKey,
  canCall,
  recordCall,
  getRemaining,
  waitForRateLimit,
} from "./quota-manager";
import { getStoredGeminiKey } from "./gemini-key-store";
import { GeminiKeyInvalidError, isGeminiKeyInvalidError } from "./gemini-errors";

export type { ModelKey };

export const MODEL_CONFIG: Record<ModelKey, string> = {
  flash31Lite: "gemini-3.1-flash-lite",
  flash25: "gemini-2.5-flash",
  flash25Lite: "gemini-2.5-flash-lite",
  flash3: "gemini-3-flash",
  gemma27b: "gemma-3-27b-it",
  gemma12b: "gemma-3-12b-it",
  gemma4b: "gemma-3-4b-it",
  embedding: "gemini-embedding-001",
};

type TextModelKey = Exclude<ModelKey, "embedding">;
type GeminiModelKey = "flash31Lite" | "flash25" | "flash25Lite" | "flash3";
type GemmaModelKey = "gemma27b" | "gemma12b" | "gemma4b";

const GEMMA_MAX_INPUT_CHARS = 300;
const GEMMA_TPM_LIMIT = 15000;

async function getClient() {
  const apiKey = await getStoredGeminiKey();
  if (!apiKey) {
    throw new Error(
      "Gemini API 키가 설정되지 않았습니다. 메인 페이지에서 입력해 주세요."
    );
  }
  return new GoogleGenerativeAI(apiKey);
}

function isRetryableError(e: unknown): boolean {
  const msg = String(e instanceof Error ? e.message : e);
  return (
    msg.includes("429") ||
    msg.includes("RESOURCE_EXHAUSTED") ||
    msg.includes("resource_exhausted") ||
    msg.includes("503") ||
    msg.includes("Service Unavailable") ||
    msg.includes("high demand")
  );
}

function backoffMs(attempt: number): number {
  const base = Math.min(2000 * Math.pow(2, attempt), 8000);
  const jitter = Math.random() * 500;
  return base + jitter;
}

const MAX_RETRIES = 3;

// ─── Single-model call (Gemini) ───

export async function callGeminiJson<T>({
  modelKey,
  prompt,
  systemInstruction,
}: {
  modelKey: GeminiModelKey;
  prompt: string;
  systemInstruction?: string;
}): Promise<T> {
  if (!(await canCall(modelKey))) {
    throw new Error(`Gemini ${modelKey} 무료 쿼터가 소진되었습니다.`);
  }

  await waitForRateLimit(modelKey);
  const client = await getClient();
  const model = client.getGenerativeModel({
    model: MODEL_CONFIG[modelKey],
    ...(systemInstruction ? { systemInstruction } : {}),
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
        },
      });
      await recordCall(modelKey);
      const text = result.response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error("Gemini 응답 JSON 파싱에 실패했습니다.");
      }
    } catch (e) {
      lastError = e;
      if (isGeminiKeyInvalidError(e)) {
        throw new GeminiKeyInvalidError();
      }
      if (isRetryableError(e) && attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// ─── Single-model call (Gemma) ───

export async function callGemmaJson<T>({
  modelKey,
  prompt,
  inputText,
}: {
  modelKey: GemmaModelKey;
  prompt: string;
  inputText?: string;
}): Promise<T> {
  if (!(await canCall(modelKey))) {
    throw new Error(`Gemma ${modelKey} 무료 쿼터가 소진되었습니다.`);
  }

  const trimmedInput = inputText
    ? inputText.slice(0, GEMMA_MAX_INPUT_CHARS)
    : "";
  const fullPrompt = trimmedInput
    ? `${prompt}\n\nText: "${trimmedInput}"`
    : prompt;

  if (fullPrompt.length > GEMMA_TPM_LIMIT * 0.25) {
    console.warn(
      `[Gemma] 프롬프트가 ${fullPrompt.length}자로 TPM 한도에 근접합니다.`
    );
  }

  await waitForRateLimit(modelKey);
  const client = await getClient();
  const model = client.getGenerativeModel({
    model: MODEL_CONFIG[modelKey],
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      });
      await recordCall(modelKey);
      const text = result.response.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error("Gemma 응답 JSON 파싱에 실패했습니다.");
      }
    } catch (e) {
      lastError = e;
      if (isGeminiKeyInvalidError(e)) {
        throw new GeminiKeyInvalidError();
      }
      if (isRetryableError(e) && attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// ─── Fallback chains ───

const ANALYSIS_FALLBACK: GeminiModelKey[] = [
  "flash31Lite",
  "flash25",
  "flash3",
  "flash25Lite",
];

const PREPROCESSING_FALLBACK: TextModelKey[] = [
  "gemma27b",
  "gemma12b",
  "flash31Lite",
];

export type FallbackChain = "analysis" | "preprocessing";

export async function callGeminiJsonWithFallback<T>({
  prompt,
  systemInstruction,
  chain = "analysis",
}: {
  prompt: string;
  systemInstruction?: string;
  chain?: FallbackChain;
}): Promise<{ data: T; modelKey: TextModelKey }> {
  const fallbackKeys =
    chain === "preprocessing" ? PREPROCESSING_FALLBACK : ANALYSIS_FALLBACK;

  const remaining = await getRemaining();
  const orderedKeys = [...fallbackKeys].sort((a, b) => {
    const remA = remaining[a].limit - remaining[a].used;
    const remB = remaining[b].limit - remaining[b].used;
    return remB - remA;
  });

  let lastError: unknown;

  for (const modelKey of orderedKeys) {
    if (!(await canCall(modelKey))) continue;
    await waitForRateLimit(modelKey);

    const isGemma = modelKey.startsWith("gemma");
    const client = await getClient();
    const modelName = MODEL_CONFIG[modelKey];
    const model = client.getGenerativeModel({
      model: modelName,
      ...(systemInstruction && !isGemma ? { systemInstruction } : {}),
    });

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: isGemma ? 0.1 : 0.2,
          },
        });

        await recordCall(modelKey);
        const text = result.response.text();
        try {
          const data = JSON.parse(text) as T;
          return { data, modelKey };
        } catch {
          throw new Error("응답 JSON 파싱에 실패했습니다.");
        }
      } catch (e) {
        lastError = e;
        if (isGeminiKeyInvalidError(e)) {
          throw new GeminiKeyInvalidError();
        }
        if (isRetryableError(e) && attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
          continue;
        }
        break;
      }
    }
  }

  throw lastError ?? new Error("모든 모델 호출이 실패했습니다.");
}
