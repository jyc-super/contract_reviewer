import Link from "next/link";
import { getContractDetail } from "../../../lib/data/contracts";
import { ContractDetailView } from "../../../components/contract/ContractDetailView";

interface ContractPageProps {
  params: Promise<{ id: string }>;
}

export default async function ContractPage({ params }: ContractPageProps) {
  const { id } = await params;
  const data = await getContractDetail(id);

  if (!data) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">계약 상세</div>
            <div className="page-subtitle">
              계약을 불러올 수 없습니다. Supabase가 설정되지 않았거나 해당 ID가 없을 수 있습니다.
            </div>
          </div>
        </div>
        <div className="page-body">
          <Link href="/" className="btn btn-outline">대시보드로 돌아가기</Link>
        </div>
      </div>
    );
  }

  const { contract, clauses, analyses } = data;
  const analysisMap = new Map(analyses.map((a) => [a.clause_id, a]));

  const clauseItems = clauses.map((c) => {
    const a = analysisMap.get(c.id);
    return {
      id: c.id,
      title: c.title ?? undefined,
      textPreview: c.text.slice(0, 150) + (c.text.length > 150 ? "..." : ""),
      clausePrefix: c.clause_prefix ?? undefined,
      number: c.number ?? undefined,
      riskLevel: a?.risk_level,
      needsReview: c.needs_review,
    };
  });

  return (
    <ContractDetailView
      contractId={id}
      contract={contract}
      clauseItems={clauseItems}
      analyses={analyses}
    />
  );
}
