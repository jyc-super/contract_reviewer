"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ClauseList } from "./ClauseList";
import { ClauseAnalysisPanel } from "./ClauseAnalysisPanel";
import { useContractDetailStore } from "../../store/contract-detail";
import type { ContractDetailContract, ContractDetailAnalysis } from "../../lib/data/contracts";

interface ClauseItem {
  id: string;
  title?: string;
  textPreview: string;
  clausePrefix?: string;
  number?: string;
  riskLevel?: string;
  keywords?: string[];
  needsReview?: boolean;
}

interface ContractDetailViewProps {
  contractId: string;
  contract: Pick<ContractDetailContract, "name" | "status" | "page_count">;
  clauseItems: ClauseItem[];
  analyses: ContractDetailAnalysis[];
}

export function ContractDetailView({
  contractId,
  contract,
  clauseItems,
  analyses,
}: ContractDetailViewProps) {
  const router = useRouter();
  const { selectedClauseId, setSelectedClauseId } = useContractDetailStore();
  const [analyzing, setAnalyzing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const selectedAnalysis = selectedClauseId
    ? analyses.find((a) => a.clause_id === selectedClauseId)
    : null;

  const clausesWithRisk = clauseItems.map((c) => {
    const a = analyses.find((an) => an.clause_id === c.id);
    return {
      ...c,
      riskLevel: c.riskLevel ?? a?.risk_level,
    };
  });

  const runAnalysis = async () => {
    setMessage(null);
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/analyze`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401 && body?.code === "GEMINI_KEY_INVALID") {
          window.location.href = "/?geminiKeyInvalid=1";
          return;
        }
        setMessage({ type: "error", text: body?.error ?? "분석 요청에 실패했습니다." });
        return;
      }
      const text =
        body.message ??
        (body.analyzed != null
          ? `${body.analyzed}건 분석 완료${body.total != null ? ` (전체 ${body.total}건)` : ""}.`
          : "분석이 완료되었습니다.");
      setMessage({ type: "success", text });
      router.refresh();
    } finally {
      setAnalyzing(false);
    }
  };

  const fidicDisplay =
    selectedAnalysis?.fidic_comparisons != null
      ? typeof selectedAnalysis.fidic_comparisons === "string"
        ? selectedAnalysis.fidic_comparisons
        : JSON.stringify(selectedAnalysis.fidic_comparisons)
      : undefined;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">조항 분석</div>
          <div className="page-subtitle">
            {contract.name} · {clauseItems.length}개 조항
            {analyses.length > 0 && ` · 분석 ${analyses.length}건`}
            {contract.status === "filtering" && (
              <>
                {" · "}
                <Link
                  href={`/contracts/${contractId}/zones`}
                  style={{ color: "var(--accent-blue)", textDecoration: "underline" }}
                >
                  구역 검토 →
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="page-actions">
          <Link
            href={`/contracts/${contractId}/report`}
            className="btn btn-outline"
          >
            📥 리포트 보기
          </Link>
          <button
            className="btn btn-primary"
            onClick={runAnalysis}
            disabled={analyzing || contract.status === "analyzing"}
          >
            {analyzing || contract.status === "analyzing" ? "⟳ 분석 중…" : "⚡ 분석 실행"}
          </button>
        </div>
      </div>

      {message && (
        <div
          style={{
            margin: "0 32px",
            marginTop: 12,
            padding: "10px 16px",
            borderRadius: "var(--radius)",
            fontSize: 13,
            background: message.type === "success" ? "var(--accent-green-dim)" : "var(--accent-red-dim)",
            color: message.type === "success" ? "var(--accent-green)" : "var(--accent-red)",
          }}
        >
          {message.text}
        </div>
      )}

      <div className="page-body">
        <div className="analysis-layout">
          <div>
            <ClauseList
              clauses={clausesWithRisk}
              selectedClauseId={selectedClauseId}
              onClauseSelect={setSelectedClauseId}
            />
          </div>
          <div className="analysis-sidebar">
            <div className="card" style={{ position: "sticky", top: 24 }}>
              {selectedAnalysis && (
                <div
                  className="card-header"
                  style={{
                    background: selectedAnalysis.risk_level?.toLowerCase() === "high"
                      ? "var(--accent-red-dim)"
                      : "var(--bg-tertiary)",
                  }}
                >
                  <div className="card-title">
                    {clauseItems.find((c) => c.id === selectedClauseId)?.title ?? "분석 결과"}
                  </div>
                </div>
              )}
              <ClauseAnalysisPanel
                riskLevel={selectedAnalysis?.risk_level}
                riskSummary={selectedAnalysis?.risk_summary}
                recommendations={selectedAnalysis?.recommendations}
                fidicComparison={fidicDisplay}
                llmModel={selectedAnalysis?.llm_model}
                isEmpty={!selectedClauseId}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
