export type RiskLevel = "high" | "medium" | "low" | "info";

export interface FidicComparison {
  fidicEdition: string;
  clauseNumber: string;
  title: string;
  deviationSummary: string;
  deviationSeverity: "critical" | "major" | "minor" | "none";
}

export interface ClauseAnalysis {
  clauseId: string;
  riskLevel: RiskLevel;
  riskSummary: string;
  recommendations: string;
  fidicComparisons: FidicComparison[];
  llmModel: string;
}

