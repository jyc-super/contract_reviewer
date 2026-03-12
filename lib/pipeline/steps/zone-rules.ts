/**
 * DOCX 구역 분류 — document-part-patterns.json 기반 규칙 엔진.
 * Gemma API 호출 없이 0-cost로 구역 분류. Port of lpr/legal/document_parts.py.
 */

import { detectDocumentPart } from "../../layout/zone-classifier";
import { detectNumberingHint } from "../../layout/numbering";

export interface ZoneDetectionResult {
  zones: Array<{
    id: string;
    type: string;
    confidence: number;
    text: string;
  }>;
}

const VALID_ZONE_TYPES = [
  "contract_body",
  "general_conditions",
  "particular_conditions",
  "technical_specification",
  "drawing_list",
  "schedule",
  "cover_page",
  "definitions",
  "commercial_terms",
  "appendices",
  "toc",
  "other",
] as const;

type ZoneType = (typeof VALID_ZONE_TYPES)[number];

function isValidZoneType(v: unknown): v is ZoneType {
  return typeof v === "string" && VALID_ZONE_TYPES.includes(v as ZoneType);
}

/** 단락 첫 줄이 구역 헤딩인지 판단 */
function detectParagraphZone(
  paragraph: string
): { type: string; confidence: number } {
  const firstLine = paragraph.split(/\n/)[0]?.trim() ?? "";
  const allUpper = firstLine === firstLine.toUpperCase() && firstLine.length > 3;
  const hint = detectNumberingHint(firstLine);
  const isHeadingLike =
    allUpper ||
    (hint?.isHeadingCandidate ?? false) ||
    /^(ARTICLE|SECTION|SCHEDULE|EXHIBIT|APPENDIX|제\s*\d+\s*조)\b/i.test(firstLine);

  const match = detectDocumentPart(firstLine, {
    isHeadingLike,
    upperRatioHint: allUpper ? 0.9 : undefined,
  });

  if (match) {
    return {
      type: match.key,
      confidence: match.isAnalysisTarget ? 0.88 : 0.82,
    };
  }

  // Clause-pattern based confidence for contract_body
  const clauseLikeMatches =
    paragraph.match(
      /(^|\n)\s*(Article\s+\d+|Section\s+\d+|Clause\s+\d+|\d+\.\d+[\.\d]*|제\s*\d+\s*조)/gim
    ) ?? [];
  const baseConfidence = 0.6 + Math.min(clauseLikeMatches.length * 0.05, 0.3);
  return { type: "contract_body", confidence: Math.min(1, baseConfidence) };
}

/**
 * 규칙 기반 구역 분류 (Gemma 호출 없음).
 */
export function ruleBasedZoning(text: string): ZoneDetectionResult {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const zones = paragraphs.map((p, index) => {
    const { type, confidence } = detectParagraphZone(p);
    return {
      id: `zone-${index + 1}`,
      type,
      confidence,
      text: p,
    };
  });

  return { zones };
}

/**
 * 구역 분류 메인 함수 — 이전 Gemma 호출 버전을 규칙 기반으로 전면 교체.
 */
export async function applyZoneRules(
  text: string
): Promise<ZoneDetectionResult> {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const zones = paragraphs.map((p, index) => {
    const { type, confidence } = detectParagraphZone(p);
    const finalType = isValidZoneType(type) ? type : "contract_body";
    return {
      id: `zone-${index + 1}`,
      type: finalType,
      confidence,
      text: p,
    };
  });

  return { zones };
}

export { ruleBasedZoning as gemmaFallbackZoning };
