/**
 * 조항 분리 — detectNumberingHint 기반 헤딩 감지 + Gemma 검증 제거.
 * lpr/legal/numbering.py 로직으로 헤딩 패턴 강화. Gemma 호출 없음.
 */

import { detectNumberingHint } from "../../layout/numbering";

export interface Clause {
  id: string;
  text: string;
  flags?: string[];
}

/** numbering.ts 기반 헤딩 판별 (ARTICLE/SECTION/decimal/한국어 조) */
function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t) return false;

  // numbering hint
  const hint = detectNumberingHint(t);
  if (hint?.isHeadingCandidate) return true;

  // 명시적 키워드 (대소문자 무관)
  if (/^(Article|Section|Clause|Part)\s+\d+/i.test(t)) return true;
  if (/^Part\s+[IVX]+/i.test(t)) return true;

  // 한국어
  if (/^제\s*\d+\s*조/.test(t)) return true;
  if (/^[가-힣]\.\s/.test(t)) return true;

  return false;
}

export function regexSplitClauses(text: string): Clause[] {
  const lines = text.split(/\r?\n/);
  const clauses: Clause[] = [];
  let currentTitle: string | undefined;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentBody.length === 0) return;
    const bodyText = currentBody.join("\n").trim();
    if (!bodyText) {
      currentBody = [];
      return;
    }
    clauses.push({
      id: `clause-${clauses.length + 1}`,
      text: currentTitle ? `${currentTitle}\n${bodyText}` : bodyText,
    });
    currentBody = [];
    currentTitle = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      currentBody.push(rawLine);
      continue;
    }
    if (isHeading(line)) {
      flush();
      currentTitle = line.trim();
    } else {
      currentBody.push(rawLine);
    }
  }
  flush();

  if (clauses.length === 0) {
    return [
      {
        id: "clause-1",
        text: text.trim(),
        flags: ["auto_split", "needs_review"],
      },
    ];
  }

  return clauses;
}

export async function splitClauses(text: string): Promise<Clause[]> {
  return regexSplitClauses(text);
}
