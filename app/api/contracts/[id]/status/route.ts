import { NextRequest, NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../../../../../lib/supabase/admin";
import { getUserIdFromRequest, PLACEHOLDER_USER_ID } from "../../../../../lib/auth/server";

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

  const { data, error } = await supabase
    .from("contracts")
    .select("status, user_id")
    .eq("id", id)
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: "계약을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  if (data.user_id !== userId) {
    return NextResponse.json(
      { error: "계약을 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  return NextResponse.json({ status: data.status });
}
