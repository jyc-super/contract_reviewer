/**
 * Port of lpr/legal/document_parts.py — rule-based document zone classification.
 * Uses document-part-patterns.json. Zero API calls.
 */

import type { LayoutBlock } from "./types";
import PATTERNS from "./document-part-patterns.json";

// ---------------------------------------------------------------------------
// Zone display metadata (used by ContractDetailView and ClauseSectionGroup)
// ---------------------------------------------------------------------------

export const ZONE_LABELS: Record<string, string> = {
  preamble: "문서 전문",
  contract_agreement: "계약서 본문",
  general_conditions: "일반 조건",
  particular_conditions: "특수 조건",
  conditions_of_contract: "계약 조건",
  commercial_terms: "상업 조건",
  definitions: "정의 조항",
  letter_of_acceptance: "수락 서한",
  technical_specifications: "기술 시방서",
  appendices: "부속서",
  toc: "목차",
  cover_page: "표지",
  drawing_list: "도면 목록",
  form_of_tender: "입찰 서식",
  bill_of_quantities: "물량내역서",
};

export const ZONE_ORDER: string[] = [
  "preamble",
  "contract_agreement",
  "general_conditions",
  "particular_conditions",
  "conditions_of_contract",
  "commercial_terms",
  "definitions",
  "letter_of_acceptance",
  "technical_specifications",
  "appendices",
  "toc",
  "cover_page",
  "drawing_list",
  "form_of_tender",
  "bill_of_quantities",
];

export const ANALYSIS_TARGET_ZONES = new Set([
  "contract_agreement",
  "general_conditions",
  "particular_conditions",
  "conditions_of_contract",
  "commercial_terms",
  "definitions",
  "letter_of_acceptance",
]);

interface PartPattern {
  key: string;
  isAnalysisTarget: boolean;
  patterns: string[];
}

// Pre-compile regexes at module load time
const COMPILED_PARTS: Array<{
  key: string;
  isAnalysisTarget: boolean;
  regexes: RegExp[];
}> = (PATTERNS.parts as PartPattern[]).map((p) => ({
  key: p.key,
  isAnalysisTarget: p.isAnalysisTarget,
  regexes: p.patterns.map((rx) => new RegExp(rx, "i")),
}));

// Zone types that are always analysis targets regardless of detection
const ALWAYS_ANALYSIS_TARGET_KEYS = new Set([
  "contract_agreement",
  "general_conditions",
  "particular_conditions",
  "conditions_of_contract",
  "commercial_terms",
  "definitions",
]);

function upperRatio(text: string): number {
  const letters = [...text].filter((c) => /[a-zA-Z]/.test(c));
  if (!letters.length) return 0;
  return letters.filter((c) => c === c.toUpperCase()).length / letters.length;
}

/**
 * Detect which contract part a heading block belongs to.
 * Returns null if not a recognised part heading.
 */
export function detectDocumentPart(
  text: string,
  opts: {
    isHeadingLike?: boolean;
    boldRatio?: number;
    avgFontSize?: number;
    globalFontBaseline?: number;
    upperRatioHint?: number;
  } = {}
): { key: string; isAnalysisTarget: boolean } | null {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return null;

  // Strong literal triggers (always match)
  if (/^\s*this\s+contract\s+agreement\b/i.test(t)) {
    return { key: "contract_agreement", isAnalysisTarget: true };
  }
  if (/^\s*general\s+provisions\s*$/i.test(t)) {
    return { key: "general_conditions", isAnalysisTarget: true };
  }

  // Heading-like signals
  const typoHeading =
    (opts.boldRatio !== undefined && opts.boldRatio >= 0.55) ||
    (opts.avgFontSize !== undefined &&
      opts.globalFontBaseline !== undefined &&
      opts.globalFontBaseline > 0 &&
      opts.avgFontSize >= opts.globalFontBaseline * 1.10) ||
    (opts.upperRatioHint !== undefined && opts.upperRatioHint >= 0.55);

  if (!opts.isHeadingLike && !typoHeading) return null;
  if (t.length > 100) return null;
  if (/[.;?!]$/.test(t)) return null;
  if (/["[\]]/.test(t)) return null;

  const wordCount = t.split(/\s+/).length;
  if (wordCount > 12) return null;

  const ur = Math.max(
    upperRatio(t),
    opts.upperRatioHint ?? 0
  );
  if (ur < 0.35 && wordCount > 6 && !typoHeading) return null;

  // Match patterns
  for (const part of COMPILED_PARTS) {
    for (const rx of part.regexes) {
      if (rx.test(t)) {
        return { key: part.key, isAnalysisTarget: part.isAnalysisTarget };
      }
    }
  }
  return null;
}

export interface DocumentZoneInfo {
  key: string;
  title: string;
  isAnalysisTarget: boolean;
  startPage: number;
  endPage: number;
  blocks: LayoutBlock[];
}

/**
 * Get confidence score for a zone (heuristic based on key and block count).
 */
export function zoneConfidence(zone: DocumentZoneInfo): number {
  if (ALWAYS_ANALYSIS_TARGET_KEYS.has(zone.key)) return 0.90;
  if (zone.key === "contract_body") {
    // Confidence based on how many clause-like blocks
    const clauseCount = zone.blocks.filter(
      (b) => b.numberingHint !== undefined
    ).length;
    return Math.min(0.95, 0.6 + clauseCount * 0.02);
  }
  return 0.75;
}
