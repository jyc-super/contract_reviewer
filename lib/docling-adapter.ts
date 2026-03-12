import { detectNumberingHint } from "./layout/numbering";
import type { DocumentZone, ParsedClause } from "./document-parser";

export type DoclingErrorCode =
  | "DOCLING_UNAVAILABLE"
  | "DOCLING_PARSE_FAILED";

export class DoclingParseError extends Error {
  code: DoclingErrorCode;

  constructor(code: DoclingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "DoclingParseError";
  }
}

interface DoclingSection {
  heading: string;
  level: number;
  content: string;
  page_start: number;
  page_end: number;
  zone_hint: string;
}

interface DoclingResponse {
  sections: DoclingSection[];
  total_pages: number;
  warnings: string[];
}

export interface DoclingParseResult {
  zones: DocumentZone[];
  clauses: ParsedClause[];
  totalPages: number;
  warnings: string[];
}

// When instrumentation.ts auto-starts the sidecar, it may still be importing
// Python dependencies on first parse (lazy-import mode).  Give the adapter
// a longer window so it does not immediately fail with DOCLING_UNAVAILABLE.
const DOCLING_READY_WAIT_MS = 30_000;
const DOCLING_HEALTH_INTERVAL_MS = 1_000;
const DOCLING_PARSE_RETRIES = 2;
// 300s: 180s baseline for Windows Defender DLL scan + headroom for large-PDF
// batching (e.g. 215-page PDF split into 5×50-page batches at ~40s each).
// The sidecar processes batches internally in a single HTTP request, so the
// full multi-batch duration must fit within this timeout.
const DOCLING_PARSE_TIMEOUT_MS = 300_000;

const ANALYSIS_TARGET_ZONES = new Set([
  "contract_agreement",
  "general_conditions",
  "particular_conditions",
  "conditions_of_contract",
  "commercial_terms",
  "definitions",
  "contract_body",
]);

function isAnalysisTarget(zoneHint: string): boolean {
  return ANALYSIS_TARGET_ZONES.has(zoneHint);
}

function zoneConfidence(zoneHint: string, level: number): number {
  if (ANALYSIS_TARGET_ZONES.has(zoneHint)) return 0.92;
  if (zoneHint === "toc" || zoneHint === "cover_page") return 0.85;
  return level <= 1 ? 0.8 : 0.75;
}

function normalizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getSidecarUrl(): string {
  return process.env.DOCLING_SIDECAR_URL ?? "http://127.0.0.1:8766";
}

