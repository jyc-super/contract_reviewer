/**
 * Port of lpr/layout/header_footer.py — remove repeated headers/footers.
 * Zero API calls.
 */

import type { PdfLine, PdfPageInfo } from "./types";

const PAGE_NO_PATTERNS = [
  /^\s*\d+\s*$/i,              // 12
  /^\s*-\s*\d+\s*-\s*$/i,     // - 12 -
  /^\s*page\s+\d+(\s+of\s+\d+)?\s*$/i, // Page 12 / Page 12 of 220
  /^\s*p\.?\s*\d+\s*$/i,       // p.12 / p12
  /^\s*\d+\s*\/\s*\d+\s*$/i,  // 12/220
];

function isPageNumber(text: string): boolean {
  const t = (text || "").trim();
  return PAGE_NO_PATTERNS.some((rx) => rx.test(t));
}

function normLineText(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "0") // normalize all numbers (page numbers etc.)
    .toLowerCase();
}

/**
 * Remove repeated headers/footers from all pages.
 *
 * @param pages - Extracted page data
 * @param bandRatio - Top/bottom band fraction (default 12%)
 * @param repeatRatio - Remove if appears on >= this fraction of pages (default 60%)
 * @param edgeLineCount - Also consider first/last N lines as candidates
 */
export function removeRepeatedHeaderFooter(
  pages: PdfPageInfo[],
  bandRatio = 0.12,
  repeatRatio = 0.60,
  edgeLineCount = 2
): PdfPageInfo[] {
  if (!pages.length) return pages;

  // Collect candidate lines (top/bottom band or edge lines)
  const candidateCounts = new Map<string, number>();

  for (const pg of pages) {
    const h = pg.height;
    if (h <= 0) continue;
    const topY = h * bandRatio;
    const botY = h * (1 - bandRatio);
    const sorted = [...pg.lines].sort((a, b) => a.bbox[1] - b.bbox[1]);
    const n = sorted.length;

    sorted.forEach((ln, i) => {
      const y0 = ln.bbox[1];
      const y1 = ln.bbox[3];
      const inTop = y1 <= topY;
      const inBot = y0 >= botY;
      const inEdge = i < edgeLineCount || i >= Math.max(0, n - edgeLineCount);
      if (inTop || inBot || inEdge) {
        const nt = normLineText(ln.text);
        if (nt.length >= 3) {
          candidateCounts.set(nt, (candidateCounts.get(nt) ?? 0) + 1);
        }
      }
    });
  }

  const pageCount = Math.max(1, pages.length);
  const repeated = new Set<string>(
    [...candidateCounts.entries()]
      .filter(([, c]) => c / pageCount >= repeatRatio)
      .map(([t]) => t)
  );

  if (!repeated.size) return pages;

  // Filter out repeated lines from each page
  return pages.map((pg) => {
    const h = pg.height;
    if (h <= 0) return pg;
    const topY = h * bandRatio;
    const botY = h * (1 - bandRatio);
    const sorted = [...pg.lines].sort((a, b) => a.bbox[1] - b.bbox[1]);
    const n = sorted.length;

    const kept: PdfLine[] = sorted.filter((ln, i) => {
      const y0 = ln.bbox[1];
      const y1 = ln.bbox[3];
      const inBand = y1 <= topY || y0 >= botY;
      const inEdge = i < edgeLineCount || i >= Math.max(0, n - edgeLineCount);
      if (!(inBand || inEdge)) return true;
      const nt = normLineText(ln.text);
      return !isPageNumber(ln.text) && !repeated.has(nt);
    });

    return { ...pg, lines: kept };
  });
}
