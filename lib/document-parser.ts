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
  /** Aggregated section content for this zone (populated by sectionsToZones). */
  text?: string;
  is_analysis_target: boolean;
  confidence: number;
}

export interface ParsedClause {
  clause_number: string;
  /** Parent clause number for nested clauses (e.g. "1.1.1" for "1.1.1.2", or "1.1.1" for "(a)"). */
  parent_clause_number?: string;
  title?: string;
  content: string;
  order_index: number;
  is_auto_split?: boolean;
  zoneKey?: string;
  /** 1-indexed page number where this clause starts (from the source section). */
  page_start?: number;
  /**
   * Content format indicator.
   * "markdown" — content contains inline markdown (e.g. **bold** spans from pdfplumber).
   * "plain"    — content is plain text with no markdown markup (default).
   */
  content_format?: "markdown" | "plain";
  /**
   * 조항 구조 유형.
   * "numbered_titled"   — 번호 + 제목 + 본문 (예: "1.1 Definitions" + body)
   * "numbered_untitled" — 번호 + 본문, 제목 없음 (예: '1.1.1.1 "Absolute Guarantee" means...')
   * "unnumbered"        — 번호 없음, 본문만 (예: 서문, 전문 등)
   */
  clause_structure?: "numbered_titled" | "numbered_untitled" | "unnumbered";
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

/** CL-2: Shared implementation for both parsePdf and parseDocx. */
async function parseViaDocling(
  buffer: Buffer,
  filename: string
): Promise<ParseResult> {
  try {
    const result = await parseWithDoclingRequired(buffer, filename);
    return { ...result, parser: "docling" };
  } catch (err) {
    throw toDocumentParseError(err);
  }
}

export async function parsePdf(
  pdfBuffer: Buffer,
  filename = "contract.pdf"
): Promise<ParseResult> {
  return parseViaDocling(pdfBuffer, filename);
}

export async function parseDocx(
  docxBuffer: Buffer,
  filename = "contract.docx"
): Promise<ParseResult> {
  return parseViaDocling(docxBuffer, filename);
}
