import { NextRequest, NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../../../../lib/supabase/admin";
import { requireUserIdFromRequest } from "../../../../lib/auth/server";
import * as logger from "../../../../lib/logger";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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

  if (process.env.NODE_ENV === "production" && contract.user_id !== userId) {
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

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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

  // Pre-check: verify the contract exists before attempting DELETE.
  // This lets us distinguish "record not found" from "RLS silently blocked".
  const { data: existing, error: selectError } = await supabase
    .from("contracts")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();

  if (selectError) {
    logger.error("[contracts/[id]/route] DELETE: pre-check select failed", selectError as Error);
    return NextResponse.json({ error: "삭제 전 조회에 실패했습니다." }, { status: 500 });
  }

  if (!existing) {
    // 이미 삭제된 계약에 대한 재요청 — 멱등성을 위해 200 반환.
    // Next.js Router Cache 때문에 삭제 후에도 UI에 잔존하여
    // 사용자가 다시 삭제 버튼을 누를 수 있음.
    logger.info("[contracts/[id]/route] DELETE: contract already gone (idempotent OK)", { contractId: id });
    return NextResponse.json({ ok: true, alreadyDeleted: true });
  }

  // Production: verify ownership
  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && existing.user_id !== userId) {
    return NextResponse.json({ error: "삭제 권한이 없습니다." }, { status: 403 });
  }

  // CASCADE DELETE (document_zones → clauses → clause_analyses 자동 삭제)
  const { data: deleted, error: deleteError } = await supabase
    .from("contracts")
    .delete()
    .eq("id", id)
    .select("id");

  if (deleteError) {
    logger.error("[contracts/[id]/route] DELETE: failed", {
      contractId: id,
      userId,
      code: (deleteError as { code?: string }).code,
      message: (deleteError as { message?: string }).message,
    } as unknown as Error);
    return NextResponse.json({ error: "삭제 중 오류가 발생했습니다." }, { status: 500 });
  }

  if (!deleted || deleted.length === 0) {
    // Record exists (pre-check passed) but DELETE returned nothing.
    // This means RLS is blocking the delete — likely the Supabase client
    // is using the anon key instead of the service_role key.
    logger.error("[contracts/[id]/route] DELETE: row exists but delete returned empty — RLS blocking? Check SUPABASE_SERVICE_ROLE_KEY", {
      contractId: id,
      userId,
      existingUserId: existing.user_id,
    } as unknown as Error);
    return NextResponse.json(
      { error: "삭제가 차단되었습니다. 서버 설정(Service Role Key)을 확인하세요." },
      { status: 500 }
    );
  }

  logger.info("[contracts/[id]/route] DELETE: contract deleted", { contractId: id, userId });
  return NextResponse.json({ ok: true });
}
