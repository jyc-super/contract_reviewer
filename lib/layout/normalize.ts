/** Port of lpr/legal/normalize.py — conservative text joining. */

function safeMergeHyphenated(lineA: string, lineB: string): string {
  const a = lineA.trimEnd();
  const b = lineB.trimStart();
  if (!a.endsWith("-")) return a + " " + b;
  if (a.length < 2) return a + " " + b;
  if (!/[a-zA-Z]/.test(a[a.length - 2])) return a + " " + b;
  if (!b) return a;
  if (!b[0] || b[0] !== b[0].toLowerCase() || /[\d\W]/.test(b[0]))
    return a + " " + b;
  // Merge: remove trailing hyphen, join without space
  return a.slice(0, -1) + b;
}

export function safeJoinLines(lines: string[]): string {
  const cleaned = lines
    .map((ln) => (ln || "").trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (!cleaned.length) return "";
  let out = cleaned[0];
  for (const nxt of cleaned.slice(1)) {
    out = safeMergeHyphenated(out, nxt);
  }
  return out.replace(/\s+/g, " ").trim();
}
