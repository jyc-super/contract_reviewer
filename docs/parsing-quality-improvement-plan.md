# 파싱 품질 개선 계획: 조항 분리 정확도

> 초판: 2026-03-13 (문서 구역 분류 & TOC)
> 갱신: 2026-03-14 (중첩 조항 번호 분리 실패 + 물리/논리 섹션 불일치 문제 추가)
> 분석 담당: document-ai-expert, backend-architect, qa-debugger

---

## 0. 신규 이슈 요약 (2026-03-14 접수)

이번 분석에서 새롭게 확인된 두 가지 심각한 파싱 품질 문제를 기록하고 해결 계획을 수립한다.

### 이슈 A — 중첩 조항 번호 분리 실패

**증상**: `1.1.1.1` 조항이 추출된 후, `1.1.1.2`, `1.1.1.3`이 별도 clause로 분리되지 않고 `1.1.1.1` 섹션의 content에 흡수됨.

**재현 예시**:
```
1.1.1.1 "Absolute Guarantee" or "Absolute Performance Levels" means
each of the absolute performance guarantees...
1.1.1.2 "Acceptable Credit Rating" means a credit rating for the relevant
bank's long term debt obligations of not less than Standard & Poor...
```

현재 동작: `1.1.1.1` 섹션 1개만 추출됨. `1.1.1.2` 텍스트는 `1.1.1.1` content에 포함됨.
기대 동작: `1.1.1.1`과 `1.1.1.2` 각각 독립 clause로 추출됨.

---

### 이슈 B — 물리적 섹션과 논리적 조항 번호 불일치

**증상**: Docling이 "Section 6"으로 파싱한 물리적 단위에 `5.5`, `5.6`, `5.7`, `5.8`, `5.9` 조항이 들어있음. `5.1`~`5.4`는 아예 별도 clause로 추출되지 않음.

현재 동작: 물리적 섹션 번호(Docling 구조)를 조항 번호로 사용하거나, 섹션 경계에서 조항을 분리함.
기대 동작: 물리적 섹션 번호 무관하게 텍스트 내 조항 번호(`5.1`, `5.2` 등)를 기준으로 분리함.

---

## 1. 근본 원인 분석

### 이슈 A: 중첩 조항 번호 분리 실패

#### 근본 원인 A-1: pdfplumber Phase 3.5 병합 로직의 조건 불완전성

**위치**: `scripts/docling_sidecar.py` 2436~2525행 (`_SHORT_CONTENT_THRESHOLD` 병합 루프)

현재 병합 예외 조건은 다음과 같다:
```python
_DEEP_NUMERIC_PATTERN = _re.compile(r'^\s*\d+(?:\.\d+){3,}\s')
# "1.1.1.x" (점 3개 이상) → 독립 보존
```

이 패턴이 보호하는 것은 `1.1.1.x` 형태(점 3개 이상, 즉 4단계 이상)이다.

**실제 장애 시나리오**: `1.1.1.1`과 `1.1.1.2` 사이에는 두 가지 경로로 분리 실패가 발생한다.

**경로 1 - pdfplumber 섹션 분리 실패 (물리 레이어)**:

`is_heading()` 판별 로직(1901~1998행)을 보면, `1.1.1.1 "Absolute Guarantee"...` 줄이 heading으로 판별되면 `new_section()` 호출로 독립 섹션이 생성된다. 그러나 `is_heading()`은 다음 조건으로 heading을 제외한다:

```python
if t[-1] in '.;!?':
    return False
```

정의 조항은 보통 `1.1.1.1 "Absolute Guarantee" or "Absolute Performance Levels" means` 처럼 마침표나 세미콜론으로 끝나지 않지만, `means` 다음에 내용이 이어지는 **여러 줄 spanning** 구조일 경우, pdfplumber가 줄 단위로 읽을 때 `1.1.1.1`과 본문 텍스트가 **같은 줄**에 있지 않으면 `1.1.1.1` 단독 줄이 heading으로 인식된 후, 이후 텍스트는 content로 축적된다. 그 다음 `1.1.1.2` 줄이 나타날 때는 `is_heading()`이 `True`를 반환해야 독립 섹션이 생성되는데, 이 시점에 `_DEEP_NUMERIC_PATTERN`은 4단계 번호이므로 is_heading()은 `True`를 반환해야 한다.

따라서 **물리적 섹션 생성 자체는 올바를 수 있다**. 문제는 Phase 3.5 병합 단계에서 발생한다.

