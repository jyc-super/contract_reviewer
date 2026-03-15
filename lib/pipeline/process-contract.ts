import { validateFile } from "./steps/validate-file";
import { parsePdf, parseDocx } from "../document-parser";
import { qualityCheck } from "./steps/quality-check";
import type { Clause } from "./steps/split-clauses";
import { detectLanguage } from "../utils/language";
import { contentHash } from "../cache";
import type { DoclingDocumentPart, DoclingHeaderFooterInfo, TocEntry, SubDocument } from "../docling-adapter";

function elapsed(start: number): string {
  return `${Date.now() - start}ms`;
}

/**
 * Progress callback invoked at key pipeline milestones.
 * Receives an integer 0–100.  The caller is responsible for persisting this
 * value to the DB — the pipeline itself has no DB dependency.
 *
 * Milestone map (PDF/DOCX):
 *   5  — arrayBuffer ready
 *   10 — Docling parse request sent
 *   55 — Docling parse response received
 *   60 — Zone mapping complete
 *   65 — qualityCheck start
 *   70 — qualityCheck complete
 *   75 — Language detection complete
 *   80 — processContract() about to return
 *
 * The caller (contracts/route.ts) adds additional milestones during persist:
 *   90 — persistParseResult start
 *   95 — Zones inserted
 *   98 — Clauses inserted
 */
export type OnProgressCallback = (percent: number) => void;

/**
 * Options passed to processContract() to allow the caller to hook into
 * pipeline lifecycle events without giving the pipeline a direct DB dependency.
 *
 * onQualityCheckStart — awaited immediately before qualityCheck() runs.
 *   Use this to transition the contract DB status to "quality_checking" so the
 *   polling client can display a distinct stage for this step.
 *   Errors thrown here are intentionally NOT caught — a failed DB update
 *   should not silently continue; the caller should handle the error.
 */
export interface ProcessContractOptions {
  onProgress?: OnProgressCallback;
  onQualityCheckStart?: () => Promise<void>;
}

export interface ZoneForDb {
  pageFrom: number;
  pageTo: number;
  zoneType: string;
  confidence: number;
  isAnalysisTarget: boolean;
  text: string;
}

export interface ClauseForDb {
  zoneIndex: number;
  text: string;
  isAutoSplit: boolean;
  needsReview: boolean;
  title?: string;
  number?: string;
  /** Parent clause number for nested clauses (e.g. "1.1.1" for "1.1.1.2"). */
  parentNumber?: string;
  contentHash?: string;
  zoneKey?: string;
  /** Content format: "markdown" when text contains inline **bold** spans; "plain" otherwise. */
  contentFormat?: "markdown" | "plain";
  /** 조항 구조 유형: numbered_titled / numbered_untitled / unnumbered */
  clauseStructure?: "numbered_titled" | "numbered_untitled" | "unnumbered";
}

export interface ProcessContractResult {
  contractId?: string;
  pages: number;
  analysisTargetCount: number;
  uncertainZoneCount: number;
  clauseCount: number;
  needsReview: boolean;
  sourceLanguages?: string[];
  zones: ZoneForDb[];
  clauses: ClauseForDb[];
  parserUsed?: "docling";
  documentParts?: DoclingDocumentPart[];
  headerFooterInfo?: DoclingHeaderFooterInfo;
  tocEntries?: TocEntry[];
  subDocuments?: SubDocument[];
}

function getExtension(fileName: string): "pdf" | "docx" | "" {
  const base = fileName.toLowerCase();
  if (base.endsWith(".pdf")) return "pdf";
  if (base.endsWith(".docx")) return "docx";
  return "";
}

