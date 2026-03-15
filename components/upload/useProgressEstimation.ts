"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";

// ---------------------------------------------------------------------------
// useProgressEstimation — custom hook that interpolates progress and
// computes ETA from pipeline stage transitions + DB parseProgress.
// ---------------------------------------------------------------------------

/** Stage weight configuration for ETA calculation. */
export interface StageWeightConfig {
  /** 1-based stage number. */
  stage: number;
  /** Relative weight for ETA (how much of total time this stage takes). */
  weight: number;
  /** Expected duration in ms (for fake progress interpolation). */
  expectedDurationMs: number;
}

/** Output of the useProgressEstimation hook. */
export interface ProgressEstimation {
  /** 0–100 overall interpolated progress. */
  interpolatedProgress: number;
  /** Progress within the current stage, 0–100. */
  stageProgress: number;
  /** Estimated remaining time in ms. null when ETA cannot be computed. */
  etaMs: number | null;
  /** Elapsed time in ms since startTime. */
  elapsedMs: number;
  /** Per-stage "effective" progress: completed weight / total weight. */
  effectiveProgress: number;
}

/** Configuration for the hook. */
export interface UseProgressEstimationOptions {
  /** 1-based current pipeline stage. 0 = idle. */
  currentStage: number;
  /** DB-backed parse progress (0–100) for stage 2, or null. */
  parseProgress: number | null;
  /** Timestamp (ms) when the upload started. null = not started. */
  startTime: number | null;
  /** Number of stages (default 6). */
  stageCount: number;
  /** Whether the pipeline is in a terminal state (done/error). */
  isTerminal: boolean;
  /** Custom stage weight configs (optional — sensible defaults provided). */
  stageWeights?: StageWeightConfig[];
  /** File size in bytes — used to dynamically estimate Docling parse duration. */
  fileSizeBytes?: number | null;
}

// ---------------------------------------------------------------------------
// Dynamic duration estimation based on file size
// ---------------------------------------------------------------------------

/**
 * Docling 파싱 예상 시간을 파일 크기 기반으로 동적 계산.
 * 경험적 추정: 기본 30초 + MB당 12초. 최소 30초, 최대 600초.
 */
function estimateDoclingDuration(fileSizeBytes: number | null | undefined): number {
  if (!fileSizeBytes || fileSizeBytes <= 0) return 180_000; // 기본 3분
  const sizeMB = fileSizeBytes / (1024 * 1024);
  return Math.max(30_000, Math.min(600_000, 30_000 + sizeMB * 12_000));
}

