/**
 * Port of lpr/legal/document_parts.py — rule-based document zone classification.
 * Uses document-part-patterns.json. Zero API calls.
 */

import type { LayoutBlock } from "./types";
import PATTERNS from "./document-part-patterns.json";

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
 * Segment blocks into named document zones based on heading detection.
 * Returns zones in document order.
 */
export function segmentZones(blocks: LayoutBlock[]): DocumentZoneInfo[] {
  const zones: DocumentZoneInfo[] = [];
  let currentZone: DocumentZoneInfo | null = null;

  // Compute global font baseline (median of all block avg font sizes)
  const fontVals = blocks
    .map((b) => b.avgFontSize)
    .filter((f) => f > 0)
    .sort((a, b) => a - b);
  const globalFontBaseline =
    fontVals.length ? fontVals[Math.floor(fontVals.length / 2)] : 0;

  const flushCurrent = () => {
    if (currentZone && currentZone.blocks.length > 0) {
      zones.push(currentZone);
    }
  };

  for (const block of blocks) {
    if (block.blockType === "heading") {
      const match = detectDocumentPart(block.text, {
        isHeadingLike: true,
        boldRatio: block.boldLineRatio,
        avgFontSize: block.avgFontSize,
        globalFontBaseline,
        upperRatioHint: block.upperRatio,
      });

      if (match) {
        flushCurrent();
        currentZone = {
          key: match.key,
          title: block.text.trim(),
          isAnalysisTarget: match.isAnalysisTarget,
          startPage: block.page + 1, // convert to 1-indexed
          endPage: block.page + 1,
          blocks: [block],
        };
        continue;
      }
    }

    if (currentZone) {
      currentZone.blocks.push(block);
      currentZone.endPage = Math.max(currentZone.endPage, block.page + 1);
    } else {
      // Content before first recognized zone → treat as contract_body
      currentZone = {
        key: "contract_body",
        title: "Contract Body",
        isAnalysisTarget: true,
        startPage: block.page + 1,
        endPage: block.page + 1,
        blocks: [block],
      };
    }
  }

  flushCurrent();

  // If no zones detected at all, return single contract_body zone
  if (!zones.length && blocks.length) {
    return [
      {
        key: "contract_body",
        title: "Contract Body",
        isAnalysisTarget: true,
        startPage: blocks[0].page + 1,
        endPage: blocks[blocks.length - 1].page + 1,
        blocks,
      },
    ];
  }

  return zones;
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
