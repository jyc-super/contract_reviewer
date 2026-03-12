import { NextRequest, NextResponse } from "next/server";
import { isSupabaseConfigConfigured, setSupabaseConfig } from "@/lib/supabase-config-store";
import { createClient } from "@supabase/supabase-js";
import * as logger from "@/lib/logger";
import { requireAdminApiToken } from "@/lib/auth/server";

export async function GET() {
  try {
    const configured = isSupabaseConfigConfigured();
    return NextResponse.json({ configured });
  } catch {
    return NextResponse.json({ configured: false });
  }
}

export async function POST(req: NextRequest) {
  const adminAuth = requireAdminApiToken(req);
  if ("response" in adminAuth) return adminAuth.response;

  try {
    const body = await req.json();
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    const serviceRoleKey = typeof body?.serviceRoleKey === "string" ? body.serviceRoleKey.trim() : "";

    if (!url || !serviceRoleKey) {
      return NextResponse.json(
        { error: "Supabase URL과 Service Role Key를 모두 입력해 주세요." },
        { status: 400 }
      );
    }

    // 연결 테스트: 해당 url·키로 접속 가능 여부 확인 (contracts 테이블 없어도 저장 허용)
    try {
      const testClient = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
      const { error } = await testClient.from("contracts").select("id").limit(1).maybeSingle();
      const isTableMissing =
        error?.message?.includes("Could not find the table") ||
        error?.message?.includes("schema cache") ||
        error?.code === "42P01";
      if (error && !isTableMissing && error.code !== "PGRST116") {
        return NextResponse.json(
          { error: "연결에 실패했습니다. URL과 Service Role Key를 확인해 주세요. (" + (error.message ?? error.code) + ")" },
          { status: 400 }
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Invalid API key") || msg.includes("JWT") || msg.includes("401")) {
        return NextResponse.json(
          { error: "유효하지 않은 Service Role Key입니다. Supabase 대시보드에서 확인해 주세요." },
          { status: 400 }
        );
      }
      // 테이블 없음(schema cache 등)은 연결은 된 것이므로 저장 허용
      if (msg.includes("Could not find the table") || msg.includes("schema cache")) {
        // 아래 setSupabaseConfig로 진행
      } else {
        return NextResponse.json(
          { error: "연결에 실패했습니다. URL과 키를 확인해 주세요." },
          { status: 400 }
        );
      }
    }

    setSupabaseConfig({ url, serviceRoleKey });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ENCRYPTION_KEY")) {
      return NextResponse.json(
        { error: "저장을 위해 .env에 ENCRYPTION_KEY를 32자 이상 설정해 주세요. (로컬 파일에 암호화 저장됩니다.)" },
        { status: 503 }
      );
    }
    logger.error("Supabase 설정 저장 실패", e instanceof Error ? e : new Error(msg));
    return NextResponse.json(
      { error: msg || "저장에 실패했습니다." },
      { status: 500 }
    );
  }
}
