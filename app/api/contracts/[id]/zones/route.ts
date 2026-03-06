import { NextRequest, NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../../../../../lib/supabase/admin";
import { getUserIdFromRequest, PLACEHOLDER_USER_ID } from "../../../../../lib/auth/server";
import * as logger from "../../../../../lib/logger";

interface Params {
  params: Promise<{ id: string }>;
}

interface ZonesBody {
  includeZoneIds?: string[];
  excludeZoneIds?: string[];
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id: contractId } = await params;
  const userId = (await getUserIdFromRequest(req)) ?? PLACEHOLDER_USER_ID;
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
