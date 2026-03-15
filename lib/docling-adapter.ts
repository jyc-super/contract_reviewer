import { detectNumberingHint, stripNumberingPrefix } from "./layout/numbering";
import { detectDocumentPart } from "./layout/zone-classifier";
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
  /** sidecar가 TOC 섹션으로 명시 마킹한 경우 true */
  is_toc?: boolean;
}

interface DoclingDocumentPart {
  part_type: string;
  page_start: number;
  page_end: number;
  title: string;
}

export interface SubDocument {
  title: string;
  page_start: number;
  page_end: number;
  document_parts: DoclingDocumentPart[];
}

interface DoclingHeaderFooterPattern {
  pattern: string;
  type: string;
}

interface DoclingHeaderFooterInfo {
  header_patterns: string[];
  footer_patterns: DoclingHeaderFooterPattern[];
  total_pages: number;
  page_number_style: string;
  removed_header_count: number;
  removed_footer_count: number;
}

export interface TocEntry {
  title: string;
  page_number: number | null;
  level: number;
  numbering: string | null;
}

interface DoclingResponse {
  sections: DoclingSection[];
  total_pages: number;
  warnings: string[];
  document_parts?: DoclingDocumentPart[];
  header_footer_info?: DoclingHeaderFooterInfo;
  toc_entries?: TocEntry[];
  sub_documents?: SubDocument[];
}

export interface DoclingParseResult {
  zones: DocumentZone[];
  clauses: ParsedClause[];
  totalPages: number;
  warnings: string[];
  documentParts?: DoclingDocumentPart[];
  headerFooterInfo?: DoclingHeaderFooterInfo;
  tocEntries?: TocEntry[];
  subDocuments?: SubDocument[];
}

export type { DoclingDocumentPart, DoclingHeaderFooterInfo };

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

// 명확히 비분석 대상인 zone 타입 (블랙리스트).
// 이 목록에 없는 모든 zone은 기본적으로 분석 대상으로 처리한다.
// 화이트리스트 방식은 EPC 등 다양한 계약 구조에서 대부분의 zone이 uncertain으로
// 분류되는 문제(analysisZones=2, uncertainZones=41)를 야기했다.
const NON_ANALYSIS_ZONES = new Set([
  "toc",
  "cover_page",
  "preamble",            // 수정 4: 전문은 리스크 분석 대상 아님
  "drawing_list",
  "form_of_tender",
  "bill_of_quantities",
  "appendices",
  "technical_specifications",
]);

function isAnalysisTarget(zoneHint: string | undefined): boolean {
  if (!zoneHint) return true; // 미분류 zone은 기본 분석 대상
  return !NON_ANALYSIS_ZONES.has(zoneHint);
}

