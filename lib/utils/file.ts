const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

const PDF_SIGNATURE = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
const ZIP_SIGNATURE = new Uint8Array([0x50, 0x4b]); // PK (DOCX is ZIP)

export function isSupportedContractFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".pdf") || lower.endsWith(".docx");
}

export function isWithinSizeLimit(sizeBytes: number): boolean {
  return sizeBytes > 0 && sizeBytes <= MAX_FILE_SIZE_BYTES;
}

/**
 * magic bytes로 실제 파일 타입 검사. 확장자와 일치해야 통과.
 * @param buffer 파일 앞부분 최소 4바이트
 * @param fileName 확장자 판별용
 */
export function checkMagicBytes(
  buffer: ArrayBuffer,
  fileName: string
): { ok: boolean; reason?: string } {
  const arr = new Uint8Array(buffer);
  const len = arr.length;
  const lower = fileName.toLowerCase();

  const looksPdf =
    len >= 4 &&
    arr[0] === PDF_SIGNATURE[0] &&
    arr[1] === PDF_SIGNATURE[1] &&
    arr[2] === PDF_SIGNATURE[2] &&
    arr[3] === PDF_SIGNATURE[3];
  const looksZip =
    len >= 2 && arr[0] === ZIP_SIGNATURE[0] && arr[1] === ZIP_SIGNATURE[1];

  if (lower.endsWith(".pdf")) {
    if (!looksPdf) {
      return {
        ok: false,
        reason: "파일 확장자는 PDF이지만 내용이 PDF 형식이 아닙니다. (magic bytes 검사 실패)",
      };
    }
    return { ok: true };
  }
  if (lower.endsWith(".docx")) {
    if (!looksZip) {
      return {
        ok: false,
        reason: "파일 확장자는 DOCX이지만 내용이 DOCX(ZIP) 형식이 아닙니다. (magic bytes 검사 실패)",
      };
    }
    return { ok: true };
  }
  return { ok: false, reason: "지원하지 않는 파일 형식입니다." };
}