async function processPdf(file: File, options: ProcessContractOptions): Promise<ProcessContractResult> {
  const { onProgress, onQualityCheckStart } = options;
  const pipelineStart = Date.now();
  console.log(`[processContract] processPdf: start — file=${file.name} size=${file.size}B`);

  const t0 = Date.now();
  const buffer = Buffer.from(await file.arrayBuffer());
  console.log(`[processContract] step=arrayBuffer elapsed=${elapsed(t0)}`);
  onProgress?.(5);

  const t1 = Date.now();
  onProgress?.(10);

  // Docling 파싱 중 합성 progress: 파일 크기 기반 예상 시간으로
  // milestone 10~55 사이를 5초 간격으로 점진 보고
  const estimatedParseMs = Math.max(30_000, Math.min(600_000, 30_000 + (file.size / (1024 * 1024)) * 12_000));
  const parseProgressTimer = setInterval(() => {
    const parseElapsed = Date.now() - t1;
    const ratio = Math.min(parseElapsed / estimatedParseMs, 0.95);
    const milestone = 10 + Math.round(ratio * 45); // 10~55 범위
    onProgress?.(milestone);
  }, 5_000);

  let rawZones, rawClauses, totalPages, warnings, parser: "docling", documentParts, headerFooterInfo, tocEntries, subDocuments;
  try {
    ({ zones: rawZones, clauses: rawClauses, totalPages, warnings, parser, documentParts, headerFooterInfo, tocEntries, subDocuments } =
      await parsePdf(buffer, file.name));
  } finally {
    clearInterval(parseProgressTimer);
  }
  console.log(`[processContract] step=parsePdf elapsed=${elapsed(t1)} zones=${rawZones.length} rawClauses=${rawClauses.length} pages=${totalPages} warnings=${warnings.length}`);
  onProgress?.(55);

  const analysisTargetZones = rawZones.filter((z) => z.is_analysis_target);
  const uncertainZones = rawZones.filter((z) => !z.is_analysis_target);

  const zones: ZoneForDb[] = rawZones.map((z) => ({
    pageFrom: z.start_page,
    pageTo: z.end_page,
    zoneType: z.zone_type,
    confidence: z.confidence,
    isAnalysisTarget: z.is_analysis_target,
    text: z.text ?? z.title ?? "",
  }));

  // M-3 + M-4: Build a page-range → zone index map from zones array.
  // Uses the final zones array (which may include synthetic preamble zone)
  // so that indices match the DB-persisted zone order.
  const pageToZoneIndex = new Map<number, number>();
  zones.forEach((z, idx) => {
    for (let p = z.pageFrom; p <= z.pageTo; p++) {
      if (!pageToZoneIndex.has(p)) {
        pageToZoneIndex.set(p, idx);
      }
    }
  });

  // Fallback: key by zone_type → index within rawZones (all zones), consistent
  // with the page-based path which also indexes into the full zones array.
  const zoneKeyToIndex = new Map<string, number>();
  rawZones.forEach((z, i) => {
    if (!zoneKeyToIndex.has(z.zone_type)) {
      zoneKeyToIndex.set(z.zone_type, i);
    }
  });
  onProgress?.(60);

  const clausesForQc: Clause[] = rawClauses.map((c) => ({
    id: c.clause_number,
    // content is clean body text (heading excluded); title is stored separately.
    text: c.content,
    flags: c.is_auto_split ? ["auto_split"] : [],
  }));

  // Signal to the caller that quality check is about to start so they can
  // update the DB status to "quality_checking" before the (potentially slow)
  // Gemma quality score call.  Awaited so the DB write completes before we
  // proceed — this keeps the status transition strictly ordered.
  if (onQualityCheckStart) {
    await onQualityCheckStart();
  }
  onProgress?.(65);

  const t2 = Date.now();
  const qc = await qualityCheck(clausesForQc);
  console.log(`[processContract] step=qualityCheck elapsed=${elapsed(t2)} qcClauses=${qc.clauses.length} needsReview=${qc.needsReview}`);
  onProgress?.(70);

  // Validate clause count parity between raw parse and quality-check output.
  // A mismatch means qualityCheck merged or split clauses, which would cause
  // zoneIndex misassignment via the rawClauses[i] / qc.clauses[i] pairing.
  if (qc.clauses.length !== rawClauses.length) {
    console.warn(
      `[processContract] clause count mismatch: rawClauses=${rawClauses.length} qc.clauses=${qc.clauses.length}. ` +
        "zoneIndex assignment will use clamped fallback (index 0 for out-of-range entries)."
    );
  }

  const clauses: ClauseForDb[] = rawClauses.map((parsed, i) => {
    // qc.clauses 길이가 rawClauses와 다를 수 있음 — 안전하게 fallback
    const q = i < qc.clauses.length ? qc.clauses[i] : undefined;
    const clauseText = q?.text ?? parsed.content;
    const sectionPage = parsed.page_start;
    const zIdxFromPage =
      sectionPage !== undefined ? pageToZoneIndex.get(sectionPage) : undefined;
    const zIdx = zIdxFromPage ?? zoneKeyToIndex.get(parsed.zoneKey ?? "") ?? 0;
    return {
      zoneIndex: zIdx,
      text: clauseText,
      isAutoSplit: q?.flags?.includes("auto_split") ?? parsed.is_auto_split ?? false,
      needsReview: q?.flags?.includes("needs_review") ?? false,
      title: parsed.title?.slice(0, 200),
      number: parsed.clause_number,
      parentNumber: parsed.parent_clause_number,
      contentHash: contentHash(clauseText),
      zoneKey: parsed.zoneKey,
      contentFormat: parsed.content_format,
      clauseStructure: parsed.clause_structure,
    };
  });

  let sourceLanguages: string[] = [];
  try {
    const fullText = rawClauses.map((c) => c.content).join("\n");
    const lang = await detectLanguage(fullText);
    if (lang && lang !== "unknown") sourceLanguages.push(lang);
  } catch {
    // ignore
  }
  onProgress?.(75);

  console.log(`[processContract] processPdf: done — total=${elapsed(pipelineStart)} analysisZones=${analysisTargetZones.length} uncertainZones=${uncertainZones.length} clauses=${clauses.length}`);
  onProgress?.(80);

  return {
    pages: totalPages,
    analysisTargetCount: analysisTargetZones.length,
    uncertainZoneCount: uncertainZones.length,
    clauseCount: qc.clauses.length,
    needsReview: qc.needsReview || warnings.length > 0,
    sourceLanguages: sourceLanguages.length > 0 ? sourceLanguages : undefined,
    zones,
    clauses,
    parserUsed: parser,
    documentParts,
    headerFooterInfo,
    tocEntries,
    subDocuments,
  };
}

