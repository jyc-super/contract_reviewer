"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";

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
const POLL_INTERVAL_MS = 30_000;

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
  // BUG-17: 에러 상태 추가
  const [fetchError, setFetchError] = useState(false);
  const pathname = usePathname();

  const fetchQuota = useCallback(() => {
    setFetchError(false);
    fetch("/api/quota")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("quota fetch failed"))))
      .then((json: Record<string, unknown>) => {
        setData({
          analysis: (json.analysis ?? json.flash31Lite ?? EMPTY_ROW) as QuotaRow,
          crossValidation: (json.crossValidation ?? {
            ...EMPTY_ROW,
            models: {
              flash25: (json.flash25 ?? EMPTY_ROW) as QuotaRow,
              flash25Lite: (json.flash25Lite ?? EMPTY_ROW) as QuotaRow,
              flash3: (json.flash3 ?? EMPTY_ROW) as QuotaRow,
            },
          }) as GroupQuota,
          preprocessing: (json.preprocessing ?? {
            ...EMPTY_ROW,
            models: {
              gemma27b: (json.gemma27b ?? EMPTY_ROW) as QuotaRow,
              gemma12b: (json.gemma12b ?? EMPTY_ROW) as QuotaRow,
              gemma4b: (json.gemma4b ?? EMPTY_ROW) as QuotaRow,
            },
          }) as GroupQuota,
          embedding: (json.embedding ?? EMPTY_ROW) as QuotaRow,
          resetAt: typeof json.resetAt === "string" ? json.resetAt : undefined,
        });
      })
      .catch(() => {
        // BUG-17: 에러 상태 설정으로 영구 로딩 방지
        setFetchError(true);
      });
  }, []);

  // 초기 로드 + 경로 변경 시 즉시 갱신 (분석 완료 후 페이지 이동 케이스 커버)
  useEffect(() => {
    fetchQuota();
  }, [pathname, fetchQuota]);

  // 30초 주기 polling — 분석 진행 중에도 사용량 반영
  useEffect(() => {
    const id = setInterval(fetchQuota, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchQuota]);

  // BUG-17: 에러 상태 UI — 재시도 버튼 표시
  if (fetchError) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        <span>할당량 조회 실패</span>
        <button
          type="button"
          onClick={fetchQuota}
          style={{
            display: "block",
            marginTop: 4,
            fontSize: 11,
            color: "var(--accent-blue)",
            background: "none",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          다시 시도
        </button>
      </div>
    );
  }

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
        label="Lite (PDF+분석)"
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
