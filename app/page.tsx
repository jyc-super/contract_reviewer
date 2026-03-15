export const dynamic = "force-dynamic";

import Link from "next/link";
import { RecentContracts } from "../components/dashboard/RecentContracts";
import { StatsCards } from "../components/dashboard/StatsCards";
import { GeminiKeySetupWrapper } from "../components/dashboard/GeminiKeySetupWrapper";
import { RiskChart } from "../components/dashboard/RiskChart";
import { TopRiskCategories } from "../components/dashboard/TopRiskCategories";
import { AutoRefreshWrapper } from "../components/contracts/AutoRefreshWrapper";
import { getContractListStats } from "../lib/data/contracts";

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Asia/Seoul",
    }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}

export default async function HomePage() {
  const stats = await getContractListStats();
  const contracts = stats?.contracts ?? [];
  const totalContracts = stats?.totalContracts ?? 0;
  const analyzedClauses = stats?.analyzedClauses ?? 0;
  const highRiskClauses = stats?.highRiskClauses ?? 0;
  const mediumRiskClauses = stats?.mediumRiskClauses ?? 0;
  const lowRiskClauses = stats?.lowRiskClauses ?? 0;
  const infoRiskClauses = stats?.infoRiskClauses ?? 0;
  const completedContracts = stats?.completedContracts ?? 0;
  const inProgressContracts = stats?.inProgressContracts ?? 0;

  const items = contracts.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status ?? "",
    createdAt: formatDate(c.created_at),
    updatedAt: formatDate(c.updated_at),
  }));

  const statuses = items.map((item) => item.status);

  const isEmpty = totalContracts === 0;

  return (
    <AutoRefreshWrapper statuses={statuses}>
    <div className="page">
      <GeminiKeySetupWrapper />

      <header className="page-header">
        <div>
          <h1 className="page-title">대시보드</h1>
          <p className="page-subtitle">계약서 리스크 현황 요약</p>
        </div>
        <div className="page-actions">
          <Link href="/upload" className="btn btn-primary">
            + 새 계약서 업로드
          </Link>
        </div>
      </header>

      <main className="page-body">
        <div className="stats-grid animate-in">
          <StatsCards
            totalContracts={totalContracts}
            highRiskClauses={highRiskClauses}
            completedContracts={completedContracts}
            inProgressContracts={inProgressContracts}
            analyzedClauses={analyzedClauses}
          />
        </div>

        {isEmpty ? (
          <div className="empty-dashboard animate-in">
            <div className="empty-dashboard-icon">📋</div>
            <h2 className="empty-dashboard-title">아직 등록된 계약서가 없습니다</h2>
            <p className="empty-dashboard-desc">
              첫 번째 계약서를 업로드하면 AI가 조항별 리스크를 분석하고,
              FIDIC 국제 표준과 비교하여 상세한 보고서를 생성합니다.
            </p>
            <div className="empty-dashboard-actions">
              <Link href="/upload" className="btn btn-primary">
                계약서 업로드하기
              </Link>
            </div>
            <div className="empty-dashboard-features">
              <div className="empty-dashboard-feature">
                <span className="empty-feature-icon">📄</span>
                <div>
                  <div className="empty-feature-title">문서 파싱</div>
                  <div className="empty-feature-desc">PDF/DOCX에서 조항을 자동 추출</div>
                </div>
              </div>
              <div className="empty-dashboard-feature">
                <span className="empty-feature-icon">🔍</span>
                <div>
                  <div className="empty-feature-title">리스크 분석</div>
                  <div className="empty-feature-desc">Gemini AI로 조항별 위험도 평가</div>
                </div>
              </div>
              <div className="empty-dashboard-feature">
                <span className="empty-feature-icon">📊</span>
                <div>
                  <div className="empty-feature-title">FIDIC 비교</div>
                  <div className="empty-feature-desc">국제 표준 대비 편차 분석</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="two-col">
            <div className="card">
              <div className="card-header">
                <div className="card-title">최근 계약서</div>
                <Link href="/contracts" className="btn btn-outline" style={{ fontSize: 11 }}>
                  전체 보기
                </Link>
              </div>
              <RecentContracts items={items} />
            </div>

            <div>
              <RiskChart
                high={highRiskClauses}
                medium={mediumRiskClauses}
                low={lowRiskClauses}
                info={infoRiskClauses}
              />
              <TopRiskCategories />
            </div>
          </div>
        )}
      </main>
    </div>
    </AutoRefreshWrapper>
  );
}
