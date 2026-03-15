---
name: Clause Analysis Page Readability Audit
description: Identified readability problems in ContractDetailView and ZoneReviewView; reference before working on these pages
type: project
---

Key findings from reading ContractDetailView, ZoneReviewList, ZoneReviewView, ContractTabNav, globals.css, and tailwind.config.ts.

**Why:** User feedback that readability is poor despite layout being acceptable. Need this context to make targeted improvements rather than wholesale redesigns.

**How to apply:** Use these findings as the source of truth when implementing readability improvements. Do not re-audit unless the files have changed significantly.

## Design system facts
- Dark theme only: `--bg-primary: #0F1117`, cards at `#1A1D2B`, secondary bg `#161821`
- Text scale: `--text-primary: #E8E9ED`, `--text-secondary: #9496A8` (contrast ~3.5:1 on card bg — below WCAG AA), `--text-muted: #6B6E82` (contrast ~2.5:1 — fails AA)
- Three fonts: Noto Sans KR (UI), Source Serif 4 (page titles), JetBrains Mono (code/numbers)
- Global body font-size: 14px, line-height: 1.6
- Tailwind token names mirror CSS variables: `text-text-primary`, `bg-bg-card`, `accent-blue`, etc.

## Identified readability problems

### P1 — Critical
1. **Clause body uses `font-mono` (JetBrains Mono) for all contract text** (`ClauseDocumentItem`, line 241). Legal prose is not code; monospace reduces readability significantly for long paragraphs.
2. **`text-text-secondary` (#9496A8) on `bg-bg-card` (#1A1D2B) has ~3.5:1 contrast** — below WCAG AA 4.5:1 for normal text. Used for all clause body text.
3. **`text-text-muted` (#6B6E82) on dark backgrounds ~2.5:1 contrast** — used for "분석 미완료" labels, zone text preview, section labels. Fails AA.

### P2 — High
4. **Clause cards have `space-y-3` gap** — nearly identical visual weight between cards; no breathing room to distinguish individual clauses at a glance.
5. **Analysis panel section headers use `text-xs uppercase tracking-wide`** — at 12px uppercase they are very hard to read. Used 3 times in `ClauseInlineAnalysis`.
6. **Risk stats in the page header are tiny dots + `text-xs`** — the summary row (High N / Medium N / Low N) is visually buried under the subtitle at 12px.
7. **Filter tabs have no count indicators** — user cannot see how many clauses each filter level will yield before clicking.
8. **"분석 결과 보기" toggle uses a raw HTML entity `&#9654;` (►) as the expand icon** — inconsistent with project icon usage and visually heavy at small size.

### P3 — Medium
9. **ZoneReviewView uses inline `style` objects throughout** — mixes styling paradigms. Part-group headers, sub-document headers, and the warnings banner all use raw style props instead of Tailwind classes.
10. **ZoneCard text preview is `text-xs line-clamp-2`** — at 12px on the muted color this is hard to scan quickly.
11. **ContractTabNav uses inline styles** — `fontSize: 13`, color via CSS variables as strings. Inconsistent with the rest of the codebase which uses Tailwind classes.
12. **`ClauseInlineAnalysis` FIDIC section renders JSON.stringify output raw** — unformatted JSON is very hard to read.
13. **Sub-document headers in `ContractDetailView` use inline `style` objects** (lines 627–639), inconsistent with surrounding Tailwind usage.

### P4 — Low / Polish
14. **No visual separator between clause number and title** — `clause.number` and `clause.title` sit in the same flex row with no semantic grouping.
15. **"분석 미완료" state is a plain muted text line** — no icon, no action affordance.
16. **`max-h-[2000px]` animation on collapse** — causes a visible delay/stutter when collapsing long analyses.
