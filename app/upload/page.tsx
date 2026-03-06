"use client";

import { useState, useEffect, useRef } from "react";
import { FileDropzone } from "../../components/upload/FileDropzone";
import { UploadProgress } from "../../components/upload/UploadProgress";
import { QuotaDisplayWrapper } from "../../components/dashboard/QuotaDisplayWrapper";

interface ProcessSummary {
  pages: number;
  analysisTargetCount: number;
  uncertainZoneCount: number;
  clauseCount: number;
  needsReview: boolean;
}

interface UploadResponse {
  ok: boolean;
  data?: ProcessSummary;
  contractId?: string;
  error?: string;
}

const POLL_INTERVAL_MS = 2000;
const UPLOAD_TIMEOUT_MS = 300_000;
const TERMINAL_STATUSES = ["ready", "partial", "error"];
const POLL_FAILURE_LIMIT = 3;

function stageFromStatus(status: string): number {
  switch (status) {
    case "filtering":
      return 2;
    case "parsing":
      return 3;
    case "analyzing":
      return 4;
    case "ready":
    case "partial":
    case "error":
      return 6;
    default:
      return 1;
  }
}

export default function UploadPage() {
  const [stage, setStage] = useState(1);
  const [isUploading, setIsUploading] = useState(false);
  const [summary, setSummary] = useState<ProcessSummary | null>(null);
  const [contractId, setContractId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailureCountRef = useRef(0);

  const stages = [
    "1. 파일 검증",
    "2. 텍스트 추출",
    "3. 문서 구역 분류",
    "4. 사용자 확인",
    "5. 조항 파싱",
    "6. 품질 검증",
  ];

  useEffect(() => {
    if (!contractId) return;
    setPollError(null);
    pollFailureCountRef.current = 0;
    const poll = async () => {
      try {
        const res = await fetch(`/api/contracts/${contractId}/status`);
        if (!res.ok) {
          pollFailureCountRef.current += 1;
          const body = await res.json().catch(() => null);
          const msg = body?.error ?? "상태 조회에 실패했습니다.";
          setPollError(msg);
          if (pollFailureCountRef.current >= POLL_FAILURE_LIMIT && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setPollError("저장소 연결을 확인해 주세요. 상태 조회가 반복 실패했습니다.");
          }
          return;
        }
        pollFailureCountRef.current = 0;
        setPollError(null);
        const json = await res.json();
        const s = json?.status ?? "";
        setLiveStatus(s);
        setStage((prev) => Math.max(prev, stageFromStatus(s)));
        if (TERMINAL_STATUSES.includes(s) && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        pollFailureCountRef.current += 1;
        setPollError("상태 조회에 실패했습니다.");
        if (pollFailureCountRef.current >= POLL_FAILURE_LIMIT && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setPollError("저장소 연결을 확인해 주세요. 상태 조회가 반복 실패했습니다.");
        }
      }
    };
    poll();
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [contractId]);

  const progress = (stage / stages.length) * 100;
  const statusLabel = liveStatus ? `상태: ${liveStatus}` : undefined;

  const handleUpload = async (file: File) => {
    setError(null);
    setPollError(null);
    setSummary(null);
    setContractId(null);
    setLiveStatus(null);
    setSelectedFileName(file.name);
    setIsUploading(true);
    setStage(1);

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
        const message = body?.error ?? "업로드 처리 중 오류가 발생했습니다.";
        throw new Error(message);
      }

      const body = (await res.json()) as UploadResponse;
      const data = body.data;
      if (data) setSummary(data);
      if (body.contractId) setContractId(body.contractId);
      setStage(data?.uncertainZoneCount ? 2 : 6);
      if (body.contractId && data) {
        setLiveStatus(data.uncertainZoneCount ? "filtering" : "ready");
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError("처리 시간이 5분을 초과했습니다. 파일 크기를 줄이거나 잠시 후 다시 시도해 주세요. 대용량 문서는 2~3분 이상 걸릴 수 있습니다.");
      } else {
        const message =
          e instanceof Error
            ? e.message
            : "알 수 없는 오류가 발생했습니다.";
        setError(message);
      }
    } finally {
      clearTimeout(timeoutId);
      setIsUploading(false);
      setSelectedFileName(null);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">계약서 업로드</h1>
          <p className="page-subtitle">
            PDF/DOCX 파일을 업로드하면 6단계 전처리 파이프라인을 통해 조항 단위까지 파싱합니다.
          </p>
        </div>
        <div style={{ minWidth: 260 }}>
          <QuotaDisplayWrapper />
        </div>
      </header>

      <main className="page-body">
        <section className="card">
          <div className="card-body">
            <FileDropzone onFileSelected={handleUpload} disabled={isUploading} />

            <div className="progress-steps">
              <UploadProgress
                progress={progress}
                statusText={statusLabel ?? `${stages[stage - 1]} 진행 중...`}
              />
              <div>
                {stages.map((label, index) => {
                  const active = index + 1 === stage;
                  const done = index + 1 < stage;
                  const iconClass = done ? "step-done" : active ? "step-active" : "step-waiting";
                  const barWidth =
                    index + 1 < stage ? "100%" : index + 1 === stage ? `${progress}%` : "0%";
                  return (
                    <div key={label} className="step-item">
                      <div className={`step-icon ${iconClass}`}>{index + 1}</div>
                      <div className="step-content">
                        <div className="step-title">{label}</div>
                        <div className="step-desc">
                          {index === 0 && "파일 형식/용량을 확인합니다."}
                          {index === 1 && "본문 텍스트와 표, 머리글/바닥글을 추출합니다."}
                          {index === 2 && "문서 구역을 본문/표/부록 등으로 분류합니다."}
                          {index === 3 && "신뢰도가 낮은 구역에 대해 사용자 확인을 요청합니다."}
                          {index === 4 && "확정된 구역을 기준으로 조항 단위로 파싱합니다."}
                          {index === 5 && "조항 품질을 점검하고 needs_review 플래그를 설정합니다."}
                        </div>
                        <div className="step-bar">
                          <div className="step-bar-fill" style={{ width: barWidth }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {isUploading && (
                <p className="text-xs text-text-secondary">
                  {selectedFileName
                    ? `선택된 파일: ${selectedFileName} — 처리 중입니다. 대용량 파일은 2~3분 이상 걸릴 수 있습니다. 완료될 때까지 창을 닫지 마세요.`
                    : "처리 중입니다. 대용량 파일은 2~3분 이상 걸릴 수 있습니다. 완료될 때까지 창을 닫지 마세요."}
                </p>
              )}
              {error && (
                <p className="text-xs" style={{ color: "#f87171" }}>
                  오류: {error}
                </p>
              )}
              {pollError && (
                <p className="text-xs" style={{ color: "#f87171" }}>
                  오류: {pollError}
                </p>
              )}
              {summary && (
                <div className="mt-2 space-y-1 rounded-lg border border-border-subtle bg-bg-elevated/70 p-3 text-xs text-text-secondary">
                  {!contractId && (
                    <p className="text-text-soft">
                      전처리가 완료되었습니다. 저장소가 연결되지 않아 상세 보기는 제공되지 않습니다.
                    </p>
                  )}
                  <p>페이지 수: {summary.pages}</p>
                  <p>분석 대상 구역 수: {summary.analysisTargetCount}</p>
                  <p>불확실 구역 수: {summary.uncertainZoneCount}</p>
                  <p>파싱된 조항 수: {summary.clauseCount}</p>
                  <p>추가 검토 필요: {summary.needsReview ? "예" : "아니오"}</p>
                  {contractId && (
                    <p className="mt-2 border-t border-border-subtle pt-2">
                      <a
                        href={`/contracts/${contractId}`}
                        className="text-accent-soft hover:text-accent-primary hover:underline"
                      >
                        계약 상세 보기 →
                      </a>
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

