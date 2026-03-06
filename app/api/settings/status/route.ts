import { NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../../../../lib/supabase/admin";
import { isGeminiKeyConfigured } from "../../../../lib/gemini-key-store";
import * as logger from "../../../../lib/logger";
import fs from "fs";
import path from "path";

const DOCLING_SERVICE_URL = process.env.DOCLING_SERVICE_URL;

// #region agent log
function writeLog(message: string, data: Record<string, unknown>, hypothesisId: string) {
  const payload = { sessionId: "b06c12", location: "app/api/settings/status/route.ts", message, data, timestamp: Date.now(), hypothesisId };
  try { fs.appendFileSync(path.join(process.cwd(), "debug-b06c12.log"), JSON.stringify(payload) + "\n", "utf8"); } catch (_) {}
  fetch("http://127.0.0.1:7399/ingest/03b57e5a-e83f-4605-bb0f-fb2aabef1b25", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "b06c12" }, body: JSON.stringify(payload) }).catch(() => {});
}
// #endregion

export async function GET() {
  // #region agent log
  writeLog("status GET env", {
    hasSupabaseUrl: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    hasServiceRoleKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    hasDoclingUrl: !!(DOCLING_SERVICE_URL && DOCLING_SERVICE_URL.trim()),
  }, "H4");
  // #endregion
  const supabase = getAdminSupabaseClientIfAvailable();
  let supabaseConfigured = false;
  let supabaseDetail: string | null = null;

  if (supabase) {
    try {
      const { count, error } = await supabase
        .from("contracts")
        .select("id", { count: "exact", head: true });
      if (!error) {
        supabaseConfigured = true;
        supabaseDetail = "정상";
      } else {
        supabaseDetail = error.message ?? "연결 실패";
      }
    } catch (e) {
      logger.error("Supabase status check", e instanceof Error ? e : new Error(String(e)));
      supabaseDetail = "연결 실패";
    }
  }

  let doclingConfigured = false;
  let doclingDetail: string | null = null;
  if (DOCLING_SERVICE_URL?.trim()) {
    try {
      const url = DOCLING_SERVICE_URL.replace(/\/$/, "");
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(5000) });
      if (res.ok || res.status === 404) {
        doclingConfigured = true;
        doclingDetail = "실행 중";
      } else {
        doclingDetail = `HTTP ${res.status}`;
      }
    } catch {
      doclingDetail = "감지 안 됨";
    }
  } else {
    doclingDetail = "미설정";
  }

  // #region agent log
  writeLog("status result", { supabaseConfigured, doclingConfigured, supabaseDetail, doclingDetail }, "H5");
  // #endregion

  let geminiConfigured = false;
  try {
    geminiConfigured = await isGeminiKeyConfigured();
  } catch {
    geminiConfigured = false;
  }

  return NextResponse.json({
    supabaseConfigured,
    supabaseDetail: supabaseDetail ?? (supabase ? "확인 중" : "미설정"),
    doclingConfigured,
    doclingDetail: doclingDetail ?? "미설정",
    geminiConfigured,
    allOk: supabaseConfigured && doclingConfigured && geminiConfigured,
  });
}
