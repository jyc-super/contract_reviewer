import Link from "next/link";
import { RecentContracts } from "../components/dashboard/RecentContracts";
import { StatsCards } from "../components/dashboard/StatsCards";
import { GeminiKeySetupWrapper } from "../components/dashboard/GeminiKeySetupWrapper";
import { RiskChart } from "../components/dashboard/RiskChart";
import { TopRiskCategories } from "../components/dashboard/TopRiskCategories";
import { getContractListStats } from "../lib/data/contracts";

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });
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
  const completedContracts = stats?.completedContracts ?? 0;
  const inProgressContracts = stats?.inProgressContracts ?? 0;

  const items = contracts.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status ?? "",
    updatedAt: formatDate(c.updated_at),
  }));

  return (
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
              medium={0}
              low={0}
              info={0}
            />
            <TopRiskCategories />
          </div>
        </div>
      </main>
    </div>
  );
}
