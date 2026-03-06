/**
 * Reserved for future auth (browser Supabase client).
 * Requires NEXT_PUBLIC_SUPABASE_ANON_KEY when used.
 * Current app uses Admin client only; this is not imported anywhere.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export function createBrowserSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Supabase 브라우저 클라이언트 환경변수가 설정되어 있지 않습니다.");
  }

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

