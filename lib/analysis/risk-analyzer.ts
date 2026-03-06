import { analyzeClause } from "./analyze-clause";

export type RiskLevel = "high" | "medium" | "low" | "info";

export interface ClauseAnalysisForDb {
  clauseId: string;
  riskLevel: RiskLevel;
  riskSummary: string;
  recommendations: string;
  fidicComparisons: unknown;
  llmModel: string;
}

const MODEL_STUB = "gemini-flash-stub";

/**
 * 조항 텍스트로 리스크 분석 + FIDIC 비교 수행 후 DB 저장용 형식으로 반환.
 * (실제 Gemini 연동은 analyze-clause 내부에서 수행)
 */
export async function analyzeClauseForDb(
  clauseId: string,
  clauseText: string,
  contractId: string
): Promise<ClauseAnalysisForDb> {
  const out = await analyzeClause({
    clauseText,
    contractId,
  });

  const riskLevel =
    out.riskLevel && ["high", "medium", "low", "info"].includes(out.riskLevel)
      ? (out.riskLevel as RiskLevel)
      : deriveRiskLevel(out.riskSummary);

  return {
    clauseId,
    riskLevel,
    riskSummary: out.riskSummary || "(분석 없음)",
    recommendations: out.recommendations || "",
    fidicComparisons: out.fidicComparison ?? null,
    llmModel: out.llmModel ?? MODEL_STUB,
  };
}

function deriveRiskLevel(summary: string): RiskLevel {
  const s = summary.toLowerCase();
  if (/\bhigh\b|\b높음\b|\b심각\b/.test(s)) return "high";
  if (/\bmedium\b|\b중간\b|\b주의\b/.test(s)) return "medium";
  if (/\blow\b|\b낮음\b/.test(s)) return "low";
  return "info";
}
