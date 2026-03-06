export type ModelKey =
  | "flash31Lite"
  | "flash25"
  | "flash25Lite"
  | "flash3"
  | "gemma27b"
  | "gemma12b"
  | "gemma4b"
  | "embedding";

export interface QuotaEntry {
  used: number;
  limit: number;
  resetAt: Date;
}

interface ModelState extends QuotaEntry {
  lastCallTime: number;
}

const RPD_LIMITS: Record<ModelKey, number> = {
  flash31Lite: 500,
  flash25: 20,
  flash25Lite: 20,
  flash3: 20,
  gemma27b: 14400,
  gemma12b: 14400,
  gemma4b: 14400,
  embedding: 1000,
};

const RPM_LIMITS: Record<ModelKey, number> = {
  flash31Lite: 15,
  flash25: 5,
  flash25Lite: 10,
  flash3: 5,
  gemma27b: 30,
  gemma12b: 30,
  gemma4b: 30,
  embedding: 100,
};

const MIN_INTERVAL: Record<ModelKey, number> = {
  flash31Lite: 4000,
  flash25: 12000,
  flash25Lite: 6000,
  flash3: 12000,
  gemma27b: 2000,
  gemma12b: 2000,
  gemma4b: 2000,
  embedding: 600,
};

const ALL_KEYS: ModelKey[] = [
  "flash31Lite",
  "flash25",
  "flash25Lite",
  "flash3",
  "gemma27b",
  "gemma12b",
  "gemma4b",
  "embedding",
];

function getTodayReset(): Date {
  const now = new Date();
  const reset = new Date(now);
  reset.setHours(17, 0, 0, 0);
  if (reset <= now) {
    reset.setDate(reset.getDate() + 1);
  }
  return reset;
}

function makeState(): Record<ModelKey, ModelState> {
  const entries = {} as Record<ModelKey, ModelState>;
  for (const key of ALL_KEYS) {
    entries[key] = {
      used: 0,
      limit: RPD_LIMITS[key],
      resetAt: getTodayReset(),
      lastCallTime: 0,
    };
  }
  return entries;
}

const state: Record<ModelKey, ModelState> = makeState();

function ensureReset(key: ModelKey) {
  const entry = state[key];
  const now = new Date();
  if (now >= entry.resetAt) {
    entry.used = 0;
    entry.resetAt = getTodayReset();
  }
}

export async function canCall(key: ModelKey): Promise<boolean> {
  ensureReset(key);
  return state[key].used < state[key].limit;
}

export async function recordCall(key: ModelKey): Promise<void> {
  ensureReset(key);
  state[key].used += 1;
  state[key].lastCallTime = Date.now();
}

export async function getRemaining(): Promise<Record<ModelKey, QuotaEntry>> {
  const result = {} as Record<ModelKey, QuotaEntry>;
  for (const key of ALL_KEYS) {
    ensureReset(key);
    result[key] = {
      used: state[key].used,
      limit: state[key].limit,
      resetAt: state[key].resetAt,
    };
  }
  return result;
}

export async function waitForRateLimit(key: ModelKey): Promise<void> {
  const elapsed = Date.now() - state[key].lastCallTime;
  const required = MIN_INTERVAL[key];
  if (elapsed < required) {
    await new Promise((r) => setTimeout(r, required - elapsed));
  }
}

export function getRpmLimit(key: ModelKey): number {
  return RPM_LIMITS[key];
}

export function getRpdLimit(key: ModelKey): number {
  return RPD_LIMITS[key];
}

export { ALL_KEYS };
