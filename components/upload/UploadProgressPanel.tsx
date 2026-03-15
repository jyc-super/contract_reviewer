"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { SegmentedProgressBar, type ProgressStage } from "./SegmentedProgressBar";
import { EtaDisplay } from "./EtaDisplay";
import { useProgressEstimation } from "./useProgressEstimation";

interface ProcessSummary {
  pages: number;
  analysisTargetCount: number;
  uncertainZoneCount: number;
  clauseCount: number;
  needsReview: boolean;
  /** Document number extracted from footer patterns (document_number type). */
  documentNumber?: string;
  /** Total removed header + footer block count from the parsing pipeline. */
  removedHeaderFooterCount?: number;
  /** Total page count as reported by header/footer analysis. */
  headerFooterTotalPages?: number;
}

interface UploadProgressPanelProps {
  fileName: string | null;
  progress: number;
  statusText: string;
  stages: string[];
  currentStage: number;
  isUploading: boolean;
  error: string | null;
  errorCode: string | null;
  pollError: string | null;
  contractId: string | null;
  liveStatus: string | null;
  summary: ProcessSummary | null;
  /** Timestamp (ms) when upload started -- used for elapsed time display. */
  startTime: number | null;
  /**
   * Granular parse progress (0-100) from the DB during status=parsing.
   * When provided for stage 2, replaces the fake interpolated progress for
   * both the per-stage bar and the main progress bar so the UI reflects real
   * backend state rather than a time-based estimate.
   */
  parseProgress?: number | null;
  /** File size in bytes — passed to useProgressEstimation for dynamic ETA. */
  fileSize?: number | null;
  onRetry?: () => void;
  onReset: () => void;
}

// ---------------------------------------------------------------------------
// Pipeline stage definitions for the segmented progress bar
// ---------------------------------------------------------------------------
const PIPELINE_STAGES: ProgressStage[] = [
  { key: "validate", label: "파일 검증", weight: 0.01 },
  { key: "docling", label: "Docling 파싱", weight: 0.93 },
  { key: "quality", label: "품질 검사", weight: 0.05 },
  { key: "zone", label: "Zone 분류", weight: 0.01 },
  { key: "confirm", label: "사용자 확인", weight: 0.00 },
];

// ---------------------------------------------------------------------------
// Cycling sub-messages per stage (shown during long waits)
// ---------------------------------------------------------------------------
const STAGE_MESSAGES: Record<number, string[]> = {
  1: ["파일 유효성 검사 중...", "파일 형식 확인 중...", "파일 크기 확인 중..."],
  2: [
    "Docling 모델 초기화 중...",
    "문서 구조 분석 중...",
    "텍스트 추출 중...",
    "레이아웃 인식 중...",
    "페이지별 파싱 중...",
    "테이블/이미지 영역 감지 중...",
  ],
  3: [
    "품질 검사 실행 중...",
    "파싱 결과 검증 중...",
    "조항 수 / 길이 유효성 확인 중...",
  ],
  4: [
    "구역 분류 모델 실행 중...",
    "본문 / 부속 구분 중...",
    "헤더/푸터 필터링 중...",
  ],
  5: ["사용자 확인 대기 중..."],
};

const MESSAGE_CYCLE_INTERVAL_MS = 4000;

