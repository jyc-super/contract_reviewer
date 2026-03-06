/** Gemini API 키가 유효하지 않을 때 (401 등). UI에서 재입력 유도용. */
export class GeminiKeyInvalidError extends Error {
  constructor(message = "Gemini API 키가 유효하지 않습니다.") {
    super(message);
    this.name = "GeminiKeyInvalidError";
  }
}

export function isGeminiKeyInvalidError(e: unknown): boolean {
  if (e instanceof GeminiKeyInvalidError) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("API_KEY_INVALID") ||
    msg.includes("401") ||
    msg.includes("invalid API key") ||
    msg.includes("API key not valid")
  );
}
