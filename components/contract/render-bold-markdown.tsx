import type { ReactNode } from "react";

const BOLD_MD_RE = /\*\*(.+?)\*\*/g;

/**
 * 마크다운 **bold** 패턴을 <strong> 태그로 변환합니다.
 * 패턴이 없으면 원본 문자열을 그대로 반환합니다.
 */
export function renderBoldMarkdown(line: string, keyPrefix: string): ReactNode {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset lastIndex for global regex
  BOLD_MD_RE.lastIndex = 0;

  while ((match = BOLD_MD_RE.exec(line)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }
    // Add the bold text
    parts.push(
      <strong key={`${keyPrefix}-b${match.index}`} className="font-bold">
        {match[1]}
      </strong>
    );
    lastIndex = match.index + match[0].length;
  }

  // No bold patterns found — return original string (avoids unnecessary wrapper)
  if (parts.length === 0) return line;

  // Add remaining text after last match
  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }

  return parts;
}
