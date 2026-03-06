/**
 * franc 기반 언어 감지. 패키지 미설치 시 "unknown" 반환.
 * @returns ISO 639-3 코드 (예: eng, kor) 또는 "unknown"
 */
export async function detectLanguage(text: string): Promise<string> {
  if (!text?.trim()) return "unknown";
  const sample = text.slice(0, 5000);
  try {
    const mod = await import("franc");
    type FrancFn = (t: string, o?: { minLength?: number }) => string;
    const franc: FrancFn = (mod as unknown as { default?: FrancFn }).default ?? (mod as unknown as FrancFn);
    const code = franc(sample, { minLength: 3 });
    return code === "und" ? "unknown" : code;
  } catch {
    return "unknown";
  }
}

/** 동기 버전 (캐시된 결과용). franc 미지원 시 "unknown" */
export function detectLanguageSync(text: string): string {
  return "unknown";
}

