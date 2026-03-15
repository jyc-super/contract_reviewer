"use client";

// ---------------------------------------------------------------------------
// EtaDisplay — shows elapsed time, ETA, and percentage in a compact row.
// ---------------------------------------------------------------------------

interface EtaDisplayProps {
  /** Elapsed time in ms since upload started. */
  elapsedMs: number;
  /** Estimated remaining time in ms. null = cannot compute. */
  etaMs: number | null;
  /** Overall progress percentage 0–100. */
  progress: number;
  /** 1-based current stage. */
  currentStage: number;
  /** Whether the pipeline finished (success or error). */
  isTerminal: boolean;
  /** Whether there is an error. */
  isError: boolean;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function formatEta(etaMs: number | null, elapsedMs: number, currentStage: number): string {
  // Stage 5 = user confirmation waiting
  if (currentStage === 5) return "검토 대기 중";
  // Not enough data yet
  if (etaMs === null || elapsedMs < 8_000) return "계산 중...";
  // Under 30 seconds
  if (etaMs < 30_000) return "곧 완료";
  // Under 60 seconds: round to nearest 10s
  if (etaMs < 60_000) return `약 ${Math.ceil(etaMs / 10_000) * 10}초`;
  // 5 minutes or more: show only minutes
  if (etaMs >= 300_000) return `약 ${Math.round(etaMs / 60_000)}분`;
  // Format as m:ss
  return `약 ${formatDuration(etaMs)}`;
}

export function EtaDisplay({
  elapsedMs,
  etaMs,
  progress,
  currentStage,
  isTerminal,
  isError,
}: EtaDisplayProps) {
  const etaText = formatEta(etaMs, elapsedMs, currentStage);
  const isWaiting = currentStage === 5;

  return (
    <div className="flex items-center justify-between text-xs tabular-nums">
      {/* Left: elapsed time */}
      <div className="flex items-center gap-2">
        <span
          className="font-mono"
          style={{
            color: isError
              ? "var(--accent-red)"
              : isTerminal
                ? "var(--accent-green)"
                : "var(--text-muted)",
          }}
        >
          {isTerminal ? "총 소요" : "경과"} {formatDuration(elapsedMs)}
        </span>
      </div>

      {/* Center: ETA */}
      {!isTerminal && (
        <span
          className="font-mono"
          style={{
            color: isWaiting
              ? "var(--accent-yellow)"
              : isError
                ? "var(--accent-red)"
                : "var(--text-secondary)",
          }}
        >
          {isError ? "오류 발생" : etaText}
        </span>
      )}

      {/* Right: percentage */}
      <span
        className="font-mono font-medium"
        style={{
          color: isError
            ? "var(--accent-red)"
            : isTerminal
              ? "var(--accent-green)"
              : "var(--accent-blue)",
          minWidth: "36px",
          textAlign: "right",
        }}
      >
        {Math.round(progress)}%
      </span>
    </div>
  );
}
