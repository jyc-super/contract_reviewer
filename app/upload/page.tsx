"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { FileDropzone } from "../../components/upload/FileDropzone";
import { UploadProgressPanel } from "../../components/upload/UploadProgressPanel";
import { ZoneReviewView } from "../../components/contract/ZoneReviewView";
import { useUploadStore } from "../../lib/stores/upload-store";
import type { ZoneItem } from "../../components/contract/ZoneReviewList";
import type { DoclingDocumentPart } from "../../components/contract/ZoneReviewView";
import type { TocEntry, SubDocument } from "../../lib/docling-adapter";

// ---------------------------------------------------------------------------
// Backend data shapes (all new fields are optional — backend may not send them)
// ---------------------------------------------------------------------------

interface FooterPattern {
  pattern: string;
  type: "page_number" | "document_number" | "confidentiality_notice" | string;
}

interface HeaderFooterInfo {
  header_pattern?: string;
  footer_patterns?: FooterPattern[];
  total_pages?: number;
  page_number_style?: string;
  removed_header_count?: number;
  removed_footer_count?: number;
}

// ---------------------------------------------------------------------------
// UI data shapes
// ---------------------------------------------------------------------------

interface ProcessSummary {
  pages: number;
  analysisTargetCount: number;
  uncertainZoneCount: number;
  clauseCount: number;
  needsReview: boolean;
  /** Document number extracted from footer_patterns (document_number type). */
  documentNumber?: string;
  /** Total removed header + footer blocks. */
  removedHeaderFooterCount?: number;
  /** Total page count reported by header/footer analysis. */
  headerFooterTotalPages?: number;
}

interface UploadResponse {
  ok: boolean;
  status?: string;
  data?: ProcessSummary;
  contractId?: string;
  error?: string;
  code?: string;
  message?: string;
}

