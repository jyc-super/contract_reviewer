---
name: Parsing pipeline architecture analysis
description: Complete map of how PDF/DOCX parsing flows through the system — sidecar, adapter, parser, pipeline, and the connected layout module
type: project
---

Two parallel layout/zone systems exist. As of 2026-03-14, the TypeScript zone-classifier is now connected to the adapter.

**Active path (Docling sidecar):**
1. `scripts/docling_sidecar.py` — pdfplumber primary, Docling TextOnlyPdfPipeline fallback
2. pdfplumber `_parse_pdf_native()` uses regex HEADING_PATTERNS + font-size/bold heuristics to detect sections
3. `_detect_zone_hint()` — regex pattern matcher (ported from document-part-patterns.json) + legacy keyword fallback. Default return value is now "contract_body" (was "general_conditions").
4. Returns `{sections, total_pages, document_parts, header_footer_info, warnings}`
5. `lib/docling-adapter.ts` `sectionsToZones()`:
   - If document_parts present → document_parts-based zones (confidence 0.95)
   - Fallback → section-based zones with detectDocumentPart() override (P0-1 3C connected)
6. `lib/document-parser.ts` wraps adapter with error handling
7. `lib/pipeline/process-contract.ts` runs validate -> parse -> qualityCheck -> DB format

**lib/layout/ modules — connection status:**
- `zone-classifier.ts` `detectDocumentPart()` — NOW CONNECTED via adapter import (P0-1)
- `document-part-patterns.json` — NOW PORTED to Python sidecar (P1-2 1A)
- `layout-extract.ts` uses pdfjs-dist (disabled per policy) — still disconnected, correct
- `blockify.ts`, `header-footer.ts`, `build-clauses.ts` — still not connected, OK

**Improvements applied 2026-03-14 (P0+P1):**
- P0-1 (3C): adapter now imports detectDocumentPart() and overrides sidecar zone_hint
- P0-2 (1C): ALL-CAPS single-word heading odetection fixed (min 2 words), bold heading max length 80→50
- P0-2 (1C): _detect_zone_hint() default changed from "general_conditions" to "contract_body"
- P1-1 (1D): _detect_headers_footers() added with PageElement dataclass, Y-zone detection, repeat-pattern matching; sections cleaned in _parse_pdf_native(); header_footer_info added to response
- P1-2 (1A): ZONE_KEYWORD_MAP replaced by regex-compiled _COMPILED_PART_PATTERNS ported from document-part-patterns.json (11 types, 30+ patterns); _detect_zone_hint_from_patterns() with heading-likeness guard
- P1-3 (1B): _detect_document_boundaries() added — 3-pass boundary detection; document_parts added to response; child sections inherit parent zone_hint
- P1-4 (3A): DoclingDocumentPart + DoclingHeaderFooterInfo interfaces added to adapter; document_parts consumed in sectionsToZones(); additive fields for backward compatibility

**Improvements applied 2026-03-14 (round 2 — parsing quality fixes):**
- is_heading() 전면 재설계: STRUCT_HEADING_PATTERNS(구조적 번호 패턴) + ALL_CAPS 조건 강화 + 문장 패턴 제외 + Bold 비율 임계값 0.5 적용
- 한국어 계층 레벨 감지: 장/편=1, 절=2, 조=2 명시
- TOC 섹션에 zone_hint="toc" + is_toc=True 명시 마킹 → JS side에서 is_toc 플래그로 강제 오버라이드
- _detect_document_boundaries() Pass 1에서 is_toc=True 섹션 경계 후보 제외
- _TOC_HEADING_PATTERNS에 "[목차]", "차례" 등 한국어 변형 추가
- 한국어 계약서 document_part 패턴 추가: 계약서/일반사항/특수사항/계약조건 등
- ZONE_KEYWORD_MAP 한국어 키워드 보강
- document-part-patterns.json TypeScript 측에도 동기화
- sectionsToClauses()에 page_start + level 기준 명시적 정렬 추가 (병렬 처리 순서 불일치 방지)
- 빈 clauses fallback에서 toc/cover_page 섹션 제외

**Key remaining gaps:**
1. lib/header-footer.ts still disconnected (Python sidecar handles header/footer removal now)
2. 스캔 PDF OCR 미지원

**Why:** Understanding this architecture is essential for any parsing quality improvement — changes must be coordinated between Python sidecar and TypeScript adapter.
**How to apply:** Any improvement plan must work within the active pdfplumber->sidecar path, not the disconnected pdfjs-dist layout path.
