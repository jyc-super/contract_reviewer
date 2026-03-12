import { NextRequest, NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../../../../../lib/supabase/admin";
import { requireUserIdFromRequest } from "../../../../../lib/auth/server";

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
      {
        error: "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or configure via the Settings page.",
        code: "SUPABASE_UNAVAILABLE",
      },
      { status: 503 }
    );
  }

  // Impose a hard timeout on the status query.  If the Supabase instance
  // becomes unreachable mid-poll (e.g. local CLI stopped), the supabase-js
  // client has no built-in timeout and the OS TCP timeout can take ~600s on
  // Windows.  5 seconds is generous enough for a normal round trip while
  // keeping the polling UX responsive.
  const STATUS_QUERY_TIMEOUT_MS = 5_000;

  type QueryResult = { data: { status: string; user_id: string; updated_at: string; page_count: number | null } | null; error: { message?: string } | null };
  const queryWithTimeout: Promise<QueryResult | "timeout"> = Promise.race([
    supabase
      .from("contracts")
      .select("status, user_id, updated_at, page_count")
      .eq("id", id)
      .single() as unknown as Promise<QueryResult>,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), STATUS_QUERY_TIMEOUT_MS)),
  ]);

  const queryOutcome = await queryWithTimeout;

  if (queryOutcome === "timeout") {
    return NextResponse.json(
      {
        error: "Supabase is unreachable. Check your Supabase instance.",
        code: "SUPABASE_UNREACHABLE",
      },
      { status: 503 }
    );
  }

  const { data, error } = queryOutcome;

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

  // Surface enough context for the client to display progress/errors
  return NextResponse.json({
    status: data.status,
    updatedAt: data.updated_at,
    pageCount: data.page_count ?? null,
    // Convenience: tell the client whether to keep polling
    done: data.status !== "parsing" && data.status !== "uploading",
  });
}
