"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { QuotaDisplayWrapper } from "../dashboard/QuotaDisplayWrapper";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const [supabaseConfigured, setSupabaseConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/settings/status")
      .then((r) => r.json())
      .then((data: { supabaseConfigured?: boolean }) => setSupabaseConfigured(data.supabaseConfigured ?? false))
      .catch(() => setSupabaseConfigured(null));
  }, [pathname]);

  const showDemoBanner = supabaseConfigured === false;

  return (
    <div className="app-container">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="logo-icon">C</div>
          <div>
            <div className="logo-text">ContractLens</div>
            <div className="logo-sub">Risk Analysis Platform</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <p className="nav-section-label">메뉴</p>
          <NavItem href="/" icon="📊" active={pathname === "/"}>
            대시보드
          </NavItem>
          <NavItem href="/upload" icon="📤" active={pathname === "/upload"}>
            계약서 업로드
          </NavItem>

          <p className="nav-section-label">계약서</p>
          <NavItem href="/contracts" icon="📋" active={pathname?.startsWith("/contracts") && !pathname.includes("/report")}>
            구역 분류 확인
          </NavItem>
          <NavItem href="/contracts" icon="📑" active={false}>
            조항 분석
          </NavItem>
          <NavItem href="/contracts" icon="📄" active={pathname?.includes("/report") ?? false}>
            리포트
          </NavItem>
          <p className="nav-section-label">시스템</p>
          <NavItem href="/settings" icon="⚙️" active={pathname === "/settings"}>
            설정
          </NavItem>
        </nav>

        <div className="sidebar-quota">
          <div className="quota-title">API 할당량</div>
          <QuotaDisplayWrapper />
        </div>
      </aside>

      <main className="main-content">
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
  icon?: string;
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