// ---------------------------------------------------------------------------
// Stage pill icon component
// ---------------------------------------------------------------------------
function StagePill({
  stageNum,
  isDone,
  isActive,
  isWaiting,
  label,
}: {
  stageNum: number;
  isDone: boolean;
  isActive: boolean;
  isWaiting: boolean;
  label: string;
}) {
  return (
    <div
      className="flex items-center gap-1.5"
      title={label}
    >
      {/* Circle indicator */}
      <div
        className="flex items-center justify-center rounded-full text-[10px] font-bold leading-none"
        style={{
          width: 18,
          height: 18,
          ...(isDone
            ? { background: "var(--accent-green-dim)", color: "var(--accent-green)" }
            : isActive
              ? { background: "var(--accent-blue)", color: "white" }
              : { background: "var(--bg-tertiary)", color: "var(--text-muted)" }),
          transition: "all 0.3s ease",
        }}
      >
        {isDone ? "\u2713" : stageNum}
      </div>
      {/* Label — only show on md+ to save space */}
      <span
        className="hidden md:inline text-[11px]"
        style={{
          color: isDone
            ? "var(--accent-green)"
            : isActive
              ? "var(--text-primary)"
              : "var(--text-muted)",
          fontWeight: isActive ? 500 : 400,
          transition: "color 0.3s ease",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function UploadProgressPanel({
  fileName,
  progress,
  statusText,
  stages,
  currentStage,
  isUploading,
  error,
  errorCode,
  pollError,
  contractId,
  liveStatus,
  summary,
  startTime,
  parseProgress,
  fileSize,
  onRetry,
  onReset,
}: UploadProgressPanelProps) {
  const isTerminal =
    liveStatus === "ready" ||
    liveStatus === "partial" ||
    liveStatus === "error" ||
    !!error;
  const isSuccess = liveStatus === "ready" || liveStatus === "partial";
  const isActive = !isTerminal && (isUploading || !!liveStatus);

  // -------------------------------------------------------------------------
  // Progress estimation hook
  // -------------------------------------------------------------------------
  const {
    interpolatedProgress,
    stageProgress,
    etaMs,
    elapsedMs,
  } = useProgressEstimation({
    currentStage,
    parseProgress: parseProgress ?? null,
    startTime,
    stageCount: stages.length,
    isTerminal,
    fileSizeBytes: fileSize,
  });

  // Use hook's interpolated progress when active, parent progress when terminal
  const displayProgress = isTerminal ? progress : interpolatedProgress;

  // -------------------------------------------------------------------------
  // Cycling sub-messages
  // -------------------------------------------------------------------------
  const [messageIndex, setMessageIndex] = useState(0);

  useEffect(() => {
    setMessageIndex(0);
    if (isTerminal || currentStage === 0) return;
    const msgs = STAGE_MESSAGES[currentStage];
    if (!msgs || msgs.length <= 1) return;
    const id = setInterval(() => {
      setMessageIndex((prev) => (prev + 1) % msgs.length);
    }, MESSAGE_CYCLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [currentStage, isTerminal]);

  const cyclingMessage = useMemo(() => {
    if (isTerminal) return undefined;
    const msgs = STAGE_MESSAGES[currentStage];
    if (!msgs || msgs.length === 0) return undefined;
    return msgs[messageIndex % msgs.length];
  }, [currentStage, messageIndex, isTerminal]);

  // Status badge
  const statusBadge = (() => {
    if (error || liveStatus === "error") {
      return { label: "오류", className: "badge-error" };
    }
    if (isSuccess) {
      return { label: "완료", className: "badge-done" };
    }
    if (
      isUploading ||
      liveStatus === "parsing" ||
      liveStatus === "quality_checking"
    ) {
      return { label: "처리중", className: "badge-analyzing" };
    }
    if (liveStatus === "filtering") {
      return { label: "확인 필요", className: "badge-analyzing" };
    }
    return { label: "대기", className: "badge-status" };
  })();

  const showRetry =
    onRetry &&
    (errorCode === "DOCLING_UNAVAILABLE" || errorCode === "DOCLING_PARSE_FAILED");

  const showNewUploadButton = isTerminal && !isUploading;
  const isWaitingStage = currentStage === 5 && !isTerminal;

  return (
    <div className="animate-in" style={{ minHeight: 200 }}>
      {/* File header with status badge */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: "16px 20px",
          background: "var(--bg-tertiary)",
          borderRadius: "var(--radius-lg) var(--radius-lg) 0 0",
          border: "1px solid var(--border)",
          borderBottom: "none",
        }}
      >
        <div className="flex items-center gap-3">
          <span className="text-xl" aria-hidden="true">
            {error || liveStatus === "error" ? "\u274C" : isSuccess ? "\u2705" : "\uD83D\uDCC4"}
          </span>
          <div>
            <p className="text-sm font-medium text-text-primary">
              {fileName ?? "파일 처리 중"}
            </p>
            <p className="text-xs text-text-muted">
              {isUploading
                ? "서버로 전송 중..."
                : isSuccess
                  ? "처리가 완료되었습니다"
                  : error
                    ? "처리 중 오류가 발생했습니다"
                    : "파이프라인 처리 중..."}
            </p>
          </div>
        </div>
        <span className={`badge-status ${statusBadge.className}`}>
          {statusBadge.label}
        </span>
      </div>

      {/* Progress section */}
      <div
        style={{
          padding: "20px",
          border: "1px solid var(--border)",
          borderBottom: "none",
          background: "var(--bg-card)",
        }}
      >
        {/* ETA + elapsed + percentage row */}
        <div className="mb-3">
          <EtaDisplay
            elapsedMs={elapsedMs}
            etaMs={etaMs}
            progress={displayProgress}
            currentStage={currentStage}
            isTerminal={isTerminal}
            isError={!!error || liveStatus === "error"}
          />
        </div>

        {/* Segmented progress bar */}
        <SegmentedProgressBar
          stages={PIPELINE_STAGES}
          currentStage={currentStage}
          stageProgress={stageProgress}
          isError={!!error || liveStatus === "error"}
          isActive={isActive}
        />

        {/* Stage pills row */}
        <div className="flex items-center justify-between mt-3 gap-1">
          {stages.map((label, index) => {
            const stageNum = index + 1;
            const isDone = stageNum < currentStage;
            const isActiveStage = currentStage > 0 && stageNum === currentStage;
            return (
              <StagePill
                key={label}
                stageNum={stageNum}
                isDone={isDone}
                isActive={isActiveStage}
                isWaiting={!isDone && !isActiveStage}
                label={label.replace(/^\d+\.\s*/, "")}
              />
            );
          })}
        </div>

        {/* Active stage cycling sub-message */}
        {cyclingMessage && isActive && (
          <div
            className="mt-3 text-xs transition-opacity duration-300 ease-in-out"
            style={{
              color: isWaitingStage ? "var(--accent-yellow)" : "var(--accent-blue)",
            }}
          >
            {cyclingMessage}
          </div>
        )}

        {/* Stage 5 amber warning banner */}
        {isWaitingStage && (
          <div
            className="mt-3 px-3 py-2 rounded-md text-xs"
            style={{
              background: "var(--accent-yellow-dim)",
              color: "var(--accent-yellow)",
              border: "1px solid rgba(251,191,36,0.25)",
            }}
          >
            아래에서 불확실 구역을 검토해 주세요. 확인 후 분석이 시작됩니다.
          </div>
        )}
      </div>

      {/* Bottom section: errors, summary, actions */}
      <div
        style={{
          padding: "12px 20px 20px",
          border: "1px solid var(--border)",
          borderTop: "none",
          borderRadius: "0 0 var(--radius-lg) var(--radius-lg)",
          background: "var(--bg-card)",
        }}
      >
        {/* Uploading indicator */}
        {isUploading && (
          <p className="text-xs mt-1 text-text-secondary">
            {fileName
              ? `선택 파일: ${fileName} - 처리 중입니다.`
              : "처리 중입니다."}
          </p>
        )}

        {/* Error area */}
        {error && (
          <div className="mt-2 space-y-2">
            <p className="text-xs text-accent-red">
              오류: {error}
            </p>
            {errorCode && (
              <p className="text-xs text-text-secondary">
                Error code: {errorCode}
              </p>
            )}
            {showRetry && (
              <div className="text-xs text-text-secondary">
                <p>
                  가이드: 문서 파서가 아직 준비되지 않았습니다. 잠시 후 다시 시도하거나,
                  관리자에게 문의해 주세요.
                </p>
                <button
                  type="button"
                  className="btn btn-outline mt-2 text-xs"
                  onClick={onRetry}
                >
                  다시 시도
                </button>
              </div>
            )}
          </div>
        )}

        {/* Poll error */}
        {pollError && (
          <p className="text-xs text-accent-red mt-2">
            오류: {pollError}
          </p>
        )}

        {/* Async complete: link to contract detail + contracts list */}
        {!summary &&
          contractId &&
          liveStatus &&
          liveStatus !== "parsing" &&
          liveStatus !== "quality_checking" &&
          liveStatus !== "uploading" &&
          liveStatus !== "error" &&
          liveStatus !== "filtering" && (
            <div
              className="mt-3 px-4 py-3 bg-bg-tertiary rounded-lg text-xs"
              style={{
                border: "1px solid var(--border)",
              }}
            >
              <p className="text-text-secondary">
                파싱이 완료되었습니다.{" "}
                <Link
                  href={`/contracts/${contractId}`}
                  className="text-accent-blue font-medium"
                >
                  계약 상세 보기 →
                </Link>
              </p>
              <p className="text-text-muted mt-1">
                리스크 분석은 계약 상세 페이지에서 실행할 수 있습니다.
              </p>
              {(liveStatus === "ready" || liveStatus === "partial") && (
                <p className="text-text-muted mt-1.5">
                  <Link
                    href="/contracts"
                    className="text-text-secondary hover:text-accent-blue transition-colors"
                  >
                    계약 목록으로 돌아가기
                  </Link>
                </p>
              )}
            </div>
          )}

        {/* Sync path: summary inline */}
        {summary && (
          <div
            className="mt-3 px-4 py-3 bg-bg-tertiary rounded-lg space-y-1 text-xs"
            style={{
              border: "1px solid var(--border)",
            }}
          >
            {!contractId && (
              <p className="text-text-muted">
                상세 페이지 링크를 만들 수 없어 요약만 표시됩니다.
              </p>
            )}
            <p className="text-text-secondary">
              페이지 수: {summary.pages}
            </p>
            <p className="text-text-secondary">
              분석 대상 구역: {summary.analysisTargetCount}
            </p>
            <p className="text-text-secondary">
              불확실 구역: {summary.uncertainZoneCount}
            </p>
            <p className="text-text-secondary">
              추출 조항: {summary.clauseCount}
            </p>
            <p className="text-text-secondary">
              추가 검토 필요: {summary.needsReview ? "예" : "아니오"}
            </p>
            {summary.removedHeaderFooterCount !== undefined && (
              <p className="text-text-secondary">
                헤더/푸터 제거: {summary.removedHeaderFooterCount}건
              </p>
            )}
            {summary.documentNumber !== undefined && (
              <p className="text-text-secondary">
                문서 번호: {summary.documentNumber}
              </p>
            )}
            {contractId && liveStatus !== "filtering" && (
              <p
                className="mt-2 pt-2 flex items-center gap-3"
                style={{
                  borderTop: "1px solid var(--border)",
                }}
              >
                <Link
                  href={`/contracts/${contractId}`}
                  className="text-accent-blue"
                >
                  계약 상세 보기
                </Link>
                <Link
                  href="/contracts"
                  className="text-text-secondary hover:text-accent-blue transition-colors"
                >
                  계약 목록
                </Link>
              </p>
            )}
          </div>
        )}

        {/* New upload button -- shown in terminal states */}
        {showNewUploadButton && (
          <div className="mt-4 text-center">
            <button
              type="button"
              className="btn btn-outline text-[13px]"
              onClick={onReset}
            >
              새 파일 업로드
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
