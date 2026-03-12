/**
 * PDF layout extraction using pdfjs-dist (replaces Gemini PDF inlineData calls).
 * Port of lpr/ingest/pdf_reader.py — zero API calls.
 */

import type { PdfLine, PdfPageInfo, PdfWord } from "./types";

interface RawItem {
  text: string;
  tx: number; // PDF x (left edge)
  ty: number; // PDF y (baseline, increases upward)
  width: number;
  fontSize: number;
  fontName: string;
}

function groupIntoLines(
  items: RawItem[],
  pageHeight: number
): PdfLine[] {
  if (!items.length) return [];

  // Sort by ty descending (high ty = top of page in PDF coords), then tx ascending
  items.sort((a, b) =>
    Math.abs(b.ty - a.ty) > 1 ? b.ty - a.ty : a.tx - b.tx
  );

  // Group items with similar ty (within 40% of fontSize tolerance)
  const lineGroups: RawItem[][] = [];
  let current: RawItem[] = [];
  let currentTy = items[0].ty;

  for (const item of items) {
    const tol = Math.max(2, item.fontSize * 0.4);
    if (Math.abs(item.ty - currentTy) <= tol) {
      current.push(item);
    } else {
      if (current.length) lineGroups.push(current);
      current = [item];
      currentTy = item.ty;
    }
  }
  if (current.length) lineGroups.push(current);

  // Convert groups to PdfLine
  const lines: PdfLine[] = [];
  for (const group of lineGroups) {
    group.sort((a, b) => a.tx - b.tx);
    const text = group.map((i) => i.text).join(" ").trim();
    if (!text) continue;

    const avgFontSize =
      group.reduce((s, i) => s + i.fontSize, 0) / group.length;
    const boldCount = group.filter((i) => /bold/i.test(i.fontName)).length;
    const isBold = boldCount / group.length >= 0.5;

    // Convert PDF coords → screen coords (origin top-left, y increases downward)
    const words: PdfWord[] = group.map((i) => {
      const screenY0 = pageHeight - i.ty - i.fontSize;
      const screenY1 = pageHeight - i.ty + i.fontSize * 0.2;
      return {
        text: i.text,
        bbox: [i.tx, screenY0, i.tx + i.width, screenY1],
      };
    });

    const x0 = Math.min(...words.map((w) => w.bbox[0]));
    const y0 = Math.min(...words.map((w) => w.bbox[1]));
    const x1 = Math.max(...words.map((w) => w.bbox[2]));
    const y1 = Math.max(...words.map((w) => w.bbox[3]));

    lines.push({
      page: 0, // filled by caller
      text,
      bbox: [x0, y0, x1, y1],
      words,
      fontSize: avgFontSize,
      isBold,
    });
  }

  return lines;
}

export async function extractPdfPages(buffer: Buffer): Promise<PdfPageInfo[]> {
  // Dynamic import to avoid SSR/build issues with pdfjs-dist
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Disable worker — not available in Node.js
  pdfjsLib.GlobalWorkerOptions.workerSrc = "";

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    // Disable features not needed for text extraction
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });

  const doc = await loadingTask.promise;
  const pages: PdfPageInfo[] = [];

  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1); // pdfjs is 1-indexed
    const viewport = page.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    const textContent = await page.getTextContent();

    const rawItems: RawItem[] = [];
    for (const item of textContent.items) {
      // TextItem has str, transform, width, fontName
      const ti = item as {
        str?: string;
        transform?: number[];
        width?: number;
        fontName?: string;
      };
      const str = (ti.str || "").trim();
      if (!str) continue;

      const transform = ti.transform ?? [1, 0, 0, 1, 0, 0];
      const [sx, , , sy, tx, ty] = transform;
      const fontSize = Math.abs(sy) || Math.hypot(sx, sy) || 10;
      const width = typeof ti.width === "number" && ti.width > 0 ? ti.width : fontSize * str.length * 0.6;

      rawItems.push({
        text: str,
        tx,
        ty,
        width,
        fontSize,
        fontName: ti.fontName || "",
      });
    }

    const lines = groupIntoLines(rawItems, pageHeight);
    // Assign page index
    for (const ln of lines) ln.page = i;

    pages.push({ pageIndex: i, width: pageWidth, height: pageHeight, lines });
  }

  return pages;
}
