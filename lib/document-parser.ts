import {
  parseWithDoclingRequired,
  type DoclingErrorCode,
  type DoclingParseResult,
} from "./docling-adapter";

export interface DocumentZone {
  zone_type: string;
  start_page: number;
  end_page: number;
  title?: string;
  is_analysis_target: boolean;
  confidence: number;
}

export interface ParsedClause {
  clause_number: string;
  title?: string;
  content: string;
  order_index: number;
  is_auto_split?: boolean;
}

export interface ParseResult extends DoclingParseResult {
  parser: "docling";
}

export class DocumentParseError extends Error {
  code: DoclingErrorCode;

  constructor(code: DoclingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DocumentParseError";
  }
}

function normalizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function toDocumentParseError(err: unknown): DocumentParseError {
  if (err instanceof DocumentParseError) return err;
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const maybeCode = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? "Docling parse failed.";
    if (maybeCode === "DOCLING_UNAVAILABLE" || maybeCode === "DOCLING_PARSE_FAILED") {
      return new DocumentParseError(maybeCode, message);
    }
  }
  return new DocumentParseError("DOCLING_PARSE_FAILED", normalizeError(err));
}

export async function parsePdf(
  pdfBuffer: Buffer,
  filename = "contract.pdf"
): Promise<ParseResult> {
  try {
    const result = await parseWithDoclingRequired(pdfBuffer, filename);
    return { ...result, parser: "docling" };
  } catch (err) {
    throw toDocumentParseError(err);
  }
}

export async function parseDocx(
  docxBuffer: Buffer,
  filename = "contract.docx"
): Promise<ParseResult> {
  try {
    const result = await parseWithDoclingRequired(docxBuffer, filename);
    return { ...result, parser: "docling" };
  } catch (err) {
    throw toDocumentParseError(err);
  }
}
