---
name: Deep Numbering and Sub-item Parsing Issues
description: Analysis and implementation of 1.1.1.x deep numbering and (a)(b)(c) sub-item nesting — all 3 improvements implemented 2026-03-14
type: project
---

## 구현 완료 (2026-03-14)

모든 3개 개선안 구현 완료. 변경 파일:
- `scripts/docling_sidecar.py` Phase 3.5 — threshold 200→50, _is_deep_definitions 예외, _is_sub_item (a)(b)(c) 병합
- `lib/document-parser.ts` — ParsedClause.parent_clause_number?: string 추가
- `lib/docling-adapter.ts` — inferParentClauseNumber() + sectionsToClauses() 레벨 스택 추적
- `lib/pipeline/process-contract.ts` — ClauseForDb.parentNumber?: string, processPdf/processDocx 매핑
- `app/api/contracts/route.ts` — clauseRows에 parent_clause_number 포함
- `supabase/migrations/009_add_parent_clause_number.sql` — 신규 마이그레이션 (contract_id+parent_clause_number 인덱스 포함)

## 문제: 깊은 번호 체계(1.1.1.x)와 (a)(b)(c) 서브아이템 누락/미중첩

**발견 날짜:** 2026-03-14

### 근본 원인

#### 1. Phase 3.5 단락 병합 (M-7) — 4단계 조항 조기 병합
`docling_sidecar.py` 2270~2303줄, Phase 3.5 조각 섹션 병합 단계:

```python
_SHORT_CONTENT_THRESHOLD = 200  # 200자 미만인 level >= 3 섹션은 이전 섹션에 병합
if (
    _level >= 3
    and len(_content) < _SHORT_CONTENT_THRESHOLD
    ...
):
```

- `level >= 3`이고 content가 200자 미만이면 이전 섹션에 병합됨
- 1.1.1.x 번호 체계에서 level 계산: `"1.1.1.1 Title"` → 점 개수 3 + 1 = **level 4**
- FIDIC Definitions 섹션의 1.1.1.1~1.1.1.92 같은 짧은 정의 항목들이 모두 이전 섹션에 병합됨
- 결과: Definitions 섹션의 개별 정의 항목이 단일 섹션 content에 뭉쳐서 `clause_number`가 부모 섹션 하나만 생성됨

#### 2. (a)(b)(c) 서브아이템 — STRUCT_HEADING_PATTERNS 미매칭
`docling_sidecar.py` 1787~1793줄 `STRUCT_HEADING_PATTERNS`:

```python
STRUCT_HEADING_PATTERNS = [
    re.compile(r'^\s*(\d+\.){1,}\d*\s+\S'),          # 1. / 1.1 / 14.1.2 Title
    re.compile(r'^\s*(ARTICLE|CLAUSE|PART|SECTION|CHAPTER)\s+[\dIVXivx]+', re.I),
    re.compile(r'^\s*제\s*\d+\s*[조장절]\b'),
    re.compile(r'^\s*[IVX]{1,5}\.\s+[A-Z]'),
    re.compile(r'^\s*[A-Z]\.\s+[A-Z][A-Z]'),
]
```

`(a) The Contractor shall...` 형식의 서브아이템은 어떤 STRUCT 패턴에도 매칭되지 않음.
- `_ALPHA_PAREN`은 `lib/layout/numbering.ts`에만 있음 (TS 측 detectNumberingHint)
- Python sidecar `is_heading()` 함수에는 `(a)`, `(b)` 패턴이 없음
- 폰트 크기/Bold 신호가 없으면 본문 텍스트로 처리 → content에 흡수됨

#### 3. `lib/docling-adapter.ts` sectionsToClauses() — 계층 구조 미지원
`lib/docling-adapter.ts` 238~298줄 `sectionsToClauses()`:

- sections를 flat list로 순회하여 각각 독립적인 `ParsedClause`로 변환
- parent-child 관계 추적 없음
- `(a)` 서브아이템이 section으로 도달했다고 해도 부모 조항에 중첩되지 않고 별개 조항으로 저장됨
- `clause_number`는 detectNumberingHint()가 `(a)` → `normalized: "(a)"`, `level: 5`로 처리
- 그러나 DB 저장 시 단순 flat row → 계층 구조가 DB 스키마에 없음

### 개선 방향 (우선순위 순)

**A. Phase 3.5 threshold 조정 (즉시 적용 가능)**
- 현행: `_SHORT_CONTENT_THRESHOLD = 200` (200자 미만 level>=3 병합)
- 개선: Definitions 섹션 내 level>=4는 병합 제외 — `zone_hint == "definitions"`인 parent 하에서는 병합 억제
- 또는 threshold를 낮춤 (50자 이하만 병합) → 짧은 1.1.1.x 정의도 독립 섹션 유지

**B. STRUCT_HEADING_PATTERNS에 (a)(b) 패턴 추가**
- `re.compile(r'^\s*\([a-z]{1,3}\)\s+\S')` 추가
- 단, 본문 괄호 참조(`(See Clause 14.3)`, `(i) The Contractor`) 오탐 주의
- 폰트 Bold 신호와 AND 조건으로 제한 권장

**C. sectionsToClauses() 계층 구조 지원**
- 가장 근본적인 개선이지만 DB 스키마 변경 필요
- `parent_clause_number` 필드 추가 → ParsedClause에 parentNumber 옵션 추가
- 단기적으로는 (a)(b)(c)를 부모 조항 content에 병합하는 것이 현실적

### 관련 파일
- `scripts/docling_sidecar.py` 2270~2303줄 — Phase 3.5 병합 로직
- `scripts/docling_sidecar.py` 1787~1793줄 — STRUCT_HEADING_PATTERNS
- `scripts/docling_sidecar.py` 2205~2234줄 — is_heading() + level 계산
- `lib/docling-adapter.ts` 238~298줄 — sectionsToClauses() flat 변환
- `lib/layout/numbering.ts` 116~127줄 — _ALPHA_PAREN TS 측 패턴 (sidecar와 불일치)

**Why:** FIDIC 계약서의 Section 1 Definitions는 1.1.1.1~1.1.1.92 같은 4단계 번호를 사용. 각 정의가 독립 조항으로 파싱되어야 리스크 분석이 정확함.

**How to apply:** Phase 3.5 threshold/조건 수정은 sidecar Python 파일만 건드리면 됨. (a)(b) 패턴은 오탐 리스크가 있어 신중하게 접근. DB 스키마 변경 없이 flat 병합으로 처리하는 것이 단기 현실적 방안.
