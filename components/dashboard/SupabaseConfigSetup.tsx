"use client";

import { useEffect, useState } from "react";

export interface SupabaseConfigSetupProps {
  onSaved?: () => void;
}

export function SupabaseConfigSetup({ onSaved }: SupabaseConfigSetupProps) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");
  const [serviceRoleKey, setServiceRoleKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    fetch("/api/settings/supabase-config")
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
    return () => { mounted = false; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!url.trim() || !serviceRoleKey.trim()) {
      setError("Supabase URL과 Service Role Key를 모두 입력해 주세요.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings/supabase-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), serviceRoleKey: serviceRoleKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "저장에 실패했습니다.");
        return;
      }
      setConfigured(true);
      setShowForm(false);
      setUrl("");
      setServiceRoleKey("");
      setError("");
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  if (loading && configured === null) {
    return (
      <div className="gemini-key-card" style={{ color: "var(--text-muted)", fontSize: 13 }}>
        Supabase 연결 설정 확인 중…
      </div>
    );
  }

  if (!showForm && configured) {
    return (
      <div className="gemini-key-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Supabase 연결 정보가 설정되어 있습니다. 문제가 있으면 다시 입력할 수 있습니다.
          </span>
          <button
            type="button"
            className="btn btn-outline"
            style={{ fontSize: 11, padding: "4px 12px" }}
            onClick={() => setShowForm(true)}
          >
            다시 입력
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gemini-key-form-card">
      <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--accent-blue)", marginBottom: 8 }}>
        Supabase Cloud 연결
      </h2>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
        Supabase 프로젝트 URL과 Service Role Key를 입력하면 암호화해 로컬에 저장합니다. .env 없이 설정 페이지만으로 연결할 수 있습니다.
      </p>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <label
            htmlFor="supabase-url"
            style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}
          >
            Project URL
          </label>
          <input
            id="supabase-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://xxxxx.supabase.co"
            className="gemini-key-input"
            autoComplete="off"
          />
        </div>
        <div style={{ flex: 1 }}>
          <label
            htmlFor="supabase-service-role-key"
            style={{ display: "block", fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", marginBottom: 4 }}
          >
            Service Role Key
          </label>
          <input
            id="supabase-service-role-key"
            type="password"
            value={serviceRoleKey}
            onChange={(e) => setServiceRoleKey(e.target.value)}
            placeholder="eyJhbGciOiJIUzI1NiIs..."
            className="gemini-key-input"
            autoComplete="off"
          />
        </div>
        {error && (
          <p style={{ fontSize: 12, color: "var(--accent-red)" }}>{error}</p>
        )}
        <button type="submit" className="btn btn-primary" disabled={saving} style={{ alignSelf: "flex-start" }}>
          {saving ? "저장 중…" : "저장"}
        </button>
      </form>
      <p style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted)" }}>
        Supabase 대시보드 → <strong>Settings</strong> → <strong>API</strong>에서 Project URL과 <code>service_role</code> 키를 확인할 수 있습니다.
      </p>
    </div>
  );
}