export async function isDoclingAvailable(): Promise<boolean> {
  const sidecarUrl = getSidecarUrl();
  try {
    const res = await fetch(`${sidecarUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as {
      status?: string;
      // legacy field (v1.1): always true when server is up
      docling?: boolean;
      // lazy-import mode: false until first /parse or preload completes
      models_ready?: boolean;
    };
    // Server is "available" if it is reachable and status is ok.
    // In lazy-import mode models_ready is false until first parse — that is fine.
    // We fall back to checking the legacy `docling` field for older sidecar versions.
    return json.status === "ok" || json.docling === true;
  } catch {
    return false;
  }
}

async function waitForDoclingReady(timeoutMs = DOCLING_READY_WAIT_MS): Promise<boolean> {
  const startedAt = Date.now();
  console.log(`[DoclingAdapter] waitForDoclingReady: polling sidecar health (timeout=${timeoutMs}ms)`);
  while (Date.now() - startedAt < timeoutMs) {
    if (await isDoclingAvailable()) {
      const elapsed = Date.now() - startedAt;
      console.log(`[DoclingAdapter] waitForDoclingReady: sidecar ready in ${elapsed}ms`);
      return true;
    }
    await sleep(DOCLING_HEALTH_INTERVAL_MS);
  }
  const elapsed = Date.now() - startedAt;
  console.warn(`[DoclingAdapter] waitForDoclingReady: timed out after ${elapsed}ms`);
  return false;
}

function sectionsToZones(sections: DoclingSection[]): DocumentZone[] {
  const topLevel = sections.filter((s) => s.level <= 1);
  if (!topLevel.length) {
    return [
      {
        zone_type: "contract_body",
        start_page: 1,
        end_page: Math.max(...sections.map((s) => s.page_end), 1),
        title: "Contract Body",
        is_analysis_target: true,
        confidence: 0.7,
      },
    ];
  }
  return topLevel.map((s) => ({
    zone_type: s.zone_hint || "contract_body",
    start_page: s.page_start,
    end_page: s.page_end,
    title: s.heading || undefined,
    is_analysis_target: isAnalysisTarget(s.zone_hint),
    confidence: zoneConfidence(s.zone_hint, s.level),
  }));
}

function sectionsToClauses(sections: DoclingSection[]): ParsedClause[] {
  const clauses: ParsedClause[] = [];
  let orderIndex = 0;
  const targetSections = sections.filter((s) => isAnalysisTarget(s.zone_hint));

  for (const section of targetSections) {
    const fullText = (
      section.heading ? section.heading + "\n" + section.content : section.content
    ).trim();
    if (!fullText) continue;

    const hint = section.heading ? detectNumberingHint(section.heading) : null;
    const clauseNumber =
      hint?.normalized ??
      (section.heading
        ? `${section.zone_hint}-${orderIndex + 1}`
        : `${section.zone_hint}-auto-${orderIndex + 1}`);

    clauses.push({
      clause_number: clauseNumber,
      title: section.heading || undefined,
      content: fullText,
      order_index: orderIndex++,
      is_auto_split: !section.heading,
    });
  }

  if (!clauses.length && sections.length) {
    const allText = sections.map((s) => s.content).join("\n\n").trim();
    if (allText) {
      clauses.push({
        clause_number: "contract_body-auto-1",
        title: undefined,
        content: allText,
        order_index: 0,
        is_auto_split: true,
      });
    }
  }

  return clauses;
}

async function parseOnce(
  buffer: Buffer,
  filename: string
): Promise<DoclingParseResult> {
  const sidecarUrl = getSidecarUrl();
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const safeBytes = new Uint8Array(bytes.length);
  safeBytes.set(bytes);
  const form = new FormData();
  form.append(
    "file",
    new Blob([safeBytes], { type: "application/octet-stream" }),
    filename
  );

  return requestDoclingParse(sidecarUrl, form);
}

async function requestDoclingParse(
  sidecarUrl: string,
  form: FormData
): Promise<DoclingParseResult> {
  let res: Response;
  const fetchStart = Date.now();
  console.log(`[DoclingAdapter] requestDoclingParse: POST ${sidecarUrl}/parse (timeout=${DOCLING_PARSE_TIMEOUT_MS}ms)`);
  try {
    res = await fetch(`${sidecarUrl}/parse`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(DOCLING_PARSE_TIMEOUT_MS),
    });
  } catch (err) {
    const elapsed = Date.now() - fetchStart;
    console.error(`[DoclingAdapter] requestDoclingParse: fetch failed after ${elapsed}ms — ${normalizeError(err)}`);
    throw new DoclingParseError(
      "DOCLING_UNAVAILABLE",
      `Docling sidecar request failed: ${normalizeError(err)}`
    );
  }

  const httpElapsed = Date.now() - fetchStart;
  console.log(`[DoclingAdapter] requestDoclingParse: HTTP ${res.status} received in ${httpElapsed}ms`);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 503 || res.status === 502 || res.status === 504) {
      throw new DoclingParseError(
        "DOCLING_UNAVAILABLE",
        `Docling sidecar is unavailable (${res.status}). ${body}`.trim()
      );
    }
    throw new DoclingParseError(
      "DOCLING_PARSE_FAILED",
      `Docling parse failed (${res.status}). ${body}`.trim()
    );
  }

  const jsonStart = Date.now();
  const raw = (await res.json()) as DoclingResponse;
  const jsonElapsed = Date.now() - jsonStart;
  console.log(`[DoclingAdapter] requestDoclingParse: JSON parsed in ${jsonElapsed}ms — sections=${raw.sections?.length ?? 0}`);
  if (!raw.sections?.length) {
    throw new DoclingParseError(
      "DOCLING_PARSE_FAILED",
      "Docling returned no sections."
    );
  }

  const zones = sectionsToZones(raw.sections);
  const clauses = sectionsToClauses(raw.sections);
  if (!clauses.length) {
    throw new DoclingParseError(
      "DOCLING_PARSE_FAILED",
      "Docling returned sections but no clauses."
    );
  }

  return {
    zones,
    clauses,
    totalPages: raw.total_pages ?? 1,
    warnings: raw.warnings ?? [],
  };
}

export async function parseWithDoclingRequired(
  buffer: Buffer,
  filename: string
): Promise<DoclingParseResult> {
  const overallStart = Date.now();
  const sidecarUrl = getSidecarUrl();
  console.log(`[DoclingAdapter] parseWithDoclingRequired: start — file=${filename} size=${buffer.length}B sidecar=${sidecarUrl}`);

  // Fast check first. Only enter full polling loop if sidecar is not immediately available.
  const immediatelyReady = await isDoclingAvailable();
  if (!immediatelyReady) {
    const ready = await waitForDoclingReady(DOCLING_READY_WAIT_MS);
    if (!ready) {
      const elapsed = Date.now() - overallStart;
      console.error(`[DoclingAdapter] parseWithDoclingRequired: sidecar unavailable after ${elapsed}ms`);
      throw new DoclingParseError(
        "DOCLING_UNAVAILABLE",
        `Docling sidecar is not responding at ${sidecarUrl}. ` +
          "Ensure the sidecar is running (run.bat or scripts\\start_sidecar.bat) and retry."
      );
    }
  }

  const result = await parseWithRetry(() => parseOnce(buffer, filename), DOCLING_PARSE_RETRIES);
  const elapsed = Date.now() - overallStart;
  console.log(`[DoclingAdapter] parseWithDoclingRequired: done — zones=${result.zones.length} clauses=${result.clauses.length} pages=${result.totalPages} elapsed=${elapsed}ms`);
  return result;
}

async function parseWithRetry<T>(
  task: () => Promise<T>,
  retries: number
): Promise<T> {
  let lastError: DoclingParseError | null = null;
  const totalStart = Date.now();

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptStart = Date.now();
    console.log(`[DoclingAdapter] parseWithRetry: attempt ${attempt + 1}/${retries + 1}`);
    try {
      const result = await task();
      const elapsed = Date.now() - attemptStart;
      const total = Date.now() - totalStart;
      console.log(`[DoclingAdapter] parseWithRetry: attempt ${attempt + 1} succeeded in ${elapsed}ms (total=${total}ms)`);
      return result;
    } catch (err) {
      const elapsed = Date.now() - attemptStart;
      if (err instanceof DoclingParseError) {
        lastError = err;
      } else {
        lastError = new DoclingParseError(
          "DOCLING_PARSE_FAILED",
          normalizeError(err)
        );
      }
      console.warn(`[DoclingAdapter] parseWithRetry: attempt ${attempt + 1} failed after ${elapsed}ms — ${lastError.code}: ${lastError.message}`);

      if (attempt < retries) {
        const delay = 500 * (attempt + 1);
        console.log(`[DoclingAdapter] parseWithRetry: waiting ${delay}ms before retry`);
        await sleep(delay);
      }
    }
  }

  const total = Date.now() - totalStart;
  console.error(`[DoclingAdapter] parseWithRetry: all ${retries + 1} attempts exhausted after ${total}ms`);
  throw (
    lastError ??
    new DoclingParseError(
      "DOCLING_PARSE_FAILED",
      "Unknown Docling parsing error."
    )
  );
}
