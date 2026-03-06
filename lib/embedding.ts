import { GoogleGenerativeAI } from "@google/generative-ai";
import { canCall, recordCall, waitForRateLimit } from "./quota-manager";
import { getStoredGeminiKey } from "./gemini-key-store";
import { GeminiKeyInvalidError, isGeminiKeyInvalidError } from "./gemini-errors";

const EMBEDDING_MODEL_ID = "gemini-embedding-001";
const MAX_INPUT_CHARS = 8000;

async function getClient() {
  const apiKey = await getStoredGeminiKey();
  if (!apiKey) {
    throw new Error(
      "Gemini API 키가 설정되지 않았습니다. 메인 페이지에서 입력해 주세요."
    );
  }
  return new GoogleGenerativeAI(apiKey);
}

function is503Or429(msg: string): boolean {
  return (
    msg.includes("503") ||
    msg.includes("Service Unavailable") ||
    msg.includes("high demand") ||
    msg.includes("429") ||
    msg.includes("RESOURCE_EXHAUSTED")
  );
}

export async function generateEmbedding(text: string): Promise<number[]> {
  if (!(await canCall("embedding"))) {
    throw new Error("Gemini embedding 무료 쿼터가 소진되었습니다.");
  }

  await waitForRateLimit("embedding");

  const client = await getClient();
  const model = client.getGenerativeModel({ model: EMBEDDING_MODEL_ID });
  const maxRetries = 3;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await model.embedContent({
        content: {
          role: "user",
          parts: [{ text: text.slice(0, MAX_INPUT_CHARS) }],
        },
      });

      await recordCall("embedding");

      const embedding = (result as { embedding?: { values?: number[] } })
        .embedding;
      const values = embedding?.values;
      if (!Array.isArray(values)) {
        throw new Error("Gemini embedding 응답 형식이 올바르지 않습니다.");
      }
      return values;
    } catch (e) {
      lastErr = e;
      if (isGeminiKeyInvalidError(e)) {
        throw new GeminiKeyInvalidError();
      }
      const msg = String(e instanceof Error ? e.message : e);
      if (is503Or429(msg) && attempt < maxRetries - 1) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 8000);
        await new Promise((r) => setTimeout(r, delay + Math.random() * 500));
        continue;
      }
      throw e;
    }
  }

  throw lastErr ?? new Error("Embedding 모델 호출이 실패했습니다.");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
