/**
 * PDF/DOCX 텍스트 추출. Docling 미사용 시 fallback으로 사용.
 * 의존성: pdf-parse (PDF), mammoth (DOCX). 미설치 시 빈 문자열 반환.
 */

function getExtension(fileName: string): string {
  const base = fileName.toLowerCase();
  if (base.endsWith(".pdf")) return "pdf";
  if (base.endsWith(".docx")) return "docx";
  return "";
}

export async function extractText(file: File): Promise<string> {
  const ext = getExtension(file.name ?? "");
  const buffer = Buffer.from(await file.arrayBuffer());

  if (ext === "pdf") {
    try {
      const pdfParse = (await import("pdf-parse")).default;
      const data = await pdfParse(buffer);
      return typeof data?.text === "string" ? data.text : "";
    } catch {
      return "";
    }
  }

  if (ext === "docx") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return typeof result?.value === "string" ? result.value : "";
    } catch {
      return "";
    }
  }

  return "";
}

/**
 * PDF 페이지 단위 텍스트. pdf-parse가 페이지 수를 반환하면 활용 가능.
 */
export async function extractTextByPage(file: File): Promise<{ page: number; text: string }[]> {
  const full = await extractText(file);
  if (!full.trim()) return [];
  return [{ page: 1, text: full }];
}