interface ZonesApiResponse {
  contractName: string;
  pageCount: number | null;
  uncertainZones: ZoneItem[];
  analysisTargetCount: number;
  /** Optional document structure for grouping zones by section. */
  document_parts?: DoclingDocumentPart[];
  /** Optional sub-document structure for 2-depth zone grouping. */
  sub_documents?: SubDocument[];
  /** Optional header/footer metadata for display in the upload panel. */
  header_footer_info?: HeaderFooterInfo;
  /** Optional table-of-contents entries from the Docling parse result. */
  toc_entries?: TocEntry[];
  /** Parsing warnings from the Docling sidecar. */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Helper: map HeaderFooterInfo fields onto ProcessSummary optional fields
// ---------------------------------------------------------------------------
function extractHeaderFooterMeta(
  info: HeaderFooterInfo | undefined
): Pick<ProcessSummary, "documentNumber" | "removedHeaderFooterCount" | "headerFooterTotalPages"> {
  if (!info) return {};
  const docNumberPattern = info.footer_patterns?.find((p) => p.type === "document_number");
  const removedCount =
    (info.removed_header_count ?? 0) + (info.removed_footer_count ?? 0);
  return {
    documentNumber: docNumberPattern?.pattern,
    removedHeaderFooterCount: removedCount > 0 ? removedCount : undefined,
    headerFooterTotalPages: info.total_pages,
  };
}

const POLL_INTERVAL_FAST_MS = 2000; // 파싱 중 (stage 2)
const POLL_INTERVAL_NORMAL_MS = 3000; // 그 외 상태
const UPLOAD_TIMEOUT_MS = 30_000;
const POLL_FAILURE_LIMIT = 3;

function stageFromStatus(status: string): number {
  switch (status) {
    case "parsing":
      return 2;
    case "quality_checking":
      return 3;
    case "filtering":
      return 5; // zone classification done; waiting for user confirmation (stage 5)
    case "ready":
    case "partial":
      return 6; // past the last stage (5) so all steps render as done
    case "error":
      return 5;
    default:
      return 1;
  }
}

function mapUploadError(code?: string, fallbackMessage?: string): string {
  if (code === "DOCLING_UNAVAILABLE") {
    return "문서 파서가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.";
  }
  if (code === "DOCLING_PARSE_FAILED_SCAN") {
    return "스캔된 이미지 PDF로 감지되었습니다. OCR 처리된 PDF 또는 텍스트 기반 PDF를 업로드해 주세요.";
  }
  if (code === "DOCLING_PARSE_FAILED") {
    return "문서 파싱에 실패했습니다. 파일이 손상되었거나 지원하지 않는 형식일 수 있습니다.";
  }
  if (code === "SUPABASE_INSERT_FAILED" || code === "SUPABASE_UNREACHABLE") {
    return "Supabase에 연결할 수 없습니다. 설정 페이지에서 URL과 키를 확인하세요.";
  }
  if (code === "SUPABASE_SCHEMA_MISSING") {
    return "Supabase 스키마가 초기화되지 않았습니다. 마이그레이션(001~003)을 실행해 주세요.";
  }
  return fallbackMessage ?? "업로드 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.";
}

/** Terminal statuses where polling should stop. */
const TERMINAL_STATUSES = new Set(["ready", "partial", "error"]);

export default function UploadPage() {
  // -------------------------------------------------------------------------
  // Persisted state (survives navigation)
  // BUG-02: 전체 구독 대신 개별 selector로 분리하여 폴링 중 리렌더 폭주 방지
  // -------------------------------------------------------------------------
  const stage = useUploadStore((s) => s.stage);
  const contractId = useUploadStore((s) => s.contractId);
  const liveStatus = useUploadStore((s) => s.liveStatus);
  const error = useUploadStore((s) => s.error);
  const errorCode = useUploadStore((s) => s.errorCode);
  const fileName = useUploadStore((s) => s.fileName);
  const startTime = useUploadStore((s) => s.startTime);
  const parseProgress = useUploadStore((s) => s.parseProgress);
  const fileSize = useUploadStore((s) => s.fileSize);
  // 액션은 참조가 안정적이므로 한 번에 가져와도 무방
  const storeReset = useUploadStore((s) => s.reset);
  const storeSetFileName = useUploadStore((s) => s.setFileName);
  const storeSetFileSize = useUploadStore((s) => s.setFileSize);
  const storeSetStartTime = useUploadStore((s) => s.setStartTime);
  const storeSetStage = useUploadStore((s) => s.setStage);
  const storeAdvanceStage = useUploadStore((s) => s.advanceStage);
  const storeSetContractId = useUploadStore((s) => s.setContractId);
  const storeSetLiveStatus = useUploadStore((s) => s.setLiveStatus);
  const storeSetError = useUploadStore((s) => s.setError);
  const storeSetParseProgress = useUploadStore((s) => s.setParseProgress);
  const storeSetLastCompleted = useUploadStore((s) => s.setLastCompletedContractId);

  // -------------------------------------------------------------------------
  // Ephemeral state (component-local, lost on unmount — intentional)
  // -------------------------------------------------------------------------
  const [isUploading, setIsUploading] = useState(false);
  const [summary, setSummary] = useState<ProcessSummary | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  // Inline zone review data (fetched when liveStatus === "filtering")
  const [zoneData, setZoneData] = useState<ZonesApiResponse | null>(null);
  const [zoneLoading, setZoneLoading] = useState(false);
  const [zoneError, setZoneError] = useState<string | null>(null);

  // Hydration guard: zustand persist hydrates async, so initial render uses
  // default (empty) values. This flag flips to true after hydration so the
  // component can start using persisted state safely.
  const [hydrated, setHydrated] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailureCountRef = useRef(0);
  const lastFileRef = useRef<File | null>(null);
  const zoneReviewRef = useRef<HTMLElement | null>(null);

  // Hydration: wait for zustand persist to rehydrate from sessionStorage
  useEffect(() => {
    // useUploadStore.persist is guaranteed to exist because we used the
    // persist middleware. The onFinishHydration callback fires once.
    const unsub = useUploadStore.persist.onFinishHydration(() => {
      setHydrated(true);
    });
    // If hydration already completed synchronously (e.g. empty storage),
    // the callback may not fire. Check hasHydrated() as a fallback.
    if (useUploadStore.persist.hasHydrated()) {
      setHydrated(true);
    }
    return unsub;
  }, []);

  const stages = [
    "1. File validation",
    "2. Docling parse",
    "3. Quality check",
    "4. Zone classification",
    "5. User confirmation",
  ];

  // -------------------------------------------------------------------------
  // Polling logic
  // -------------------------------------------------------------------------

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (cid: string) => {
      stopPolling();
      setPollError(null);
      pollFailureCountRef.current = 0;

      const scheduleNext = () => {
        // 매 폴링마다 최신 stage를 읽어 간격 결정 (클로저 캡처 방지)
        const currentStage = useUploadStore.getState().stage;
        const interval = currentStage === 2 ? POLL_INTERVAL_FAST_MS : POLL_INTERVAL_NORMAL_MS;
        pollRef.current = setTimeout(() => void poll(), interval);
      };

      const poll = async () => {
        try {
          const res = await fetch(`/api/contracts/${cid}/status`);
          if (!res.ok) {
            pollFailureCountRef.current += 1;
            const body = await res.json().catch(() => null);
            const msg = (body as { error?: string } | null)?.error ?? "Status request failed.";
            setPollError(msg);
            if (pollFailureCountRef.current >= POLL_FAILURE_LIMIT) {
              stopPolling();
              setPollError("Status polling failed repeatedly. Check server logs.");
            } else {
              scheduleNext();
            }
            return;
          }

          pollFailureCountRef.current = 0;
          setPollError(null);
          const json = await res.json() as { status?: string; done?: boolean; parseProgress?: number | null };
          const s = json.status ?? "";
          storeSetLiveStatus(s);
          storeAdvanceStage(stageFromStatus(s));
          storeSetParseProgress(typeof json.parseProgress === "number" ? json.parseProgress : null);
          if (json.done === true || TERMINAL_STATUSES.has(s)) {
            stopPolling();
            if (s === "ready" || s === "partial" || s === "filtering") {
              storeSetLastCompleted(cid);
            }
          } else {
            scheduleNext();
          }
        } catch {
          pollFailureCountRef.current += 1;
          setPollError("Status request failed.");
          if (pollFailureCountRef.current >= POLL_FAILURE_LIMIT) {
            stopPolling();
            setPollError("Status polling failed repeatedly. Check network/server.");
          } else {
            scheduleNext();
          }
        }
      };

      void poll();
    },
    [stopPolling, storeSetLiveStatus, storeAdvanceStage, storeSetParseProgress, storeSetLastCompleted]
  );

