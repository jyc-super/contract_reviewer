"use client";

import Link from "next/link";

export function AppNav() {
  return (
    <nav className="border-b border-slate-200 bg-white/90 sticky top-0 z-10">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-4">
        <Link
          href="/"
          className="text-sm font-medium text-slate-700 hover:text-slate-900"
        >
          대시보드
        </Link>
        <Link
          href="/upload"
          className="text-sm font-medium text-slate-700 hover:text-slate-900"
        >
          업로드
        </Link>
      </div>
    </nav>
  );
}
