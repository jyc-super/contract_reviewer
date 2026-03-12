import { validateFile } from "./steps/validate-file";
import { parsePdf, parseDocx } from "../document-parser";
import { qualityCheck } from "./steps/quality-check";
import type { Clause } from "./steps/split-clauses";
import { detectLanguage } from "../utils/language";
import { contentHash } from "../cache";

function elapsed(start: number): string {
  return `${Date.now() - start}ms`;
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
  contentHash?: string;
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
}

function getExtension(fileName: string): "pdf" | "docx" | "" {
  const base = fileName.toLowerCase();
  if (base.endsWith(".pdf")) return "pdf";
  if (base.endsWith(".docx")) return "docx";
  return "";
}

async function processPdf(file: File): Promise<ProcessContractResult> {
  const pipelineStart = Date.now();
  console.log(`[processContract] processPdf: start — file=${file.name} size=${file.size}B`);

  const t0 = Date.now();
  const buffer = Buffer.from(await file.arrayBuffer());
  console.log(`[processContract] step=arrayBuffer elapsed=${elapsed(t0)}`);

  const t1 = Date.now();
  const { zones: rawZones, clauses: rawClauses, totalPages, warnings, parser } =
    await parsePdf(buffer, file.name);
  console.log(`[processContract] step=parsePdf elapsed=${elapsed(t1)} zones=${rawZones.length} rawClauses=${rawClauses.length} pages=${totalPages} warnings=${warnings.length}`);

  const analysisTargetZones = rawZones.filter((z) => z.is_analysis_target);
  const uncertainZones = rawZones.filter((z) => !z.is_analysis_target);

  const zones: ZoneForDb[] = rawZones.map((z) => ({
    pageFrom: z.start_page,
    pageTo: z.end_page,
    zoneType: z.zone_type,
    confidence: z.confidence,
    isAnalysisTarget: z.is_analysis_target,
    text: z.title ?? "",
  }));

  const zoneKeyToIndex = new Map<string, number>(
    analysisTargetZones.map((z, i) => [z.zone_type + "_" + z.start_page, i])
  );

  const clausesForQc: Clause[] = rawClauses.map((c) => ({
    id: c.clause_number,
    text: (c.title ? c.title + "\n" : "") + c.content,
    flags: c.is_auto_split ? ["auto_split"] : [],
  }));

  const t2 = Date.now();
  const qc = await qualityCheck(clausesForQc);
  console.log(`[processContract] step=qualityCheck elapsed=${elapsed(t2)} qcClauses=${qc.clauses.length} needsReview=${qc.needsReview}`);

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
    const q = qc.clauses[i];
    const zIdx = zoneKeyToIndex.get(parsed.clause_number.split("-")[0] + "_1") ?? 0;
    return {
      zoneIndex: zIdx,
      text: q.text,
      isAutoSplit: q.flags?.includes("auto_split") ?? parsed.is_auto_split ?? false,
      needsReview: q.flags?.includes("needs_review") ?? false,
      title: parsed.title?.slice(0, 200),
      number: parsed.clause_number,
      contentHash: contentHash(q.text),
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

  console.log(`[processContract] processPdf: done — total=${elapsed(pipelineStart)} analysisZones=${analysisTargetZones.length} uncertainZones=${uncertainZones.length} clauses=${clauses.length}`);

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
  };
}

async function processDocx(file: File): Promise<ProcessContractResult> {
  const pipelineStart = Date.now();
  console.log(`[processContract] processDocx: start — file=${file.name} size=${file.size}B`);

  const t0 = Date.now();
  const buffer = Buffer.from(await file.arrayBuffer());
  console.log(`[processContract] step=arrayBuffer elapsed=${elapsed(t0)}`);

  const t1 = Date.now();
  const { zones: rawZones, clauses: rawClauses, totalPages, warnings, parser } =
    await parseDocx(buffer, file.name);
  console.log(`[processContract] step=parseDocx elapsed=${elapsed(t1)} zones=${rawZones.length} rawClauses=${rawClauses.length} pages=${totalPages} warnings=${warnings.length}`);

  const analysisTargetZones = rawZones.filter((z) => z.is_analysis_target);
  const uncertainZones = rawZones.filter((z) => !z.is_analysis_target);

  const zones: ZoneForDb[] = rawZones.map((z) => ({
    pageFrom: z.start_page,
    pageTo: z.end_page,
    zoneType: z.zone_type,
    confidence: z.confidence,
    isAnalysisTarget: z.is_analysis_target,
    text: z.title ?? "",
  }));

  const clausesForQc: Clause[] = rawClauses.map((c) => ({
    id: c.clause_number,
    text: (c.title ? c.title + "\n" : "") + c.content,
    flags: c.is_auto_split ? ["auto_split"] : [],
  }));

  const t2 = Date.now();
  const qc = await qualityCheck(clausesForQc);
  console.log(`[processContract] step=qualityCheck elapsed=${elapsed(t2)} qcClauses=${qc.clauses.length} needsReview=${qc.needsReview}`);

  // Validate clause count parity. DOCX zoneIndex is always 0 so a mismatch
  // is less harmful than PDF, but still worth surfacing early.
  if (qc.clauses.length !== rawClauses.length) {
    console.warn(
      `[processContract] clause count mismatch: rawClauses=${rawClauses.length} qc.clauses=${qc.clauses.length}.`
    );
  }

  const clauses: ClauseForDb[] = rawClauses.map((parsed, i) => {
    const q = qc.clauses[i];
    return {
      zoneIndex: 0,
      text: q.text,
      isAutoSplit: q.flags?.includes("auto_split") ?? parsed.is_auto_split ?? false,
      needsReview: q.flags?.includes("needs_review") ?? false,
      title: parsed.title?.slice(0, 200),
      number: parsed.clause_number,
      contentHash: contentHash(q.text),
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

  console.log(`[processContract] processDocx: done — total=${elapsed(pipelineStart)} analysisZones=${analysisTargetZones.length} uncertainZones=${uncertainZones.length} clauses=${clauses.length}`);

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
  };
}

export async function processContract(file: File): Promise<ProcessContractResult> {
  const validation = await validateFile(file);
  if (!validation.isValid) {
    throw new Error(validation.reason ?? "Unsupported file or file size limit exceeded.");
  }

  const ext = getExtension(file.name ?? "");
  if (ext === "pdf") {
    return processPdf(file);
  }
  if (ext === "docx") {
    return processDocx(file);
  }

  throw new Error("Unsupported file format. Only PDF or DOCX can be uploaded.");
}
