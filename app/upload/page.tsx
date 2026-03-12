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
  // Async 202 path: contractId + status="parsing", no data yet
  status?: string;
  // Sync path (no Supabase): full data inline
  data?: ProcessSummary;
  contractId?: string;
  error?: string;
  code?: string;
  message?: string;
}

const POLL_INTERVAL_MS = 3000;
// With the async 202 flow the server responds within seconds (just a DB insert).
// 30s is generous for the initial POST round-trip including file upload.
const UPLOAD_TIMEOUT_MS = 30_000;
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

function mapUploadError(code?: string, fallbackMessage?: string): string {
  if (code === "DOCLING_UNAVAILABLE") {
    return "Docling sidecar is not ready. Run scripts/start_sidecar.bat and retry.";
  }
  if (code === "DOCLING_PARSE_FAILED") {
    return "Docling failed to parse this file. Check sidecar logs and retry.";
  }
  if (code === "SUPABASE_INSERT_FAILED" || code === "SUPABASE_UNREACHABLE") {
    return "Supabase에 연결할 수 없습니다. 설정 페이지에서 URL과 키를 확인하세요.";
  }
  if (code === "SUPABASE_SCHEMA_MISSING") {
    return "Supabase 스키마가 초기화되지 않았습니다. 마이그레이션(001~003)을 실행해 주세요.";
  }
  return fallbackMessage ?? "Upload processing failed.";
}

export default function UploadPage() {
  const [stage, setStage] = useState(1);
  const [isUploading, setIsUploading] = useState(false);
  const [summary, setSummary] = useState<ProcessSummary | null>(null);
  const [contractId, setContractId] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailureCountRef = useRef(0);
  const lastFileRef = useRef<File | null>(null);

  const stages = [
    "1. File validation",
    "2. Docling parse",
    "3. Zone classification",
    "4. User confirmation",
    "5. Clause extraction",
    "6. Quality check",
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
          const msg = body?.error ?? "Status request failed.";
          setPollError(msg);
          if (pollFailureCountRef.current >= POLL_FAILURE_LIMIT && pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setPollError("Status polling failed repeatedly. Check server logs.");
          }
          return;
        }

        pollFailureCountRef.current = 0;
        setPollError(null);
        const json = await res.json();
        const s = json?.status ?? "";
        setLiveStatus(s);
        setStage((prev) => Math.max(prev, stageFromStatus(s)));
        if (json?.done === true && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        pollFailureCountRef.current += 1;
        setPollError("Status request failed.");
        if (pollFailureCountRef.current >= POLL_FAILURE_LIMIT && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setPollError("Status polling failed repeatedly. Check network/server.");
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
  const statusLabel = liveStatus ? `Status: ${liveStatus}` : undefined;
  const isIdle = !isUploading && !contractId && !summary && !error;
  const displayProgress = isIdle ? 0 : progress;
  const displayStatusText = isIdle
    ? "Drop a file or click to choose PDF/DOCX"
    : error
      ? error
      : liveStatus === "filtering"
        ? "Zone confirmation is required. Open zone review below."
        : statusLabel ?? `${stages[stage - 1]} in progress...`;

  const handleUpload = async (file: File) => {
    lastFileRef.current = file;
    setError(null);
    setErrorCode(null);
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
        setErrorCode(body?.code ?? null);
        throw new Error(mapUploadError(body?.code, body?.error));
      }

      const body = (await res.json()) as UploadResponse;

      if (res.status === 202 && body.contractId) {
        // Async path: server accepted the file and is parsing in the background.
        // Start polling — the useEffect on contractId will handle it.
        setContractId(body.contractId);
        setLiveStatus("parsing");
        setStage(stageFromStatus("parsing"));
        // isUploading stays false from the finally block below; polling UI takes over
      } else {
        // Sync path (no Supabase configured): result is inline
        const data = body.data;
        if (data) setSummary(data);
        if (body.contractId) setContractId(body.contractId);
        setStage(data?.uncertainZoneCount ? 2 : 6);
        if (body.contractId && data) {
          setLiveStatus(data.uncertainZoneCount ? "filtering" : "ready");
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setError("Upload request timed out. Check your network and retry.");
      } else {
        setError(e instanceof Error ? e.message : "Unexpected upload error.");
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
          <p className="page-subtitle">PDF/DOCX를 업로드하면 Docling 기반 파이프라인으로 조항까지 파싱합니다.</p>
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
              <UploadProgress progress={displayProgress} statusText={displayStatusText} />
              <div>
                {stages.map((label, index) => {
                  const active = !isIdle && index + 1 === stage;
                  const done = index + 1 < stage;
                  const iconClass = done ? "step-done" : active ? "step-active" : "step-waiting";
                  const barWidth =
                    isIdle ? "0%" : index + 1 < stage ? "100%" : index + 1 === stage ? `${progress}%` : "0%";
                  return (
                    <div key={label} className="step-item">
                      <div className={`step-icon ${iconClass}`}>{index + 1}</div>
                      <div className="step-content">
                        <div className="step-title">{label}</div>
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
                    ? `선택 파일: ${selectedFileName} - 처리 중입니다.`
                    : "처리 중입니다."}
                </p>
              )}

              {error && (
                <div className="space-y-2">
                  <p className="text-xs" style={{ color: "#f87171" }}>
                    오류: {error}
                  </p>
                  {errorCode && (
                    <p className="text-xs text-text-secondary">Error code: {errorCode}</p>
                  )}
                  {(errorCode === "DOCLING_UNAVAILABLE" || errorCode === "DOCLING_PARSE_FAILED") && (
                    <div className="text-xs text-text-secondary">
                      <p>가이드: `scripts/start_sidecar.bat` 실행 후, sidecar 준비 완료 상태에서 다시 업로드하세요.</p>
                      <button
                        type="button"
                        className="mt-2 rounded border border-border-subtle px-2 py-1 text-text-primary hover:bg-bg-elevated"
                        onClick={() => {
                          const file = lastFileRef.current;
                          setError(null);
                          setErrorCode(null);
                          if (file) handleUpload(file);
                        }}
                      >
                        다시 시도
                      </button>
                    </div>
                  )}
                </div>
              )}

              {pollError && (
                <p className="text-xs" style={{ color: "#f87171" }}>
                  오류: {pollError}
                </p>
              )}

              {summary && (
                <div className="mt-2 space-y-1 rounded-lg border border-border-subtle bg-bg-elevated/70 p-3 text-xs text-text-secondary">
                  {!contractId && (
                    <p className="text-text-soft">상세 페이지 링크를 만들 수 없어 요약만 표시됩니다.</p>
                  )}
                  <p>페이지 수: {summary.pages}</p>
                  <p>분석 대상 구역: {summary.analysisTargetCount}</p>
                  <p>불확실 구역: {summary.uncertainZoneCount}</p>
                  <p>추출 조항: {summary.clauseCount}</p>
                  <p>추가 검토 필요: {summary.needsReview ? "예" : "아니오"}</p>
                  {contractId && (
                    <p className="mt-2 border-t border-border-subtle pt-2">
                      {liveStatus === "filtering" ? (
                        <a
                          href={`/contracts/${contractId}/zones`}
                          className="text-accent-soft hover:text-accent-primary hover:underline"
                        >
                          구역 분류 확인으로 이동
                        </a>
                      ) : (
                        <a
                          href={`/contracts/${contractId}`}
                          className="text-accent-soft hover:text-accent-primary hover:underline"
                        >
                          계약 상세 보기
                        </a>
                      )}
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
