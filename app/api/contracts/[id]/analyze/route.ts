import { NextRequest, NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../../../../../lib/supabase/admin";
import { requireUserIdFromRequest } from "../../../../../lib/auth/server";
import { analyzeClauseForDb } from "../../../../../lib/analysis/risk-analyzer";
import { GeminiKeyInvalidError } from "../../../../../lib/gemini-errors";
import { clearStoredGeminiKey } from "../../../../../lib/gemini-key-store";
import * as logger from "../../../../../lib/logger";

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: Params) {
  const { id: contractId } = await params;
  const auth = await requireUserIdFromRequest(req);
  if ("response" in auth) return auth.response;
  const { userId } = auth;
  const supabase = getAdminSupabaseClientIfAvailable();

  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase가 설정되지 않았습니다." },
      { status: 503 }
    );
  }

  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id, status, user_id")
    .eq("id", contractId)
    .single();

  if (contractError || !contract) {
    return NextResponse.json(
      { error: "계약을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  if (contract.user_id !== userId) {
    return NextResponse.json(
      { error: "계약을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  await supabase
    .from("contracts")
    .update({ status: "analyzing", updated_at: new Date().toISOString() })
    .eq("id", contractId);

  try {
    const { data: clauses } = await supabase
      .from("clauses")
      .select("id, text")
      .eq("contract_id", contractId);

    if (!clauses?.length) {
      await supabase
        .from("contracts")
        .update({ status: "ready", updated_at: new Date().toISOString() })
        .eq("id", contractId);
      return NextResponse.json({
        ok: true,
        contractId,
        analyzed: 0,
        message: "분석할 조항이 없습니다.",
      });
    }

    const { data: existing } = await supabase
      .from("clause_analyses")
      .select("clause_id")
      .in("clause_id", clauses.map((c) => c.id));

    const existingIds = new Set((existing ?? []).map((r) => r.clause_id));
    const toAnalyze = clauses.filter((c) => !existingIds.has(c.id));

    let analyzed = 0;
    for (const clause of toAnalyze) {
      try {
        const row = await analyzeClauseForDb(
          clause.id,
          clause.text,
          contractId
        );
        const { error: insertErr } = await supabase.from("clause_analyses").insert({
          clause_id: row.clauseId,
          risk_level: row.riskLevel,
          risk_summary: row.riskSummary,
          recommendations: row.recommendations,
          fidic_comparisons: row.fidicComparisons,
          llm_model: row.llmModel,
        });
        if (!insertErr) analyzed++;
        // 무료 티어 보호: Flash 호출 간격 >= 6s (master.md)
        if (toAnalyze.indexOf(clause) < toAnalyze.length - 1) {
          await new Promise((r) => setTimeout(r, 6000));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (e instanceof GeminiKeyInvalidError) {
          await clearStoredGeminiKey();
          return NextResponse.json(
            { error: "Gemini API 키가 유효하지 않습니다. 메인 페이지에서 다시 입력해 주세요.", code: "GEMINI_KEY_INVALID" },
            { status: 401 }
          );
        }
        if (msg.includes("쿼터") || msg.includes("소진")) {
          await supabase
            .from("contracts")
            .update({ status: "partial", updated_at: new Date().toISOString() })
            .eq("id", contractId);
          return NextResponse.json({
            ok: true,
            contractId,
            analyzed,
            total: clauses.length,
            message: "쿼터 소진으로 일부만 분석되었습니다. 내일 17:00 KST에 리셋됩니다.",
          });
        }
        throw e;
      }
    }

    await supabase
      .from("contracts")
      .update({ status: "ready", updated_at: new Date().toISOString() })
      .eq("id", contractId);

    return NextResponse.json({
      ok: true,
      contractId,
      analyzed,
      total: clauses.length,
    });
  } catch (e) {
    if (e instanceof GeminiKeyInvalidError) {
      await clearStoredGeminiKey();
      return NextResponse.json(
        { error: "Gemini API 키가 유효하지 않습니다. 메인 페이지에서 다시 입력해 주세요.", code: "GEMINI_KEY_INVALID" },
        { status: 401 }
      );
    }
    await supabase
      .from("contracts")
      .update({ status: "error", updated_at: new Date().toISOString() })
      .eq("id", contractId);
    logger.error("계약 분석 중 오류", e instanceof Error ? e : new Error(String(e)));
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "분석 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
