import { NextRequest } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../supabase/admin";

/** Auth 미연동 시 API에서 사용할 기본 user_id */
export const PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * 요청에서 Supabase Auth JWT를 읽어 user_id를 반환합니다.
 * Authorization: Bearer <access_token> 이 있고 유효하면 user.id, 아니면 null.
 * Auth 미연동 시 클라이언트가 토큰을 보내지 않으므로 null → API에서 PLACEHOLDER 사용.
 */
export async function getUserIdFromRequest(req: NextRequest): Promise<string | null> {
  const supabase = getAdminSupabaseClientIfAvailable();
  if (!supabase) return null;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user?.id) return null;
    return user.id;
  } catch {
    return null;
  }
}
