/**
 * Port of lpr/layout/blockify.py — group PdfLines into LayoutBlocks,
 * then detect headings. Zero API calls.
 */

import type { LayoutBlock, PdfLine, PdfPageInfo } from "./types";
import { detectNumberingHint } from "./numbering";
import { safeJoinLines } from "./normalize";

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function bboxUnion(
  a: [number, number, number, number],
  b: [number, number, number, number]
): [number, number, number, number] {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
}

function upperRatio(text: string): number {
  const letters = [...text].filter((c) => /[a-zA-Z]/.test(c));
  if (!letters.length) return 0;
  return letters.filter((c) => c === c.toUpperCase()).length / letters.length;
}

let _blockCounter = 0;

function makeBlockId(page: number, idx: number): string {
  return `p${page}_b${idx}_${++_blockCounter}`;
}

/**
 * Group sorted lines (across all pages) into paragraph-like LayoutBlocks.
 */
export function blockifyLines(pages: PdfPageInfo[]): LayoutBlock[] {
  // Flatten all lines, already sorted by (page, y0, x0) within each page
  const allLines: PdfLine[] = pages.flatMap((pg) =>
    [...pg.lines].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
  );

  if (!allLines.length) return [];

  const heights = allLines
    .map((ln) => ln.bbox[3] - ln.bbox[1])
    .filter((h) => h > 0);
  const medH = median(heights) || 10;
  const yGapThresh = Math.max(3.5, medH * 0.9);

  const blocks: LayoutBlock[] = [];
  const pageBlockCount = new Map<number, number>();

  let current: PdfLine[] = [];
  let currentBbox: [number, number, number, number] | null = null;
  let currentPage: number | null = null;

  const flush = () => {
    if (!current.length || currentBbox === null || currentPage === null) {
      current = [];
      currentBbox = null;
      currentPage = null;
      return;
    }

    const indentX = Math.min(...current.map((ln) => ln.bbox[0]));
    const text = safeJoinLines(current.map((ln) => ln.text));
    const hint = detectNumberingHint(text) ?? undefined;

    const fontSizes = current
      .map((ln) => ln.fontSize)
      .filter((f) => f > 0);
    const avgFontSize = fontSizes.length
      ? fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length
      : 0;

    const boldCount = current.filter((ln) => ln.isBold).length;
    const boldLineRatio = boldCount / Math.max(1, current.length);

    const ur = upperRatio(text);

    const pgIdx = pageBlockCount.get(currentPage) ?? 0;
    pageBlockCount.set(currentPage, pgIdx + 1);

    blocks.push({
      id: makeBlockId(currentPage, pgIdx),
      page: currentPage,
      bbox: currentBbox,
      text,
      lines: current,
      indentX,
      blockType: "paragraph",
      numberingHint: hint,
      avgFontSize,
      boldLineRatio,
      upperRatio: ur,
    });

    current = [];
    currentBbox = null;
    currentPage = null;
  };

  for (const ln of allLines) {
    if (!ln.text.trim()) continue;

    if (currentPage === null) {
      currentPage = ln.page;
      current = [ln];
      currentBbox = ln.bbox;
      continue;
    }

    // Page break → new block
    if (ln.page !== currentPage) {
      flush();
      currentPage = ln.page;
      current = [ln];
      currentBbox = ln.bbox;
      continue;
    }

    const prev = current[current.length - 1];
    const yGap = ln.bbox[1] - prev.bbox[3];
    const indentShift = Math.abs(
      ln.bbox[0] - Math.min(...current.map((l) => l.bbox[0]))
    );

    if (yGap > yGapThresh || indentShift > 80) {
      flush();
      currentPage = ln.page;
      current = [ln];
      currentBbox = ln.bbox;
    } else {
      current.push(ln);
      currentBbox = bboxUnion(currentBbox!, ln.bbox);
    }
  }
  flush();

  return blocks;
}

/**
 * Heuristic heading detection — mutates block.blockType in-place.
 * Port of lpr/layout/blockify.py:mark_heading_blocks().
 */
export function markHeadingBlocks(blocks: LayoutBlock[]): void {
  // Compute per-page and global font size median
  const pageFonts = new Map<number, number[]>();
  for (const b of blocks) {
    if (b.avgFontSize > 0) {
      const arr = pageFonts.get(b.page) ?? [];
      arr.push(b.avgFontSize);
      pageFonts.set(b.page, arr);
    }
  }
  const pageMed = new Map<number, number>(
    [...pageFonts.entries()].map(([p, fs]) => [p, median(fs)])
  );
  const allFonts = [...pageFonts.values()].flat();
  const globalMed = median(allFonts) || 0;

  for (const b of blocks) {
    const t = b.text.trim();
    if (!t) continue;

    const pgMed = pageMed.get(b.page) ?? globalMed;

    const sizeProminent =
      b.avgFontSize > 0 && pgMed > 0 && b.avgFontSize >= pgMed * 1.12;
    const boldProminent = b.boldLineRatio >= 0.55 && t.length <= 140;
    const typoHeading =
      (sizeProminent || boldProminent) &&
      b.upperRatio >= 0.35 &&
      t.length <= 180;

    // Explicit ARTICLE/SECTION/SCHEDULE start
    if (
      /^(ARTICLE|SECTION|SCHEDULE|EXHIBIT|APPENDIX)\s/i.test(t) ||
      /^제\s*\d+\s*조\b/.test(t)
    ) {
      b.blockType = "heading";
      continue;
    }

    // Numbering hint says heading candidate
    if (b.numberingHint?.isHeadingCandidate) {
      b.blockType = "heading";
      continue;
    }

    if (typoHeading) {
      b.blockType = "heading";
      continue;
    }

    // All-caps short line
    const letters = [...t].filter((c) => /[a-zA-Z]/.test(c)).length;
    const uppers = [...t].filter((c) => /[A-Z]/.test(c)).length;
    if (letters > 0 && letters <= 80 && uppers / letters > 0.8) {
      b.blockType = "heading";
    }
  }
}