function zoneConfidence(zoneHint: string | undefined, level: number): number {
  if (!zoneHint) return level <= 1 ? 0.8 : 0.75;
  if (!NON_ANALYSIS_ZONES.has(zoneHint)) return 0.92;
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

function sectionsToZones(
  sections: DoclingSection[],
  documentParts?: DoclingDocumentPart[]
): DocumentZone[] {
  // P1-4 (3A): document_parts 존재 시 document_parts 기반 zone 직접 생성 (confidence 0.95)
  // M-5: aggregate section content for each document_part page range into zone.text
  if (documentParts && documentParts.length > 0) {
    const zones = documentParts.map((dp) => {
      const zoneText = sections
        .filter((s) => s.page_start >= dp.page_start && s.page_end <= dp.page_end)
        .map((s) => (s.heading ? s.heading + "\n" + s.content : s.content).trim())
        .filter(Boolean)
        .join("\n\n");

      return {
        zone_type: dp.part_type || "contract_body",
        start_page: dp.page_start,
        end_page: dp.page_end,
        title: dp.title || undefined,
        text: zoneText || undefined,
        is_analysis_target: isAnalysisTarget(dp.part_type),
        confidence: 0.95,
      };
    });

    // 방어: documentParts에 preamble이 없지만 섹션에 preamble이 있으면 합성 zone 추가
    const hasPreamblePart = documentParts.some((dp) => dp.part_type === "preamble");
    if (!hasPreamblePart) {
      const preambleSections = sections.filter((s) => s.zone_hint === "preamble");
      if (preambleSections.length > 0) {
        const pText = preambleSections
          .map((s) => (s.heading ? s.heading + "\n" + s.content : s.content).trim())
          .filter(Boolean)
          .join("\n\n");
        if (pText) {
          zones.unshift({
            zone_type: "preamble",
            start_page: preambleSections[0].page_start,
            end_page: preambleSections[preambleSections.length - 1].page_end,
            title: "전문",
            text: pText,
            is_analysis_target: false,
            confidence: 0.85,
          });
        }
      }
    }

    return zones;
  }

  // Fallback: section 기반 zone 생성 + detectDocumentPart() 보정
  // P0-1 (3C): sidecar의 zone_hint를 detectDocumentPart() 패턴으로 오버라이드
  const enrichedSections = sections.map((s) => {
    if (!s.heading) return s;
    const match = detectDocumentPart(s.heading, { isHeadingLike: true });
    if (match) {
      return { ...s, zone_hint: match.key };
    }
    return s;
  });

  const topLevel = enrichedSections.filter((s) => s.level <= 1);
  if (!topLevel.length) {
    const allText = sections
      .map((s) => (s.heading ? s.heading + "\n" + s.content : s.content).trim())
      .filter(Boolean)
      .join("\n\n");
    return [
      {
        zone_type: "contract_body",
        start_page: 1,
        end_page: Math.max(...sections.map((s) => s.page_end), 1),
        title: "Contract Body",
        text: allText || undefined,
        is_analysis_target: true,
        confidence: 0.7,
      },
    ];
  }
  // 수정 3: 동일 zone_hint를 가진 연속 섹션들을 하나의 zone으로 병합.
  // document_parts 없이 section fallback으로 만들어지는 경우,
  // "Dated ____", 당사자 정보, "Background" 등 전문 구성 요소들이
  // 각각 독립 zone이 되는 과잉 분리 문제를 방지한다.
  // 단, 서로 다른 분석 대상 zone들 간의 경계는 반드시 유지한다.
  const mergedZones: DocumentZone[] = [];
  for (const s of topLevel) {
    const zoneType = s.zone_hint || "contract_body";
    const sectionText = (s.heading ? s.heading + "\n" + s.content : s.content).trim();
    const last = mergedZones[mergedZones.length - 1];
    if (last && last.zone_type === zoneType) {
      // 같은 zone_type이면 기존 zone에 병합
      last.end_page = s.page_end;
      const combined = [last.text, sectionText].filter(Boolean).join("\n\n");
      last.text = combined || undefined;
    } else {
      mergedZones.push({
        zone_type: zoneType,
        start_page: s.page_start,
        end_page: s.page_end,
        title: s.heading || undefined,
        text: sectionText || undefined,
        is_analysis_target: isAnalysisTarget(s.zone_hint),
        confidence: zoneConfidence(s.zone_hint, s.level),
      });
    }
  }
  return mergedZones;
}

/**
 * 조항 번호에서 부모 번호를 추론한다.
 *
 * 처리 규칙:
 *   "1.1.1.2"    → "1.1.1"   (마지막 세그먼트 제거)
 *   "1.1"        → "1"        (마지막 세그먼트 제거)
 *   "1"          → null       (최상위, 부모 없음)
 *   "(a)", ARTICLE 등 → null  (호출자가 컨텍스트 추적으로 설정)
 */
function inferParentClauseNumber(normalized: string): string | null {
  const dotMatch = /^(\d+(?:\.\d+)+)$/.exec(normalized);
  if (dotMatch) {
    const parts = dotMatch[1].split(".");
    if (parts.length <= 1) return null;
    return parts.slice(0, -1).join(".");
  }
  return null;
}

// ── Task 3: 2차 content 재분할 ────────────────────────────────────────────
// 조항 번호 경계 패턴 (최소 X.Y 형식, 2단계 이상).
// 행 선두의 들여쓰기(공백·탭)는 허용하되, 번호 바로 뒤에 공백이 아닌 문자(제목)가
// 따라와야 한다 — 단순 목록 번호나 날짜 등 오검출 억제.
const CLAUSE_SPLIT_RE = /(?:^|\n)[ \t]*(\d+(?:\.\d+){1,})[ \t]+\S/gm;

/**
 * 하나의 content 문자열 안에 복수의 조항 번호 경계가 있을 때 분할한다.
 *
 * 반환 조건:
 * - 경계가 2개 이상
 * - 첫 경계가 content 시작에서 50자 이내 (중간에 갑자기 시작하는 경우 제외)
 * - content 총 길이가 200자 이상 (짧은 항목 오분할 방지)
 *
 * 위 조건을 충족하지 않으면 null 반환.
 */
// 교차참조 패턴: "N.N [Title]" 또는 "N.N [Title]." 만으로 끝나는 줄은 인라인 참조
const INLINE_REF_BRACKET_ONLY_RE = /^\s*\d+(?:\.\d+)+\s+\[.*?\]\.?\s*$/;
// FIDIC 인라인 참조: "N.N [Title]," / "N.N [Title];" / "N.N [Title]:" / "N.N [Title]."
const INLINE_REF_PUNCT_RE = /^\s*\d+(?:\.\d+)+\s+\[.*?\]\s*[,;:.]/;
// FIDIC 인라인 참조 이어짐: "N.N [Title] the/a/shall/..." 등 관사·조동사가 따라오는 경우
const INLINE_REF_CONTINUATION_RE = /^\s*\d+(?:\.\d+)+\s+\[.*?\]\s*,?\s+(?:the|a|an|this|that|may|shall|and|or|to|in|of|for|with|by)\s/i;
// 브라켓 참조 + 후속 텍스트 추출: "N.N [Title] trailing text..."
const INLINE_REF_BRACKET_TRAILING_RE = /^\s*\d+(?:\.\d+)+\s+\[.*?\]\s*,?\s*(.*)/;
// 교차참조 키워드: 직전 줄이 Sub-Clause/Clause/Article 등으로 끝나는 경우
const PRECEDING_REF_KEYWORD_RE = /(?:Sub-?\s*Clause|Clause|Article|Section|Part|Chapter)\s*$/i;

/**
 * 매치된 줄이 교차참조(cross-reference)인지 판별한다.
 * 교차참조이면 true를 반환하여 분할 경계에서 제외한다.
 */
function isCrossReference(content: string, matchIndex: number): boolean {
  // 매치 위치에서 줄 텍스트 추출
  let lineStart = matchIndex;
  if (lineStart > 0 && content[lineStart] === "\n") lineStart += 1;
  let lineEnd = content.indexOf("\n", lineStart);
  if (lineEnd === -1) lineEnd = content.length;
  const lineText = content.slice(lineStart, lineEnd).trim();

  // "N.N [Title]" 또는 "N.N [Title]." 만으로 끝나는 줄
  if (INLINE_REF_BRACKET_ONLY_RE.test(lineText)) return true;
  // "N.N [Title]," / "N.N [Title];" 등 구두점이 따르는 경우
  if (INLINE_REF_PUNCT_RE.test(lineText)) return true;
  // "N.N [Title] the ..." 등 관사/조동사가 이어지는 경우
  if (INLINE_REF_CONTINUATION_RE.test(lineText)) return true;
  // "N.N [Title] + 30자 이상 텍스트" 는 본문 내 참조 문장
  const bracketTrailMatch = INLINE_REF_BRACKET_TRAILING_RE.exec(lineText);
  if (bracketTrailMatch) {
    const trailing = (bracketTrailMatch[1] ?? "").trim();
    if (trailing.length > 30) return true;
  }

  // 직전 줄이 Sub-Clause/Clause/Article 등으로 끝나는지 확인
  if (matchIndex > 1) {
    const prevLineEnd = lineStart > 0 ? lineStart - 1 : 0;
    const prevLineStart = content.lastIndexOf("\n", prevLineEnd - 1);
    const prevLine = content.slice(
      prevLineStart >= 0 ? prevLineStart + 1 : 0,
      prevLineEnd
    ).trim();
    if (PRECEDING_REF_KEYWORD_RE.test(prevLine)) return true;
  }

  return false;
}

function splitContentByClauses(
  content: string
): { number: string; text: string }[] | null {
  // RegExp 재사용 시 lastIndex 누적 방지를 위해 새 인스턴스 사용
  const re = new RegExp(CLAUSE_SPLIT_RE.source, CLAUSE_SPLIT_RE.flags);
  const matches = [...content.matchAll(re)];

  if (matches.length < 2) return null;
  if ((matches[0].index ?? 0) > 50) return null;
  if (content.length < 200) return null;

  // 교차참조 패턴을 필터링하여 실제 조항 경계만 남김
  const validMatches = matches.filter(
    (m) => !isCrossReference(content, m.index ?? 0)
  );

  if (validMatches.length < 2) return null;

  const result: { number: string; text: string }[] = [];
  for (let i = 0; i < validMatches.length; i++) {
    const start = validMatches[i].index ?? 0;
    const end =
      i + 1 < validMatches.length
        ? (validMatches[i + 1].index ?? content.length)
        : content.length;
    const chunk = content.slice(start, end).trim();
    if (chunk) {
      result.push({ number: validMatches[i][1], text: chunk });
    }
  }

  return result.length >= 2 ? result : null;
}

/**
 * heading에서 번호를 제거한 나머지(remainder)가 **제목**인지 **본문 시작**인지 판별한다.
 *
 * 본문 시작 판별 기준:
 * - 정의 마커: "means", "has the meaning", "shall mean"
 * - 따옴표/대괄호로 시작: 정의 조항 본문
 * - 80자 초과: 제목치고 너무 길음
 * - 문장 구조: 중간에 마침표/세미콜론 + 후속 텍스트
 */
function classifyHeadingRemainder(remainder: string): "title" | "body" {
  const r = remainder.trim();
  if (!r) return "title";

  // 정의 조항 마커 → 본문
  if (/\bmeans\b|\bhas\s+the\s+meaning\b|\bshall\s+mean\b/i.test(r)) return "body";

  // 따옴표·대괄호로 시작 → 정의 본문 (예: '"Absolute Guarantee"')
  if (/^["'\u201c\u201d]/.test(r)) return "body";
  // 대괄호 시작: FIDIC bracket title (`[Title]` / `[Title`) vs 정의 본문 (`["term" means...`)
  // FIDIC 조항 제목은 `[Title]` 또는 `[Title` (닫힘 괄호가 content에 있는 경우)
  // 정의 본문은 따옴표(`["`)로 시작하거나 쉼표가 2개 이상인 긴 문장
  if (/^\[/.test(r)) {
    const isFidicTitle = /^\[[A-Z]/.test(r) && !/^\["/.test(r) && r.split(",").length < 3;
    if (!isFidicTitle && r.length > 20) return "body";
  }

  // 80자 초과 → 본문
  if (r.length > 80) return "body";

  // 문장 구조 (마침표/세미콜론 + 후속 텍스트) → 본문
  if (/[.;!?]\s+\S/.test(r)) return "body";

  return "title";
}

/**
 * 고립된 마크다운 테이블 잔여물(유령 테이블)을 정리한다.
 * pdfplumber가 대괄호 주석 등을 1행짜리 표로 오감지하면 `| text | text |`
 * + `| --- | --- |` 형태의 노이즈가 일반 텍스트에 끼어든다.
 *
 * 정리 대상:
 * - 1행 테이블 + separator만 있는 불완전 테이블 → 셀 텍스트 추출
 * - separator-only 행 (`| --- | --- |`) → 제거
 */
function cleanGhostTableMarkdown(text: string): string {
  // 패턴 1: 헤더행 + separator행만 있는 불완전 테이블 (데이터행 없음)
  // 예: `| text1 | text2 |\n| --- | --- |\n`
  let cleaned = text.replace(
    /^(\|[^\n]+\|)\s*\n(\|\s*[-:]+\s*(?:\|\s*[-:]+\s*)*\|)\s*$/gm,
    (_match, headerRow: string) => {
      // 헤더행에서 셀 텍스트만 추출
      const cells = headerRow.split("|").filter((c: string) => c.trim());
      return cells.map((c: string) => c.trim()).join(" ");
    }
  );

  // 패턴 2: 고립된 separator-only 행 제거
  cleaned = cleaned.replace(/^\|\s*[-:]+\s*(?:\|\s*[-:]+\s*)*\|\s*$/gm, "");

  // 패턴 3: 일반 텍스트 중간에 끼어든 단일 파이프 행 (1행 테이블 잔여물)
  // 예: `| some text that is clearly not a table |` — 전후가 일반 텍스트
  // 조건: 2열 이하이고 셀 내용이 일반 문장(20자 이상)이면 파이프 제거
  cleaned = cleaned.replace(
    /^\|([^|]+(?:\|[^|]+)?)\|\s*$/gm,
    (_match, inner: string) => {
      const cells = inner.split("|").map((c: string) => c.trim());
      // 2열 이하 + 전체 길이 20자 이상이면 일반 텍스트로 간주
      if (cells.length <= 2 && inner.trim().length >= 20) {
        return cells.join(" ");
      }
      return _match; // 정상 테이블일 수 있으므로 유지
    }
  );

  // 연속 빈 줄 정리
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned;
}

/**
 * PDF의 시각적 줄바꿈을 문단 단위로 재흐름(reflow)한다.
 *
 * PDF에서는 각 텍스트 줄이 개별 \n으로 분리되지만, 실제로는 하나의 문단인 경우가 많다.
 * 이 함수는 "문장 중간의 단순 줄바꿈"과 "의도적 문단 구분"을 구별한다.
 *
 * 유지하는 줄바꿈:
 * - 빈 줄 (\n\n) → 문단 구분
 * - 목록 항목 시작 ((a), (i), 1., -)
 * - 마크다운 테이블 행 (|로 시작)
 * - 볼드 마크다운으로 시작하는 줄 (**로 시작)
 *
 * 합치는 줄바꿈:
 * - 소문자/대문자로 시작하는 일반 연속 줄 → 공백으로 연결
 */
function reflowParagraphs(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 빈 줄 → 문단 구분 유지
    if (!trimmed) {
      result.push("");
      continue;
    }

    // 현재 줄이 새 블록을 시작하는지 판별
    // 목록 항목 패턴:
    //   (a), (b), (aa), (bb) — 알파벳 1~3자 괄호
    //   (i), (ii), (iv), (xi) — 로마숫자 괄호
    //   (1), (2) ... (9) — 한 자릿수 숫자 괄호 (리스트 마커)
    //   1., 1), -  — 번호/대시 마커
    // 제외:
    //   (14), (30), (2024) — 두 자릿수 이상 숫자 괄호는 본문 내 인라인 참조
    //   예: "within fourteen (14) calendar days" → 리스트 아님
    const isNewBlock =
      /^\s*(?:\([a-zA-Z]{1,3}\)(?:\s|$)|\([ivxIVX]{1,8}\)(?:\s|$)|\([0-9]\)(?:\s|$)|[0-9]+[.)]\s|\-\s)/.test(line) ||
      // 마크다운 테이블 행
      trimmed.startsWith("|") ||
      // 전체 볼드 줄 (제목/소제목)
      /^\s*\*\*[^*]+\*\*\s*$/.test(line);

    // 이전 줄이 문장 종결(.)로 끝나고, 현재 줄이 긴 괄호 문장으로 시작하면 새 문단
    // 예: "(ee) Schedule 30.\n(together, the "Contract") constitute..."
    // 리스트 마커 (a), (iv), (ee) 등은 `)` 이전에 1~4자이므로 5자 이상이면 비-리스트
    const prevEndsWithPeriod = result.length > 0 && /[.;:]\s*$/.test(result[result.length - 1]);
    const startsNonListParen = /^\s*\([^)]{5,}/.test(line);
    const isNewParagraph = prevEndsWithPeriod && startsNonListParen;

    if (isNewBlock || isNewParagraph || result.length === 0) {
      result.push(line);
    } else {
      // 이전 줄이 빈 줄이면 새 줄 시작
      const prev = result[result.length - 1];
      if (prev === "") {
        result.push(line);
      } else {
        // 문장 중간 줄바꿈 → 공백으로 연결
        result[result.length - 1] = prev + " " + trimmed;
      }
    }
  }

  return result.join("\n");
}

function sectionsToClauses(sections: DoclingSection[]): ParsedClause[] {
  const clauses: ParsedClause[] = [];
  let orderIndex = 0;

  // 페이지 순서 보장: pdfplumber 병렬 처리 후 정렬이 완전하지 않을 수 있으므로
  // page_start 기준으로 명시적 정렬 수행.
  // 같은 페이지 내에서는 원래 파서 순서(index) 유지 — level 기준 정렬하면
  // "1.25"(level=2)가 같은 페이지의 "ARTICLE 2"(level=1) 뒤로 밀리는 문제 발생
  const indexedSections = sections.map((s, i) => ({ s, i }));
  const sortedSections = indexedSections
    .sort((a, b) => {
      if (a.s.page_start !== b.s.page_start) return a.s.page_start - b.s.page_start;
      // 같은 페이지면 원래 순서 유지
      return a.i - b.i;
    })
    .map((x) => x.s);

  // 비분석 zone 중 "preamble"은 참조용 clause로 포함 (UI에서 축소 표시)
  // 나머지 비분석 zone(toc, cover_page 등)은 제외
  const REFERENCE_ONLY_ZONES = new Set(["preamble"]);

  // ── Zone별 intro 병합: 각 zone의 첫 번호 조항 이전 섹션을 하나의 clause로 합침 ──
  // preamble은 전체가 intro, 다른 zone은 첫 번호 heading 이전만 intro
  const allTargetSections = sortedSections.filter(
    (s) => isAnalysisTarget(s.zone_hint) || REFERENCE_ONLY_ZONES.has(s.zone_hint ?? "")
  );

  // zone별로 그룹핑 (순서 유지)
  const zoneGroups = new Map<string, DoclingSection[]>();
  for (const s of allTargetSections) {
    const key = s.zone_hint ?? "contract_body";
    if (!zoneGroups.has(key)) zoneGroups.set(key, []);
    zoneGroups.get(key)!.push(s);
  }

  // 각 zone의 intro 섹션 수집 + 메인 루프에서 건너뛸 섹션 표시
  const introSectionSet = new WeakSet<DoclingSection>();

  for (const [zone, zoneSections] of zoneGroups) {
    // preamble은 전체가 intro
    if (zone === "preamble") {
      for (const s of zoneSections) introSectionSet.add(s);
      const content = zoneSections
        .map((s) => {
          const parts: string[] = [];
          if (s.heading) parts.push(s.heading);
          if (s.content.trim()) parts.push(s.content.trim());
          return parts.join("\n");
        })
        .filter(Boolean)
        .join("\n\n");
      if (content) {
        clauses.push({
          clause_number: "preamble-1",
          title: undefined,
          content,
          order_index: orderIndex++,
          is_auto_split: false,
          zoneKey: "preamble",
          page_start: zoneSections[0].page_start,
          content_format: "markdown",
          clause_structure: "unnumbered",
        });
      }
      continue;
    }

    // 다른 zone: 첫 번호 heading 이전 섹션을 intro로 수집
    const introSections: DoclingSection[] = [];
    let hasNumberedAfter = false;
    for (const s of zoneSections) {
      const heading = s.heading ?? "";
      const hint = heading ? detectNumberingHint(heading) : null;
      if (hint) {
        hasNumberedAfter = true;
        break;
      }
      introSections.push(s);
    }

    // 번호 조항이 뒤에 있고, intro 섹션이 1개 이상이면 병합
    if (hasNumberedAfter && introSections.length > 0) {
      for (const s of introSections) introSectionSet.add(s);
      const content = introSections
        .map((s) => {
          const parts: string[] = [];
          if (s.heading) parts.push(s.heading);
          if (s.content.trim()) parts.push(s.content.trim());
          return parts.join("\n");
        })
        .filter(Boolean)
        .join("\n\n");
      if (content) {
        clauses.push({
          clause_number: `${zone}-intro`,
          title: undefined,
          content,
          order_index: orderIndex++,
          is_auto_split: false,
          zoneKey: zone,
          page_start: introSections[0].page_start,
          content_format: "markdown",
          clause_structure: "unnumbered",
        });
      }
    }
  }

  const targetSections = allTargetSections.filter(
    (s) => !introSectionSet.has(s)
  );

  // 계층 추적: 레벨별 최근 clause_number 기록
  // alpha_paren/roman_paren 서브아이템의 부모를 추적하기 위해 마지막 숫자 조항도 별도 보관
  const levelStack = new Map<number, string>();
  let lastNumericClauseNumber: string | null = null;

  for (const section of targetSections) {
    // content holds body text only — heading is stored separately as title.
    // Guard: skip sections that have neither a heading nor any body text.
    const bodyText = section.content.trim();
    if (!bodyText && !section.heading) continue;

    // Task 6: content 첫 줄을 heading fallback으로 사용해 조항 번호를 추출한다.
    // section.heading이 없거나 번호 추출이 안 될 때 content 첫 줄로 재시도한다.
    const headingText =
      section.heading ??
      (() => {
        const firstLine = bodyText.split("\n")[0];
        return firstLine.length > 0 && firstLine.length <= 120 ? firstLine : null;
      })();
    const hint = headingText ? detectNumberingHint(headingText) : null;
    const clauseNumber =
      hint?.normalized ??
      (section.heading
        ? `${section.zone_hint ?? "general"}-${orderIndex + 1}`
        : `${section.zone_hint ?? "general"}-auto-${orderIndex + 1}`);

    // ── 부모 조항 번호 추론 ────────────────────────────────────────────────
    let parentClauseNumber: string | undefined;

    if (hint) {
      if (hint.kind === "alpha_paren" || hint.kind === "roman_paren") {
        // (a)(b)(c) / (i)(ii)(iii): 직전 숫자 조항을 부모로 설정
        if (lastNumericClauseNumber !== null) {
          parentClauseNumber = lastNumericClauseNumber;
        }
      } else {
        // decimal/article/section: normalized 번호에서 부모 추론
        const inferred = inferParentClauseNumber(hint.normalized);
        if (inferred !== null) {
          parentClauseNumber = inferred;
        } else if (hint.level > 1) {
          // 추론 실패 시 레벨 스택에서 직전 상위 레벨 조회
          for (let l = hint.level - 1; l >= 1; l--) {
            const ancestor = levelStack.get(l);
            if (ancestor !== undefined) {
              parentClauseNumber = ancestor;
              break;
            }
          }
        }
        // 숫자 계열 조항이므로 lastNumericClauseNumber 갱신
        lastNumericClauseNumber = clauseNumber;
      }

      // 레벨 스택 갱신: 현재 레벨 등록, 하위 레벨 초기화
      levelStack.set(hint.level, clauseNumber);
      for (const existingLevel of [...levelStack.keys()]) {
        if (existingLevel > hint.level) {
          levelStack.delete(existingLevel);
        }
      }
    }

    // ── Task 3: 2차 content 재분할 방어선 ──────────────────────────────────
    // sidecar가 한 section에 복수 조항을 묶어 반환한 경우 TS 측에서 분리한다.
    const subClauses = bodyText.length > 200 ? splitContentByClauses(bodyText) : null;

    if (subClauses && subClauses.length > 1) {
      for (const sub of subClauses) {
        const subHint = detectNumberingHint(sub.number);
        const subClauseNumber = subHint?.normalized ?? sub.number;
        // 부모 조항 번호 추론: 마지막 점 세그먼트 제거 (예: 1.1.1.2 → 1.1.1)
        const subParent = subClauseNumber.includes(".")
          ? subClauseNumber.slice(0, subClauseNumber.lastIndexOf("."))
          : undefined;

        // 재분할된 조항도 첫 줄의 remainder를 분류
        const subFirstLine = sub.text.split("\n")[0];
        const { remainder: subRemainder } = stripNumberingPrefix(subFirstLine);
        const subClassification = classifyHeadingRemainder(subRemainder);
        const subTitle = subClassification === "title"
          ? (subRemainder || subFirstLine).slice(0, 120)
          : undefined;

        clauses.push({
          clause_number: subClauseNumber,
          parent_clause_number: subParent,
          title: subTitle,
          content: sub.text,
          order_index: orderIndex++,
          is_auto_split: true,
          zoneKey: section.zone_hint ?? "general_conditions",
          page_start: section.page_start ?? 1,
          content_format: "markdown",
          clause_structure: subClassification === "title" ? "numbered_titled" : "numbered_untitled",
        });
      }
    } else {
      // ── 조항 구조 분류: numbered_titled / numbered_untitled / unnumbered ──
      let clauseTitle: string | undefined;
      let clauseContent = bodyText;
      let clauseStructure: "numbered_titled" | "numbered_untitled" | "unnumbered";

      if (hint && section.heading) {
        // 번호가 감지된 heading → remainder를 분류하여 title vs body 판별
        const { remainder } = stripNumberingPrefix(section.heading);
        const classification = classifyHeadingRemainder(remainder);

        if (classification === "body") {
          // 번호+본문 구조: heading 텍스트를 content 앞에 합침
          clauseTitle = undefined;
          clauseContent = (section.heading + "\n" + bodyText).trim();
          clauseStructure = "numbered_untitled";
        } else {
          // 번호+제목 구조: remainder를 title로 사용
          // FIDIC bracket title 정리: "[Title]" → "Title", "[Title" → "Title"
          let cleanTitle = remainder || section.heading;
          if (/^\[/.test(cleanTitle)) {
            cleanTitle = cleanTitle.replace(/^\[/, "").replace(/\]$/, "").trim();
          }
          clauseTitle = cleanTitle;
          clauseStructure = "numbered_titled";
        }
      } else if (!hint && section.heading) {
        // 번호 없는 heading → unnumbered (heading을 title로 유지)
        clauseTitle = section.heading;
        clauseStructure = "unnumbered";
      } else {
        // heading 자체가 없음 → unnumbered
        clauseTitle = undefined;
        clauseStructure = "unnumbered";
      }

      clauses.push({
        clause_number: clauseNumber,
        parent_clause_number: parentClauseNumber,
        title: clauseTitle,
        content: clauseContent,
        order_index: orderIndex++,
        is_auto_split: !section.heading,
        zoneKey: section.zone_hint,
        page_start: section.page_start,
        content_format: "markdown",
        clause_structure: clauseStructure,
      });
    }
  }

  if (!clauses.length && sections.length) {
    // 분석 대상이 없는 경우: TOC/cover_page를 제외한 섹션 텍스트를 병합
    const nonTocSections = sortedSections.filter(
      (s) => s.zone_hint !== "toc" && s.zone_hint !== "cover_page"
    );
    const allText = (nonTocSections.length ? nonTocSections : sortedSections)
      .map((s) => s.content)
      .join("\n\n")
      .trim();
    if (allText) {
      clauses.push({
        clause_number: "contract_body-auto-1",
        title: undefined,
        content: allText,
        order_index: 0,
        is_auto_split: true,
        content_format: "markdown",
      });
    }
  }

  // 유령 테이블 마크다운 후처리 클리닝
  for (const c of clauses) {
    c.content = reflowParagraphs(cleanGhostTableMarkdown(c.content));
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

  // P1-4 (3A): document_parts 기반 zone 생성 또는 section fallback
  // P0-1 (3C): sectionsToClauses 에도 detectDocumentPart() 보정 적용
  const enrichedSections: DoclingSection[] = raw.sections.map((s) => {
    // sidecar가 is_toc=true로 마킹한 섹션은 zone_hint를 "toc"로 강제 설정
    // — TOC 내용이 조항으로 오추출되는 것을 TypeScript 측에서도 차단
    if (s.is_toc) {
      return { ...s, zone_hint: "toc" };
    }
    if (!s.heading) return s;
    const match = detectDocumentPart(s.heading, { isHeadingLike: true });
    if (match) {
      return { ...s, zone_hint: match.key };
    }
    return s;
  });
  const zones = sectionsToZones(enrichedSections, raw.document_parts);
  const clauses = sectionsToClauses(enrichedSections);
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
    documentParts: raw.document_parts,
    headerFooterInfo: raw.header_footer_info,
    tocEntries: raw.toc_entries,
    subDocuments: raw.sub_documents,
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
