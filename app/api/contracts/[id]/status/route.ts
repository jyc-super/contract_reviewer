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

  type QueryResult = { data: { status: string; user_id: string; name: string; updated_at: string; created_at: string; page_count: number | null; parse_progress: number | null } | null; error: { message?: string } | null };
  const queryWithTimeout: Promise<QueryResult | "timeout"> = Promise.race([
    supabase
      .from("contracts")
      .select("status, user_id, name, updated_at, created_at, page_count, parse_progress")
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

  // Surface enough context for the client to display progress/errors and
  // restore state when the user navigates back to the upload page.
  //
  // Transient statuses intentionally omitted from TERMINAL_STATUSES so that
  // the polling client continues to poll through each intermediate phase:
  //   "parsing"          — Docling sidecar is parsing the document
  //   "quality_checking" — qualityCheck() is running (may invoke Gemma LLM)
  //   "filtering"        — uncertain zones need user confirmation
  //   "analyzing"        — clause-level risk analysis is in progress
  const TERMINAL_STATUSES = ["ready", "partial", "error"] as const;
  return NextResponse.json({
    status: data.status,
    name: data.name,
    updatedAt: data.updated_at,
    createdAt: data.created_at,
    pageCount: data.page_count ?? null,
    // parseProgress: integer 0–100 during status=parsing, null otherwise.
    // Clients should use this to render smooth progress within the parsing stage
    // rather than holding at a fixed percentage for the entire Docling parse duration.
    parseProgress: data.parse_progress ?? null,
    // Convenience: tell the client whether to keep polling.
    // Explicitly enumerate terminal states so that transient states like
    // "analyzing" do not prematurely stop polling if analysis becomes async.
    done: (TERMINAL_STATUSES as readonly string[]).includes(data.status),
  });
}
