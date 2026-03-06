"use client";

import { useEffect, useState } from "react";

interface QuotaRow {
  used: number;
  remaining: number;
  limit: number;
}

interface GroupQuota extends QuotaRow {
  models?: Record<string, QuotaRow>;
}

interface QuotaData {
  analysis: QuotaRow;
  crossValidation: GroupQuota;
  preprocessing: GroupQuota;
  embedding: QuotaRow;
  resetAt?: string;
}

const EMPTY_ROW: QuotaRow = { used: 0, remaining: 0, limit: 0 };

function sumGroup(group: GroupQuota): QuotaRow {
  return { used: group.used, remaining: group.remaining, limit: group.limit };
}

function SidebarQuotaRow({
  label,
  row,
  color,
}: {
  label: string;
  row: QuotaRow;
  color: string;
}) {
  const pct = row.limit > 0 ? Math.min(100, (row.used / row.limit) * 100) : 0;
  return (
    <div className="quota-row">
      <span className="quota-label">{label}</span>
      <div className="quota-bar">
        <div
          className="quota-bar-fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="quota-value">
        {row.used}/{row.limit}
      </span>
    </div>
  );
}

export function QuotaDisplayWrapper() {
  const [data, setData] = useState<QuotaData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/quota")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json) {
          setData({
            analysis: json.analysis ?? json.flash31Lite ?? EMPTY_ROW,
            crossValidation: json.crossValidation ?? {
              ...EMPTY_ROW,
              models: {
                flash25: json.flash25 ?? EMPTY_ROW,
                flash25Lite: json.flash25Lite ?? EMPTY_ROW,
                flash3: json.flash3 ?? EMPTY_ROW,
              },
            },
            preprocessing: json.preprocessing ?? {
              ...EMPTY_ROW,
              models: {
                gemma27b: json.gemma27b ?? EMPTY_ROW,
                gemma12b: json.gemma12b ?? EMPTY_ROW,
                gemma4b: json.gemma4b ?? EMPTY_ROW,
              },
            },
            embedding: json.embedding ?? EMPTY_ROW,
            resetAt: json.resetAt,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (data == null) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        로딩 중...
      </div>
    );
  }

  const flash = sumGroup(data.crossValidation);
  const gemma = sumGroup(data.preprocessing);

  return (
    <>
      <SidebarQuotaRow
        label="Lite"
        row={data.analysis}
        color="var(--accent-blue)"
      />
      <SidebarQuotaRow
        label="Flash"
        row={flash}
        color="var(--accent-yellow)"
      />
      <SidebarQuotaRow
        label="Gemma"
        row={gemma}
        color="var(--accent-green)"
      />
      <SidebarQuotaRow
        label="Embed"
        row={data.embedding}
        color="var(--accent-purple)"
      />
      {data.resetAt && (
        <div className="quota-reset">리셋 {data.resetAt}</div>
      )}
    </>
  );
}
