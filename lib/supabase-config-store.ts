/**
 * Supabase Cloud 연결 정보(URL, Service Role Key)를 암호화해 로컬 파일에 저장.
 * env 우선, 없으면 이 파일에서 읽어 Admin 클라이언트 생성에 사용.
 * (DB에 저장하지 않음 — 연결 전이므로 순환 의존 회피)
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ALG = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 16;
const CONFIG_FILE = "supabase-config.enc";
const DEV_KEY_SALT = "contract-risk-dev-only-not-for-production";

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

function hasEncryptionKey(): boolean {
  try {
    getEncryptionKey();
    return true;
  } catch {
    return false;
  }
}

function encrypt(plain: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${enc.toString("hex")}`;
}

function decrypt(blob: string): string {
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

function getConfigFilePath(): string {
  return join(process.cwd(), "data", CONFIG_FILE);
}

export interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

/** env 우선, 없으면 로컬 파일. 없으면 null. */
export function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url && serviceRoleKey) return { url, serviceRoleKey };

  const filePath = getConfigFilePath();
  if (!existsSync(filePath) || !hasEncryptionKey()) return null;
  try {
    const blob = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(decrypt(blob)) as { url?: string; serviceRoleKey?: string };
    if (typeof parsed?.url === "string" && typeof parsed?.serviceRoleKey === "string") {
      return { url: parsed.url.trim(), serviceRoleKey: parsed.serviceRoleKey.trim() };
    }
  } catch {
    return null;
  }
  return null;
}

/** URL·키를 암호화해 data/supabase-config.enc에 저장. */
export function setSupabaseConfig(config: { url: string; serviceRoleKey: string }): void {
  const url = config.url?.trim() ?? "";
  const serviceRoleKey = config.serviceRoleKey?.trim() ?? "";
  if (!url || !serviceRoleKey) {
    throw new Error("Supabase URL과 Service Role Key가 모두 필요합니다.");
  }
  if (!hasEncryptionKey()) {
    throw new Error("ENCRYPTION_KEY가 설정되어 있지 않습니다. .env에 ENCRYPTION_KEY를 32자 이상 설정해 주세요.");
  }

  const encrypted = encrypt(JSON.stringify({ url, serviceRoleKey }));
  const filePath = getConfigFilePath();
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, encrypted, "utf8");
}

/** UI: 설정 여부. env 또는 로컬 파일 존재·복호화 성공 시 true. */
export function isSupabaseConfigConfigured(): boolean {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return true;
  }
  const config = getSupabaseConfig();
  return config !== null;
}