**경로 2 - Phase 3.5 병합 조건의 엣지 케이스 (확정적 근본 원인)**:

```python
_is_trivial_fragment = (
    _level >= 3
    and len(_content) < _SHORT_CONTENT_THRESHOLD   # 50자 미만
    and not _is_boundary
    and not _is_deep_numeric                        # 4단계 수치 번호면 예외
    and merged
)
```

`_DEEP_NUMERIC_PATTERN = r'^\s*\d+(?:\.\d+){3,}\s'` 는 점이 **3개 이상**인 경우를 보호한다. `1.1.1.1`은 점이 3개이므로 `{3,}`에 매칭되어 보호된다.

그러나 **섹션의 content가 50자 이상**이면 `_is_trivial_fragment`가 `False`가 되어 어차피 독립 보존된다. **content가 50자 미만인 경우**에만 문제가 된다.

실제 문제는 다음 케이스에서 발생한다: `1.1.1.1 "Absolute Guarantee"...` 가 **heading으로 인식되지 않고** 이전 섹션의 content에 흡수되는 경우다.

**경로 3 - is_heading()에서 1.1.1.1 줄 미인식 (가장 유력한 근본 원인)**:

```python
STRUCT_HEADING_PATTERNS = [
    re.compile(r'^\s*(\d+\.){1,}\d*\s+\S'),    # 인덱스 0: 1. / 1.1 / 14.1.2 Title
    ...
]
```

이 패턴을 `1.1.1.1 "Absolute Guarantee"` 에 적용하면:
- `(\d+\.){1,}` — `1.`, `1.`, `1.` (3번) 매칭
- `\d*` — `1` 매칭
- `\s+\S` — ` "` 매칭

**이 패턴은 정상 매칭된다.** 그러나 이 경우 `"Absolute Guarantee"` 가 `"` 로 시작하므로 `t[0].islower()` 조건은 `False`, 마침표 ending도 없다.

**실제 장애 지점**: `1.1.1.1 "Absolute Guarantee" or "Absolute Performance Levels" means` 처럼 줄이 **길고**, pdfplumber가 이 텍스트를 **여러 줄로 분리**해 추출하면:
- 줄 1: `1.1.1.1 "Absolute Guarantee" or "Absolute Performance Levels" means`
- 줄 2: `each of the absolute performance guarantees or absolute performance`
- 줄 3: `levels identified in Schedule 3A [Performance Guarantees for LNG`

줄 1이 `is_heading()`으로 판별될 때, 다음 조건에서 실패할 수 있다:

```python
if t[-1] in '.;!?':
    return False
```

`means`로 끝나므로 이 조건은 통과한다. 그러나:

```python
if t.count(',') >= 2:
    return False
```

`"Absolute Guarantee" or "Absolute Performance Levels" means` 에 쉼표가 2개 이상이면 본문으로 판별된다. 실제 예시에서는 쉼표 개수가 0~1개이므로 이 조건도 통과한다.

**가장 유력한 실패 경로**: `is_heading()` 내부에서 `len(t) > 120` 조건:

```python
if not t or len(t) > 120:
    return False
```

`1.1.1.1 "Absolute Guarantee" or "Absolute Performance Levels" means` 의 길이는 약 70자로 통과한다.

**결론**: 개별 줄 단위 분석에서는 is_heading()이 `True`를 반환해야 하므로, 문제는 **pdfplumber가 줄을 어떻게 그룹핑**하느냐에 달려있다. pdfplumber의 `extract_words()` 또는 `extract_text()` 결과에서 `1.1.1.2 "Acceptable Credit Rating" means` 전체가 하나의 "줄"로 오지 않고 **여러 fragments로 분리**되면, 첫 fragment (`1.1.1.2`) 만 heading으로 인식되고 나머지가 content로 처리될 수 있다.

**또는**: `1.1.1.1`과 `1.1.1.2`가 **같은 페이지의 연속된 줄**로 올바르게 인식되더라도, `_merge_fragmented_headings()` (Phase 5, 2572~2575행)에서 heading-only 섹션이 이후 섹션과 병합될 때 `1.1.1.2`의 내용이 잘못 귀속될 수 있다.

#### 근본 원인 A-2: TypeScript sectionsToClauses()에서 섹션-내 다중 조항 미분리

**위치**: `lib/docling-adapter.ts` 283~388행 `sectionsToClauses()`

