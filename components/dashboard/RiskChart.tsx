"use client";

interface RiskChartProps {
  high: number;
  medium: number;
  low: number;
  info: number;
}

export function RiskChart({ high, medium, low, info }: RiskChartProps) {
  const max = Math.max(high, medium, low, info, 1);

  const bars = [
    { label: `HIGH (${high})`, value: high, bg: "var(--accent-red-dim)", border: "var(--accent-red)" },
    { label: `MED (${medium})`, value: medium, bg: "var(--accent-yellow-dim)", border: "var(--accent-yellow)" },
    { label: `LOW (${low})`, value: low, bg: "var(--accent-green-dim)", border: "var(--accent-green)" },
    { label: `INFO (${info})`, value: info, bg: "var(--accent-blue-dim)", border: "var(--accent-blue)" },
  ];

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <div className="card-title">리스크 분포</div>
      </div>
      <div className="card-body">
        <div className="risk-chart">
          {bars.map((b) => (
            <div
              key={b.label}
              className="risk-bar"
              style={{
                height: `${max > 0 ? Math.max(10, (b.value / max) * 100) : 10}%`,
                background: b.bg,
                border: `1px solid ${b.border}`,
              }}
            >
              <span className="risk-bar-label">{b.label}</span>
            </div>
          ))}
        </div>
        <div style={{ height: 28 }} />
      </div>
    </div>
  );
}
