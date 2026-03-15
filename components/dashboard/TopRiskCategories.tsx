"use client";

const DEFAULT_CATEGORIES = [
  { name: "책임 제한 (Limitation of Liability)", count: 0 },
  { name: "지체상금 (Liquidated Damages)", count: 0 },
  { name: "계약 해지 (Termination)", count: 0 },
  { name: "면책 (Indemnity)", count: 0 },
  { name: "불가항력 (Force Majeure)", count: 0 },
];

interface TopRiskCategoriesProps {
  categories?: { name: string; count: number }[];
}

export function TopRiskCategories({ categories }: TopRiskCategoriesProps) {
  // BUG-14: categories가 undefined이면 DEFAULT_CATEGORIES를 보여주되,
  // 명시적으로 빈 배열[]이 전달되면 "데이터 없음" 상태를 표시
  const items = categories ?? DEFAULT_CATEGORIES;
  const hasData = items.some((cat) => cat.count > 0);

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">고위험 카테고리 Top 5</div>
      </div>
      <div className="card-body">
        {!hasData ? (
          <p style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "8px 0" }}>
            분석된 데이터가 없습니다
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((cat) => (
              <div
                key={cat.name}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span style={{ fontSize: 12 }}>{cat.name}</span>
                <span className="badge badge-high" style={{ fontSize: 11 }}>
                  {cat.count}건
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