현재 `sectionsToClauses()`는 **각 Docling section을 정확히 1개의 clause로 변환**한다. 섹션 내에 `1.1.1.1`과 `1.1.1.2`가 모두 포함된 경우 (즉, sidecar가 섹션 분리에 실패한 경우), TypeScript 쪽에서 이를 감지하여 추가 분리하는 로직이 **없다**.

```typescript
// sectionsToClauses() 핵심 루프 (283~365행)
for (const section of targetSections) {
    // section 당 정확히 1개 clause 생성
    clauses.push({
        clause_number: clauseNumber,
        content: bodyText,   // 복수 조항이 포함된 raw content 그대로
        ...
    });
}
```

`section.content`에 `1.1.1.1 ... 1.1.1.2 ...` 가 모두 들어있어도, TypeScript는 이를 단일 clause로 처리한다.

---

### 이슈 B: 물리적 섹션과 논리적 조항 번호 불일치

#### 근본 원인 B-1: pdfplumber의 섹션 단위가 물리적 구조를 따름

**위치**: `scripts/docling_sidecar.py` `_parse_pdf_native()` Phase 3 (2230~2415행)

pdfplumber는 PDF를 페이지 단위로 읽어 `is_heading()` 판별 결과에 따라 섹션을 분리한다. 이 때 **섹션 경계는 heading으로 판별된 줄**에서 생성된다. 즉:

- `new_section()` 호출 시점 = heading 줄이 감지된 시점
- 섹션 번호(`section.heading`)는 그 heading 텍스트
- level은 heading 내 숫자 dot 구조에서 파생

**문제 시나리오**: 실제 계약서에서 `5.1`, `5.2`, `5.3`, `5.4`는 **한 페이지에 여러 조항**이 들어있거나, 각 조항의 시작 줄이 `is_heading()`에서 `True`를 반환해야 한다. 만약 `5.1`~`5.4`의 시작 줄이 heading으로 인식되지 않으면 이 조항들은 섹션 경계 없이 이전 섹션의 content에 흡수된다.

그런데 "Section 6"(Docling 물리 섹션)에 `5.5`~`5.9`만 들어있다는 것은:

1. Docling fallback path(TextOnlyPdfPipeline)를 통한 경우, Docling 자체의 섹션 분류(heading level detection)가 PDF의 물리적 단락 구조를 따라 `5.1`~`5.4`를 별도 섹션으로 분리하지 못했음
2. 또는 pdfplumber path에서 `5.1`~`5.4`가 이전 대분류 섹션(예: `5. General` heading 섹션)의 content에 흡수되고, 물리 페이지 경계 후의 `5.5`부터 heading으로 다시 인식된 경우

#### 근본 원인 B-2: sectionsToClauses()가 content 내 미분리 조항을 재분할하지 않음

**위치**: `lib/docling-adapter.ts` `sectionsToClauses()` (283~388행)

근본 원인 A-2와 동일한 구조적 한계다. sidecar가 `5.1`~`5.4`를 하나의 섹션 content에 넣어 보내면, TypeScript 어댑터는 이를 단일 clause로 그대로 통과시킨다.

**섹션 내 다중 조항을 감지할 수 있는 신호**:
- content 내에 `\n\d+\.\d+\s` 패턴 (줄바꿈 후 X.Y 숫자 패턴) 2회 이상
- content 내에 `\n\d+\.\d+\.\d+\s` 패턴 (4단계 이상 조항 번호)

이 신호가 있으면 content를 조항 번호 기준으로 재분할해야 하나, 현재 로직에는 이 단계가 없다.

#### 근본 원인 B-3: 물리 섹션 번호와 논리 조항 번호 간 매핑 부재

**위치**: `lib/docling-adapter.ts` `sectionsToClauses()` (309~314행)

```typescript
const hint = section.heading ? detectNumberingHint(section.heading) : null;
const clauseNumber =
    hint?.normalized ??
    (section.heading
        ? `${section.zone_hint}-${orderIndex + 1}`
        : `${section.zone_hint}-auto-${orderIndex + 1}`);
```

`detectNumberingHint()`는 section.heading에서 조항 번호를 추출한다. 만약 section.heading이 `"5. General"`이고 content 안에 `5.1`, `5.2`, `5.3`, `5.4`가 포함되어 있다면, `clause_number = "ARTICLE 5"`로 단 하나의 clause만 생성된다. `5.1`~`5.4`의 논리 조항 번호는 유실된다.

---

## 2. 데이터 흐름 관점 갭 다이어그램

