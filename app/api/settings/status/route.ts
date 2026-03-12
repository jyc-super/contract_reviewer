import { NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../../../../lib/supabase/admin";
import { isGeminiKeyConfigured } from "../../../../lib/gemini-key-store";
import * as logger from "../../../../lib/logger";

export async function GET() {
  const supabase = getAdminSupabaseClientIfAvailable();
  let supabaseConfigured = false;
  let supabaseDetail: string | null = null;

  if (supabase) {
    try {
      const { error } = await supabase
        .from("contracts")
        .select("id", { count: "exact", head: true });

      if (!error) {
        supabaseConfigured = true;
        supabaseDetail = "ok";
      } else {
        supabaseDetail = error.message ?? "connection failed";
      }
    } catch (e) {
      logger.error("Supabase status check", e instanceof Error ? e : new Error(String(e)));
      supabaseDetail = "connection failed";
    }
  }

  let geminiConfigured = false;
  try {
    geminiConfigured = await isGeminiKeyConfigured();
  } catch {
    geminiConfigured = false;
  }

  const fallbackSupabaseDetail = supabase
    ? "checking or not configured"
    : "not configured";

  return NextResponse.json({
    supabaseConfigured,
    supabaseDetail: supabaseDetail ?? fallbackSupabaseDetail,
    geminiConfigured,
    allOk: supabaseConfigured && geminiConfigured,
  });
}
