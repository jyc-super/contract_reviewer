"use client";

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

interface ClauseListProps {
  clauses: ClauseItem[];
  selectedClauseId?: string | null;
  onClauseSelect?: (id: string) => void;
}

function riskClass(level?: string): string {
  switch (level?.toLowerCase()) {
    case "high": return "risk-high";
    case "medium": return "risk-medium";
    case "low": return "risk-low";
    case "info": return "risk-info";
    default: return "";
  }
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

export function ClauseList({ clauses, selectedClauseId, onClauseSelect }: ClauseListProps) {
  if (!clauses.length) {
    return (
      <p style={{ fontSize: 13, color: "var(--text-muted)", padding: 16 }}>
        아직 파싱된 조항이 없습니다.
      </p>
    );
  }

  return (
    <div>
      {clauses.map((clause, index) => {
        const isSelected = selectedClauseId === clause.id;
        const risk = riskClass(clause.riskLevel);
        const Wrapper = (onClauseSelect ? "button" : "div") as "button" | "div";
        return (
          <Wrapper
            key={clause.id}
            type={onClauseSelect ? "button" : undefined}
            onClick={onClauseSelect ? () => onClauseSelect(clause.id) : undefined}
            className={`clause-card${risk ? ` ${risk}` : ""}${isSelected ? " risk-info" : ""}`}
            style={{ textAlign: "left", width: "100%" }}
          >
            <div className="clause-toolbar">
              <div className="toolbar-btn" title="FIDIC 비교">🔍</div>
              <div className="toolbar-btn" title="복사">📋</div>
            </div>

            <div className="clause-header">
              {clause.clausePrefix && (
                <span className="clause-prefix">{clause.clausePrefix}</span>
              )}
              <span className="clause-number">
                {clause.number ?? String(index + 1)}
              </span>
              {clause.title && (
                <span className="clause-title-text">{clause.title}</span>
              )}
              {clause.riskLevel && (
                <span className={riskBadgeClass(clause.riskLevel)} style={{ marginLeft: "auto" }}>
                  {clause.riskLevel.toUpperCase()}
                </span>
              )}
            </div>

            <p className="clause-body">{clause.textPreview}</p>

            {(clause.keywords?.length || clause.needsReview) && (
              <div className="clause-meta">
                {clause.keywords?.map((kw) => (
                  <span key={kw} className="clause-keyword">{kw}</span>
                ))}
                {clause.needsReview && (
                  <span className="clause-review-badge" style={{ marginLeft: "auto" }}>
                    검토 필요
                  </span>
                )}
              </div>
            )}
          </Wrapper>
        );
      })}
    </div>
  );
}
