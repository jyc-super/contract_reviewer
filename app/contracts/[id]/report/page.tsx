import Link from "next/link";
import { getContractDetail } from "../../../../lib/data/contracts";

interface ContractReportPageProps {
  params: Promise<{ id: string }>;
}

export default async function ContractReportPage({ params }: ContractReportPageProps) {
  const { id } = await params;
  const data = await getContractDetail(id);

  if (!data) {
    return (
      <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 lg:px-8 lg:py-10">
        <div>
          <p className="text-sm text-text-soft">
            계약을 불러올 수 없습니다. Supabase가 설정되지 않았거나 해당 ID가 없을 수 있습니다.
          </p>
          <Link
            href="/"
            className="mt-4 inline-block text-sm text-accent-soft hover:text-accent-primary hover:underline"
          >
            대시보드로 돌아가기
          </Link>
        </div>
      </main>
    );
  }

  const { contract, clauses, analyses } = data;
  const analysisByClause = new Map(analyses.map((a) => [a.clause_id, a]));

  const rows = clauses.map((c, index) => {
    const a = analysisByClause.get(c.id);
    const fidic =
      a?.fidic_comparisons != null
        ? typeof a.fidic_comparisons === "string"
          ? a.fidic_comparisons
          : JSON.stringify(a.fidic_comparisons)
        : "";
    return {
      no: index + 1,
      title: c.title ?? c.number ?? c.clause_prefix ?? `조항 ${index + 1}`,
      riskLevel: a?.risk_level ?? "-",
      fidic,
    };
  });

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">FIDIC 비교 리포트</h1>
          <p className="page-subtitle">
            {contract.name} 계약의 조항별 리스크 레벨 및 FIDIC 편차 요약입니다.
          </p>
        </div>
        <div className="page-actions">
          <Link href={`/contracts/${id}`} className="btn btn-outline">
            계약 상세로 돌아가기
          </Link>
        </div>
      </header>

      <main className="page-body">
        <section className="card">
          <div className="card-header">
            <h2 className="card-title">조항별 FIDIC 편차 요약</h2>
          </div>
          <div className="card-body">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>조항</th>
                  <th>리스크 레벨</th>
                  <th>FIDIC 편차 요약</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.no}>
                    <td>{row.no}</td>
                    <td>{row.title}</td>
                    <td>
                      <span className="badge badge-info">{row.riskLevel}</span>
                    </td>
                    <td>{row.fidic || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-text-soft">
                아직 파싱된 조항 또는 분석 결과가 없습니다.
              </p>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

