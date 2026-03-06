import { NextRequest, NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../../../../lib/supabase/admin";
import { getUserIdFromRequest, PLACEHOLDER_USER_ID } from "../../../../lib/auth/server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const userId = (await getUserIdFromRequest(req)) ?? PLACEHOLDER_USER_ID;
  const supabase = getAdminSupabaseClientIfAvailable();

  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase가 설정되지 않았습니다." },
      { status: 503 }
    );
  }

  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id, user_id, name, status, page_count, created_at, updated_at")
    .eq("id", id)
    .single();

  if (contractError || !contract) {
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

  const { data: zones } = await supabase
    .from("document_zones")
    .select("id, page_from, page_to, zone_type, confidence, is_analysis_target, user_confirmed, text")
    .eq("contract_id", id)
    .order("created_at");

  const { data: clauses } = await supabase
    .from("clauses")
    .select("id, zone_id, clause_prefix, number, title, text, is_auto_split, needs_review")
    .eq("contract_id", id)
    .order("created_at");

  const { user_id: _u, ...contractWithoutUserId } = contract;
  return NextResponse.json({
    contract: contractWithoutUserId,
    zones: zones ?? [],
    clauses: clauses ?? [],
  });
}
