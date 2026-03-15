---
name: bold-text-preservation-pipeline
description: 볼드 텍스트 보존 기능 구현 내역 — pdfplumber chars 기반 **bold** markdown 변환, content_format 컬럼 추가
type: project
---

pdfplumber Phase 3 경로에서 볼드 텍스트를 **...** 마크다운으로 변환하여 저장하는 기능을 추가했다.

**Why:** 계약서의 볼드 텍스트(정의, 강조 조항)는 리스크 분석에서 의미 있는 신호이므로 파싱 시 보존이 필요하다.

**How to apply:** 이 기능이 동작하는 파이프라인 위치와 제약을 이해하고 향후 유지보수 시 참고한다.

## 구현 위치

- `scripts/docling_sidecar.py` — `apply_bold_markdown()` 함수 (Phase 3 내부 중첩 함수)
  - `chars` 배열의 `fontname`에 "bold" 포함 여부로 볼드 판정
  - 전체 볼드 줄은 `**...**` 미적용 (heading 경로로 처리됨)
  - 부분 볼드 구간만 `**span**` 변환
  - `chars` 없거나 빈 경우 plain text fallback

- `scripts/docling_sidecar.py` — `_build_sections_from_doc()` Phase 2 (Docling iterate_items 경로)
  - TextItem, ListItem에 `export_to_markdown(doc)` 시도 추가 (TableItem과 동일 패턴)
  - fallback: `export_to_markdown()` → `item.text.strip()`

## 데이터 흐름

sidecar content (볼드 **...**) → DoclingSection.content → ParsedClause.content_format="markdown"
  → ClauseForDb.contentFormat → clauses.content_format DB 컬럼

## DB

migration `010_add_content_format.sql`: `clauses.content_format TEXT NOT NULL DEFAULT 'plain'`
CHECK 제약: `IN ('plain', 'markdown')`

## 제약 사항

- `is_heading()` 판정된 줄은 heading으로 저장되므로 content에 내려오지 않음 → 볼드 마킹 불필요
- TOC 페이지 축적 경로는 `apply_bold_markdown` 미적용 (TOC 내용은 분석 대상 아님)
- Docling iterate_items 경로(Phase 2)에서 export_to_markdown이 실제로 볼드를 마크다운으로 반환하는지는 Docling 버전에 따라 다를 수 있음 — fallback이 있어 안전
