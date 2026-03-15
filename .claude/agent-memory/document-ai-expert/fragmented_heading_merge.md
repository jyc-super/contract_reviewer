---
name: Fragmented Heading Merge Bug Fix
description: Bug where PDF clause number and title on separate lines each become heading-only sections; fixed with _merge_fragmented_headings() post-processing in Phase 5
type: project
---

## Bug: Split-line clause headings produce duplicate/fragmented sections

**Root cause:** When a PDF renders a clause heading across two separate text lines (e.g., "1.1" on one line and "Definitions" on the next), `_parse_pdf_native()` Phase 3 calls `is_heading()` on each line independently. Both pass — the number matches `STRUCT_HEADING_PATTERNS[0]` and the title matches via font/caps signals — producing:

```
section[N]:   { heading: "1.1",         content: "" }
section[N+1]: { heading: "Definitions", content: "" }
section[N+2]: { heading: "",            content: "정의\n..." }
```

**Fix applied 2026-03-14:** Added `_merge_fragmented_headings(sections)` function (line ~1754 in `scripts/docling_sidecar.py`) as a post-processing step.

**Algorithm:**
- Walk sections forward; when a section has `content.strip() == ""` and a non-empty heading, collect it as a "heading fragment"
- Continue collecting consecutive heading-only sections
- When a section with content is found, combine all accumulated heading parts (space-joined) prepended to that section's own heading
- `level` and `page_start` taken from the first anchor fragment (its clause number has the correct structural level)
- `zone_hint` from anchor only if it is not the generic `contract_body` value
- If no content-bearing section follows, preserve the heading-only sections as-is (no data loss)

**Call sites:**
1. `_parse_pdf_native()` — Phase 5, just before `log.info` + `return` (line ~2490)
2. DOCX path in `/parse` endpoint — immediately after `total_pages` is resolved for DOCX (line ~2712)

**Why:** Both paths produce `sections: list[dict]` with identical field structure, so the same function handles both.

**Interaction with Phase 3.5 (short-section merge):** Phase 3.5 runs before Phase 4 (header/footer), and `_merge_fragmented_headings` runs after Phase 4. The two do not conflict: Phase 3.5 merges trivially short content sections into their predecessor; this function merges heading-only stubs forward into their successor.