```
PDF 파일
  │
  ▼ [pdfplumber Phase 1~3]
  섹션 목록 (heading + content)
  │
  ├── [이슈 A] heading 미인식 → 1.1.1.2가 1.1.1.1 content에 흡수됨
  ├── [이슈 B] 섹션 경계 누락 → 5.1~5.4가 상위 섹션 content에 흡수됨
  │
  ▼ [Phase 3.5: 짧은 섹션 병합]
  섹션 목록 (일부 병합됨)
  │
  ├── [이슈 A] _DEEP_NUMERIC_PATTERN 보호 로직 있으나 실제 병합 케이스 존재 가능
  │
  ▼ [sidecar → TypeScript via HTTP/JSON]
  DoclingSection[]
  │
  ▼ [sectionsToClauses()]
  ParsedClause[]
  │
  ├── [이슈 A+B 공통] content 내 복수 조항 미분리 — 섹션 1개 = clause 1개
  │
  ▼ [processContract() → DB]
  ClauseForDb[] (부정확한 조항 경계)
```

---

## 3. 해결 계획

### 우선순위 판단 기준

- **P0 (긴급)**: 데이터 유실 — 조항이 아예 추출되지 않음
- **P1 (높음)**: 조항 경계 오류 — 추출되나 범위가 틀림
- **P2 (중간)**: 조항 번호 오류 — 내용은 있으나 번호가 틀림

두 이슈 모두 **P0~P1** 수준. 리스크 분석 품질에 직접 영향.

---

### Task 1: sidecar — heading 인식 강화 [P0, Python]

**파일**: `scripts/docling_sidecar.py`
**위치**: `is_heading()` 함수 (1901~1998행)

**목적**: `1.1.1.2 "Acceptable Credit Rating" means...` 처럼 조항 번호로 시작하는 줄을 heading으로 반드시 인식시킴.

**현재 문제**: 아래 순서로 검증이 수행되는데, `STRUCT_HEADING_PATTERNS[0]`이 정상 매칭되더라도 **is_heading() 진입 전** 또는 **진입 직후** 조건에서 조기 반환되는 경우가 있다.

```python
# 현재 조기 반환 조건들 (is_heading 상단)
if not t or len(t) > 120:        return False
if t[-1] in '.;!?':              return False
if t.count(',') >= 2:            return False
if t.startswith('[') and ...:    return False
if t[0].islower():               return False
```

**수정 내용**:

1. **`\d+(?:\.\d+)+` 으로 시작하는 줄에 대해 조기 반환 조건 우회**

   구조적 숫자 패턴(`\d+(?:\.\d+)+\s`) 으로 시작하는 줄은 heading 판별이 사실상 확정적이므로, 쉼표 개수나 길이 조건을 우회해야 한다.

   ```python
   _is_structured_numeric = bool(re.match(r'^\s*\d+(?:\.\d+)+\s', t))

   # 수정: 구조적 숫자 패턴이 있으면 조기 반환 조건 완화
   if not _is_structured_numeric:
       if len(t) > 120:
           return False
       if t.count(',') >= 2:
           return False
   ```

2. **`STRUCT_HEADING_PATTERNS[0]` 패턴 정밀화**

   현재: `r'^\s*(\d+\.){1,}\d*\s+\S'`

   이 패턴은 `1.1.1.1 ` 뒤에 `\S`(임의의 비공백)만 있으면 매칭되므로, 실제로는 충분히 강력하다. 다만 `(\d+\.){1,}` 캡처 그룹이 반복 횟수를 추적하지 않으므로 `1.` (1단계)와 `1.1.1.1.` (4단계)를 구분하지 못한다. 이는 현재 문제의 직접 원인이 아니므로 이번 수정에서는 유지.

**영향 범위**: pdfplumber 경로만 영향. Docling fallback 경로는 별도 로직이므로 무관.

---

### Task 2: sidecar — content 내 다중 조항 재분할 [P0, Python]

**파일**: `scripts/docling_sidecar.py`
**위치**: Phase 3.5 이후, Phase 4 이전 (약 2527행 근처)에 새 단계 추가

**목적**: 한 섹션의 content 안에 여러 개의 조항 번호가 포함된 경우 재분할.

**신규 함수**: `_split_multi_clause_sections(sections: list[dict]) -> list[dict]`

**분할 기준 패턴**:
```python
# 조항 번호로 시작하는 줄 (최소 2단계 이상 수치 번호)
_CLAUSE_BOUNDARY = re.compile(
    r'(?:^|\n)\s*(\d+(?:\.\d+){1,})\s+\S',  # 1.1 / 1.1.1 / 1.1.1.1 Title
    re.MULTILINE
)
```

