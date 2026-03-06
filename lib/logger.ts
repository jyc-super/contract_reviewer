/**
 * 서버 측 실행 오류·이벤트를 파일에 기록하는 로거.
 * 로그 파일: logs/app.log (프로젝트 루트 기준)
 * Edge 런타임에서는 파일 쓰기를 건너뛰고 console만 사용합니다.
 */

const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_DIR = "logs";
const LOG_FILE = "app.log";

function getLogPath(): string | null {
  if (typeof process === "undefined" || !process.cwd) return null;
  try {
    const path = require("node:path");
    return path.join(process.cwd(), LOG_DIR, LOG_FILE);
  } catch {
    return null;
  }
}

function ensureLogDir(): boolean {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(process.cwd(), LOG_DIR);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}

function writeToFile(level: string, line: string): void {
  try {
    if (!ensureLogDir()) return;
    const fs = require("node:fs");
    const path = require("node:path");
    const filePath = path.join(process.cwd(), LOG_DIR, LOG_FILE);
    const data = line + "\n";
    fs.appendFileSync(filePath, data, "utf8");
  } catch {
    // 파일 쓰기 실패 시 무시 (Edge 등)
  }
}

function formatMeta(meta?: Record<string, unknown> | Error | null): string {
  if (meta == null) return "";
  if (meta instanceof Error) {
    return ` ${meta.message}${meta.stack ? "\n" + meta.stack : ""}`;
  }
  try {
    return " " + JSON.stringify(meta);
  } catch {
    return " [object]";
  }
}

function formatLine(level: string, message: string, meta?: Record<string, unknown> | Error | null): string {
  const ts = new Date().toISOString();
  const metaStr = formatMeta(meta);
  return `[${ts}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown> | Error | null): void {
  const line = formatLine(level, message, meta);
  if (level === "error") {
    console.error(message, meta ?? "");
  } else if (level === "warn") {
    console.warn(message, meta ?? "");
  } else {
    console.log(`[${level}]`, message, meta ?? "");
  }
  writeToFile(level, line);
}

/** 오류 로그 (예외 객체 포함 가능) */
export function error(message: string, err?: Error | Record<string, unknown> | null): void {
  log("error", message, err ?? undefined);
}

/** 경고 로그 */
export function warn(message: string, meta?: Record<string, unknown> | null): void {
  log("warn", message, meta ?? undefined);
}

/** 일반 정보 로그 */
export function info(message: string, meta?: Record<string, unknown> | null): void {
  log("info", message, meta ?? undefined);
}

/** 디버그 로그 (상세 추적용) */
export function debug(message: string, meta?: Record<string, unknown> | null): void {
  log("debug", message, meta ?? undefined);
}

/** 클라이언트에서 전달받은 오류를 서버 로그에 기록할 때 사용 (API에서만 호출) */
export function logClientError(payload: {
  message: string;
  stack?: string | null;
  digest?: string | null;
  url?: string | null;
}): void {
  const { message, stack, digest, url } = payload;
  const parts = [`[client] ${message}`];
  if (url) parts.push(`url=${url}`);
  if (digest) parts.push(`digest=${digest}`);
  const synthetic = new Error(parts.join(" "));
  if (stack) synthetic.stack = stack;
  error(parts[0], synthetic);
}
