export interface AnalyzeClauseInput {
  clauseText: string;
  contractId: string;
}

export interface AnalyzeClauseOutput {
  riskSummary: string;
  recommendations: string;
  fidicComparison: unknown;
  riskLevel?: "high" | "medium" | "low" | "info";
  llmModel?: string;
}

const SYSTEM_INSTRUCTION = `You are a contract risk analyst for construction/EPC contracts. 
Given a contract clause text, respond with JSON only (no markdown) with these exact keys:
- riskSummary: string (brief risk summary in Korean or English, 1-3 sentences)
- recommendations: string (actionable recommendations, 1-3 sentences)
- fidicComparison: string | null (comparison with FIDIC standard clauses if relevant, or null)
- riskLevel: one of "high" | "medium" | "low" | "info" (overall risk level for this clause)`;

const CROSS_VALIDATION_INSTRUCTION = `You are a senior contract risk reviewer. Re-analyze this clause independently.
Respond with JSON only: { "riskLevel": "high"|"medium"|"low"|"info", "confidence": 0.0-1.0, "notes": "..." }`;

const SUMMARIZE_PROMPT = `Summarize the following contract clause in under 300 characters, preserving key legal terms and obligations. Reply with the summary text only, in JSON: {"summary":"..."}`;

const LONG_CLAUSE_THRESHOLD = 2000;

import {
  analysisCache,
  getAnalysisCacheKey,
} from "../cache";

const STUB_OUTPUT: AnalyzeClauseOutput = {
  riskSummary: "",
  recommendations: "",
  fidicComparison: null,
  riskLevel: undefined,
};

async function summarizeLongClause(clauseText: string): Promise<string> {
  try {
    const { callGeminiJsonWithFallback } = await import("../gemini");
    const text = clauseText.slice(0, 2000);
    const prompt = `${SUMMARIZE_PROMPT}\n\nText: "${text}"`;
    const { data } = await callGeminiJsonWithFallback<{ summary: string }>({
      prompt,
      chain: "preprocessing",
    });
    return data.summary || text;
  } catch {
    return clauseText.slice(0, 2000);
  }
}

async function crossValidateHighRisk(
  clauseText: string,
  originalLevel: string
): Promise<"high" | "medium" | "low" | "info" | undefined> {
  try {
    const { callGeminiJsonWithFallback } = await import("../gemini");
    const { data: result } = await callGeminiJsonWithFallback<{
      riskLevel?: string;
      confidence?: number;
      notes?: string;
    }>({
      prompt: `Clause text:\n${clauseText.slice(0, 4000)}`,
      systemInstruction: CROSS_VALIDATION_INSTRUCTION,
      chain: "analysis",
    });

    const level = result.riskLevel;
    if (
      level === "high" ||
      level === "medium" ||
      level === "low" ||
      level === "info"
    ) {
      if (level !== originalLevel && (result.confidence ?? 0) > 0.7) {
        return level;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function analyzeClause(
  input: AnalyzeClauseInput
): Promise<AnalyzeClauseOutput> {
  try {
    const { callGeminiJsonWithFallback, MODEL_CONFIG } = await import(
      "../gemini"
    );
    const { getFidicCandidates } = await import("./fidic-candidates");
    const { getStoredGeminiKey } = await import("../gemini-key-store");
    const apiKey = await getStoredGeminiKey();
    if (!apiKey) {
      return STUB_OUTPUT;
    }

    const cacheKey = getAnalysisCacheKey(input.clauseText);
    const cached = analysisCache.get(cacheKey);
    if (cached) {
      return {
        riskSummary: cached.riskSummary,
        recommendations: cached.recommendations,
        fidicComparison: cached.fidicComparison,
        riskLevel: cached.riskLevel as AnalyzeClauseOutput["riskLevel"],
        llmModel: cached.llmModel,
      };
    }

    let clauseForAnalysis = input.clauseText;
    if (input.clauseText.length > LONG_CLAUSE_THRESHOLD) {
      clauseForAnalysis = await summarizeLongClause(input.clauseText);
    }

    const candidates = await getFidicCandidates(input.clauseText, 3);
    const fidicRefs =
      candidates.length > 0
        ? "\nReference FIDIC clauses (Red Book 2017) to compare with:\n" +
          candidates.map((c) => `- ${c.reference}: ${c.text}`).join("\n")
        : "";
    const prompt = `Analyze the following contract clause and provide risk summary, recommendations, and FIDIC comparison.${fidicRefs}\n\nClause text:\n${clauseForAnalysis.slice(0, 12000)}`;
    const { data: res, modelKey } = await callGeminiJsonWithFallback<{
      riskSummary?: string;
      recommendations?: string;
      fidicComparison?: unknown;
      riskLevel?: string;
    }>({
      prompt,
      systemInstruction: SYSTEM_INSTRUCTION,
      chain: "analysis",
    });

    let level: "high" | "medium" | "low" | "info" | undefined;
    if (
      res.riskLevel === "high" ||
      res.riskLevel === "medium" ||
      res.riskLevel === "low" ||
      res.riskLevel === "info"
    ) {
      level = res.riskLevel;
    }

    if (level === "high") {
      const override = await crossValidateHighRisk(
        clauseForAnalysis,
        level
      );
      if (override) {
        level = override;
      }
    }

    const result: AnalyzeClauseOutput = {
      riskSummary:
        typeof res.riskSummary === "string" ? res.riskSummary : "",
      recommendations:
        typeof res.recommendations === "string" ? res.recommendations : "",
      fidicComparison: res.fidicComparison ?? null,
      riskLevel: level,
      llmModel: MODEL_CONFIG[modelKey],
    };

    analysisCache.set(cacheKey, {
      riskSummary: result.riskSummary,
      recommendations: result.recommendations,
      fidicComparison: result.fidicComparison,
      riskLevel: result.riskLevel,
      llmModel: result.llmModel,
    });

    return result;
  } catch (e) {
    const { GeminiKeyInvalidError } = await import("../gemini-errors");
    if (e instanceof GeminiKeyInvalidError) throw e;
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("쿼터") || msg.includes("소진")) {
      throw e;
    }
    return STUB_OUTPUT;
  }
}
