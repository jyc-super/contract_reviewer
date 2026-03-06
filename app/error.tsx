"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        url: typeof window !== "undefined" ? window.location.href : undefined,
      }),
    }).catch(() => {});
  }, [error]);

  const isSupabaseEnvMissing =
    error.message?.includes("Supabase Admin 클라이언트 환경변수가 설정되어 있지 않습니다.") ??
    false;

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-primary px-6 py-8">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-border-muted bg-bg-card/80 p-6 text-center shadow-sm shadow-black/25">
        <h1 className="text-xl font-semibold text-text-primary">오류가 발생했습니다</h1>
        <p className="text-sm text-text-soft">
          {error.message || "일시적인 오류가 발생했습니다. 다시 시도해 주세요."}
        </p>

        {isSupabaseEnvMissing && (
          <div className="space-y-2 rounded-lg border border-amber-500/60 bg-amber-500/10 p-3 text-left text-xs text-amber-100">
            <p className="font-semibold">현재 Supabase가 설정되지 않아 데이터 저장 없이 데모 모드로 동작합니다.</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>계약/분석 데이터는 브라우저 새로고침 후 유지되지 않을 수 있습니다.</li>
              <li>
                실제 DB에 저장하려면 <code className="rounded bg-bg-elevated px-1 py-0.5 text-[11px]">NEXT_PUBLIC_SUPABASE_URL</code>과{" "}
                <code className="rounded bg-bg-elevated px-1 py-0.5 text-[11px]">SUPABASE_SERVICE_ROLE_KEY</code> 환경변수를
                설정한 뒤 서버를 다시 시작해 주세요.
              </li>
            </ul>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-accent-primary px-4 py-2 text-sm font-medium text-white shadow-sm shadow-accent-primary/40 hover:bg-accent-primary/90"
          >
            다시 시도
          </button>
          <Link
            href="/"
            className="rounded-md border border-border-subtle px-4 py-2 text-sm font-medium text-text-secondary hover:border-accent-soft hover:text-accent-soft"
          >
            대시보드로
          </Link>
        </div>
      </div>
    </main>
  );
}
