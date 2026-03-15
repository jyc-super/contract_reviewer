"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const GEMINI_KEY_INVALID_EVENT = "gemini-key-invalid";

export interface GeminiKeySetupProps {
  initialShowFromInvalid?: boolean;
}

type SetupStep = 1 | 2 | 3;

export function GeminiKeySetup({ initialShowFromInvalid }: GeminiKeySetupProps) {
  const [geminiConfigured, setGeminiConfigured] = useState<boolean | null>(null);
  const [supabaseConfigured, setSupabaseConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  // Step 1: Gemini
  const [apiKey, setApiKey] = useState("");
  const [geminiError, setGeminiError] = useState("");
  const [geminiSaving, setGeminiSaving] = useState(false);

  // Step 2: Supabase
  const [supabaseUrl, setSupabaseUrl] = useState("");
  const [supabaseKey, setSupabaseKey] = useState("");
  const [supabaseError, setSupabaseError] = useState("");
  const [supabaseSaving, setSupabaseSaving] = useState(false);

  // Navigation
  const [currentStep, setCurrentStep] = useState<SetupStep>(1);
  const [forceShowFromInvalid, setForceShowFromInvalid] = useState(!!initialShowFromInvalid);

  useEffect(() => {
    // BUG-07: AbortController 추가 — 언마운트 후 setState 호출 방지
    const controller = new AbortController();

    Promise.all([
      fetch("/api/settings/gemini-key", { signal: controller.signal })
        .then((r) => r.json())
        .catch((e: unknown) => {
          if (e instanceof Error && e.name === "AbortError") throw e;
          return { configured: false };
        }),
      fetch("/api/settings/status", { signal: controller.signal })
        .then((r) => r.json())
        .catch((e: unknown) => {
          if (e instanceof Error && e.name === "AbortError") throw e;
          return { supabaseConfigured: false };
        }),
    ]).then(([geminiData, statusData]) => {
      const gConfigured = !!geminiData?.configured;
      const sConfigured = !!statusData?.supabaseConfigured;
      setGeminiConfigured(gConfigured);
      setSupabaseConfigured(sConfigured);

      // Determine which step to show
      if (!gConfigured) {
        setCurrentStep(1);
      } else if (!sConfigured) {
        setCurrentStep(2);
      } else {
        setCurrentStep(3);
      }
      setLoading(false);
    }).catch((e: unknown) => {
      // AbortError는 정상 종료이므로 무시
      if (e instanceof Error && e.name !== "AbortError") {
        setLoading(false);
      }
    });

    const onInvalid = () => setForceShowFromInvalid(true);
    window.addEventListener(GEMINI_KEY_INVALID_EVENT, onInvalid);
    return () => {
      controller.abort();
      window.removeEventListener(GEMINI_KEY_INVALID_EVENT, onInvalid);
    };
  }, []);

  const handleGeminiSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeminiError("");
    if (!apiKey.trim()) {
      setGeminiError("API 키를 입력해 주세요.");
      return;
    }
    setGeminiSaving(true);
    try {
      const res = await fetch("/api/settings/gemini-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGeminiError(data?.error ?? "저장에 실패했습니다.");
        return;
      }
      setGeminiConfigured(true);
      setApiKey("");
      setGeminiError("");
      setForceShowFromInvalid(false);
      // Move to step 2
      if (!supabaseConfigured) {
        setCurrentStep(2);
      } else {
        setCurrentStep(3);
      }
    } finally {
      setGeminiSaving(false);
    }
  };

  const handleSupabaseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSupabaseError("");
    if (!supabaseUrl.trim() || !supabaseKey.trim()) {
      setSupabaseError("Supabase URL과 Service Role Key를 모두 입력해 주세요.");
      return;
    }
    setSupabaseSaving(true);
    try {
      const res = await fetch("/api/settings/supabase-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: supabaseUrl.trim(), serviceRoleKey: supabaseKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSupabaseError(data?.error ?? "저장에 실패했습니다.");
        return;
      }
      setSupabaseConfigured(true);
      setSupabaseUrl("");
      setSupabaseKey("");
      setSupabaseError("");
      setCurrentStep(3);
    } finally {
      setSupabaseSaving(false);
    }
  };

  const handleSkipSupabase = () => {
    setCurrentStep(3);
  };

  // Loading state
  if (loading) {
    return (
      <div className="onboarding-card" style={{ padding: 24 }}>
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
          설정 상태 확인 중...
        </div>
      </div>
    );
  }

  // If everything is configured and no invalid key event, don't show anything
  const needsSetup = !geminiConfigured || forceShowFromInvalid;
  if (!needsSetup) {
    return null;
  }

  // If triggered by invalid key event, show simplified re-entry
  if (forceShowFromInvalid && geminiConfigured) {
    return (
      <div className="gemini-key-form-card">
        <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--accent-yellow)", marginBottom: 8 }}>
          Gemini API 키 재입력 필요
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
          기존 API 키가 유효하지 않습니다. 새 키를 입력해 주세요.
        </p>
        <form onSubmit={handleGeminiSubmit} style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label
              htmlFor="gemini-api-key-reentry"
              style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}
            >
              API 키
            </label>
            <input
              id="gemini-api-key-reentry"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Google AI Studio에서 발급한 API 키"
              className="gemini-key-input"
              autoComplete="off"
            />
            {geminiError && (
              <p style={{ marginTop: 4, fontSize: 12, color: "var(--accent-red)" }}>{geminiError}</p>
            )}
          </div>
          <button type="submit" className="btn btn-primary" disabled={geminiSaving}>
            {geminiSaving ? "저장 중..." : "저장"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="onboarding-card animate-in">
      {/* Header */}
      <div className="onboarding-header">
        <div className="onboarding-icon">C</div>
        <div>
          <h1 className="onboarding-title">ContractLens에 오신 것을 환영합니다</h1>
          <p className="onboarding-subtitle">
            PDF/DOCX 계약서를 업로드하면 AI가 조항별 리스크를 분석하고 FIDIC 표준과 비교합니다.
          </p>
        </div>
      </div>

      {/* Step indicators */}
      <div className="onboarding-steps">
        <StepIndicator
          number={1}
          label="Gemini API 키"
          state={geminiConfigured ? "done" : currentStep === 1 ? "active" : "waiting"}
          onClick={() => !geminiConfigured && setCurrentStep(1)}
        />
        <div className="onboarding-step-line" />
        <StepIndicator
          number={2}
          label="Supabase (선택)"
          state={supabaseConfigured ? "done" : currentStep === 2 ? "active" : "waiting"}
          onClick={() => geminiConfigured && !supabaseConfigured ? setCurrentStep(2) : undefined}
        />
        <div className="onboarding-step-line" />
        <StepIndicator
          number={3}
          label="계약서 업로드"
          state={currentStep === 3 ? "active" : "waiting"}
          onClick={() => geminiConfigured ? setCurrentStep(3) : undefined}
        />
      </div>

      {/* Step content */}
      <div className="onboarding-content">
        {currentStep === 1 && (
          <div className="onboarding-step-content animate-in">
            <h2 className="onboarding-step-title">
              <span className="onboarding-step-badge">1</span>
              Gemini API 키 설정
            </h2>
            <p className="onboarding-step-desc">
              조항 분석과 임베딩에 Google Gemini API를 사용합니다.
              한 번 입력하면 암호화하여 로컬에 저장됩니다.
            </p>
            <form onSubmit={handleGeminiSubmit} className="onboarding-form">
              <div className="onboarding-input-group">
                <label htmlFor="gemini-api-key" className="onboarding-label">
                  API 키 <span style={{ color: "var(--accent-red)" }}>*</span>
                </label>
                <input
                  id="gemini-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Google AI Studio에서 발급한 API 키"
                  className="gemini-key-input"
                  autoComplete="off"
                />
                {geminiError && (
                  <p className="onboarding-error">{geminiError}</p>
                )}
                <p className="onboarding-hint">
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--accent-blue)", textDecoration: "underline" }}
                  >
                    Google AI Studio
                  </a>
                  에서 무료로 API 키를 발급받을 수 있습니다.
                </p>
              </div>
              <button type="submit" className="btn btn-primary" disabled={geminiSaving}>
                {geminiSaving ? "저장 중..." : "저장하고 다음으로"}
              </button>
            </form>
          </div>
        )}

        {currentStep === 2 && (
          <div className="onboarding-step-content animate-in">
            <h2 className="onboarding-step-title">
              <span className="onboarding-step-badge">2</span>
              Supabase 연결
              <span className="onboarding-optional-badge">선택</span>
            </h2>
            <p className="onboarding-step-desc">
              Supabase를 연결하면 계약서와 분석 결과가 클라우드에 저장됩니다.
              건너뛰면 데모 모드로 동작하며, 새로고침 시 데이터가 유지되지 않을 수 있습니다.
            </p>
            <form onSubmit={handleSupabaseSubmit} className="onboarding-form">
              <div className="onboarding-input-group">
                <label htmlFor="supabase-url" className="onboarding-label">
                  Project URL
                </label>
                <input
                  id="supabase-url"
                  type="url"
                  value={supabaseUrl}
                  onChange={(e) => setSupabaseUrl(e.target.value)}
                  placeholder="https://xxxxx.supabase.co"
                  className="gemini-key-input"
                  autoComplete="off"
                />
              </div>
              <div className="onboarding-input-group">
                <label htmlFor="supabase-service-key" className="onboarding-label">
                  Service Role Key
                </label>
                <input
                  id="supabase-service-key"
                  type="password"
                  value={supabaseKey}
                  onChange={(e) => setSupabaseKey(e.target.value)}
                  placeholder="eyJhbGciOiJIUzI1NiIs..."
                  className="gemini-key-input"
                  autoComplete="off"
                />
              </div>
              {supabaseError && (
                <p className="onboarding-error">{supabaseError}</p>
              )}
              <p className="onboarding-hint">
                Supabase 대시보드 &rarr; <strong>Settings</strong> &rarr; <strong>API</strong>에서 확인할 수 있습니다.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="submit" className="btn btn-primary" disabled={supabaseSaving}>
                  {supabaseSaving ? "저장 중..." : "연결"}
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={handleSkipSupabase}
                >
                  건너뛰기
                </button>
              </div>
            </form>
          </div>
        )}

        {currentStep === 3 && (
          <div className="onboarding-step-content animate-in">
            <h2 className="onboarding-step-title">
              <span className="onboarding-step-badge" style={{ background: "var(--accent-green-dim)", color: "var(--accent-green)" }}>
                &#10003;
              </span>
              준비 완료!
            </h2>
            <p className="onboarding-step-desc">
              설정이 완료되었습니다. 첫 번째 계약서를 업로드하여 리스크 분석을 시작하세요.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <Link href="/upload" className="btn btn-primary">
                계약서 업로드하기
              </Link>
              <Link href="/settings" className="btn btn-outline">
                설정 확인
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* --- Step indicator sub-component --- */

interface StepIndicatorProps {
  number: number;
  label: string;
  state: "done" | "active" | "waiting";
  onClick?: () => void;
}

function StepIndicator({ number, label, state, onClick }: StepIndicatorProps) {
  const stateClass = `onboarding-step-dot-${state}`;
  return (
    <button
      type="button"
      className={`onboarding-step-indicator ${state !== "waiting" ? "clickable" : ""}`}
      onClick={onClick}
      tabIndex={state === "waiting" ? -1 : 0}
      aria-label={`${label} - ${state === "done" ? "완료" : state === "active" ? "진행 중" : "대기"}`}
    >
      <div className={`onboarding-step-dot ${stateClass}`}>
        {state === "done" ? "\u2713" : number}
      </div>
      <span className={`onboarding-step-label ${state === "active" ? "active" : ""}`}>
        {label}
      </span>
    </button>
  );
}

export function dispatchGeminiKeyInvalid() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GEMINI_KEY_INVALID_EVENT));
  }
}
