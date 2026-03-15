---
name: Sub-item marker and heading merge fixes
description: Fixes for (14) treated as list marker in reflowParagraphs and ARTICLE N / N.N parent-child heading merge in sidecar
type: project
---

Two parsing issues fixed on 2026-03-15:

**1. reflowParagraphs treats (14) as list marker (TS side)**
- `lib/docling-adapter.ts` reflowParagraphs `isNewBlock` regex matched `(14)`, `(30)` etc. as list markers because `[a-zA-Z0-9ivxIVX]+` included digits
- Fix: split the pattern into separate alternatives:
  - `\([a-zA-Z]{1,3}\)` for alpha markers (a), (bb)
  - `\([ivxIVX]{1,8}\)` for roman numerals (i), (iv)
  - `\([0-9]\)` for single-digit only (1)-(9)
- Multi-digit numeric parentheses like (14), (30), (2024) are now correctly treated as inline text

**2. ARTICLE N heading merged with N.1 sub-heading (sidecar side)**
- `_merge_fragmented_headings` in sidecar merged ["6.", "COMMENCEMENT"] with "6.1 Effectiveness..." because parent-child check only looked at `last_collected` heading part
- Fix: check ALL collected heading_parts for parent-child relationship with target
- Also fixed `_extract_heading_number` to handle "6." (number + period) and "6. COMMENCEMENT" (number + period + space + text)

**3. Sidecar _LIST_MARKER_RE also restricted (sidecar side)**
- `_LIST_MARKER_RE` pattern `\(\d+\)` changed to `\(\d\)` for consistency — single digit only
- The existing `_PAREN_NUM_START_RE` fallback for mid-sentence merge is still in place as defense-in-depth

**Why:** EPC contracts frequently use "fourteen (14) calendar days" pattern. Also ARTICLE headings followed by sub-clause headings are standard FIDIC structure.

**How to apply:** When touching reflowParagraphs or _unwrap_content_lines, always test with multi-digit parenthetical numbers. When touching _merge_fragmented_headings, verify ARTICLE N + N.1 separation.
