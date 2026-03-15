"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ZoneReviewList, type ZoneItem } from "./ZoneReviewList";
import { TocPreviewPanel } from "./TocPreviewPanel";
import type { TocEntry, SubDocument } from "../../lib/docling-adapter";

/**
 * Represents a logical section of the document as classified by Docling.
 * All fields from the backend are optional — when absent the zone list
 * degrades gracefully to the existing flat rendering.
 */
export interface DoclingDocumentPart {
  part_type: string;
  page_start: number;
  page_end: number;
  title: string;
}

interface ZoneReviewViewProps {
  contractId: string;
  contractName: string;
  uncertainZones: ZoneItem[];
  analysisTargetCount: number;
  totalPageInfo?: string;
  /**
   * Optional document structure from the backend parsing pipeline.
   * When provided, zones are grouped by their parent document_part in the list.
   */
  documentParts?: DoclingDocumentPart[];
  /**
   * Optional sub-document structure from the Docling parse result.
   * When provided together with documentParts, enables 2-depth grouping:
   * sub_document → document_part → zone cards.
   */
  subDocuments?: SubDocument[];
  /** TOC entries from the Docling parse result for preview display. */
  tocEntries?: TocEntry[];
  /** Warnings associated with the TOC (shown as a banner above entries). */
  tocWarnings?: string[];
  /** Parsing warnings from the Docling sidecar (shown as a banner at the top). */
  warnings?: string[];
  /** When provided, called after zone confirmation instead of router.push. */
  onConfirm?: () => void;
  /** When true, the component renders without the full page wrapper (header/main). */
  inline?: boolean;
}

