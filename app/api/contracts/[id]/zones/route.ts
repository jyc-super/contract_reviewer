import { NextRequest, NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../../../../../lib/supabase/admin";
import { requireUserIdFromRequest } from "../../../../../lib/auth/server";
import * as logger from "../../../../../lib/logger";

interface Params {
  params: Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// GET /api/contracts/[id]/zones — uncertain zones for inline zone review
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, { params }: Params) {
  const { id: contractId } = await params;
  const auth = await requireUserIdFromRequest(req);
  if ("response" in auth) return auth.response;
  const { userId } = auth;
  const supabase = getAdminSupabaseClientIfAvailable();

  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase가 설정되지 않았습니다.", code: "SUPABASE_UNAVAILABLE" },
      { status: 503 }
    );
  }

  // Verify ownership
  const { data: contract, error: contractErr } = await supabase
    .from("contracts")
    .select("id, user_id, name, page_count, document_parts, header_footer_info, toc_entries, sub_documents")
    .eq("id", contractId)
    .single();

  if (contractErr || !contract) {
    return NextResponse.json({ error: "계약을 찾을 수 없습니다." }, { status: 404 });
  }
  if (contract.user_id !== userId) {
    return NextResponse.json({ error: "계약을 찾을 수 없습니다." }, { status: 404 });
  }

  // Fetch all zones for this contract
  const { data: zones, error: zonesErr } = await supabase
    .from("document_zones")
    .select("id, zone_type, confidence, text, is_analysis_target, user_confirmed, page_from, page_to")
    .eq("contract_id", contractId)
    .order("page_from", { ascending: true });

  if (zonesErr) {
    logger.error("zones GET 조회 실패", zonesErr as Error);
    return NextResponse.json({ error: "구역 조회에 실패했습니다." }, { status: 500 });
  }

  const allZones = zones ?? [];
  const uncertainZones = allZones
    .filter((z: { is_analysis_target: boolean; user_confirmed: boolean | null }) =>
      z.is_analysis_target === false && z.user_confirmed == null
    )
    .map((z: { id: string; zone_type: string; confidence: number; text: string; page_from: number | null; page_to: number | null }) => ({
      id: z.id,
      type: z.zone_type,
      confidence: z.confidence,
      textPreview: z.text.slice(0, 200) + (z.text.length > 200 ? "\u2026" : ""),
      pageFrom: z.page_from ?? undefined,
      pageTo: z.page_to ?? undefined,
    }));

  const analysisTargetCount = allZones.filter(
    (z: { is_analysis_target: boolean }) => z.is_analysis_target
  ).length;

  return NextResponse.json({
    contractName: contract.name,
    pageCount: contract.page_count,
    uncertainZones,
    analysisTargetCount,
    document_parts: (contract as { document_parts?: unknown }).document_parts ?? null,
    header_footer_info: (contract as { header_footer_info?: unknown }).header_footer_info ?? null,
    toc_entries: (contract as { toc_entries?: unknown }).toc_entries ?? null,
    sub_documents: (contract as { sub_documents?: unknown }).sub_documents ?? null,
  });
}

// ---------------------------------------------------------------------------
// PUT /api/contracts/[id]/zones — confirm zone decisions
// ---------------------------------------------------------------------------

interface ZonesBody {
  includeZoneIds?: string[];
  excludeZoneIds?: string[];
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id: contractId } = await params;
  const auth = await requireUserIdFromRequest(req);
  if ("response" in auth) return auth.response;
  const { userId } = auth;
  const supabase = getAdminSupabaseClientIfAvailable();

  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase가 설정되지 않았습니다." },
      { status: 503 }
    );
  }

  const { data: contract, error: contractErr } = await supabase
    .from("contracts")
    .select("id, user_id")
    .eq("id", contractId)
    .single();

  if (contractErr || !contract) {
    return NextResponse.json(
      { error: "계약을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  if (contract.user_id !== userId) {
    return NextResponse.json(
      { error: "계약을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  let body: ZonesBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "요청 본문이 올바른 JSON이 아닙니다." },
      { status: 400 }
    );
  }

  const includeIds = Array.isArray(body.includeZoneIds) ? body.includeZoneIds : [];
  const excludeIds = Array.isArray(body.excludeZoneIds) ? body.excludeZoneIds : [];

  if (includeIds.length > 0) {
    const { error: incErr } = await supabase
      .from("document_zones")
      .update({
        user_confirmed: true,
        is_analysis_target: true,
      })
      .eq("contract_id", contractId)
      .in("id", includeIds);

    if (incErr) {
      logger.error("zones PUT 포함 구역 확정 실패", incErr as Error);
      return NextResponse.json(
        { error: "포함 구역 확정 처리에 실패했습니다." },
        { status: 500 }
      );
    }
  }

  if (excludeIds.length > 0) {
    const { error: excErr } = await supabase
      .from("document_zones")
      .update({
        user_confirmed: true,
        is_analysis_target: false,
      })
      .eq("contract_id", contractId)
      .in("id", excludeIds);

    if (excErr) {
      logger.error("zones PUT 제외 구역 확정 실패", excErr as Error);
      return NextResponse.json(
        { error: "제외 구역 확정 처리에 실패했습니다." },
        { status: 500 }
      );
    }
  }

  // 구역 확정 후 계약 상태를 ready로 전환
  // 리스크 분석은 상세 페이지에서 사용자가 명시적으로 요청할 때 실행
  await supabase
    .from("contracts")
    .update({ status: "ready", updated_at: new Date().toISOString() })
    .eq("id", contractId);

  return NextResponse.json({
    ok: true,
    contractId,
    included: includeIds.length,
    excluded: excludeIds.length,
  });
}
