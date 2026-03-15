"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useRef, useState } from "react";
import { LayoutDashboard, Upload, FileText, Settings, Menu, X, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { QuotaDisplayWrapper } from "../dashboard/QuotaDisplayWrapper";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const prevPathnameRef = useRef(pathname);
  const [supabaseConfigured, setSupabaseConfigured] = useState<boolean | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);


  // Invalidate the Next.js Router Cache on every client-side navigation so
  // Server Components always re-fetch fresh data from Supabase.  Without this,
  // the Router Cache serves a stale RSC payload for up to 30 seconds, causing
  // newly-uploaded contracts or status changes to be invisible after a <Link>
  // navigation.
  // Close sidebar on route change (mobile)
  // BUG-11: router를 ref로 저장하여 의존성에서 제외 — router 변경 시 의도치 않은 재실행 방지
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  });

  useEffect(() => {
    if (prevPathnameRef.current !== pathname) {
      prevPathnameRef.current = pathname;
      setSidebarOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Supabase 설정 여부 확인 — 최초 마운트 시 1회만 호출
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings/status", { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { supabaseConfigured?: boolean }) => setSupabaseConfigured(data.supabaseConfigured ?? false))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name !== "AbortError") {
          setSupabaseConfigured(null);
        }
      });
    return () => controller.abort();
  }, []);

  const showDemoBanner = supabaseConfigured === false;

  return (
    <div className="app-container">
      {/* Mobile header bar */}
      <div className="mobile-header">
        <button
          className="mobile-header-burger"
          onClick={() => setSidebarOpen(true)}
          aria-label="메뉴 열기"
        >
          <Menu size={22} />
        </button>
        <span className="mobile-header-title">ContractLens</span>
      </div>

      {/* Sidebar overlay (mobile) */}
      <div
        className={`sidebar-overlay${sidebarOpen ? " open" : ""}`}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />

      <aside className={`sidebar${sidebarOpen ? " sidebar--open" : ""}${sidebarCollapsed ? " sidebar--collapsed" : ""}`}>
        <div className="sidebar-logo">
          <div className="logo-icon">C</div>
          <div className="sidebar-logo-text">
            <div className="logo-text">ContractLens</div>
            <div className="logo-sub">Risk Analysis Platform</div>
          </div>
          {/* Mobile close button */}
          <button
            className="mobile-header-burger"
            onClick={() => setSidebarOpen(false)}
            aria-label="메뉴 닫기"
            style={{ marginLeft: "auto" }}
          >
            <X size={20} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {/* Desktop collapse toggle */}
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label={sidebarCollapsed ? "사이드바 펼치기" : "사이드바 접기"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <p className="nav-section-label">메뉴</p>
          <NavItem href="/" icon={<LayoutDashboard size={18} aria-hidden="true" />} active={pathname === "/"}>
            대시보드
          </NavItem>
          <NavItem href="/upload" icon={<Upload size={18} aria-hidden="true" />} active={pathname === "/upload"}>
            계약서 업로드
          </NavItem>

          <p className="nav-section-label">계약서</p>
          <NavItem href="/contracts" icon={<FileText size={18} aria-hidden="true" />} active={pathname?.startsWith("/contracts") ?? false}>
            계약 목록
          </NavItem>
          <p className="nav-section-label">시스템</p>
          <NavItem href="/settings" icon={<Settings size={18} aria-hidden="true" />} active={pathname === "/settings"}>
            설정
          </NavItem>
        </nav>

        <div className="sidebar-quota">
          <div className="quota-title">API 할당량</div>
          <QuotaDisplayWrapper />
        </div>
      </aside>

      <main className={`main-content${sidebarCollapsed ? " main-content--collapsed" : ""}`}>
        {showDemoBanner && (
        <div className="demo-banner">
          <p>
            Supabase가 설정되지 않았습니다.{" "}
            <strong>데모 모드</strong>로 동작합니다. 업로드/분석 결과가
            새로고침 후 유지되지 않을 수 있습니다.{" "}
            <code className="rounded bg-bg-elevated px-1 py-0.5 text-[11px]">NEXT_PUBLIC_SUPABASE_URL</code>과{" "}
            <code className="rounded bg-bg-elevated px-1 py-0.5 text-[11px]">SUPABASE_SERVICE_ROLE_KEY</code>를 설정해 주세요.
          </p>
        </div>
        )}
        {children}
      </main>
    </div>
  );
}

interface NavItemProps {
  href: string;
  icon?: ReactNode;
  active?: boolean;
  badge?: number;
  children: ReactNode;
}

function NavItem({ href, icon, active, badge, children }: NavItemProps) {
  return (
    <Link href={href} className={`nav-item${active ? " active" : ""}`}>
      {icon && <span className="nav-icon">{icon}</span>}
      <span className="truncate">{children}</span>
      {badge != null && badge > 0 && (
        <span className="nav-badge">{badge}</span>
      )}
    </Link>
  );
}
