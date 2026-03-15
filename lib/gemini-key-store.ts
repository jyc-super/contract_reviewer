import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAdminSupabaseClientIfAvailable } from "./supabase/admin";
import * as logger from "./logger";

// ── .env.local 헬퍼 ─────────────────────────────────────────────────────────
function getEnvLocalPath(): string {
  return join(process.cwd(), ".env.local");
}

/** .env.local 파일에서 특정 키의 값을 읽거나, 키를 추가/업데이트합니다. */
function upsertEnvLocal(key: string, value: string): void {
  const filePath = getEnvLocalPath();
  let lines: string[] = [];
  if (existsSync(filePath)) {
    lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  }
  const prefix = `${key}=`;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  if (idx >= 0) {
    lines[idx] = `${prefix}${value}`;
  } else {
    // 빈 줄 뒤에 추가
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== "") {
      lines.push("");
    }
    lines.push(`${prefix}${value}`);
  }
  writeFileSync(filePath, lines.join("\n"), "utf8");
}

/** .env.local에서 특정 키 라인을 제거합니다. */
function removeFromEnvLocal(key: string): void {
  const filePath = getEnvLocalPath();
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  const prefix = `${key}=`;
  const filtered = lines.filter((l) => !l.startsWith(prefix));
  if (filtered.length !== lines.length) {
    writeFileSync(filePath, filtered.join("\n"), "utf8");
  }
}

const ALG = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 16;
const SETTINGS_KEY = "gemini_api_key";
const DEV_KEY_SALT = "contract-risk-dev-only-not-for-production";

/** ENCRYPTION_KEY가 없을 때 개발용으로만 쓰는 키 사용 여부 */
function isUsingDevEncryptionKey(): boolean {
  const raw = process.env.ENCRYPTION_KEY;
  return !raw || raw.length < 32;
}

function getEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (raw && raw.length >= 32) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, "hex");
    }
    return scryptSync(raw, "contract-risk-salt", KEY_LEN);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("ENCRYPTION_KEY가 설정되어 있지 않거나 32자 이상이어야 합니다.");
  }
  return scryptSync(DEV_KEY_SALT, "contract-risk-salt", KEY_LEN);
}

/** 암호화 키 사용 가능 여부 (ENCRYPTION_KEY 설정 또는 개발 환경 시 자동 사용) */
function hasEncryptionKey(): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

/** Supabase 없을 때 사용하는 로컬 파일 경로 (프로젝트 루트/data/gemini-key.enc) */
function getKeyFilePath(): string {
  return join(process.cwd(), "data", "gemini-key.enc");
}

export function encryptGeminiKey(plain: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptGeminiKey(blob: string): string {
  const key = getEncryptionKey();
  const parts = blob.split(":");
  if (parts.length !== 3) throw new Error("잘못된 암호화 데이터 형식입니다.");
  const [ivHex, tagHex, cipherHex] = parts;
  const iv = Buffer.from(ivHex!, "hex");
  const authTag = Buffer.from(tagHex!, "hex");
  const cipher = Buffer.from(cipherHex!, "hex");
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(cipher) + decipher.final("utf8");
}

/** 저장된 Gemini API 키 반환. 없거나 복호화 실패 시 null. env 우선 → .env.local 직접 읽기 → 암호화 파일 → DB. */
export async function getStoredGeminiKey(): Promise<string | null> {
  const fromEnv = process.env.GEMINI_API_KEY;
  if (fromEnv?.trim()) return fromEnv.trim();

  // .env.local에서 직접 읽기 (현재 세션에서 저장 후 재시작 전에도 인식)
  try {
    const envPath = getEnvLocalPath();
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf8");
      const match = content.match(/^GEMINI_API_KEY=(.+)$/m);
      if (match?.[1]?.trim()) return match[1].trim();
    }
  } catch {
    // fall through
  }

  // 암호화 파일
  const filePath = getKeyFilePath();
  if (existsSync(filePath) && hasEncryptionKey()) {
    try {
      const blob = readFileSync(filePath, "utf8");
      return decryptGeminiKey(blob);
    } catch {
      // fall through to DB
    }
  }

  const supabase = getAdminSupabaseClientIfAvailable();
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value_encrypted")
        .eq("key", SETTINGS_KEY)
        .maybeSingle();

      if (!error && data?.value_encrypted) return decryptGeminiKey(data.value_encrypted);
    } catch {
      // fall through
    }
  }

  return null;
}

