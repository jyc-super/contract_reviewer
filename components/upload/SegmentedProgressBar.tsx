"use client";

// ---------------------------------------------------------------------------
// SegmentedProgressBar — visually split progress bar reflecting pipeline stages
//
// Each segment's width is proportional to its weight (time-share of the total
// pipeline).  Completed segments are green, the active segment shows an
// animated blue shimmer fill, and pending segments remain grey.
// ---------------------------------------------------------------------------

export interface ProgressStage {
  /** Unique key for the stage (used as React key). */
  key: string;
  /** Human-readable label (shown on hover via title). */
  label: string;
  /** Relative weight — determines the width ratio of this segment. */
  weight: number;
}

export interface SegmentedProgressBarProps {
  /** Ordered list of pipeline stages with weights. */
  stages: ProgressStage[];
  /** 1-based index of the currently active stage.  0 = idle. */
  currentStage: number;
  /**
   * Progress within the active stage, 0–100.
   * Drives the fill width inside the active segment.
   */
  stageProgress: number;
  /** When true, the active segment turns red instead of blue. */
  isError?: boolean;
  /** When true, the active segment shows the shimmer animation. */
  isActive?: boolean;
}

export function SegmentedProgressBar({
  stages,
  currentStage,
  stageProgress,
  isError = false,
  isActive = false,
}: SegmentedProgressBarProps) {
  const totalWeight = stages.reduce((sum, s) => sum + s.weight, 0);

  return (
    <div
      className="flex w-full h-2 rounded-full overflow-hidden"
      style={{ background: "var(--bg-tertiary)" }}
      role="progressbar"
      aria-valuenow={Math.round(
        stages.reduce((acc, s, i) => {
          const stageNum = i + 1;
          if (stageNum < currentStage) return acc + (s.weight / totalWeight) * 100;
          if (stageNum === currentStage)
            return acc + (s.weight / totalWeight) * (stageProgress / 100) * 100;
          return acc;
        }, 0)
      )}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="업로드 진행률"
    >
      {stages.map((stage, i) => {
        const stageNum = i + 1;
        const widthPercent = (stage.weight / totalWeight) * 100;
        const isDone = stageNum < currentStage;
        const isActiveStage = currentStage > 0 && stageNum === currentStage;
        const isPending = stageNum > currentStage || currentStage === 0;

        // Fill percentage inside this segment
        const fillPercent = isDone ? 100 : isActiveStage ? stageProgress : 0;

        // Determine the fill color
        const fillColor = isError
          ? "var(--accent-red)"
          : isDone
            ? "var(--accent-green)"
            : "var(--accent-blue)";

        const showShimmer = isActiveStage && isActive && !isError && fillPercent > 0 && fillPercent < 100;

        return (
          <div
            key={stage.key}
            className="relative h-full"
            style={{
              width: `${widthPercent}%`,
              // Thin 1px gap between segments for visual separation
              borderRight: i < stages.length - 1 ? "1px solid var(--bg-primary)" : undefined,
            }}
            title={stage.label}
          >
            {/* Background (pending state) */}
            {isPending && (
              <div
                className="absolute inset-0"
                style={{ background: "var(--bg-tertiary)" }}
              />
            )}

            {/* Fill bar */}
            <div
              className="absolute inset-y-0 left-0"
              style={{
                width: `${fillPercent}%`,
                background: showShimmer ? undefined : fillColor,
                transition: "width 0.6s ease-out",
              }}
            >
              {/* Shimmer overlay for active segment */}
              {showShimmer && (
                <div
                  className="absolute inset-0"
                  style={{
                    background: `linear-gradient(90deg, var(--accent-blue) 0%, #7C5CFC 30%, var(--accent-blue) 60%, #7C5CFC 100%)`,
                    backgroundSize: "200% 100%",
                    animation: "shimmer-slide 2s ease-in-out infinite",
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