function buildStageWeights(fileSizeBytes: number | null | undefined): StageWeightConfig[] {
  const doclingMs = estimateDoclingDuration(fileSizeBytes);
  return [
    { stage: 1, weight: 0.01, expectedDurationMs: 5_000 },
    { stage: 2, weight: 0.93, expectedDurationMs: doclingMs },
    { stage: 3, weight: 0.05, expectedDurationMs: 30_000 },
    { stage: 4, weight: 0.01, expectedDurationMs: 20_000 },
    { stage: 5, weight: 0.00, expectedDurationMs: 60_000 },
  ];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum fake progress within a stage (real completion jumps to 100%). */
const FAKE_MAX_PERCENT = 85;
/** Interval for fake progress ticks (ms). */
const FAKE_TICK_MS = 800;
/** ETA smoothing factor — lower = adapts faster to new data. */
const ETA_SMOOTHING = 0.3;
/** Minimum elapsed time (ms) before ETA is shown. */
const ETA_MIN_ELAPSED_MS = 8_000;

/**
 * Eased interpolation: fast start, gradually slowing.
 * Returns 0..FAKE_MAX_PERCENT based on elapsed / expected ratio.
 * When elapsed exceeds expected, slowly creeps from 85% toward 95%.
 */
function easedFakeProgress(elapsedMs: number, expectedMs: number): number {
  const t = elapsedMs / expectedMs;
  if (t <= 1) {
    const eased = 1 - (1 - t) * (1 - t) * (1 - t);
    return Math.round(eased * FAKE_MAX_PERCENT);
  }
  // Over-time: slowly creep from 85% toward 99% over 2× expected duration
  const overRatio = Math.min((t - 1) / 2, 1);
  const overEased = 1 - (1 - overRatio) * (1 - overRatio);
  return Math.round(FAKE_MAX_PERCENT + overEased * 14);
}

export function useProgressEstimation({
  currentStage,
  parseProgress,
  startTime,
  stageCount,
  isTerminal,
  stageWeights: customWeights,
  fileSizeBytes,
}: UseProgressEstimationOptions): ProgressEstimation {
  const weights = useMemo(
    () => customWeights ?? buildStageWeights(fileSizeBytes),
    [customWeights, fileSizeBytes]
  );
  const totalWeight = useMemo(
    () => weights.reduce((sum, w) => sum + w.weight, 0),
    [weights]
  );

  // Track when we enter each new stage for fake progress
  const stageEnteredAtRef = useRef<number>(0);
  const prevStageRef = useRef<number>(currentStage);

  useEffect(() => {
    if (stageEnteredAtRef.current === 0 || currentStage !== prevStageRef.current) {
      stageEnteredAtRef.current = Date.now();
      prevStageRef.current = currentStage;
    }
  }, [currentStage]);

  // ---------------------------------------------------------------------------
  // Elapsed time counter
  // ---------------------------------------------------------------------------
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!startTime || isTerminal) return;
    setElapsedMs(Date.now() - startTime);
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startTime);
    }, 1000);
    return () => clearInterval(id);
  }, [startTime, isTerminal]);

  // ---------------------------------------------------------------------------
  // Fake progress interpolation per stage
  // ---------------------------------------------------------------------------
  const [fakeStageProgress, setFakeStageProgress] = useState(0);

  useEffect(() => {
    if (isTerminal || currentStage === 0) {
      setFakeStageProgress(0);
      return;
    }
    const config = weights.find((w) => w.stage === currentStage);
    const expectedMs = config?.expectedDurationMs ?? 30_000;
    const tick = () => {
      const elapsed = Date.now() - stageEnteredAtRef.current;
      setFakeStageProgress(easedFakeProgress(elapsed, expectedMs));
    };
    tick();
    const id = setInterval(tick, FAKE_TICK_MS);
    return () => clearInterval(id);
  }, [currentStage, isTerminal, weights]);

  // ---------------------------------------------------------------------------
  // Stage progress: real DB value for stage 2, fake for others
  // ---------------------------------------------------------------------------
  const stageProgress = useMemo(() => {
    if (isTerminal) return 100;
    if (currentStage === 0) return 0;
    // Stage 2 with real DB parseProgress: use it directly
    if (currentStage === 2 && typeof parseProgress === "number") {
      return Math.min(100, Math.max(0, parseProgress));
    }
    return fakeStageProgress;
  }, [currentStage, parseProgress, fakeStageProgress, isTerminal]);

  // ---------------------------------------------------------------------------
  // Overall interpolated progress (0–100)
  // ---------------------------------------------------------------------------
  const interpolatedProgress = useMemo(() => {
    if (isTerminal) return 100;
    if (currentStage === 0) return 0;

    let completed = 0;
    for (const w of weights) {
      if (w.stage < currentStage) {
        completed += w.weight;
      } else if (w.stage === currentStage) {
        completed += w.weight * (stageProgress / 100);
      }
    }

    const pct = totalWeight > 0 ? (completed / totalWeight) * 100 : 0;
    return Math.round(pct * 10) / 10;
  }, [currentStage, stageProgress, weights, totalWeight, isTerminal]);

  // Effective progress (same as interpolated but as a ratio)
  const effectiveProgress = interpolatedProgress / 100;

  // ---------------------------------------------------------------------------
  // ETA calculation — stage-aware with smoothing reset on stage transitions
  // ---------------------------------------------------------------------------
  const smoothedEtaRef = useRef<number | null>(null);
  const prevStageForEtaRef = useRef<number>(currentStage);

  const computeEta = useCallback((): number | null => {
    // Stage 5 = user confirmation — no ETA
    if (currentStage === 5) return null;
    // Not enough elapsed time for a meaningful estimate
    if (elapsedMs < ETA_MIN_ELAPSED_MS) return null;
    // No progress yet
    if (effectiveProgress <= 0) return null;
    // Terminal
    if (isTerminal) return 0;

    // Stage-aware ETA: current stage remaining + future stages
    const currentConfig = weights.find((w) => w.stage === currentStage);
    const currentExpectedMs = currentConfig?.expectedDurationMs ?? 30_000;
    const stageElapsed = Date.now() - stageEnteredAtRef.current;

    // Current stage remaining: use actual elapsed vs expected
    const stageRatio = Math.min(stageProgress / 100, 0.99);
    let stageRemainingMs: number;
    if (stageRatio > 0.05 && stageElapsed > 3_000) {
      // Have enough data to extrapolate from actual speed
      stageRemainingMs = (stageElapsed / stageRatio) * (1 - stageRatio);
    } else {
      // Not enough data, use expected duration
      stageRemainingMs = currentExpectedMs * (1 - stageRatio);
    }

    // Future stages: sum their expected durations (skip stage 5 user confirmation)
    const futureStagesMs = weights
      .filter((w) => w.stage > currentStage && w.stage !== 5)
      .reduce((sum, w) => sum + w.expectedDurationMs, 0);

    const rawEta = stageRemainingMs + futureStagesMs;

    // Reset smoothing on stage transitions for faster adaptation
    if (currentStage !== prevStageForEtaRef.current) {
      smoothedEtaRef.current = null;
      prevStageForEtaRef.current = currentStage;
    }

    // Apply exponential smoothing
    if (smoothedEtaRef.current === null) {
      smoothedEtaRef.current = rawEta;
    } else {
      smoothedEtaRef.current =
        ETA_SMOOTHING * smoothedEtaRef.current + (1 - ETA_SMOOTHING) * rawEta;
    }

    return Math.max(0, Math.round(smoothedEtaRef.current));
  }, [currentStage, elapsedMs, effectiveProgress, isTerminal, stageProgress, weights]);

  const [etaMs, setEtaMs] = useState<number | null>(null);

  useEffect(() => {
    if (isTerminal || currentStage === 0) {
      setEtaMs(null);
      smoothedEtaRef.current = null;
      return;
    }
    setEtaMs(computeEta());
    const id = setInterval(() => {
      setEtaMs(computeEta());
    }, 2000);
    return () => clearInterval(id);
  }, [computeEta, isTerminal, currentStage]);

  return {
    interpolatedProgress,
    stageProgress,
    etaMs,
    elapsedMs,
    effectiveProgress,
  };
}
