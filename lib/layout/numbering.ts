/** Port of lpr/legal/numbering.py — pure regex, zero API calls. */

import type { NumberingHint } from "./types";

const ROMAN_RE =
  /^(?=[MDCLXVI])M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/i;

function romanToInt(s: string): number | null {
  s = s.trim().toUpperCase();
  if (!s || !ROMAN_RE.test(s)) return null;
  const vals: Record<string, number> = {
    I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000,
  };
  let total = 0, prev = 0;
  for (const ch of [...s].reverse()) {
    const v = vals[ch] ?? 0;
    if (v < prev) total -= v;
    else { total += v; prev = v; }
  }
  return total;
}

const _SCHEDULE = /^\s*(SCHEDULE|EXHIBIT|APPENDIX)\s+([A-Z0-9]*)\b[.\-:\s]*(.*)/i;
const _ARTICLE = /^\s*ARTICLE\s+([IVXLCDM]+|\d+)\b[.\-:\s]*(.*)/i;
const _SECTION = /^\s*SECTION\s+(\d+(?:\.\d+)*)\b[.\-:]?\s*(.*)/i;
const _ROMAN_PAREN = /^\s*\(([ivxIVX]{1,8})\)\s+(.*)/;
const _ALPHA_PAREN = /^\s*\(([a-zA-Z])\)\s+(.*)/;
const _DECIMAL = /^\s*(\d+(?:\.\d+){0,6})\s*[.)]?\s+(.*)/;
const _DECIMAL_TIGHT = /^\s*(\d+)\s*[.)]\s+(.*)/;

// 한국어 조 패턴 (제3조, 제 10 조)
const _KO_JO = /^\s*제\s*(\d+)\s*조\b/;

function normDecimal(s: string): { norm: string; nums: number[] } {
  const parts = s.split(".").filter((p) => p.trim());
  const nums = parts.map((p) => parseInt(p, 10) || 0);
  return { norm: nums.join("."), nums };
}

export function detectNumberingHint(text: string): NumberingHint | null {
  const t = (text || "").trim();
  if (!t) return null;

  // 한국어 조항
  let m = _KO_JO.exec(t);
  if (m) {
    const num = parseInt(m[1], 10);
    return {
      raw: m[1],
      kind: "article",
      normalized: `ARTICLE ${num}`,
      level: 1,
      components: [num],
      isHeadingCandidate: true,
    };
  }

  m = _SCHEDULE.exec(t);
  if (m) {
    const kind = m[1].toUpperCase();
    const label = (m[2] || "").trim() || "1";
    return {
      raw: label,
      kind: "schedule",
      normalized: `${kind} ${label}`,
      level: 0,
      components: [label],
      isHeadingCandidate: true,
    };
  }

  m = _ARTICLE.exec(t);
  if (m) {
    const raw = m[1];
    const val = /^\d+$/.test(raw) ? parseInt(raw, 10) : romanToInt(raw);
    const normalized =
      val != null ? `ARTICLE ${val}` : `ARTICLE ${raw.toUpperCase()}`;
    return {
      raw,
      kind: "article",
      normalized,
      level: 1,
      components: [val ?? raw.toUpperCase()],
      isHeadingCandidate: true,
    };
  }

  m = _SECTION.exec(t);
  if (m) {
    const raw = m[1];
    const { norm, nums } = normDecimal(raw);
    return {
      raw,
      kind: "section",
      normalized: `SECTION ${norm}`,
      level: 2 + Math.max(0, nums.length - 1),
      components: nums,
      isHeadingCandidate: true,
    };
  }

  m = _ROMAN_PAREN.exec(t);
  if (m) {
    const raw = m[1];
    const val = romanToInt(raw);
    return {
      raw,
      kind: "roman_paren",
      normalized: `(${raw.toLowerCase()})`,
      level: 6,
      components: [val ?? raw.toLowerCase()],
      isHeadingCandidate: false,
    };
  }

  m = _ALPHA_PAREN.exec(t);
  if (m) {
    const raw = m[1];
    return {
      raw,
      kind: "alpha_paren",
      normalized: `(${raw.toLowerCase()})`,
      level: 5,
      components: [raw.toLowerCase()],
      isHeadingCandidate: false,
    };
  }

  m = _DECIMAL.exec(t) || _DECIMAL_TIGHT.exec(t);
  if (m) {
    const raw = m[1];
    const { norm, nums } = normDecimal(raw);
    const remainder = (m[2] || "").trim();
    const isHeading = remainder.length <= 80 && raw.length <= 8;
    // Single-integer heading like "1. Definitions" → treat as article-level
    if (isHeading && nums.length === 1 && nums[0] >= 1 && nums[0] <= 300) {
      return {
        raw,
        kind: "article",
        normalized: `ARTICLE ${nums[0]}`,
        level: 1,
        components: [nums[0]],
        isHeadingCandidate: true,
      };
    }
    const level = 3 + Math.max(0, nums.length - 1);
    return {
      raw,
      kind: "decimal",
      normalized: norm,
      level,
      components: nums,
      isHeadingCandidate: isHeading,
    };
  }

  return null;
}

export function stripNumberingPrefix(
  text: string
): { remainder: string; hint: NumberingHint | null } {
  const hint = detectNumberingHint(text);
  if (!hint) return { remainder: text.trim(), hint: null };

  const t = (text || "").trim();
  for (const rx of [
    _SCHEDULE, _ARTICLE, _SECTION, _ROMAN_PAREN, _ALPHA_PAREN,
    _DECIMAL, _DECIMAL_TIGHT,
  ]) {
    const m = rx.exec(t);
    if (m) {
      // last capture group is the remainder
      const last = m[m.length - 1] ?? "";
      return { remainder: last.trim(), hint };
    }
  }
  return { remainder: t, hint };
}