async function processDocx(file: File, options: ProcessContractOptions): Promise<ProcessContractResult> {
  const { onProgress, onQualityCheckStart } = options;
  const pipelineStart = Date.now();
  console.log(`[processContract] processDocx: start — file=${file.name} size=${file.size}B`);

  const t0 = Date.now();
  const buffer = Buffer.from(await file.arrayBuffer());
  console.log(`[processContract] step=arrayBuffer elapsed=${elapsed(t0)}`);
  onProgress?.(5);

  const t1 = Date.now();
  onProgress?.(10);

  // Docling 파싱 중 합성 progress (PDF와 동일 로직)
  const estimatedParseMs2 = Math.max(30_000, Math.min(600_000, 30_000 + (file.size / (1024 * 1024)) * 12_000));
  const parseProgressTimer2 = setInterval(() => {
    const parseElapsed = Date.now() - t1;
    const ratio = Math.min(parseElapsed / estimatedParseMs2, 0.95);
    const milestone = 10 + Math.round(ratio * 45);
    onProgress?.(milestone);
  }, 5_000);

  let rawZones, rawClauses, totalPages, warnings, parser: "docling", documentParts, headerFooterInfo, tocEntries, subDocuments;
  try {
    ({ zones: rawZones, clauses: rawClauses, totalPages, warnings, parser, documentParts, headerFooterInfo, tocEntries, subDocuments } =
      await parseDocx(buffer, file.name));
  } finally {
    clearInterval(parseProgressTimer2);
  }
  console.log(`[processContract] step=parseDocx elapsed=${elapsed(t1)} zones=${rawZones.length} rawClauses=${rawClauses.length} pages=${totalPages} warnings=${warnings.length}`);
  onProgress?.(55);

  const analysisTargetZones = rawZones.filter((z) => z.is_analysis_target);
  const uncertainZones = rawZones.filter((z) => !z.is_analysis_target);

  const zones: ZoneForDb[] = rawZones.map((z) => ({
    pageFrom: z.start_page,
    pageTo: z.end_page,
    zoneType: z.zone_type,
    confidence: z.confidence,
    isAnalysisTarget: z.is_analysis_target,
    text: z.text ?? z.title ?? "",
  }));

  // M-3 + M-4: page-range → zone index (same logic as processPdf).
  const pageToZoneIndex = new Map<number, number>();
  zones.forEach((z, idx) => {
    for (let p = z.pageFrom; p <= z.pageTo; p++) {
      if (!pageToZoneIndex.has(p)) {
        pageToZoneIndex.set(p, idx);
      }
    }
  });

  // Fallback: key by zone_type → index within rawZones (all zones), consistent
  // with the page-based path which also indexes into the full zones array.
  const zoneKeyToIndex = new Map<string, number>();
  rawZones.forEach((z, i) => {
    if (!zoneKeyToIndex.has(z.zone_type)) {
      zoneKeyToIndex.set(z.zone_type, i);
    }
  });
  onProgress?.(60);

  const clausesForQc: Clause[] = rawClauses.map((c) => ({
    id: c.clause_number,
    // content is clean body text (heading excluded); title is stored separately.
    text: c.content,
    flags: c.is_auto_split ? ["auto_split"] : [],
  }));

  // Signal to the caller that quality check is about to start (same as processPdf).
  if (onQualityCheckStart) {
    await onQualityCheckStart();
  }
  onProgress?.(65);

  const t2 = Date.now();
  const qc = await qualityCheck(clausesForQc);
  console.log(`[processContract] step=qualityCheck elapsed=${elapsed(t2)} qcClauses=${qc.clauses.length} needsReview=${qc.needsReview}`);
  onProgress?.(70);

  // Validate clause count parity between raw parse and quality-check output.
  if (qc.clauses.length !== rawClauses.length) {
    console.warn(
      `[processContract] clause count mismatch: rawClauses=${rawClauses.length} qc.clauses=${qc.clauses.length}.`
    );
  }

  const clauses: ClauseForDb[] = rawClauses.map((parsed, i) => {
    const q = qc.clauses[i];
    // M-3: page-based lookup first, fall back to zone_type string match.
    const sectionPage = parsed.page_start;
    const zIdxFromPage =
      sectionPage !== undefined ? pageToZoneIndex.get(sectionPage) : undefined;
    const zIdx = zIdxFromPage ?? zoneKeyToIndex.get(parsed.zoneKey ?? "") ?? 0;
    return {
      zoneIndex: zIdx,
      text: q.text,
      isAutoSplit: q.flags?.includes("auto_split") ?? parsed.is_auto_split ?? false,
      needsReview: q.flags?.includes("needs_review") ?? false,
      title: parsed.title?.slice(0, 200),
      number: parsed.clause_number,
      parentNumber: parsed.parent_clause_number,
      contentHash: contentHash(q.text),
      zoneKey: parsed.zoneKey,
      contentFormat: parsed.content_format,
      clauseStructure: parsed.clause_structure,
    };
  });

  let sourceLanguages: string[] = [];
  try {
    const fullText = rawClauses.map((c) => c.content).join("\n");
    const lang = await detectLanguage(fullText);
    if (lang && lang !== "unknown") sourceLanguages.push(lang);
  } catch {
    // ignore
  }
  onProgress?.(75);

  console.log(`[processContract] processDocx: done — total=${elapsed(pipelineStart)} analysisZones=${analysisTargetZones.length} uncertainZones=${uncertainZones.length} clauses=${clauses.length}`);
  onProgress?.(80);

  return {
    pages: totalPages,
    analysisTargetCount: analysisTargetZones.length,
    uncertainZoneCount: uncertainZones.length,
    clauseCount: qc.clauses.length,
    needsReview: qc.needsReview || warnings.length > 0,
    sourceLanguages: sourceLanguages.length > 0 ? sourceLanguages : undefined,
    zones,
    clauses,
    parserUsed: parser,
    documentParts,
    headerFooterInfo,
    tocEntries,
    subDocuments,
  };
}

export async function processContract(
  file: File,
  onProgressOrOptions?: OnProgressCallback | ProcessContractOptions
): Promise<ProcessContractResult> {
  // Support both legacy positional callback and new options object signatures
  // so existing callers (sync path in route.ts, tests) do not need changes.
  const options: ProcessContractOptions =
    typeof onProgressOrOptions === "function"
      ? { onProgress: onProgressOrOptions }
      : (onProgressOrOptions ?? {});

  const validation = await validateFile(file);
  if (!validation.isValid) {
    throw new Error(validation.reason ?? "Unsupported file or file size limit exceeded.");
  }

  const ext = getExtension(file.name ?? "");
  if (ext === "pdf") {
    return processPdf(file, options);
  }
  if (ext === "docx") {
    return processDocx(file, options);
  }

  throw new Error("Unsupported file format. Only PDF or DOCX can be uploaded.");
}
