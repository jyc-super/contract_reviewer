import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAdminSupabaseClientIfAvailable } from "./supabase/admin";
import * as logger from "./logger";

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

/** 저장된 Gemini API 키 반환. 없거나 복호화 실패 시 null. env 우선, 다음 DB, 마지막 로컬 파일. */
export async function getStoredGeminiKey(): Promise<string | null> {
  const fromEnv = process.env.GEMINI_API_KEY;
  if (fromEnv?.trim()) return fromEnv.trim();

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
      // fall through to file
    }
  }

  const filePath = getKeyFilePath();
  if (existsSync(filePath) && hasEncryptionKey()) {
    try {
      const blob = readFileSync(filePath, "utf8");
      return decryptGeminiKey(blob);
    } catch {
      return null;
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

  const supabase = getAdminSupabaseClientIfAvailable();
  if (supabase) {
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key: SETTINGS_KEY, value_encrypted: encrypted, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (!error) return;
    // DB 실패 시(테이블 없음, RLS 등) 로컬 파일로 대체 저장
  }

  const filePath = getKeyFilePath();
  const dir = join(process.cwd(), "data");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, encrypted, "utf8");
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error("로컬 파일에 API 키를 저장하지 못했습니다. " + detail + (supabase ? " (DB 저장도 실패했습니다.)" : ""));
  }
}

/** 저장된 키 삭제 (유효하지 않을 때 재입력 유도용). DB와 로컬 파일 둘 다 삭제. */
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
}

/** UI에서 사용: 키가 설정되어 있는지. (env 또는 DB 또는 로컬 파일) */
export async function isGeminiKeyConfigured(): Promise<boolean> {
  if (process.env.GEMINI_API_KEY?.trim()) return true;
  if (!hasEncryptionKey()) return false;

  const supabase = getAdminSupabaseClientIfAvailable();
  if (supabase) {
    try {
      const { data } = await supabase.from("app_settings").select("key").eq("key", SETTINGS_KEY).maybeSingle();
      if (data?.key) return true;
    } catch {
      // fall through
    }
  }

  return existsSync(getKeyFilePath());
}