/** Gemini API 키를 암호화해 저장. Supabase가 있으면 DB에, 없거나 DB 실패 시 로컬 파일(data/gemini-key.enc)에 저장. */
export async function setStoredGeminiKey(apiKey: string): Promise<void> {
  if (!hasEncryptionKey()) {
    throw new Error("ENCRYPTION_KEY가 설정되어 있지 않습니다. .env에 ENCRYPTION_KEY를 32자 이상 설정해 주세요. (배포 환경에서는 필수입니다.)");
  }
  if (isUsingDevEncryptionKey()) {
    logger.warn("ENCRYPTION_KEY가 없어 개발용 키로 API 키를 저장합니다. 배포 시 .env에 ENCRYPTION_KEY를 32자 이상 설정하세요.");
  }
  const encrypted = encryptGeminiKey(apiKey.trim());

  // 1) .env.local에 평문 저장 (Next.js 재시작 시 process.env로 자동 로드)
  try {
    upsertEnvLocal("GEMINI_API_KEY", apiKey.trim());
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logger.warn(".env.local에 GEMINI_API_KEY를 저장하지 못했습니다: " + detail);
  }

  // 2) 암호화 파일에 저장 (현재 세션에서 즉시 사용 + 백업)
  const filePath = getKeyFilePath();
  const dir = join(process.cwd(), "data");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, encrypted, "utf8");
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logger.error("로컬 파일에 API 키를 저장하지 못했습니다: " + detail);
  }

  // Supabase에도 저장 (있으면)
  const supabase = getAdminSupabaseClientIfAvailable();
  if (supabase) {
    try {
      await supabase
        .from("app_settings")
        .upsert({ key: SETTINGS_KEY, value_encrypted: encrypted, updated_at: new Date().toISOString() }, { onConflict: "key" });
    } catch {
      // DB 실패 시 로컬 파일에 이미 저장되어 있으므로 무시
    }
  }

  // 로컬 파일 또는 .env.local 중 하나라도 저장되었는지 확인
  const envLocalHasKey = existsSync(getEnvLocalPath()) &&
    readFileSync(getEnvLocalPath(), "utf8").includes("GEMINI_API_KEY=");
  if (!existsSync(filePath) && !envLocalHasKey) {
    throw new Error("API 키 저장에 실패했습니다. 로컬 파일과 DB 모두 저장할 수 없습니다.");
  }
}

/** 저장된 키 삭제 (유효하지 않을 때 재입력 유도용). DB, 로컬 파일, .env.local 모두 삭제. */
export async function clearStoredGeminiKey(): Promise<void> {
  const supabase = getAdminSupabaseClientIfAvailable();
  if (supabase) {
    await supabase.from("app_settings").delete().eq("key", SETTINGS_KEY);
  }
  const filePath = getKeyFilePath();
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // ignore
  }
  try {
    removeFromEnvLocal("GEMINI_API_KEY");
  } catch {
    // ignore
  }
}

/** UI에서 사용: 키가 설정되어 있는지. (env → .env.local 직접 → 암호화 파일 → DB) */
export async function isGeminiKeyConfigured(): Promise<boolean> {
  if (process.env.GEMINI_API_KEY?.trim()) return true;

  // .env.local 직접 체크 (현재 세션에서 저장 후 재시작 전에도 인식)
  try {
    const envPath = getEnvLocalPath();
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, "utf8");
      if (/^GEMINI_API_KEY=.+$/m.test(content)) return true;
    }
  } catch {
    // fall through
  }

  if (!hasEncryptionKey()) return false;

  // 암호화 파일 체크
  if (existsSync(getKeyFilePath())) return true;

  const supabase = getAdminSupabaseClientIfAvailable();
  if (supabase) {
    try {
      const { data } = await supabase.from("app_settings").select("key").eq("key", SETTINGS_KEY).maybeSingle();
      if (data?.key) return true;
    } catch {
      // fall through
    }
  }

  return false;
}
