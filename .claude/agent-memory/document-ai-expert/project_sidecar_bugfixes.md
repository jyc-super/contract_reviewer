---
name: Docling Sidecar Bug Fixes (2026-03-14)
description: Comprehensive parse quality bug fixes applied to scripts/docling_sidecar.py
type: project
---

Batch of parsing bug fixes applied 2026-03-14 to `scripts/docling_sidecar.py`.

**Why:** Multiple parsing issues found across heading detection, zone classification, header/footer detection, TOC parsing, and scan PDF handling.

**How to apply:** Reference these patterns when diagnosing similar parse failures or extending the pipeline.

## Fixes Applied

### M-1: is_heading() ALL CAPS overkill (CRITICAL)
- Extracted `_ALL_CAPS_PATTERN = re.compile(r'^[A-Z][A-Z\s]{4,30}$')` as a named constant inside `_parse_pdf_native()`
- Previously used `HEADING_PATTERNS[-1]` index — fragile when list order changes
- ALL CAPS check: match against constant, skip if < 2 words AND not a structural keyword (ARTICLE/CLAUSE/PART/SECTION/CHAPTER)

### M-2: conditions_of_contract pattern too broad
- Old: `r"^\s*(?:fidic\s*)?conditions\b"` matched "conditions of payment", "conditions for dispatch" etc.
- New: `r"^\s*fidic\s+conditions\s+of\s+(?:contract|subcontract)\b"` (requires explicit FIDIC prefix)
- Other pattern: `r"^\s*(?:part\s+[ivx\d]+\s*[-:]\s*)?conditions\s+of\s+(?:contract|subcontract)\b"`

### M-3: Header/footer zone ratios and min_repeat
- Zone ratios: 8% → 10% (Korean contracts have larger margins)
- min_repeat: `max(3, int(total_pages * 0.25))` → `max(2, int(total_pages * 0.15))`
- pdfplumber Y-coord verified: top=0 is page top (header_cutoff = height*0.10, footer_cutoff = height*0.90)

### M-4: TOC level detection via numbering patterns
- Old: leading_spaces // 4 — pdfplumber extract_text_lines() doesn't preserve spaces → always level=1
- New: `_infer_level_from_numbering()` — regex patterns on numbering: 1.1.1=level3, 1.1=level2, 1.=level1
- `_parse_toc_entries()` gained `total_pages` parameter; page validation uses real upper bound instead of 9999

### m-1: ThreadPoolExecutor worker cap
- `max_workers=len(chunks)` → `max_workers=min(len(chunks), 4)`
- Each worker holds full PDF bytes in memory; cap prevents N full copies

### m-3: heading also cleaned of header/footer patterns
- `_remove_header_footer_lines()` now applied to `sec["heading"]` in addition to `sec["content"]`

### m-5: TOC false positive prevention
- Added `leader_with_num_count`: lines with leader dots/dashes/tabs before trailing number
- Heuristic 3 (30% lines end with number) now requires ALSO 50%+ of those to have leader prefix
- Prevents amount/price lists from being mistaken for TOC

### S-3: TOC validation inserts missing document_parts
- Old: warning-only
- New: if level-1 TOC entry has no matching document_part within ±2 pages, and a nearby section exists → inserts new document_part with `confidence: 0.85`
- `_validate_structure_against_toc()` gained `sections` parameter

### S-5: FIDIC-specific patterns + Korean clause numbering + table None fix
- Added `form_of_tender`, `letter_of_acceptance`, `bill_of_quantities` to `_DOCUMENT_PART_PATTERNS`
- Added Korean clause pattern to HEADING_PATTERNS: `re.compile(r'^\s*제\s*\d+\s*조\b')`
- `table_to_markdown()` already correct (str(c).strip() if c is not None else "")

### S-6: Scan PDF detection
- After pdfplumber+Docling both return no sections: sample up to 10 pages, compute avg word count
- avg < 10 words/page → scan PDF detected
- Returns HTTP 422 with `scan_detected: true` flag and Korean warning message in `warnings[]`