**분할 알고리즘**:
1. 각 섹션의 content에서 `_CLAUSE_BOUNDARY` 패턴 검색
2. 매칭이 2회 이상이고, 첫 번째 매칭이 content 시작 근처(처음 50자 이내)에 있으면 분할 대상
3. 각 매칭 위치를 경계로 content를 분할 → 새 섹션 생성
4. 부모 섹션(heading 포함)은 유지, content를 분할된 조각들로 교체
5. 분할된 각 조각은 독립 섹션으로 생성:
   - heading: 조항 번호 + 첫 줄 (예: `1.1.1.2 "Acceptable Credit Rating"`)
   - level: 원 섹션과 동일 또는 dot 개수+1
   - page_start/page_end: 부모 섹션에서 상속

**예외 조건** (분할하지 않는 경우):
- 섹션이 이미 heading을 가진 경우 AND heading의 조항 번호와 첫 매칭이 동일한 경우 → 단일 조항
- content 길이가 100자 미만 → 분할해도 의미 없음
- zone_hint가 `"toc"`, `"cover_page"` → 비분석 대상
- `_is_boundary`가 True인 섹션의 직후 섹션 → 대분류 heading 직후 content는 보존

**영향 범위**: sidecar 응답 sections[] 구조 변경 → TypeScript adapter는 변경 없이 처리 가능 (섹션 수 증가만 발생).

---

### Task 3: TypeScript — sectionsToClauses() 내 content 재분할 [P1, TypeScript]

**파일**: `lib/docling-adapter.ts`
**위치**: `sectionsToClauses()` 함수 (283~388행)

**목적**: sidecar가 content 재분할에 실패한 경우, TypeScript 쪽에서 2차 방어선 제공.

**신규 헬퍼**: `splitContentByClauses(content: string, baseZoneHint?: string): {number: string, text: string}[]`

**분할 기준**:
```typescript
// 조항 번호 경계 패턴 (최소 X.Y 형식, 2단계 이상)
const CLAUSE_SPLIT_RE = /(?:^|\n)\s*(\d+(?:\.\d+){1,})\s+\S/mg;
```

**적용 조건**:
- `section.content`에서 위 패턴이 2회 이상 매칭
- section.heading이 없거나 (`is_auto_split: true`), heading의 조항 번호와 content 내 첫 번째 조항 번호가 상이한 경우
- content 길이 > 200자

**적용 방법**:
```typescript
// sectionsToClauses() 내 for 루프에서
const bodyText = section.content.trim();
const subClauses = splitContentByClauses(bodyText, section.zone_hint);

if (subClauses.length > 1) {
    // content 내 복수 조항 → 각각 독립 clause로 생성
    for (const sub of subClauses) {
        const subHint = detectNumberingHint(sub.number);
        clauses.push({
            clause_number: subHint?.normalized ?? sub.number,
            parent_clause_number: inferParentClauseNumber(subHint?.normalized ?? sub.number) ?? undefined,
            title: sub.number,
            content: sub.text,
            order_index: orderIndex++,
            is_auto_split: true,
            zoneKey: section.zone_hint,
            page_start: section.page_start,
            content_format: "markdown",
        });
    }
} else {
    // 기존 로직 그대로
    clauses.push({ ... });
}
```

**영향 범위**: `sectionsToClauses()` 반환 결과(ParsedClause[]) 수 증가 가능 → `processContract()`의 qualityCheck에서 clause count 변화 → QC 로그에 불일치 경고 증가 가능 (무해). DB 저장 구조는 변경 없음.

---

### Task 4: sidecar — `_DEEP_NUMERIC_PATTERN` 보호 범위 확인 및 수정 [P1, Python]

**파일**: `scripts/docling_sidecar.py`
**위치**: Phase 3.5, 2457행

**현재 코드**:
```python
_DEEP_NUMERIC_PATTERN = _re.compile(r'^\s*\d+(?:\.\d+){3,}\s')
```

이 패턴은 `점 3개 이상` (= 4단계 이상, 예: `1.1.1.1`) 을 보호한다.

**갭**: `1.1.1` (3단계, 점 2개)은 보호되지 않는다. 예: `1.1.1 "Definitions"` 섹션이 content 50자 미만이면 이전 섹션에 병합됨.

