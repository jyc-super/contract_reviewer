"use client";

interface StatsCardsProps {
  totalContracts: number;
  highRiskClauses: number;
  completedContracts: number;
  inProgressContracts: number;
  analyzedClauses: number;
}

export function StatsCards({
  totalContracts,
  highRiskClauses,
  completedContracts,
  inProgressContracts,
  analyzedClauses,
}: StatsCardsProps) {
  return (
    <>
      <div className="stat-card stagger-1 animate-in">
        <div className="stat-label">총 계약서</div>
        <div className="stat-value">{totalContracts}</div>
        <div className="stat-change text-muted">전체 등록</div>
      </div>
      <div className="stat-card stagger-2 animate-in">
        <div className="stat-label">고위험 조항</div>
        <div className="stat-value" style={{ color: "var(--accent-red)" }}>
          {highRiskClauses}
        </div>
        <div className="stat-change" style={{ color: "var(--accent-red)" }}>
          {analyzedClauses > 0
            ? `전체의 ${Math.round((highRiskClauses / analyzedClauses) * 100)}%`
            : "—"}
        </div>
      </div>
      <div className="stat-card stagger-3 animate-in">
        <div className="stat-label">분석 완료</div>
        <div className="stat-value" style={{ color: "var(--accent-green)" }}>
          {completedContracts}
        </div>
        <div className="stat-change text-muted">
          {inProgressContracts > 0
            ? `${inProgressContracts}건 진행 중`
            : "—"}
        </div>
      </div>
      <div className="stat-card stagger-4 animate-in">
        <div className="stat-label">분석된 조항</div>
        <div className="stat-value" style={{ color: "var(--accent-yellow)" }}>
          {analyzedClauses}
        </div>
        <div className="stat-change text-muted">누적 분석</div>
      </div>
    </>
  );
}