export function ZoneReviewView({
  contractId,
  contractName,
  uncertainZones,
  analysisTargetCount,
  totalPageInfo,
  documentParts,
  subDocuments,
  tocEntries,
  tocWarnings,
  warnings,
  onConfirm,
  inline,
}: ZoneReviewViewProps) {
  const router = useRouter();
  const [decisions, setDecisions] = useState<Record<string, "include" | "exclude">>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // BUG-10: useRef로 동기적 in-flight 여부 추적 — 두 버튼 동시 클릭 시 이중 PUT 방지
  const inFlightRef = useRef(false);

  /**
   * Enrich each ZoneItem with documentPartTitle and optionally subDocumentTitle.
   *
   * - documentPartTitle: zone's pageFrom falls within [part.page_start, part.page_end]
   *   across the flat documentParts list (1-depth, backward compatible).
   * - subDocumentTitle: zone's pageFrom falls within [subDoc.page_start, subDoc.page_end]
   *   across subDocuments. Only injected when subDocuments is provided; enables
   *   2-depth grouping in ZoneReviewList.
   *
   * When neither is available the zone is returned unchanged and the list
   * degrades gracefully to flat rendering.
   */
  const enrichedZones = useMemo<ZoneItem[]>(() => {
    const hasDocParts = documentParts && documentParts.length > 0;
    const hasSubDocs = subDocuments && subDocuments.length > 0;
    if (!hasDocParts && !hasSubDocs) return uncertainZones;

    return uncertainZones.map((zone) => {
      if (zone.pageFrom === undefined) return zone;
      const pageFrom = zone.pageFrom;

      let enriched: ZoneItem = zone;

      if (hasDocParts) {
        const part = documentParts!.find(
          (p) => pageFrom >= p.page_start && pageFrom <= p.page_end
        );
        if (part) {
          enriched = { ...enriched, documentPartTitle: part.title };
        }
      }

      if (hasSubDocs) {
        const subDoc = subDocuments!.find(
          (sd) => pageFrom >= sd.page_start && pageFrom <= sd.page_end
        );
        if (subDoc) {
          enriched = { ...enriched, subDocumentTitle: subDoc.title };
        }
      }

      return enriched;
    });
  }, [uncertainZones, documentParts, subDocuments]);

  const handleInclude = (zoneId: string) => {
    setDecisions((prev) => ({ ...prev, [zoneId]: "include" }));
  };
  const handleExclude = (zoneId: string) => {
    setDecisions((prev) => ({ ...prev, [zoneId]: "exclude" }));
  };

  const handleIncludeAll = () => {
    const all: Record<string, "include" | "exclude"> = {};
    uncertainZones.forEach((z) => { all[z.id] = "include"; });
    setDecisions(all);
  };
  const handleExcludeAll = () => {
    const all: Record<string, "include" | "exclude"> = {};
    uncertainZones.forEach((z) => { all[z.id] = "exclude"; });
    setDecisions(all);
  };

  const includeIds = uncertainZones.filter((z) => decisions[z.id] === "include").map((z) => z.id);
  const excludeIds = uncertainZones.filter((z) => decisions[z.id] === "exclude").map((z) => z.id);
  const undecidedCount = uncertainZones.filter((z) => decisions[z.id] == null).length;
  const allDecided = uncertainZones.length === 0 || undecidedCount === 0;

  /** Zone 확정 PUT → 상세 페이지 이동 (리스크 분석은 상세 페이지에서 별도 실행) */
  const confirmAndNavigate = async (zonePayload: { includeZoneIds: string[]; excludeZoneIds: string[] }) => {
    const res = await fetch(`/api/contracts/${contractId}/zones`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(zonePayload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? "확정 처리에 실패했습니다.");
    }

    if (onConfirm) {
      onConfirm();
    } else {
      router.refresh();
      router.push(`/contracts/${contractId}`);
    }
  };

  const handleSubmit = async () => {
    // BUG-10: 동기적 guard로 이중 요청 차단
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setSubmitting(true);
    try {
      await confirmAndNavigate({ includeZoneIds: includeIds, excludeZoneIds: excludeIds });
    } catch (e) {
      setError(e instanceof Error ? e.message : "확정 처리에 실패했습니다.");
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  /** 건너뛰기: 모든 uncertain zone을 exclude 처리 → status="ready" → 분석 시작 */
  const handleSkip = async () => {
    // BUG-10: 동기적 guard로 이중 요청 차단
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setError(null);
    setSubmitting(true);
    try {
      const allExcludeIds = uncertainZones.map((z) => z.id);
      await confirmAndNavigate({ includeZoneIds: [], excludeZoneIds: allExcludeIds });
    } catch (e) {
      setError(e instanceof Error ? e.message : "건너뛰기 처리에 실패했습니다.");
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const confirmLabel = inline
    ? submitting ? "처리 중…" : "확정 완료 → 분석 시작"
    : submitting ? "처리 중…" : "확정 완료 → 계약 상세로";

  const skipLabel = inline
    ? submitting ? "처리 중…" : "건너뛰기 (분석 시작)"
    : submitting ? "처리 중…" : "건너뛰기 (상세로)";

  const content = (
    <>
      {warnings && warnings.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: "10px 14px",
            background: "var(--accent-yellow-dim)",
            border: "1px solid var(--accent-yellow)",
            borderRadius: "var(--radius)",
          }}
        >
          <p className="text-xs font-medium" style={{ color: "var(--accent-yellow)", marginBottom: 4 }}>
            파싱 경고
          </p>
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {warnings.map((w, i) => (
              <li key={i} className="text-xs" style={{ color: "var(--text-secondary)", marginBottom: 2 }}>
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
      {tocEntries && tocEntries.length > 0 && (
        <TocPreviewPanel tocEntries={tocEntries} warnings={tocWarnings} />
      )}
      <section className="zone-group">
        <div className="zone-group-header">
          <span>확인 필요 구역</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            총 {uncertainZones.length}건
            {uncertainZones.length > 0 && (
              <> · 포함 {includeIds.length}건 / 제외 {excludeIds.length}건 / 미결정 {uncertainZones.length - includeIds.length - excludeIds.length}건</>
            )}
          </span>
          {uncertainZones.length > 0 && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              <button
                type="button"
                onClick={handleIncludeAll}
                disabled={submitting}
                className="zone-btn zone-btn-include"
              >
                전체 포함
              </button>
              <button
                type="button"
                onClick={handleExcludeAll}
                disabled={submitting}
                className="zone-btn zone-btn-exclude"
              >
                전체 제외
              </button>
            </div>
          )}
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
            zones={enrichedZones}
            decisions={decisions}
            onInclude={handleInclude}
            onExclude={handleExclude}
            disabled={submitting}
          />
        )}
      </section>

      {uncertainZones.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {!allDecided && (
            <p className="text-sm" style={{ color: "var(--accent-yellow)", marginBottom: 8 }}>
              {undecidedCount}개 항목이 아직 미결정입니다. 모두 결정한 후 확정할 수 있습니다.
            </p>
          )}
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allDecided || submitting}
            className="btn btn-primary"
          >
            {confirmLabel}
          </button>
          <button
            type="button"
            onClick={handleSkip}
            disabled={submitting}
            className="btn btn-outline"
          >
            {skipLabel}
          </button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm" style={{ marginTop: 8, color: "#f87171" }}>
          {error}
        </p>
      )}
    </>
  );

  if (inline) {
    return content;
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">{contractName}</h1>
          <p className="page-subtitle">
            문서 구역 분류 결과 · 분석 대상 구역: {analysisTargetCount}건
            {totalPageInfo && ` · ${totalPageInfo}`}
          </p>
        </div>
      </header>

      <main className="page-body">
        {content}
      </main>
    </div>
  );
}
