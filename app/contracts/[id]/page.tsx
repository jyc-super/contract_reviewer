import Link from "next/link";
import { getContractDetail } from "../../../lib/data/contracts";
import type { SubDocument } from "../../../lib/docling-adapter";
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

  // Build a zone lookup so we can map each clause's zone_id → page_from,
  // which is then used to determine which sub_document the clause belongs to.
  const zonePageMap = new Map(data.zones.map((z) => [z.id, z.page_from]));

  const subDocuments: SubDocument[] = (contract.sub_documents as SubDocument[] | undefined) ?? [];

  const clauseItems = clauses.map((c) => {
    const a = analysisMap.get(c.id);

    // Determine subDocumentTitle by matching the clause's zone page_from
    // against each sub_document's [page_start, page_end] range.
    let subDocumentTitle: string | undefined;
    if (subDocuments.length > 0) {
      const pageFrom = zonePageMap.get(c.zone_id);
      if (pageFrom !== undefined) {
        const subDoc = subDocuments.find(
          (sd) => pageFrom >= sd.page_start && pageFrom <= sd.page_end
        );
        subDocumentTitle = subDoc?.title;
      }
    }

    return {
      id: c.id,
      title: c.title ?? undefined,
      text: c.text,
      clausePrefix: c.clause_prefix ?? undefined,
      number: c.number ?? undefined,
      riskLevel: a?.risk_level,
      needsReview: c.needs_review,
      sortOrder: c.sort_order,
      zoneKey: c.zone_key ?? undefined,
      zoneId: c.zone_id ?? undefined,
      subDocumentTitle,
    };
  });

  return (
    <ContractDetailView
      contractId={id}
      contract={contract}
      clauseItems={clauseItems}
      analyses={analyses}
      zones={data.zones}
    />
  );
}
