"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ZoneReviewList, type ZoneItem } from "./ZoneReviewList";

interface ZoneReviewViewProps {
  contractId: string;
  contractName: string;
  uncertainZones: ZoneItem[];
  analysisTargetCount: number;
  totalPageInfo?: string;
}

export function ZoneReviewView({
  contractId,
  contractName,
  uncertainZones,
  analysisTargetCount,
  totalPageInfo,
}: ZoneReviewViewProps) {
  const router = useRouter();
  const [decisions, setDecisions] = useState<Record<string, "include" | "exclude">>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleInclude = (zoneId: string) => {
    setDecisions((prev) => ({ ...prev, [zoneId]: "include" }));
  };
  const handleExclude = (zoneId: string) => {
    setDecisions((prev) => ({ ...prev, [zoneId]: "exclude" }));
  };

  const includeIds = uncertainZones.filter((z) => decisions[z.id] === "include").map((z) => z.id);
  const excludeIds = uncertainZones.filter((z) => decisions[z.id] === "exclude").map((z) => z.id);
  const allDecided = uncertainZones.length === 0 || uncertainZones.every((z) => decisions[z.id] != null);

  const handleSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/zones`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeZoneIds: includeIds, excludeZoneIds: excludeIds }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "확정 처리에 실패했습니다.");
        return;
      }
      router.refresh();
      router.push(`/contracts/${contractId}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">{contractName}</h1>
          <p className="page-subtitle">
            문서 구역 검토 · 분석 대상 구역: {analysisTargetCount}건
            {totalPageInfo && ` · ${totalPageInfo}`}
          </p>
        </div>
      </header>

      <main className="page-body">
        <section className="zone-group">
          <div className="zone-group-header">
            <span>확인 필요 구역</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              총 {uncertainZones.length}건
            </span>
          </div>
          {uncertainZones.length === 0 ? (
            <div className="zone-item">
              <span>
                검토할 uncertain 구역이 없습니다.{" "}
                <Link
                  href={`/contracts/${contractId}`}
                  className="text-accent-soft hover:text-accent-primary hover:underline"
                >
                  계약 상세로 이동
                </Link>
              </span>
            </div>
          ) : (
            <ZoneReviewList
              zones={uncertainZones}
              decisions={decisions}
              onInclude={handleInclude}
              onExclude={handleExclude}
              disabled={submitting}
            />
          )}
        </section>

        {uncertainZones.length > 0 && (
          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!allDecided || submitting}
              className="btn btn-primary"
            >
              {submitting ? "처리 중…" : "확정 완료 → 계약 상세로"}
            </button>
            <Link href={`/contracts/${contractId}`} className="btn btn-outline">
              건너뛰기 (상세로)
            </Link>
          </div>
        )}

        {error && (
          <p className="text-sm" style={{ marginTop: 8, color: "#f87171" }}>
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
