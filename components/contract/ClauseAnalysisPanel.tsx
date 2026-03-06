"use client";

interface ClauseAnalysisPanelProps {
  riskLevel?: string;
  riskSummary?: string;
  recommendations?: string;
  fidicComparison?: string;
  llmModel?: string;
  analyzedAt?: string;
  isEmpty?: boolean;
}

function riskBadgeClass(level?: string): string {
  switch (level?.toLowerCase()) {
    case "high": return "badge badge-high";
    case "medium": return "badge badge-medium";
    case "low": return "badge badge-low";
    case "info": return "badge badge-info";
    default: return "";
  }
}

function parseRecommendations(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/\n|；|;/)
    .map((s) => s.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean);
}

export function ClauseAnalysisPanel({
  riskLevel,
  riskSummary,
  recommendations,
  fidicComparison,
  llmModel,
  analyzedAt,
  isEmpty,
}: ClauseAnalysisPanelProps) {
  const showPlaceholder = isEmpty ?? (!riskSummary && !recommendations && !fidicComparison);

  if (showPlaceholder) {
    return (
      <div className="analysis-detail" style={{ color: "var(--text-muted)", fontSize: 13 }}>
        조항을 선택하면 분석 결과가 표시됩니다.
      </div>
    );
  }

  const recs = parseRecommendations(recommendations);

  return (
    <div className="analysis-detail">
      {riskLevel && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span className={riskBadgeClass(riskLevel)}>
            {riskLevel.toUpperCase()} RISK
          </span>
        </div>
      )}

      <div className="analysis-section">
        <div className="analysis-section-title">리스크 요약</div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.7 }}>
          {riskSummary ?? "—"}
        </p>
      </div>

      <div className="analysis-section">
        <div className="analysis-section-title">수정 권고사항</div>
        {recs.length > 0 ? (
          recs.map((rec, i) => (
            <div key={i} className="recommendation-item">
              <span className="rec-icon">→</span>
              <span>{rec}</span>
            </div>
          ))
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>—</p>
        )}
      </div>

      <div className="analysis-section">
        <div className="analysis-section-title">FIDIC 비교</div>
        {fidicComparison ? (
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 12px",
            background: "var(--bg-tertiary)",
            borderRadius: "var(--radius)",
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>FIDIC 편차 분석</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                {typeof fidicComparison === "string" && fidicComparison.length > 80
                  ? fidicComparison.slice(0, 80) + "…"
                  : fidicComparison}
              </div>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>—</p>
        )}
      </div>

      {(llmModel || analyzedAt) && (
        <div className="analysis-section">
          <div className="analysis-section-title">분석 메타</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 4 }}>
            {llmModel && <div>모델: {llmModel}</div>}
            {analyzedAt && <div>분석 일시: {analyzedAt}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
