/** Shared types for rule-based PDF/DOCX layout pipeline. */

export interface PdfWord {
  text: string;
  bbox: [number, number, number, number]; // [x0, y0, x1, y1] screen-space
}

export interface PdfLine {
  page: number; // 0-indexed
  text: string;
  bbox: [number, number, number, number]; // [x0, y0, x1, y1] screen-space
  words: PdfWord[];
  fontSize: number;
  isBold: boolean;
}

export interface PdfPageInfo {
  pageIndex: number; // 0-indexed
  width: number;
  height: number;
  lines: PdfLine[];
}

export interface NumberingHint {
  raw: string;
  kind: "article" | "section" | "decimal" | "alpha_paren" | "roman_paren" | "schedule";
  normalized: string;
  level: number; // 0=schedule, 1=article, 2=section, 3-4=decimal, 5=alpha, 6=roman
  components: (number | string)[];
  isHeadingCandidate: boolean;
}

export interface LayoutBlock {
  id: string;
  page: number;
  bbox: [number, number, number, number];
  text: string;
  lines: PdfLine[];
  indentX: number;
  blockType: "paragraph" | "heading";
  numberingHint?: NumberingHint;
  avgFontSize: number;
  boldLineRatio: number;
  upperRatio: number;
}