**수정안**:
```python
# 기존: 4단계 이상만 보호
_DEEP_NUMERIC_PATTERN = _re.compile(r'^\s*\d+(?:\.\d+){3,}\s')
# 수정: 3단계 이상 보호 (1.1.1, 1.1.1.1, 1.1.1.1.1 등)
_DEEP_NUMERIC_PATTERN = _re.compile(r'^\s*\d+(?:\.\d+){2,}\s')
```

**영향 범위**: Phase 3.5에서 3단계 이상 수치 번호를 가진 짧은 섹션이 병합되지 않고 독립 보존됨. 섹션 수 소폭 증가 가능하나 정확도 향상이 우선.

---

### Task 5: sidecar — 연속된 같은 레벨 조항 heading 사이에서 섹션 분리 보장 [P1, Python]

**파일**: `scripts/docling_sidecar.py`
**위치**: `_parse_pdf_native()` Phase 3 메인 루프 (2356~2414행)

**현재 동작**: `is_heading()` → `new_section()` → content 축적 → 다음 `is_heading()` → `new_section()`

이 흐름에서 `1.1.1.1`이 heading으로 인식되면 새 섹션 생성, 이후 `1.1.1.2`가 heading으로 인식되면 또 새 섹션이 생성된다. **이 자체는 정상 동작이다**.

**문제 케이스**: `1.1.1.2` 줄이 여러 물리 줄에 걸쳐 있을 때, 특히 아래와 같이 조항 번호와 내용이 **한 줄에 있지 않은 경우**:

```
(줄 1) 1.1.1.2
(줄 2) "Acceptable Credit Rating" means a credit rating...
```

이 경우 pdfplumber는 줄 1을 heading(`1.1.1.2`)으로, 줄 2를 content로 처리한다. heading이 `1.1.1.2`뿐인 섹션이 생성되고, content는 줄 2의 텍스트가 된다. 이것은 정상이다.

**실제 장애 케이스**: `_merge_fragmented_headings()` (Phase 5, 2572~2575행)이 이 섹션을 이후 섹션과 병합한다.

**`_merge_fragmented_headings()` 동작 확인 필요**:

```python
def _merge_fragmented_headings(sections: list[dict]) -> list[dict]:
    # 연속된 heading-only 섹션을 다음 섹션과 병합
```

1772~1847행의 이 함수가 `1.1.1.2` (heading-only) 섹션을 **다음** 섹션과 병합하는 것은 정상이다 (`1.1.1.2` + `1.1.1.2의 내용`). 그러나 만약 `1.1.1.3`, `1.1.1.4`가 뒤에 오고, 이들도 heading-only라면 연쇄 병합이 발생할 수 있다.

**수정 방향**: `_merge_fragmented_headings()`에서 조항 번호 heading끼리는 서로 다른 번호이므로 다음 섹션의 heading 번호가 현재 섹션과 연번 관계인지 확인하고, **연번이면 병합하지 않음**.

---

### Task 6: TypeScript — sectionsToClauses() 섹션 내 번호 재인식 강화 [P2, TypeScript]

**파일**: `lib/docling-adapter.ts`
**위치**: `sectionsToClauses()` (309~314행)

**현재 코드**:
```typescript
const hint = section.heading ? detectNumberingHint(section.heading) : null;
const clauseNumber =
    hint?.normalized ??
    (section.heading
        ? `${section.zone_hint}-${orderIndex + 1}`
        : `${section.zone_hint}-auto-${orderIndex + 1}`);
```

section.heading이 없을 경우(`is_auto_split: true`) clauseNumber가 `zone-auto-N` 형태가 된다. 이 경우 content의 첫 줄에서 조항 번호를 추출하는 fallback이 없다.

**수정 방향**:
```typescript
// section.heading이 없는 경우, content 첫 줄에서 조항 번호 시도
const headingText = section.heading || (() => {
    const firstLine = section.content.trim().split('\n')[0];
    return firstLine.length <= 120 ? firstLine : null;
})();
const hint = headingText ? detectNumberingHint(headingText) : null;
```

이렇게 하면 sidecar가 heading을 비워둔 auto-split 섹션에서도 content 첫 줄의 조항 번호를 추출 가능하다.

**영향 범위**: `clause_number`가 `zone-auto-N` 대신 실제 조항 번호(`1.1.1.2` 등)로 채워짐. FIDIC 매핑 및 분석 품질 향상.

---

## 4. 구현 우선순위 및 순서

