import { createClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "../supabase-config-store";

const CLIENT_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  db: { schema: "public" as const },
  global: {
    headers: { "x-supabase-role": "service_role" },
  },
};

export function createAdminSupabaseClient() {
  const config = getSupabaseConfig();
  if (!config) {
    throw new Error("Supabase Admin 클라이언트 환경변수가 설정되어 있지 않습니다. 설정 페이지에서 URL과 Service Role Key를 입력해 주세요.");
  }
  return createClient(config.url, config.serviceRoleKey, CLIENT_OPTIONS);
}

/** 환경변수 또는 UI 저장값이 있으면 Admin 클라이언트 반환, 없으면 null (DB 저장 생략) */
export function getAdminSupabaseClientIfAvailable() {
  const config = getSupabaseConfig();
  if (!config) return null;
  return createClient(config.url, config.serviceRoleKey, CLIENT_OPTIONS);
}
