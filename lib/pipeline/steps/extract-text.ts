/**
 * POLICY: PDF/DOCX 파싱은 반드시 Docling sidecar를 통해 수행합니다.
 * pdf-parse, mammoth 등의 fallback 파서는 비활성화되어 있습니다.
 * 파싱이 필요하면 lib/document-parser.ts의 parsePdf() / parseDocx()를 사용하세요.
 */

export async function extractText(_file: File): Promise<string> {
  throw new Error(
    "extractText()는 비활성화되었습니다. " +
      "PDF/DOCX 파싱은 lib/document-parser.ts의 parsePdf() / parseDocx()를 통해 Docling sidecar를 사용하세요."
  );
}

export async function extractTextByPage(_file: File): Promise<{ page: number; text: string }[]> {
  throw new Error(
    "extractTextByPage()는 비활성화되었습니다. " +
      "PDF/DOCX 파싱은 lib/document-parser.ts의 parsePdf() / parseDocx()를 통해 Docling sidecar를 사용하세요."
  );
}
