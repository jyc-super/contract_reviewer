import { NextRequest, NextResponse } from "next/server";
import { logClientError } from "@/lib/logger";

/**
 * 클라이언트(에러 바운더리 등)에서 발생한 오류를 서버 로그 파일에 기록합니다.
 * POST body: { message: string, stack?: string, digest?: string, url?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message : "Unknown client error";
    const stack = typeof body?.stack === "string" ? body.stack : undefined;
    const digest = typeof body?.digest === "string" ? body.digest : undefined;
    const url = typeof body?.url === "string" ? body.url : req.url;

    logClientError({ message, stack, digest, url });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Log failed" }, { status: 500 });
  }
}