```
┌─────────────────────────────────────────────────────────┐
│ P0: Task 1 + Task 4  (sidecar — heading 인식 / 보호 강화) │
│ 예상 소요: 1~2시간                                         │
│ 파일: scripts/docling_sidecar.py                         │
│ 검증: 예시 입력 재실행 후 섹션 수 확인                       │
└────────────────────┬────────────────────────────────────┘
                     │ 완료 후
                     ▼
┌─────────────────────────────────────────────────────────┐
│ P0: Task 2  (sidecar — content 내 다중 조항 재분할)        │
│ 예상 소요: 2~3시간                                         │
│ 파일: scripts/docling_sidecar.py                         │
│ 검증: 1.1.1.1과 1.1.1.2가 별도 섹션으로 반환되는지 확인     │
└────────────────────┬────────────────────────────────────┘
                     │ 완료 후
                     ▼
┌─────────────────────────────────────────────────────────┐
│ P1: Task 5  (sidecar — _merge_fragmented_headings 수정)  │
│ 예상 소요: 1시간                                           │
│ 파일: scripts/docling_sidecar.py                         │
│ 검증: 연번 조항 번호 섹션이 연쇄 병합되지 않는지 확인          │
└────────────────────┬────────────────────────────────────┘
                     │ 병렬 진행 가능
                     ▼
┌─────────────────────────────────────────────────────────┐
│ P1: Task 3  (TypeScript — sectionsToClauses 재분할)      │
│ 예상 소요: 2시간                                           │
│ 파일: lib/docling-adapter.ts                             │
│ 검증: clause count 증가 + 각 조항 번호 정확도 확인           │
└────────────────────┬────────────────────────────────────┘
                     │ 완료 후
                     ▼
┌─────────────────────────────────────────────────────────┐
│ P2: Task 6  (TypeScript — content 첫줄 번호 추출 fallback) │
│ 예상 소요: 30분                                            │
│ 파일: lib/docling-adapter.ts                             │
│ 검증: auto-split 섹션의 clause_number가 실제 번호로 채워짐   │
└────────────────────────────────────────────────────────┘
```

---

## 5. 검증 방법

### 5-1. 단위 검증: sidecar 직접 호출

```bash
# sidecar 실행 중인 상태에서
curl -X POST http://127.0.0.1:8766/parse \
  -F "file=@test_contract.pdf" \
  | python -c "
import json, sys
data = json.load(sys.stdin)
sections = data['sections']
print(f'총 섹션 수: {len(sections)}')
for s in sections[:20]:
    print(f\"  [{s['level']}] {s['heading'][:60]} / content={len(s['content'])}자\")
"
```

**기대 결과 (이슈 A 수정 후)**:
- `1.1.1.1 "Absolute Guarantee"...` → 독립 섹션
- `1.1.1.2 "Acceptable Credit Rating"...` → 독립 섹션
- 두 섹션이 연속으로 나타남 (이전에는 하나로 합쳐져 있었음)

**기대 결과 (이슈 B 수정 후)**:
- `5.1`, `5.2`, `5.3`, `5.4`가 각각 독립 섹션으로 나타남
- 물리 섹션("Section 6")과 무관하게 논리 조항 번호 기준 분리

### 5-2. TypeScript 어댑터 검증

```typescript
// docling-adapter.test.ts에 케이스 추가
it("content 내 연속 조항 번호를 분리해야 한다", async () => {
    const mockSection = {
        heading: "1.1.1 Definitions",
        level: 4,
        content: `1.1.1.1 "Absolute Guarantee" means...\n1.1.1.2 "Acceptable Credit Rating" means...`,
        page_start: 10,
        page_end: 11,
        zone_hint: "definitions",
    };
    // sectionsToClauses([mockSection]) 결과에서
    // clause_number가 "1.1.1.1"과 "1.1.1.2"인 두 개의 clause가 있어야 함
});
```

### 5-3. 통합 검증: 실제 계약서

기존 테스트용 계약서(226페이지 EPC Contract)를 재파싱 후:
1. `clause_number`에 `1.1.1.1`~`1.1.1.N` 형태 존재 여부 확인
2. 전체 clause count 비교 (수정 전 대비 증가 여부)
3. `is_auto_split: true` 비율 감소 여부 확인 (실제 조항 번호가 부여됨)

### 5-4. 회귀 검증: 기존 정상 케이스

- `ARTICLE 1`, `1. Definitions` 등 상위 단계 조항이 올바르게 분리되는지 확인
- 너무 공격적인 재분할로 인해 단일 조항이 쪼개지지 않는지 확인
- qualityCheck에서 `needsReview: false`가 유지되는지 확인

---

## 6. 영향 범위 요약

