import { NextRequest, NextResponse } from "next/server";
import { isGeminiKeyConfigured, setStoredGeminiKey } from "@/lib/gemini-key-store";
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as logger from "@/lib/logger";
import { requireAdminApiToken } from "@/lib/auth/server";

export async function GET() {
  try {
    const configured = await isGeminiKeyConfigured();
    return NextResponse.json({ configured });
  } catch {
    return NextResponse.json({ configured: false });
  }
}

const VERIFY_MODEL_IDS = [
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemma-3-4b-it",
];

function is503Like(msg: string): boolean {
  return (
    msg.includes("503") ||
    msg.includes("Service Unavailable") ||
    msg.includes("high demand")
  );
}

function isKeyInvalid(msg: string): boolean {
  return (
    msg.includes("API_KEY_INVALID") ||
    msg.includes("401") ||
    msg.includes("invalid") ||
    msg.includes("API key")
  );
}

export async function POST(req: NextRequest) {
  const adminAuth = requireAdminApiToken(req);
  if ("response" in adminAuth) return adminAuth.response;

  try {
    const body = await req.json();
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "apiKey가 필요합니다." },
        { status: 400 }
      );
    }

    const client = new GoogleGenerativeAI(apiKey);
    let lastError: unknown;
    let all503 = true;

    for (const modelId of VERIFY_MODEL_IDS) {
      try {
        const model = client.getGenerativeModel({ model: modelId });
        await model.generateContent({
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        });
        all503 = false;
        break;
      } catch (e) {
        lastError = e;
        const msg = String(e instanceof Error ? e.message : e);
        if (isKeyInvalid(msg)) {
          return NextResponse.json(
            { error: "유효하지 않은 Gemini API 키입니다. Google AI Studio에서 키를 확인해 주세요." },
            { status: 400 }
          );
        }
        if (!is503Like(msg)) {
          throw e;
        }
      }
    }

    if (all503) {
      await setStoredGeminiKey(apiKey);
      return NextResponse.json({
        ok: true,
        message:
          "Gemini 서버가 일시적으로 바쁩니다. 키는 저장되었습니다. 잠시 후 다시 시도해 주세요.",
      });
    }

    await setStoredGeminiKey(apiKey);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ENCRYPTION_KEY")) {
      return NextResponse.json(
        { error: "API 키를 암호화해 저장하려면 .env에 ENCRYPTION_KEY를 32자 이상 설정해 주세요. (데이터베이스 없이 로컬 파일에 저장됩니다.)" },
        { status: 503 }
      );
    }
    if (msg.includes("Supabase") || msg.includes("데이터베이스")) {
      return NextResponse.json(
        { error: "저장에 실패했습니다. .env에 ENCRYPTION_KEY가 있다면 로컬 파일로 저장됩니다." },
        { status: 503 }
      );
    }
    if (msg.includes("로컬 파일에 API 키를 저장하지 못했습니다")) {
      return NextResponse.json(
        { error: msg },
        { status: 500 }
      );
    }
    logger.error("Gemini API 키 저장 실패", e instanceof Error ? e : new Error(msg));
    return NextResponse.json(
      { error: msg || "API 키 저장에 실패했습니다. .env에 ENCRYPTION_KEY를 32자 이상 설정했는지 확인하고, logs/app.log를 확인해 주세요." },
      { status: 500 }
    );
  }
}
