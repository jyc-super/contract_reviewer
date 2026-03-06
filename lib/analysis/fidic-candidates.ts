import { generateEmbedding, cosineSimilarity } from "../embedding";
import { embeddingCache, getEmbeddingCacheKey } from "../cache";

async function cachedEmbedding(text: string): Promise<number[]> {
  const key = getEmbeddingCacheKey(text);
  const cached = embeddingCache.get(key);
  if (cached) return cached;
  const vec = await generateEmbedding(text);
  embeddingCache.set(key, vec);
  return vec;
}

export interface FidicCandidate {
  id: string;
  reference: string;
  text: string;
  score: number;
}

/** FIDIC Red Book 2017 대표 조항 (embedding 실패 시 규칙 기반 후보로 fallback) */
const FIDIC_REFERENCE_CLAUSES: Omit<FidicCandidate, "score">[] = [
  { id: "8.7", reference: "Sub-Clause 8.7", text: "Delay Damages" },
  { id: "14.1", reference: "Sub-Clause 14.1", text: "Contract Price" },
  { id: "17.1", reference: "Sub-Clause 17.1", text: "Indemnities" },
  { id: "4.1", reference: "Sub-Clause 4.1", text: "Contractor's General Obligations" },
  { id: "20.1", reference: "Sub-Clause 20.1", text: "Claims" },
];

let cachedRefEmbeddings: number[][] | null = null;

async function getRefEmbeddings(): Promise<number[][]> {
  if (cachedRefEmbeddings) return cachedRefEmbeddings;
  const out: number[][] = [];
  for (const ref of FIDIC_REFERENCE_CLAUSES) {
    const vec = await cachedEmbedding(`${ref.reference}: ${ref.text}`);
    out.push(vec);
  }
  cachedRefEmbeddings = out;
  return out;
}

function fallbackCandidates(limit: number): FidicCandidate[] {
  return FIDIC_REFERENCE_CLAUSES.slice(0, limit).map((c, i) => ({
    ...c,
    score: 1 - i * 0.1,
  }));
}

/**
 * 조항 텍스트와 유사한 FIDIC 후보를 embedding 유사도로 상위 limit건 반환.
 * embedding/쿼터 실패 시 규칙 기반 후보로 fallback.
 */
export async function getFidicCandidates(
  clauseText: string,
  limit = 3
): Promise<FidicCandidate[]> {
  const trimmed = clauseText.trim();
  if (!trimmed) return fallbackCandidates(limit);

  try {
    const refEmbeddings = await getRefEmbeddings();
    const queryEmbedding = await cachedEmbedding(trimmed);
    const candidates: { item: (typeof FIDIC_REFERENCE_CLAUSES)[number]; score: number }[] = [];

    for (let i = 0; i < FIDIC_REFERENCE_CLAUSES.length; i++) {
      const ref = FIDIC_REFERENCE_CLAUSES[i];
      const score = cosineSimilarity(queryEmbedding, refEmbeddings[i]);
      candidates.push({ item: ref, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit).map(({ item, score }) => ({
      ...item,
      score,
    }));
  } catch {
    return fallbackCandidates(limit);
  }
}