| Task | 파일 | 변경 성격 | 부수 효과 |
|------|------|-----------|-----------|
| 1 | docling_sidecar.py | is_heading() 조기 반환 완화 | 섹션 수 증가 가능 |
| 2 | docling_sidecar.py | 신규 함수 _split_multi_clause_sections | 섹션 수 증가 |
| 3 | lib/docling-adapter.ts | sectionsToClauses() 재분할 로직 추가 | clause 수 증가, is_auto_split 증가 |
| 4 | docling_sidecar.py | _DEEP_NUMERIC_PATTERN 범위 확대 | 3단계 조항 독립 보존 |
| 5 | docling_sidecar.py | _merge_fragmented_headings 연번 예외 | 섹션 병합 감소 |
| 6 | lib/docling-adapter.ts | content 첫줄 번호 fallback | clause_number 정확도 향상 |

**DB 영향**: 없음 (clause 수 증가는 허용 범위, DB 스키마 변경 불필요)

**API 영향**: `app/api/contracts/route.ts`의 Docling 파싱 결과 수신 부분에 변경 없음. clause 배열 크기만 변화.

**qualityCheck 영향**: clause 수 증가 시 `ruleBasedCheck()`의 상한(`> 1500`) 도달 가능성 낮음. 단, 단일 clause가 100자 미만으로 분할되면 `needsReview: true` 가능 → 허용 범위.

---

## 7. 기술 부채 기록

이번 분석에서 확인된 신규 기술 부채:

- **TD-10**: sectionsToClauses()가 섹션 단위 1:1 매핑을 가정 — content 재분할 로직 없음. Task 3으로 해소 예정.
- **TD-11**: _DEEP_NUMERIC_PATTERN이 4단계 이상만 보호 — 3단계(1.1.1) 누락. Task 4로 해소 예정.
- **TD-12**: _merge_fragmented_headings()에 연번 조항 번호 예외 없음 — 연속 정의 조항이 연쇄 병합될 수 있음. Task 5로 해소 예정.

---

## 8. 기존 계획 (문서 구역 분류 & TOC) — 원문 유지

> 아래 내용은 2026-03-13 초판의 문서 구역 분류 개선 계획이다.
> 신규 이슈(섹션 0~7)와 독립적으로 진행 가능하나, 우선순위는 신규 이슈가 높다.

---

### 현재 상태 진단 (구역 분류 & TOC)

#### 활성 경로 (pdfplumber sidecar)

| 파일 | 역할 |
|------|------|
| `scripts/docling_sidecar.py` → `_detect_zone_hint()` | 8개 키워드 매칭으로 zone_hint 부여 |
| `lib/docling-adapter.ts` → `sectionsToZones()` | level-1 섹션을 `DocumentZone[]`으로 변환 |

#### 비활성 경로 (lib/layout/ — 연결 안 됨)

| 파일 | 역할 |
|------|------|
| `lib/layout/zone-classifier.ts` | 11개 문서 유형, 30+ 정규식 패턴의 `detectDocumentPart()` |
| `lib/layout/document-part-patterns.json` | 패턴 데이터 (현재 미사용) |
| `lib/layout/blockify.ts` | 라인→블록 그룹핑, 헤딩 감지 |
| `lib/layout/build-clauses.ts` | zone→clause 변환 |
| `lib/layout/header-footer.ts` | 반복 머리글/꼬리글 제거 |

**이 모듈들은 파이프라인 어디에서도 import되지 않음.**

---

### Phase 1~4 (구역 분류 개선) — 완료 상태

> 2026-03-14 기준 P0~P3 항목 모두 구현 완료. 상세 계획은 git 히스토리 참조.

| 우선도 | 작업 | 상태 |
|--------|------|------|
| P0 | 3C: adapter detectDocumentPart() | 완료 |
| P0 | 1C: heading 오탐 수정 + 기본값 변경 | 완료 |
| P1 | 1D: 헤더/푸터 감지 및 제거 | 완료 |
| P1 | 1A: document-part-patterns sidecar 포팅 | 완료 |
| P1 | 1B: document_parts 구조 + 경계 감지 | 완료 |
| P1 | 3A: adapter document_parts 소비 | 완료 |
| P1 | UI: Zone 그룹핑 + 페이지 범위 | 완료 |
| P2 | 2A~2C: TOC 감지/파싱/검증 | 완료 |
| P3 | 3B: zoneKey clause 연동 | 완료 |
| P3 | 4A~4B: 멀티 문서 경계 감지 | 완료 |
