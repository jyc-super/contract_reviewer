import { NextRequest, NextResponse } from "next/server";
import { getAdminSupabaseClientIfAvailable } from "../supabase/admin";

export const PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000000";

// Supabase auth.getUser() has no built-in timeout.  If the Supabase instance
// is unreachable (e.g. local dev with Supabase not running), the call hangs
// until the OS TCP timeout (~600s on Windows).  We impose a hard 4-second
// limit here so the upload endpoint always responds quickly.
const AUTH_TIMEOUT_MS = 4_000;

export async function getUserIdFromRequest(req: NextRequest): Promise<string | null> {
  const supabase = getAdminSupabaseClientIfAvailable();
  if (!supabase) return null;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), AUTH_TIMEOUT_MS)
    );
    const authPromise = supabase.auth
      .getUser(token)
      .then(({ data, error }) => (error || !data.user?.id ? null : data.user.id))
      .catch(() => null);

    return await Promise.race([authPromise, timeoutPromise]);
  } catch {
    return null;
  }
}

export async function requireUserIdFromRequest(
  req: NextRequest
): Promise<{ userId: string } | { response: NextResponse }> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    // Preserve local development flow when Auth is not wired yet.
    if (process.env.NODE_ENV !== "production") {
      return { userId: PLACEHOLDER_USER_ID };
    }
    return {
      response: NextResponse.json(
        { error: "Unauthorized. Authorization: Bearer <token> is required." },
        { status: 401 }
      ),
    };
  }

  return { userId };
}

function getBearerToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  return token || null;
}

export function requireAdminApiToken(
  req: NextRequest
): { ok: true } | { response: NextResponse } {
  const configuredToken = process.env.ADMIN_API_TOKEN?.trim();

  if (!configuredToken) {
    if (process.env.NODE_ENV !== "production") {
      return { ok: true };
    }

    return {
      response: NextResponse.json(
        { error: "ADMIN_API_TOKEN is required in production." },
        { status: 503 }
      ),
    };
  }

  const bearer = getBearerToken(req);
  if (bearer !== configuredToken) {
    return {
      response: NextResponse.json(
        { error: "Forbidden. Invalid admin token." },
        { status: 403 }
      ),
    };
  }

  return { ok: true };
}
