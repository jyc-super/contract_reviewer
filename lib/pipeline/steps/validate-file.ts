import { isSupportedContractFile, isWithinSizeLimit, checkMagicBytes } from "../../utils/file";

export interface FileValidationResult {
  isValid: boolean;
  reason?: string;
}

export async function validateFile(file: File): Promise<FileValidationResult> {
  const name = file.name ?? "";
  const size = file.size ?? 0;

  if (!isSupportedContractFile(name)) {
    return {
      isValid: false,
      reason: "지원하지 않는 파일 형식입니다. PDF 또는 DOCX만 업로드할 수 있습니다.",
    } satisfies FileValidationResult;
  }

  if (!isWithinSizeLimit(size)) {
    return {
      isValid: false,
      reason: "파일 용량이 너무 큽니다. 최대 50MB까지 업로드할 수 있습니다.",
    } satisfies FileValidationResult;
  }

  const buf = await file.slice(0, 8).arrayBuffer();
  const magic = checkMagicBytes(buf, name);
  if (!magic.ok) {
    return { isValid: false, reason: magic.reason } satisfies FileValidationResult;
  }

  return {
    isValid: true,
  } satisfies FileValidationResult;
}