  // -------------------------------------------------------------------------
  // On mount: if store has an in-flight contractId, restore polling
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!hydrated) return;
    if (!contractId) return;
    // If already in a terminal state, no need to poll — just restore UI
    if (liveStatus && TERMINAL_STATUSES.has(liveStatus)) return;
    // Resume polling for non-terminal states (e.g. "parsing", "analyzing")
    startPolling(contractId);

    return stopPolling;
    // Only run once after hydration, not on every store change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // -------------------------------------------------------------------------
  // When liveStatus becomes "filtering", scroll zone review panel into view
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (liveStatus !== "filtering") return;
    // Small delay so the zone review section has time to mount before scrolling
    const id = setTimeout(() => {
      zoneReviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
    return () => clearTimeout(id);
  }, [liveStatus]);

  // -------------------------------------------------------------------------
  // When liveStatus becomes "filtering", fetch zone data for inline review
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!hydrated) return;
    if (liveStatus !== "filtering" || !contractId) {
      // Clear zone data if we leave the filtering state
      if (liveStatus !== "filtering") {
        setZoneData(null);
        setZoneError(null);
      }
      return;
    }
    // Already loaded for this contract
    if (zoneData && !zoneError) return;

    let cancelled = false;
    const fetchZones = async () => {
      setZoneLoading(true);
      setZoneError(null);
      try {
        const res = await fetch(`/api/contracts/${contractId}/zones`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error((body as { error?: string } | null)?.error ?? "구역 데이터를 불러올 수 없습니다.");
        }
        const data = (await res.json()) as ZonesApiResponse;
        if (!cancelled) {
          setZoneData(data);
          // If the zones API includes header/footer metadata, surface it in the
          // summary so UploadProgressPanel can display it once processing is done.
          const hfMeta = extractHeaderFooterMeta(data.header_footer_info);
          const hasHfMeta =
            hfMeta.documentNumber !== undefined ||
            hfMeta.removedHeaderFooterCount !== undefined ||
            hfMeta.headerFooterTotalPages !== undefined;
          if (hasHfMeta) {
            setSummary((prev) =>
              prev
                ? { ...prev, ...hfMeta }
                : null
            );
          }
        }
      } catch (e) {
        if (!cancelled) setZoneError(e instanceof Error ? e.message : "구역 데이터 조회 실패");
      } finally {
        if (!cancelled) setZoneLoading(false);
      }
    };

    void fetchZones();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, liveStatus, contractId]);

  // Cleanup polling on unmount — if contract is still processing,
  // signal the contracts list page so it knows to keep checking
  useEffect(() => {
    return () => {
      stopPolling();
      // If we're leaving with an active (non-terminal) contract,
      // set lastCompletedContractId so AutoRefreshWrapper picks it up
      // and starts polling on the contracts list page
      const { contractId: cid, liveStatus: status } = useUploadStore.getState();
      if (cid && status && !TERMINAL_STATUSES.has(status)) {
        // Signal that there's a pending contract needing attention
        storeSetLastCompleted(cid);
      }
    };
  }, [stopPolling, storeSetLastCompleted]);

  // Progress is fully managed by useProgressEstimation inside UploadProgressPanel.
  // This displayProgress is only used as a terminal fallback (100% on done).
  const statusLabel = liveStatus ? `Status: ${liveStatus}` : undefined;
  const isIdle = !isUploading && !contractId && !summary && !error && stage === 0;
  const displayProgress = isIdle ? 0 : 100;
  const displayStatusText = isIdle
    ? "Drop a file or click to choose PDF/DOCX"
    : error
      ? error
      : liveStatus === "filtering"
        ? "불확실 구역이 있어 아래에서 검토해 주세요."
        : statusLabel ?? `${stages[Math.max(0, stage - 1)]} in progress...`;

  // -------------------------------------------------------------------------
  // Upload handler
  // -------------------------------------------------------------------------
  const handleUpload = async (file: File) => {
    if (isUploading) return;
    if (contractId && liveStatus === "parsing") return;

    lastFileRef.current = file;
    // Reset persisted state for a new upload
    storeReset();
    storeSetFileName(file.name);
    storeSetFileSize(file.size);
    storeSetStartTime(Date.now());
    storeSetStage(1);

    setSummary(null);
    setPollError(null);
    setZoneData(null);
    setZoneError(null);
    setIsUploading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/contracts", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const code = (body as { code?: string } | null)?.code ?? undefined;
        const errMsg = (body as { error?: string } | null)?.error ?? undefined;
        storeSetError(mapUploadError(code, errMsg), code);
        return;
      }

      const body = (await res.json()) as UploadResponse;

      if (res.status === 202 && body.contractId) {
        // Async path: server accepted the file and is parsing in the background.
        storeSetContractId(body.contractId);
        storeSetLiveStatus("parsing");
        storeSetStage(stageFromStatus("parsing"));
        startPolling(body.contractId);
      } else {
        // Sync path (no Supabase configured): result is inline
        const data = body.data;
        if (data) setSummary(data);
        if (body.contractId) storeSetContractId(body.contractId);
        storeSetStage(data?.uncertainZoneCount ? 5 : 6);
        if (body.contractId && data) {
          storeSetLiveStatus(data.uncertainZoneCount ? "filtering" : "ready");
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        storeSetError("업로드 요청 시간이 초과되었습니다. 네트워크 상태를 확인하고 다시 시도해 주세요.");
      } else {
        storeSetError(e instanceof Error ? e.message : "예기치 않은 업로드 오류가 발생했습니다.");
      }
    } finally {
      clearTimeout(timeoutId);
      setIsUploading(false);
    }
  };

  // -------------------------------------------------------------------------
  // Zone confirm callback — called from inline ZoneReviewView after PUT
  // -------------------------------------------------------------------------
  const handleZoneConfirm = useCallback(() => {
    // Zone PUT이 서버에서 status를 "ready"로 전환함
    // 리스크 분석은 상세 페이지에서 사용자가 별도로 실행
    storeSetLiveStatus("ready");
    storeAdvanceStage(6); // past last stage (5)
    storeSetLastCompleted(contractId);
    setZoneData(null);
  }, [contractId, storeSetLiveStatus, storeAdvanceStage, storeSetLastCompleted]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // Before hydration, render a minimal skeleton to avoid hydration mismatch
  if (!hydrated) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">계약서 업로드</h1>
            <p className="page-subtitle">PDF/DOCX를 업로드하면 Docling 기반 파이프라인으로 조항까지 파싱합니다.</p>
          </div>
        </header>
        <main className="page-body">
          <section className="card">
            <div className="card-body">
              <FileDropzone onFileSelected={handleUpload} disabled />
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">계약서 업로드</h1>
          <p className="page-subtitle">PDF/DOCX를 업로드하면 Docling 기반 파이프라인으로 조항까지 파싱합니다.</p>
        </div>
      </header>

      <main className="page-body">
        <section className="card">
          <div className="card-body">
            {isIdle ? (
              <FileDropzone onFileSelected={handleUpload} disabled={isUploading} />
            ) : (
              <UploadProgressPanel
                fileName={fileName}
                progress={displayProgress}
                statusText={displayStatusText}
                stages={stages}
                currentStage={stage}
                isUploading={isUploading}
                error={error}
                errorCode={errorCode}
                pollError={pollError}
                contractId={contractId}
                liveStatus={liveStatus}
                summary={summary}
                startTime={startTime}
                parseProgress={parseProgress}
                fileSize={fileSize}
                onRetry={
                  (errorCode === "DOCLING_UNAVAILABLE" || errorCode === "DOCLING_PARSE_FAILED")
                    ? () => {
                        const file = lastFileRef.current;
                        storeSetError(null);
                        if (file) void handleUpload(file);
                      }
                    : undefined
                }
                onReset={() => {
                  storeReset();
                  setSummary(null);
                  setPollError(null);
                  setZoneData(null);
                  setZoneError(null);
                  stopPolling();
                }}
              />
            )}
          </div>
        </section>

        {/* Inline zone review — shown when server status is "filtering" */}
        {liveStatus === "filtering" && contractId && (
          <section
            ref={zoneReviewRef}
            className="card"
            style={{ marginTop: 16, scrollMarginTop: 24 }}
          >
            <div className="card-header" style={{ borderBottom: "2px solid var(--accent-blue)" }}>
              <h2 className="card-title">
                ⚠️ 구역 분류 확인 필요
              </h2>
              <p className="text-xs text-text-secondary" style={{ marginTop: 4 }}>
                아래 구역을 검토하고 분석에 포함할지 결정해 주세요. 확인 후 분석이 시작됩니다.
              </p>
            </div>
            <div className="card-body">
              {zoneLoading && (
                <p className="text-xs text-text-secondary">구역 데이터를 불러오는 중...</p>
              )}
              {zoneError && (
                <div className="space-y-2">
                  <p className="text-xs" style={{ color: "#f87171" }}>
                    {zoneError}
                  </p>
                  <button
                    type="button"
                    className="rounded border border-border-subtle px-2 py-1 text-xs text-text-primary hover:bg-bg-elevated"
                    onClick={() => {
                      setZoneError(null);
                      setZoneData(null);
                      // Trigger re-fetch by clearing data (useEffect will re-run)
                    }}
                  >
                    다시 시도
                  </button>
                </div>
              )}
              {zoneData && (
                <ZoneReviewView
                  contractId={contractId}
                  contractName={zoneData.contractName}
                  uncertainZones={zoneData.uncertainZones}
                  analysisTargetCount={zoneData.analysisTargetCount}
                  totalPageInfo={zoneData.pageCount != null ? `총 ${zoneData.pageCount}p` : undefined}
                  documentParts={zoneData.document_parts}
                  subDocuments={zoneData.sub_documents}
                  tocEntries={zoneData.toc_entries}
                  warnings={zoneData.warnings}
                  onConfirm={handleZoneConfirm}
                  inline
                />
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
