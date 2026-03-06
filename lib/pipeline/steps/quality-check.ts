import type { Clause } from "./split-clauses";

export interface QualityCheckResult {
  clauses: Clause[];
  needsReview: boolean;
  gemmaScore?: number;
}

function ruleBasedCheck(clauses: Clause[]): boolean {
  const count = clauses.length;
  if (count < 3 || count > 500) return true;

  for (const clause of clauses) {
    if (clause.text.trim().length < 20) return true;
    if (clause.flags?.includes("needs_review")) return true;
  }
  return false;
}

async function gemmaQualityScore(
  clauses: Clause[]
): Promise<number | undefined> {
  try {
    const { callGemmaJson } = await import("../../gemini");
    const { canCall } = await import("../../quota-manager");

    if (!(await canCall("gemma12b"))) return undefined;

    const preview = clauses
      .slice(0, 8)
      .map((c, i) => `${i + 1}. [${c.text.length}ch] ${c.text.slice(0, 30)}`)
      .join("\n");

    const result = await callGemmaJson<{
      quality_score?: number;
      issues?: string[];
    }>({
      modelKey: "gemma12b",
      prompt: `Rate clause extraction quality 0.0-1.0. ${clauses.length} total clauses. Reply JSON: {"quality_score":0.0,"issues":["..."]}`,
      inputText: preview,
    });

    if (typeof result.quality_score === "number") {
      return Math.max(0, Math.min(1, result.quality_score));
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function qualityCheck(
  clauses: Clause[]
): Promise<QualityCheckResult> {
  const needsReviewByRules = ruleBasedCheck(clauses);
  const gemmaScore = await gemmaQualityScore(clauses);

  const needsReview =
    needsReviewByRules ||
    (gemmaScore !== undefined && gemmaScore < 0.5);

  return {
    clauses,
    needsReview,
    gemmaScore,
  };
}

export { ruleBasedCheck };
