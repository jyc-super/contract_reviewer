import Link from "next/link";
import { getContractDetail } from "../../../../lib/data/contracts";
import { ZoneReviewView } from "../../../../components/contract/ZoneReviewView";

interface ContractZonesPageProps {
  params: Promise<{ id: string }>;
}

export default async function ContractZonesPage({ params }: ContractZonesPageProps) {
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

  const { contract, zones } = data;
  // 검토 대기 구역: is_analysis_target=false 이면서 아직 사용자가 포함/제외를 결정하지 않은 구역.
  // user_confirmed 컬럼 기본값은 null 이므로, `!== true` 조건만 쓰면 is_analysis_target=true 인
  // 분석 대상 구역(자동 확정)도 리스트에 포함되어 버린다.
  // 올바른 판별: is_analysis_target=false 이고 user_confirmed 가 null 인 zone 만 검토 목록에 표시.
  const uncertainZones = zones.filter(
    (z) => z.is_analysis_target === false && z.user_confirmed == null
  );
  const analysisTargetCount = zones.filter((z) => z.is_analysis_target).length;

  const zoneItems = uncertainZones.map((z) => ({
    id: z.id,
    type: z.zone_type,
    confidence: z.confidence,
    textPreview: z.text.slice(0, 200) + (z.text.length > 200 ? "…" : ""),
  }));

  const totalPageInfo = contract.page_count != null ? `총 ${contract.page_count}p` : undefined;

  return (
    <ZoneReviewView
      contractId={id}
      contractName={contract.name}
      uncertainZones={zoneItems}
      analysisTargetCount={analysisTargetCount}
      totalPageInfo={totalPageInfo}
    />
  );
}
