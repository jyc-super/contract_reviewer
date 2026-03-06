"use client";

import { useEffect, useState } from "react";

const GEMINI_KEY_INVALID_EVENT = "gemini-key-invalid";

export interface GeminiKeySetupProps {
  initialShowFromInvalid?: boolean;
}

export function GeminiKeySetup({ initialShowFromInvalid }: GeminiKeySetupProps) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [showForm, setShowForm] = useState(!!initialShowFromInvalid);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetch("/api/settings/gemini-key")
      .then((r) => r.json())
      .then((data) => {
        if (mounted) {
          setConfigured(!!data?.configured);
          if (!data?.configured) setShowForm(true);
        }
      })
      .catch(() => {
        if (mounted) setConfigured(false);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    const onInvalid = () => setShowForm(true);
    window.addEventListener(GEMINI_KEY_INVALID_EVENT, onInvalid);
    return () => {
      mounted = false;
      window.removeEventListener(GEMINI_KEY_INVALID_EVENT, onInvalid);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!apiKey.trim()) {
      setError("API 키를 입력해 주세요.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/gemini-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "저장에 실패했습니다.");
        return;
      }
      setConfigured(true);
      setShowForm(false);
      setApiKey("");
      setError("");
      setSuccessMessage(typeof data?.message === "string" ? data.message : "");
    } finally {
      setSaving(false);
    }
  };

  if (loading && configured === null) {
    return (
      <div className="gemini-key-card" style={{ color: "var(--text-muted)", fontSize: 13 }}>
        API 키 설정 확인 중…
      </div>
    );
  }

  if (!showForm && configured) {
    return (
      <div className="gemini-key-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Gemini API 키가 설정되어 있습니다. 문제가 있으면 다시 입력할 수 있습니다.
          </span>
          <button
            type="button"
            className="btn btn-outline"
            style={{ fontSize: 11, padding: "4px 12px" }}
            onClick={() => setShowForm(true)}
          >
            키 재입력
          </button>
        </div>
        {successMessage && (
          <p style={{ marginTop: 8, fontSize: 11, color: "var(--accent-yellow)" }}>
            {successMessage}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="gemini-key-form-card">
      <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--accent-yellow)", marginBottom: 8 }}>
        Gemini API 키 설정
      </h2>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
        조항 분석·임베딩에 Google Gemini API를 사용합니다. 한 번 입력하면 암호화해 저장되며, 문제가 있을 때만 다시 요청합니다.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <label
            htmlFor="gemini-api-key"
            style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}
          >
            API 키
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
          {error && (
            <p style={{ marginTop: 4, fontSize: 12, color: "var(--accent-red)" }}>{error}</p>
          )}
        </div>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </button>
      </form>
      <p style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted)" }}>
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent-blue)", textDecoration: "underline" }}
        >
          Google AI Studio
        </a>
        에서 API 키를 발급받을 수 있습니다.
      </p>
    </div>
  );
}

export function dispatchGeminiKeyInvalid() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GEMINI_KEY_INVALID_EVENT));
  }
}
