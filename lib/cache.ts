import { createHash } from "node:crypto";

export function contentHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

class MemoryCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 500, ttlMs = DEFAULT_TTL_MS) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key: string, data: T): void {
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(key, { data, timestamp: Date.now() });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

interface AnalysisCacheValue {
  riskSummary: string;
  recommendations: string;
  fidicComparison: unknown;
  riskLevel?: string;
  llmModel?: string;
}

interface FidicCacheValue {
  reference: string;
  text: string;
  similarity: number;
}

export const analysisCache = new MemoryCache<AnalysisCacheValue>(500);
export const fidicCache = new MemoryCache<FidicCacheValue[]>(200);
export const embeddingCache = new MemoryCache<number[]>(300);

export function getAnalysisCacheKey(clauseText: string): string {
  return `analysis:${contentHash(clauseText)}`;
}

export function getFidicCacheKey(clauseText: string): string {
  return `fidic:${contentHash(clauseText)}`;
}

export function getEmbeddingCacheKey(text: string): string {
  return `embed:${contentHash(text)}`;
}
