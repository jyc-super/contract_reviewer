---
name: Phase 4 — Multi-document boundary detection
description: Phase 4A/4B sub-document detection implementation details and architecture decisions
type: project
---

Phase 4A/4B multi-document boundary detection implemented on 2026-03-14.

**Why:** A single PDF upload may contain multiple merged contracts (e.g., Contract Agreement + General Conditions). Sub-document detection allows downstream processing to treat each embedded document independently.

**How to apply:** When suggesting changes to parse quality or zone classification, consider that `sub_documents` is now a first-class field at every layer of the stack.

## Implemented Files

- `scripts/docling_sidecar.py` — `SubDocument` dataclass + `_detect_sub_documents()` + `_extract_sub_doc_title()` added after `_detect_document_boundaries()`. The `/parse` endpoint now includes `sub_documents` in its JSON response.
- `lib/docling-adapter.ts` — `export interface SubDocument`, `DoclingResponse.sub_documents?`, `DoclingParseResult.subDocuments?`, mapped in `requestDoclingParse()` return.
- `lib/pipeline/process-contract.ts` — `SubDocument` import, `ProcessContractResult.subDocuments?`, threaded through `processPdf()` and `processDocx()` destructure + return.
- `app/api/contracts/[id]/zones/route.ts` — GET select includes `sub_documents` column; response JSON includes `sub_documents`.
- `app/api/contracts/route.ts` — `persistParseResult` UPDATE payload includes `sub_documents: result.subDocuments ?? null`.
- `supabase/migrations/008_add_sub_documents.sql` — `ALTER TABLE contracts ADD COLUMN IF NOT EXISTS sub_documents JSONB`.

## Detection Algorithm (Python)

5 signals evaluated per `document_parts` boundary (index > 0):
1. **Page-1 marker** — regex `\bpage\s+1\s+(?:of\s+\d+)?\b` in nearby section text/heading.
2. **Title page pattern** — `part_type == "cover_page"`.
3. **Clause number restart** — title or nearby heading matches `^\s*(?:article\s+(?:i|1)|(?:clause|section|part)\s+1|1\.\s+\S)`.
4. **Mid-document TOC** — `part_type == "toc"` and `page_start > 20% of total_pages`.
5. **Cover page transition** — previous part type is not cover/toc but current is `cover_page`.

Boundary declared when **signals >= 2**. Falls back to single sub_document when no boundaries found (backward compatible — always returns at least one entry when document_parts exist).

## Key Design Decisions

- `sub_documents` is **additive** — detection failure returns `[]` and parsing continues.
- DB storage is JSONB (mirrors `document_parts` pattern). Migration 008 must be applied before the UPDATE in `contracts/route.ts` takes effect; the column is nullable so a missing migration causes a PostgREST 400 but only for new uploads.
- `SubDocument.document_parts` is typed as `DoclingDocumentPart[]` in TypeScript (re-uses existing type).
- `_extract_sub_doc_title()` is a standalone helper — finds the first heading in sections at or after a given page, used as fallback title.
