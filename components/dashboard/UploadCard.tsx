"use client";

import Link from "next/link";

export function UploadCard() {
  return (
    <div className="space-y-4 rounded-xl border border-border-muted bg-bg-card/80 p-5 shadow-sm shadow-black/20 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">새 계약 업로드</h2>
          <p className="mt-1 text-xs text-text-soft">
            PDF/DOCX 파일을 드래그 앤 드롭하거나 클릭해서 선택하세요.
            업로드 페이지에서 파일을 선택하면 검증·PDF 분석·구역 분류·조항 추출이 순서대로 진행됩니다.
          </p>
        </div>
        <Link
          href="/upload"
          className="hidden sm:inline-flex items-center justify-center rounded-md bg-accent-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm shadow-accent-primary/40 hover:bg-accent-primary/90"
        >
          업로드 페이지로 이동
        </Link>
      </div>
      <Link
        href="/upload"
        className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border-subtle bg-bg-elevated/60 px-6 py-10 text-center hover:border-accent-soft/80 hover:bg-bg-elevated"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="mb-3 h-8 w-8 text-accent-soft"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 15.75V9.75A2.25 2.25 0 015.25 7.5H9l2.25-3h1.5L15 7.5h3.75A2.25 2.25 0 0121 9.75v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15.75z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 13.5L12 10.5m0 0l3 3m-3-3v6"
          />
        </svg>
        <p className="text-sm text-text-secondary">
          여기로 <span className="font-semibold">PDF / DOCX</span> 파일을
          드래그 앤 드롭하거나, 클릭해서 선택하세요.
        </p>
        <p className="mt-1 text-[11px] text-text-soft">
          최대 50MB, 합본 PDF 지원 • 스캔본은 Gemini 비전으로 분석
        </p>
      </Link>
    </div>
  );
}
