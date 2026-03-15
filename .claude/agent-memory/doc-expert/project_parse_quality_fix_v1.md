---
name: PDF Parse Quality Fix v1 - Definition Clause Extraction
description: Root causes and fixes for missing clause numbers in pdfplumber-based PDF parsing, especially 1.1.1.x definitions
type: project
---

Three root causes were identified and fixed for missing clause numbers in the QNLP EPC Contract (226-page PDF with 219 definitions):

**Root Cause 1: `is_heading()` rejected structured clauses ending with period**
- Lines like `1.1.1.20 "Commercial Operation Date"...PPA.` were rejected by the `ends_punct` check (`t[-1] in '.;!?'`) before reaching the STRUCT pattern match.
- **Fix**: For 3-level+ structured numbers (`\d+(\.\d+){2,}`), check STRUCT patterns BEFORE `ends_punct`. 2-level numbers (e.g., `14.2`) still reject on period to avoid inline reference false positives.

**Root Cause 2: `_split_multi_clause_sections()` too restrictive**
- Required `matches[0].start() <= 50` and `matches >= 2` in content, missing sections where the first embedded clause appeared after 50+ chars of body text.
- **Fix**: Rewrote to use `_is_sibling_or_child_clause()` to filter inline references (like `14.2`, `20.3`) and split on any number of valid matches regardless of position.

**Root Cause 3: `_merge_fragmented_headings()` merged self-contained definitions**
- Single-line definitions with empty content (e.g., `1.1.1.20 "..."...PPA.`) were treated as "fragmented headings" and merged with the next section.
- **Fix**: Added `_SELF_CONTAINED_HEADING` (3-level+ numbers) and `_NOT_USED_HEADING` patterns to exclude self-contained sections from merging.

**Results**: 61.3% -> 96.8% clause recognition rate. 219/219 definitions extracted. 0 definitions embedded in content.

**How to apply**: These patterns apply to any EPC/FIDIC contract PDF. The key insight is that definition sections have a unique structure where the heading IS the entire definition text (no separate body content).
