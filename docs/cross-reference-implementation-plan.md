# 교차참조 링크(Cross-Reference Link) 기능 구현 계획

> 작성일: 2026-03-14
> 상태: 계획 (미착수)

---

## 1. 기능 개요

두 가지 유형의 교차참조를 자동 감지합니다:

### 1A. 조항 참조 (Clause References)
"Sub-Clause 8.7에 따라", "제14조 제1항에 의거", "as defined in Clause 1.1.4" 같은 텍스트를 감지하여:

1. 참조 대상 조항과 링크 연결
2. 클릭 시 해당 조항으로 스크롤 이동
3. 호버 시 참조 대상 조항의 미리보기 표시
4. "이 조항을 참조하는 다른 조항" 역참조 목록 제공

### 1B. 정의어 참조 (Defined Term References)
계약서 Definitions 조항(보통 1.1)에서 정의된 용어가 본문에서 대문자로 사용될 때 자동 감지하여:

1. 정의어를 해당 정의 조항으로 링크 연결 (예: `the Contractor` → Clause 1.1.2.2 정의)
2. 호버 시 정의 내용 미리보기 표시
3. 정의어 목록에 없는 대문자 용어는 "미해결 정의어"로 표시 (외부 문서 정의 가능성)

**정의어 예시 (FIDIC Red Book 2017)**:
- 단일어: `Contractor`, `Employer`, `Engineer`, `Subcontractor`
- 복합어: `Time for Completion`, `Taking-Over Certificate`, `Defects Notification Period`
- 한국어: `"갑"`, `"을"`, `"공사"` (정의 조항에서 `"..."이라 한다` 패턴으로 정의)

---

## 2. 설계 핵심 결정

| 결정 사항 | 선택 | 이유 |
|---|---|---|
| LLM 사용 여부 | **정규식 기반 (LLM 미사용)** | Gemini Free Tier 쿼터를 리스크 분석에 집중. 교차참조 패턴은 정형화되어 regex로 90%+ 커버 가능 |
| 처리 시점 | **clauses DB INSERT 직후, 분석 전** | 분석 프롬프트에 교차참조 정보를 포함할 수 있는 확장성 확보 |
| Docling sidecar 변경 | **없음** | 기존 파싱 결과(clauses)에 대한 후처리 |
| 에러 격리 원칙 | **non-fatal (실패해도 업로드 성공)** | 교차참조는 부가 기능이므로 실패 시 contract status를 blocking하지 않음 |
| 기존 파이프라인 수정 범위 | **persistParseResult 내 교차참조 호출만 추가** | `processContract()`, `sectionsToClauses()`, `qualityCheck()` 등 파싱 핵심 로직은 일체 수정하지 않음 |
| 기존 타입 하위호환 | **선택 필드만 추가, 기존 필드 변경 금지** | `getContractDetail()` 반환 타입에 optional 필드만 추가하여 기존 컴포넌트 컴파일 에러 방지 |

---

## 3. 전체 아키텍처

### 3.1 데이터 흐름

```
[기존 파이프라인]                         [신규 추가]
PDF/DOCX 업로드
    │
Docling sidecar 파싱
    │
sections[] → zones + clauses
    │
DB 저장 (clauses 테이블)
    │
    ├──→ [Phase A] 교차참조 감지 (신규)
    │         │
    │     정규식 기반 참조 패턴 추출
    │         │
    │     참조 대상 clause 매칭 (clause.number 기반)
    │         │
    │     cross_references 테이블 INSERT
    │
    └──→ [기존] Gemini 리스크 분석
              │
          clause_analyses 저장
```

### 3.2 파이프라인 통합 위치

```
기존 흐름:
  zones INSERT → clauses INSERT → contract status="filtering"

변경 흐름:
  zones INSERT → clauses INSERT (with .select("id, number, text, zone_key, content_format"))
                    │
                    → try { 교차참조 추출/저장 } → contract status="filtering"
                    │
                    └─ catch → warning 로그 + cross_ref_status="failed" + contract status="filtering" (정상 진행)
```

### 3.3 에러 격리 원칙

교차참조 기능은 **파싱 파이프라인의 부가 단계**이며, 실패해도 업로드/분석 흐름을 중단하지 않습니다.

```typescript
// persistParseResult() 내 교차참조 통합 패턴 (의사 코드)

// ⚠ 선행 조건: clauses INSERT 시 .select()로 UUID를 반환받아야 함
// 기존: supabase.from("clauses").insert(chunk)
// 변경: supabase.from("clauses").insert(chunk).select("id, number, text, zone_key, content_format")
// chunk 응답을 누적하여 insertedClauses 배열 구성

try {
  const xrefResult = await extractAndSaveCrossReferences(supabase, contractId, insertedClauses);
  console.log(`[cross-ref] ${xrefResult.total} refs extracted, ${xrefResult.resolved} resolved`);
  // cross_ref_status 업데이트
  await supabase.from("contracts").update({ cross_ref_status: xrefResult.skippedClauses > 0 ? "partial" : "completed" }).eq("id", contractId);
} catch (err) {
  // 교차참조 실패는 non-fatal — 업로드는 정상 완료
  console.warn(`[cross-ref] extraction failed, skipping:`, err);
  await supabase.from("contracts").update({ cross_ref_status: "failed" }).eq("id", contractId).catch(() => {});
}
// ← 여기서 contract status="filtering"으로 정상 전환
```

> **⚠ Critical 선행 작업**: 현재 `persistParseResult()`의 clauses INSERT에는 `.select()`가 없어 INSERT 후 clause UUID를 반환받지 못합니다. `extractAndSaveCrossReferences()`의 `source_clause_id` 확보를 위해, clauses INSERT를 `.insert(chunk).select("id, number, text, zone_key, content_format")`으로 변경해야 합니다. 이 수정은 기존 파이프라인 로직에 영향을 주지 않습니다 (반환값만 추가).

**수정하지 않는 파일 목록** (파싱 품질 보호):

| 파일 | 이유 |
|---|---|
| `lib/docling-adapter.ts` | `sectionsToClauses()`, `isCrossReference()`, `classifyHeadingRemainder()` 등 파싱 핵심 로직 보호 |
| `lib/document-parser.ts` | `ParsedClause`, `ParseResult` 기존 타입 변경 없음 |
| `lib/pipeline/process-contract.ts` | `processContract()` 흐름 변경 없음 |
| `lib/pipeline/steps/quality-check.ts` | 품질 검사 로직 변경 없음 |
| `scripts/docling_sidecar.py` | sidecar 파싱 로직 변경 없음 |

---

## 4. Backend 구현 계획

### 4.0 기존 `isCrossReference()`와의 관계

`lib/docling-adapter.ts`에는 이미 `isCrossReference()` 함수가 존재합니다. 이 함수는 **파싱 시점**에 `splitContentByClauses()` 내부에서 "Sub-Clause 1.1 [Title]" 패턴을 교차참조로 판별하여 **clause 분할 경계에서 제외**하는 역할을 합니다.

신규 교차참조 추출 엔진(`cross-reference-extractor.ts`)은 **DB 저장 이후**에 동작하므로, 기존 `isCrossReference()`와 **완전히 독립적**입니다.

| 구분 | 기존 `isCrossReference()` | 신규 추출 엔진 |
|---|---|---|
| 위치 | `lib/docling-adapter.ts` | `lib/analysis/cross-reference-extractor.ts` |
| 실행 시점 | 파싱 중 (sectionsToClauses) | DB 저장 후 (persistParseResult) |
| 목적 | clause 분할 시 교차참조 패턴을 경계로 잘못 분할하는 것을 방지 | 교차참조 링크 데이터 생성 |
| 입력 | section content (원시 텍스트) | clause.text (DB 저장된 텍스트) |
| 수정 여부 | **수정하지 않음** | **신규 생성** |

> **주의**: 두 모듈의 패턴이 동일한 텍스트를 다르게 해석할 수 있으나, 서로 다른 시점에 다른 목적으로 동작하므로 충돌하지 않습니다. 단, 향후 패턴 추가 시 양쪽을 함께 검토해야 합니다.

### 4.1 교차참조 패턴 감지 엔진

**신규 파일**: `lib/analysis/cross-reference-extractor.ts`

**함수**:
- `extractCrossReferences(clauseText: string, clauseId: string): CrossReferenceRaw[]`
- `extractListReferences(clauseText: string, clauseId: string): CrossReferenceRaw[]` — **나열형 전용**
- `matchReferencesToClauses(refs: CrossReferenceRaw[], clauseIndex: Map<string, string>): CrossReferenceResolved[]`
- `buildClauseIndex(clauses: { id: string; number: string | null }[]): Map<string, string>`

#### 4.1.1 조항 번호 공통 패턴 (CLAUSE_NUM)

모든 패턴에서 재사용할 조항 번호 정규식입니다. 기존 `\d+(?:\.\d+)*`에서 **영문자 접미사**와 **괄호 하위항**을 추가 지원합니다.

```typescript
// 매칭 대상: "8.7", "4.2A", "1.10A", "3(c)", "8.3B", "14.1[a]"
const CLAUSE_NUM = /\d+(?:\.\d+)*(?:[A-Za-z])?(?:\([a-z]\))?/;
// 소스 형태: "\\d+(?:\\.\\d+)*(?:[A-Za-z])?(?:\\([a-z]\\))?"
const CLAUSE_NUM_SRC = "\\d+(?:\\.\\d+)*(?:[A-Za-z])?(?:\\([a-z]\\))?";
```

실제 데이터에서 발견된 영문자 조항 번호 (24종):
`4.2A`, `1.10A`, `4.1A`, `8.3B`, `3A`, `3B`, `9A`, `9B`, `3(c)`, `1(a)`, `2(a)`, `10(a)` 등

#### 4.1.2 대괄호 제목 `[Title]` 처리

실제 데이터에서 **507건**의 참조가 `[Title]` 포함, **481건**이 `[Title]` 미포함. 대괄호 제목은 **선택 매칭**하되 offset 범위에 포함합니다.

```typescript
// [Title] 선택 매칭 — 줄바꿈이 대괄호 안에 포함될 수 있음
const BRACKET_TITLE = /(?:\s*\[[^\]]*\])?/;
const BRACKET_TITLE_SRC = "(?:\\s*\\[[^\\]]*\\])?";
```

**offset 결정**: matchedText에 `[Title]`까지 포함합니다. UI에서 전체를 링크로 표시합니다.

#### 4.1.3 단일 참조 패턴 (Simple Patterns)

개별로 등장하는 참조를 감지합니다. 나열형 참조와의 중복은 4.1.5에서 제거합니다.

| 패턴 유형 | 예시 | 정규식 패턴 |
|---|---|---|
| FIDIC Sub-Clause | "Sub-Clause 8.7", "Sub-Clause 4.2A" | `/[Ss]ub-?\s*[Cc]lauses?\s+(CLAUSE_NUM)(BRACKET_TITLE)/g` |
| Clause 참조 | "Clause 1.1.4", "Clause 20" | `/[Cc]lauses?\s+(CLAUSE_NUM)(BRACKET_TITLE)/g` |
| 조/항 한국어 | "제14조", "제1항" | `/제(\d+)조(?:\s*제(\d+)항)?/g` |
| Article 참조 | "Article 8", "Articles 1" | `/[Aa]rticles?\s+(CLAUSE_NUM)(BRACKET_TITLE)/g` |
| Section 참조 | "Section 3.1", "SECTION 5" | `/[Ss]ections?\s+(CLAUSE_NUM)(BRACKET_TITLE)/g` |
| 괄호 내 참조 | "(see 4.1)", "(refer to 8.7)" | `/\(\s*(?:see\|refer\s+to\|as\s+(?:per\|defined\s+in))\s+(CLAUSE_NUM)\s*\)/gi` |

> **변경 사항 (기존 대비)**:
> - `Clause` → `Clauses?` (복수형 지원). 실제 데이터: `Clauses` 10건, `Sub-Clauses` 9건, `Articles` 3건
> - `\d+(?:\.\d+)*` → `CLAUSE_NUM` (영문자 접미사 `4.2A`, 괄호 하위항 `3(c)` 지원)
> - 모든 패턴에 `BRACKET_TITLE` 선택 매칭 추가

#### 4.1.4 나열형 참조 전용 파서 (List Reference Parser)

**핵심 신규 로직**. 하나의 키워드(`Clauses`, `Sub-Clauses`, `Articles`) 뒤에 쉼표/and/or로 연결된 **복수의 조항 번호**를 감지합니다.

**실제 데이터 분석 결과** — 나열형 패턴 3가지:

| 패턴 | 예시 | 빈도 |
|---|---|---|
| **L1: 키워드 + 나열** | `Clauses 1 [GP], 18 [Ins], 20 [CD]` | 9건 |
| **L2: 키워드 전환** | `Clauses 1 [...], and Sub-Clauses 4.2 [...]` | 2건 |
| **L3: 범위 참조** | `Sub-Clauses 9.5 [...] to 9.7 [...]` | 7건 |

##### L1: 키워드 + 번호 나열 파서

```typescript
interface ListRefParseResult {
  keyword: string;           // "Clause" | "Sub-Clause" | "Article" | "Section"
  refs: ListRefItem[];       // 파싱된 참조 목록
  fullMatchStart: number;    // 전체 매칭 시작 offset
  fullMatchEnd: number;      // 전체 매칭 종료 offset
}
interface ListRefItem {
  number: string;            // "4.2A"
  title?: string;            // "Parent Company Guarantee"
  offsetStart: number;       // 이 참조의 시작 offset
  offsetEnd: number;         // 이 참조의 종료 offset (title 포함)
}

function extractListReferences(text: string, clauseId: string): CrossReferenceRaw[] {
  const results: CrossReferenceRaw[] = [];

  // Step 1: 키워드 위치 감지
  const KEYWORD_RE = /\b((?:Sub-\s*)?Clauses?|Articles?|Sections?)\s+/gi;
  let kwMatch: RegExpExecArray | null;

  while ((kwMatch = KEYWORD_RE.exec(text)) !== null) {
    const keyword = normalizeKeyword(kwMatch[1]); // "Sub-Clause", "Clause", "Article"
    const startPos = kwMatch.index;
    const afterKeyword = kwMatch.index + kwMatch[0].length;

    // Step 2: 키워드 이후 텍스트에서 나열된 번호들 추출
    const remaining = text.slice(afterKeyword);
    const items = parseNumberList(remaining, afterKeyword);

    if (items.length === 0) continue;

    // Step 3: 각 번호를 CrossReferenceRaw로 변환
    for (const item of items) {
      results.push({
        sourceClauseId: clauseId,
        matchedText: text.slice(item.offsetStart, item.offsetEnd),
        targetRef: item.number,
        offsetStart: item.offsetStart,
        offsetEnd: item.offsetEnd,
        patternType: keywordToPatternType(keyword),
        refType: "clause_ref",
      });
    }
  }

  return results;
}
```

##### parseNumberList() — 나열된 번호 추출 핵심 로직

```typescript
function parseNumberList(text: string, baseOffset: number): ListRefItem[] {
  const items: ListRefItem[] = [];

  // NUM [Title] 뒤에 오는 구분자: , / and / or / ; / . / 키워드 전환
  const ITEM_RE = new RegExp(
    `(${CLAUSE_NUM_SRC})` +                     // 그룹1: 번호
    `(\\s*\\[([^\\]]*)\\])?` +                  // 그룹2,3: [Title] (선택)
    `(\\s*(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s+or\\s+))` +  // 그룹4: 구분자
    `|` +
    `(${CLAUSE_NUM_SRC})` +                     // 그룹5: 마지막 번호
    `(\\s*\\[([^\\]]*)\\])?`,                   // 그룹6,7: [Title] (선택)
    "gi"
  );

  let pos = 0;
  let match: RegExpExecArray | null;

  // 첫 번째 번호 매칭
  const firstNum = new RegExp(`^(${CLAUSE_NUM_SRC})(\\s*\\[([^\\]]*)\\])?`, "i");
  const first = firstNum.exec(text);
  if (!first) return [];

  items.push({
    number: first[1],
    title: first[3]?.trim(),
    offsetStart: baseOffset,
    offsetEnd: baseOffset + first[0].length,
  });
  pos = first[0].length;

  // 후속 번호들: 구분자 + 번호 + [Title]
  const NEXT_RE = new RegExp(
    `^\\s*(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s+or\\s+)` +  // 구분자
    `(?:` +
      // 키워드 전환: "and Sub-Clauses 4.2" → 현재 리스트 종료, 새 리스트 시작
      `(?=((?:Sub-\\s*)?Clauses?|Articles?|Sections?)\\s+)` +
    `|` +
      // 다음 번호
      `(${CLAUSE_NUM_SRC})(\\s*\\[([^\\]]*)\\])?` +
    `)`,
    "i"
  );

  let safetyCount = 0;
  while (safetyCount++ < 50) {
    const remaining = text.slice(pos);
    const nextMatch = NEXT_RE.exec(remaining);
    if (!nextMatch) break;

    // 키워드 전환 감지 → 현재 리스트 종료
    if (nextMatch[1]) break;

    // 다음 번호 추가
    if (nextMatch[2]) {
      const numStart = baseOffset + pos + nextMatch.index +
                        nextMatch[0].indexOf(nextMatch[2]);
      items.push({
        number: nextMatch[2],
        title: nextMatch[4]?.trim(),
        offsetStart: numStart,
        offsetEnd: baseOffset + pos + nextMatch.index + nextMatch[0].length,
      });
    }

    pos += nextMatch.index + nextMatch[0].length;
  }

  // 단일 항목은 나열형이 아님 → 단일 참조 패턴에서 처리
  return items.length >= 2 ? items : [];
}
```

##### 키워드 전환 처리

```
"Clauses 1 [GP], 18 [Ins], and Sub-Clauses 4.2 [PB], 4.2A [PCG]"
         ↑ Clause 리스트           ↑ 전환점     ↑ Sub-Clause 리스트
```

`parseNumberList()`가 `and Sub-Clauses`를 만나면 현재 리스트를 종료합니다. 이후 `extractListReferences()`의 `KEYWORD_RE`가 `Sub-Clauses`를 새 키워드로 감지하여 별도 리스트로 파싱합니다.

```
결과:
  Clause 1, Clause 18                  → patternType: "clause"
  Sub-Clause 4.2, Sub-Clause 4.2A      → patternType: "fidic_subclause"
```

##### L3: 범위 참조 (`X.Y to X.Z`)

```typescript
// 나열형 파서 실행 후 범위 참조 검출
const RANGE_RE = new RegExp(
  `((?:Sub-\\s*)?Clauses?|Articles?|Sections?)\\s+` +
  `(${CLAUSE_NUM_SRC})\\s*\\[[^\\]]*\\]\\s+to\\s+` +
  `(${CLAUSE_NUM_SRC})\\s*\\[[^\\]]*\\]`,
  "gi"
);

function expandRange(startNum: string, endNum: string, clauseIndex: Map<string, string>): string[] {
  // clauseIndex에서 startNum과 endNum 사이에 있는 모든 조항 번호를 반환
  // 예: "9.5" to "9.7" → ["9.5", "9.6", "9.7"] (clauseIndex에 존재하는 것만)
  const prefix = startNum.split(".").slice(0, -1).join(".");

  // 영문자 접미사 감지: "4.2A" to "4.2C"
  const startLastStr = startNum.split(".").pop() ?? "0";
  const endLastStr = endNum.split(".").pop() ?? "0";
  const startAlpha = startLastStr.match(/^(\d+)([A-Za-z])$/);
  const endAlpha = endLastStr.match(/^(\d+)([A-Za-z])$/);

  if (startAlpha && endAlpha && startAlpha[1] === endAlpha[1]) {
    // 같은 숫자, 다른 알파벳: 4.2A ~ 4.2C → A, B, C
    const base = startAlpha[1];
    const startChar = startAlpha[2].charCodeAt(0);
    const endChar = endAlpha[2].charCodeAt(0);
    const expanded: string[] = [];
    for (let c = startChar; c <= endChar; c++) {
      const num = prefix ? `${prefix}.${base}${String.fromCharCode(c)}` : `${base}${String.fromCharCode(c)}`;
      if (clauseIndex.has(num)) expanded.push(num);
    }
    return expanded;
  }

  // 영문자 접미사가 포함되었지만 위 조건에 해당하지 않는 경우 → 양 끝점만 반환 (fallback)
  if (/[A-Za-z]$/.test(startLastStr) || /[A-Za-z]$/.test(endLastStr)) {
    const expanded: string[] = [];
    if (clauseIndex.has(startNum)) expanded.push(startNum);
    if (clauseIndex.has(endNum)) expanded.push(endNum);
    return expanded;
  }

  // 순수 숫자 범위
  const startLast = parseInt(startLastStr);
  const endLast = parseInt(endLastStr);

  const expanded: string[] = [];
  for (let i = startLast; i <= endLast; i++) {
    const num = prefix ? `${prefix}.${i}` : `${i}`;
    if (clauseIndex.has(num)) expanded.push(num);
  }
  return expanded;
}
```

실제 데이터: 범위 참조 7건 확인 (`5.1 to 5.9`, `9.5 to 9.7`, `11.1 to 11.7`)

#### 4.1.5 중복 제거 및 우선순위

나열형 파서(4.1.4)와 단일 패턴(4.1.3)이 **동일 참조를 중복 감지**할 수 있습니다.

```
"Sub-Clauses 4.2 [PB], 4.2A [PCG] and 14.2 [AP]"

나열형 파서: Sub-Clause 4.2, 4.2A, 14.2 (3건)
단일 패턴:   Sub-Clauses 4.2 (1건) — 복수형 키워드 + 첫 번호만 매칭
```

**중복 제거 전략**:

```typescript
function deduplicateRefs(refs: CrossReferenceRaw[]): CrossReferenceRaw[] {
  // 1. offset 범위가 겹치는 참조 감지
  // 2. 겹칠 경우 나열형 파서 결과를 우선 (더 정확한 스코프)
  // 3. 동일 (sourceClauseId, targetRef, offsetStart)는 하나만 유지
  refs.sort((a, b) => a.offsetStart - b.offsetStart);

  const result: CrossReferenceRaw[] = [];
  for (const ref of refs) {
    const last = result[result.length - 1];
    if (last && ref.offsetStart < last.offsetEnd) {
      // 겹침 → 더 넓은 범위(나열형)를 유지
      continue;
    }
    result.push(ref);
  }
  return result;
}
```

**실행 순서**:
1. `extractListReferences()` — 나열형 먼저 (우선순위 높음)
2. `extractSimpleReferences()` — 단일 패턴 (Section 4.1.3의 6개 패턴을 순차 적용)
3. `deduplicateRefs()` — 나열형이 이미 점유한 offset 구간의 단일 참조 제거

```typescript
/** 단일 조항 참조 추출 — Section 4.1.3의 SIMPLE_PATTERNS 6개를 순차 적용 */
function extractSimpleReferences(
  text: string,
  clauseId: string,
  contentFormat?: "markdown" | "plain"
): CrossReferenceRaw[];
```

### 4.2 정의어 추출 및 매칭 엔진

**신규 파일**: `lib/analysis/defined-term-extractor.ts`

**함수**:
- `extractDefinedTerms(clauses: ClauseForTermExtraction[]): DefinedTermExtracted[]` — Definitions zone 조항에서 정의어 목록 추출
- `detectDefinedTermUsages(clauseText: string, clauseId: string, termIndex: DefinedTermIndex): DefinedTermUsage[]` — 본문에서 정의어 사용 감지
- `buildDefinedTermIndex(terms: DefinedTermExtracted[]): DefinedTermIndex` — 빠른 매칭을 위한 인덱스 구축

#### 4.2.1 실제 파싱 결과 기반 정의어 구조 분석

실제 EPC 계약서(`parse_after.json`)의 Docling 파싱 결과를 분석한 결과, definitions 조항(총 219개 정의어)은 다음과 같은 구조로 저장됩니다:

**Docling sidecar 반환 구조** (각 정의어가 별도 section):
```json
{
  "heading": "1.1.1.1 \"Absolute Guarantee\" or \"Absolute Performance Levels\" means",
  "level": 4,
  "content": "each of the absolute performance guarantees or absolute performance\nlevels identified in Schedule 3A...",
  "zone_hint": "general_conditions"
}
```

**sectionsToClauses() 변환 후** (DB에 저장되는 형태):
- `classifyHeadingRemainder()`가 heading에서 `"means"`, `"has the meaning"` 등을 감지하면 **`"body"`로 분류**
- 결과: `title = undefined`, `content = heading + "\n" + body`, `clause_structure = "numbered_untitled"`

```
clause.number:  "1.1.1.1"
clause.title:   null
clause.text:    '1.1.1.1 "Absolute Guarantee" or "Absolute Performance Levels" means\neach of the absolute performance guarantees...'
clause.zoneKey: "definitions"  (또는 "general_conditions" — zone 감지 시점에 따라 다름)
```

> **핵심 발견**: 현재 sidecar는 `zone_hint: "general_conditions"`을 반환합니다. definitions zone은 TypeScript 측 `detectDocumentPart()`에서 heading 패턴으로 **재분류**됩니다. 따라서 정의어 추출 시 `zone_key` 필터 기준은 `"definitions"` 또는 `"general_conditions"` 모두를 고려해야 합니다.

#### 4.2.2 정의어 데이터 소스: heading vs text

정의어 이름은 두 곳에서 추출 가능합니다:

| 소스 | 예시 | 장점 | 단점 |
|---|---|---|---|
| `clause.text` 전체 | `'1.1.1.1 "Contractor" means the person...'` | heading+body가 이미 결합됨, 정의 내용도 함께 추출 가능 | 번호 prefix 제거 필요 |
| DB에서 `clause.number` + `clause.text` | number=`"1.1.1.1"`, text=위 전체 | 번호로 definitions 조항 필터링 쉬움 | 동일 |

**결정**: `clause.text` 전체를 스캔합니다. heading이 body에 합쳐져 있으므로 별도 분기 불필요.

#### 4.2.3 실제 파싱 결과에서 발견된 정의어 패턴 분류

219개 정의어를 분석한 결과, **5가지 핵심 패턴**이 확인되었습니다:

##### 패턴 A: 표준 정의 — `"Term" means ...` (약 60%)

```
heading: '1.1.1.6 "Affiliate" means, in relation to any person or entity, any other person'
content: 'or entity that directly or indirectly controls...'
```

- 정의어: `Affiliate`
- 정의 내용: heading의 `means` 이후 + content 전체
- 정규식: `/"([^"]{1,80})"\s+means\b/g`

> **주의**: 기존 계획서의 `[A-Z][^"]{1,60}` 패턴은 **소문자로 시작하는 정의어**(`"day"`, `"year"`)를 누락합니다. 실제 데이터에서 `"day"` means... 패턴이 확인되었으므로 `[A-Z]` 제약을 **제거**합니다.

##### 패턴 B: 의미 참조 — `"Term" has the meaning given to it in Sub-Clause X.Y` (약 25%)

```
heading: '1.1.1.4 "Advance Payment" has the meaning given to it in Sub-Clause 14.2'
content: '[Advance Payment].'
```

- 정의어: `Advance Payment`
- 정의 내용: `has the meaning given to it in Sub-Clause 14.2 [Advance Payment]`
- **특이사항**: 이 정의어의 실제 정의 내용은 **다른 조항(Sub-Clause 14.2)**에 있음
- 정규식: `/"([^"]{1,80})"\s+has\s+the\s+meaning\b/g`

##### 패턴 C: 동의어/별칭 — `"Term A" or "Term B" means ...` (약 8%)

```
heading: '1.1.1.1 "Absolute Guarantee" or "Absolute Performance Levels" means'
heading: '1.1.1.31 "Contract" or "EPC Contract" means the documents identified in'
heading: '1.1.1.143 "Owner", "Project Company" or "QNJSC" means the person'
```

- 정의어: **복수** (`Absolute Guarantee`, `Absolute Performance Levels` 각각 별도 `DefinedTermExtracted` 레코드)
- 모든 별칭이 **동일한 definitionClauseId**를 가리킴
- 정규식: `/"([^"]{1,80})"\s*(?:,\s*"([^"]{1,80})")?\s*(?:or\s+"([^"]{1,80})")?\s+means\b/g`

> **주의**: 3개 이상 별칭도 있음 (`"Owner", "Project Company" or "QNJSC"`). 고정 캡처 그룹이 아닌 **반복 매칭**이 필요합니다.

##### 패턴 D: 열거형 정의 — `"Term" means:` + `(a) ...` + `(b) ...` (약 5%)

```
heading: '1.1.1.47 "Defect" means:'
content: '(a) any defect, damage, fault...\n(b) any other aspect of the Works...'
```

- 정의어: `Defect`
- 정의 내용: content 전체 (열거 항목 포함)
- 정규식: `/"([^"]{1,80})"\s+means\s*:/g`
- **추가 처리**: content 끝에 `and the term "**Defective**" shall be construed accordingly.` 같은 **파생 정의어**가 포함될 수 있음

##### 패턴 E: 인라인 부정의어 — content 내부에서 추가 용어 정의 (약 2%)

```
heading: '1.1.1.24 "Confidential Information" means all information...'
content: '...by one Party (the "**Disclosing Party**") either directly or from any person
         associated with the Disclosing Party, to the other Party (the "**Receiving Party**")...'
```

- 주 정의어: `Confidential Information`
- 인라인 부정의어: `Disclosing Party`, `Receiving Party`
- 이들은 **별도 heading이 없으며** content 안에서만 정의됨
- 정규식: `/(the\s+)?"?\*?\*?"?([^"*]{1,60})"?\*?\*?"?\s*\)/g` (볼드+따옴표 혼합 패턴)

```
heading: '1.1.1.46 "day" means a twenty-four (24)-hour period...'
content: '00:00 midnight ICT Indochina Time and **"year"** means three hundred and sixty five (365) calendar days.'
```

- 주 정의어: `day`
- 인라인 부정의어: `year` (content 내 `**"year"** means` 패턴)
- 정규식: `/\*\*"([^"]{1,60})"\*\*\s+means\b/g`

#### 4.2.4 정의어 추출 알고리즘 (상세)

```typescript
interface ClauseForTermExtraction {
  id: string;
  number: string | null;
  title: string | null;
  text: string;
  zoneKey: string | null;
  contentFormat: "markdown" | "plain";
}

function extractDefinedTerms(clauses: ClauseForTermExtraction[]): DefinedTermExtracted[] {
  const terms: DefinedTermExtracted[] = [];

  // Step 1: definitions zone 조항만 필터링
  const defClauses = clauses.filter(c =>
    c.zoneKey === "definitions" || isDefinitionClauseByNumber(c.number)
  );

  for (const clause of defClauses) {
    // Step 1.5: "Not Used" 조항 건너뛰기
    if (clause.title === "Not Used" || /^\s*"?Not Used"?\s*$/.test(clause.text)) continue;

    // Step 1.6: title+text 결합 (heading/content 분할 복구)
    // 실제 데이터에서 "means"가 content에만 존재하여 title로 분리된 경우가 3건+ 발견됨
    // 예: title="Long Term Services Agreement" or "LTSA" or "O&M Contract", text="means the contract..."
    let scanText = clause.text;
    if (clause.title && /^\s*means\b|^\s*has\s+the\s+meaning\b/.test(clause.text)) {
      // title이 열린 따옴표로 끝나는 경우도 처리 (heading/content 경계에서 분할된 경우)
      scanText = `"${clause.title}" ${clause.text}`;
    } else if (clause.title && clause.title.endsWith('"') === false && /"$/.test(clause.title) === false) {
      // title에 따옴표가 있고 text에 means가 있으면 결합
      if (/"[^"]+/.test(clause.title) && /means\b|has\s+the\s+meaning\b/.test(clause.text)) {
        scanText = `${clause.title} ${clause.text}`;
      }
    }

    // Step 2: markdown strip (content_format === "markdown"인 경우)
    const { plain, offsetMap } = stripMarkdownForMatching(scanText, clause.contentFormat);

    // Step 3: 주 정의어 추출 (패턴 A~D)
    const primaryTerms = extractPrimaryTerms(plain, clause);

    // Step 4: 동의어/별칭 분리 (패턴 C) + definition_group_id 할당
    for (const pt of primaryTerms) {
      const aliases = splitAliases(pt.rawTermText);
      // aliases가 2개 이상이면 동의어 그룹 ID를 생성하여 모든 별칭에 동일 ID 부여
      const groupId = aliases.length > 1 ? crypto.randomUUID() : undefined;
      for (const alias of aliases) {
        terms.push({
          term: alias.trim(),
          normalizedTerm: alias.trim().toLowerCase(),
          variants: generateVariants(alias.trim()),
          definitionClauseId: clause.id,
          definitionClauseNumber: clause.number ?? "",
          definitionText: pt.definitionContent,
          defOffsetStart: remapOffset(pt.offsetStart, offsetMap),
          defOffsetEnd: remapOffset(pt.offsetEnd, offsetMap),
          definitionType: pt.type,  // "direct" | "reference" | "enumerated"
          definitionGroupId: groupId,  // 동의어 그룹 ID (2+ 별칭일 때만 설정)
        });
      }
    }

    // Step 5: 인라인 부정의어 추출 (패턴 E)
    const inlineTerms = extractInlineSubDefinitions(plain, clause);
    terms.push(...inlineTerms);

    // Step 6: content 재스캔 — 동일 section에 독립 정의어가 2개 이상 있는 경우
    // 예: 1.1.1.116 heading="LNG" means..., content="LNG Terminal" or "Terminal" means...
    // 주 정의어와 겹치지 않는 범위에서 패턴 A~D를 content에 재적용
    if (primaryTerms.length > 0) {
      const primaryEnd = Math.max(...primaryTerms.map(pt => pt.offsetEnd));
      const remainingText = plain.slice(primaryEnd);
      if (/"[^"]{1,80}"\s+means\b/.test(remainingText)) {
        const additionalTerms = extractPrimaryTerms(remainingText, clause, primaryEnd);
        for (const at of additionalTerms) {
          const aliases = splitAliases(at.rawTermText);
          const groupId = aliases.length > 1 ? crypto.randomUUID() : undefined;
          for (const alias of aliases) {
            terms.push({
              term: alias.trim(),
              normalizedTerm: alias.trim().toLowerCase(),
              variants: generateVariants(alias.trim()),
              definitionClauseId: clause.id,
              definitionClauseNumber: clause.number ?? "",
              definitionText: at.definitionContent,
              defOffsetStart: remapOffset(at.offsetStart, offsetMap),
              defOffsetEnd: remapOffset(at.offsetEnd, offsetMap),
              definitionType: at.type,
              definitionGroupId: groupId,
            });
          }
        }
      }
    }
  }

  return deduplicateTerms(terms);
}
```

##### Step 1: definitions zone 필터링

```typescript
function isDefinitionClauseByNumber(number: string | null): boolean {
  if (!number) return false;
  // 1.1.1.* 패턴 (FIDIC 스타일 definitions)
  return /^1\.1\.1\.\d+/.test(number) || /^1\.1\.\d+/.test(number);
}
```

> **중요**: `zone_key`가 `"definitions"`가 아닌 경우에도 `clause.number`가 `1.1.1.*` 패턴이면 정의어 조항으로 간주합니다. 실제 데이터에서 sidecar가 `zone_hint: "general_conditions"`를 반환하는 경우가 확인되었습니다.

##### Step 3: 주 정의어 추출 정규식

```typescript
const DEFINITION_PATTERNS = [
  // 패턴 A: "Term" means ...
  { re: /"([^"]{1,80})"\s+means\b/g,                    type: "direct" as const },
  // 패턴 A-2: "Term" shall mean ...
  { re: /"([^"]{1,80})"\s+shall\s+mean\b/g,             type: "direct" as const },
  // 패턴 B: "Term" has the meaning ...
  { re: /"([^"]{1,80})"\s+has\s+the\s+meaning\b/g,      type: "reference" as const },
  // 패턴 D: "Term" means: (열거형)
  { re: /"([^"]{1,80})"\s+means\s*:/g,                   type: "enumerated" as const },
  // 패턴 A-3: "Term" includes ...
  { re: /"([^"]{1,80})"\s+includes?\b/g,                 type: "direct" as const },
  // 패턴 A-4: "Term" refers to ...
  { re: /"([^"]{1,80})"\s+refers?\s+to\b/g,              type: "direct" as const },
  // 한국어: "용어"라 함은 ... / "용어"이라 한다
  { re: /"([^"]{1,30})"\s*(?:이)?라\s*(?:함은|한다)/g,    type: "direct" as const },
  // 한국어 괄호: (이하 "용어")
  { re: /\(이하\s*"([^"]{1,30})"\)/g,                    type: "direct" as const },
];
```

> **변경 사항**: 기존 `[A-Z][^"]{1,60}` → `[^"]{1,80}`으로 변경. 소문자 시작 정의어(`"day"`, `"year"`)와 60자 초과 정의어를 지원합니다.

##### Step 4: 동의어/별칭 분리

```typescript
function splitAliases(rawTermText: string): string[] {
  // 입력: '"Contract" or "EPC Contract"' 또는 '"Owner", "Project Company" or "QNJSC"'
  // 출력: ["Contract", "EPC Contract"] 또는 ["Owner", "Project Company", "QNJSC"]

  // 따옴표로 감싼 모든 용어를 추출
  const matches = [...rawTermText.matchAll(/"([^"]{1,80})"/g)];
  return matches.map(m => m[1]);
}
```

**실제 데이터 예시**:

| heading 내 용어 텍스트 | splitAliases() 결과 |
|---|---|
| `"Contractor" means` | `["Contractor"]` |
| `"Contract" or "EPC Contract" means` | `["Contract", "EPC Contract"]` |
| `"Owner", "Project Company" or "QNJSC" means` | `["Owner", "Project Company", "QNJSC"]` |
| `"Delay Liquidated Damages" or "Delay LDs" has the meaning` | `["Delay Liquidated Damages", "Delay LDs"]` |

##### Step 5: 인라인 부정의어 추출

definitions zone 내 clause의 `content` 부분에서 추가 정의어를 감지합니다:

```typescript
const INLINE_SUB_DEFINITION_PATTERNS = [
  // (the "**Bold Term**") — 괄호+볼드+따옴표 혼합
  /\(the\s*"?\*{0,2}"?([^"*\n]{2,60})"?\*{0,2}"?\s*\)/g,
  // **"term"** means — 볼드+따옴표+means
  /\*\*"([^"]{1,60})"\*\*\s+means\b/g,
  // "term" means — non-bold 변형 (content 내 독립 정의어)
  /"([^"]{1,60})"\s+means\b/g,
  // "**term**" means — 따옴표가 bold 바깥에 있는 경우
  /"?\*{0,2}([^"*\n]{2,60})\*{0,2}"?\s+means\b/g,
  // and the term "**Defective**" shall be construed accordingly
  /the\s+term\s+"?\*{0,2}"?([^"*\n]{2,60})"?\*{0,2}"?\s+shall\s+be\s+construed/g,
];
```

**실제 데이터 예시**:

| 패턴 | 소스 clause | 추출되는 부정의어 |
|---|---|---|
| `(the "**Disclosing Party**")` | 1.1.1.24 Confidential Information | `Disclosing Party` |
| `(the "**Receiving Party**")` | 1.1.1.24 Confidential Information | `Receiving Party` |
| `**"year"** means three hundred...` | 1.1.1.46 day | `year` |
| `"**Defective**" shall be construed` | 1.1.1.47 Defect | `Defective` |

#### 4.2.5 정의어 인덱스 구조

> **타입 구분**: `DefinedTermExtracted`는 추출 단계에서 사용하는 in-memory 타입이고, Section 4.4의 `DefinedTermRow`는 DB 행 타입입니다. 두 타입은 이름이 다르며 용도가 다릅니다.

```typescript
/** 추출 단계 in-memory 타입 (DB 저장 전) */
interface DefinedTermExtracted {
  term: string;                // 원형: "Time for Completion"
  normalizedTerm: string;      // 소문자: "time for completion"
  variants: string[];          // 변형: ["Time for Completion", "Time for Completions"]
  definitionClauseId: string;  // 정의된 조항의 clause.id
  definitionClauseNumber: string; // "1.1.1.5"
  definitionText: string;      // 정의 내용 전체 저장 (UI에서 truncation 처리)
  defOffsetStart?: number;     // clause text 내 정의어 위치 (일괄 정의 구조 대응)
  defOffsetEnd?: number;
  definitionType: "direct" | "reference" | "enumerated"; // 정의 유형
  definitionGroupId?: string;  // 동의어 그룹: crypto.randomUUID() (aliases > 1일 때)
  aliases?: string[];          // 동의어 목록: ["Contract", "EPC Contract"]
  parentTermId?: string;       // 인라인 부정의어의 경우, 주 정의어 ID
}

interface DefinedTermIndex {
  // 가장 긴 매칭 우선을 위해 term 길이 내림차순 정렬
  sortedTerms: DefinedTermExtracted[];
  // 빠른 조회용 맵 (normalizedTerm → DefinedTermExtracted)
  termMap: Map<string, DefinedTermExtracted>;
}
```

#### 4.2.6 변형 생성 로직

```typescript
function generateVariants(term: string): string[] {
  const variants = [term];

  // 1. 소유격: Contractor → Contractor's
  variants.push(term + "'s");
  variants.push(term + "\u2019s");  // 스마트 아포스트로피

  // 2. 복수형 (단순 규칙)
  if (!term.endsWith("s")) {
    variants.push(term + "s");
    if (term.endsWith("y") && !/[aeiou]y$/i.test(term)) {
      variants.push(term.slice(0, -1) + "ies");
    }
  }

  // 3. 하이픈 변형: Sub-Contractor → Subcontractor
  if (term.includes("-")) {
    variants.push(term.replace(/-/g, ""));
    variants.push(term.replace(/-/g, " "));
  }

  return [...new Set(variants)];
}
```

#### 4.2.7 본문 내 정의어 감지 로직

```typescript
function detectDefinedTermUsages(
  clauseText: string,
  clauseId: string,
  termIndex: DefinedTermIndex,
  excludedRanges: [number, number][]  // 이미 조항 참조로 매칭된 구간
): DefinedTermUsage[] {
  const usages: DefinedTermUsage[] = [];
  const occupiedRanges: [number, number][] = [...excludedRanges];

  // markdown strip (필요 시)
  const { plain, offsetMap } = stripMarkdownForMatching(clauseText);

  // longest match first — sortedTerms는 term 길이 내림차순
  for (const dt of termIndex.sortedTerms) {
    for (const variant of dt.variants) {
      // 단어 경계 매칭 (정확한 용어만)
      const re = new RegExp(`\\b${escapeRegex(variant)}\\b`, "g");
      let match: RegExpExecArray | null;

      while ((match = re.exec(plain)) !== null) {
        const start = match.index;
        const end = start + match[0].length;

        // 겹침 확인
        if (isOverlapping(start, end, occupiedRanges)) continue;

        // 대문자 확인 (소문자 정의어 "day" 등은 항상 매칭)
        if (!isCapitalizedMatch(plain, start, dt.term)) continue;

        // 문장 시작 위치 확인
        if (isSentenceStart(plain, start) && !isAlwaysCapitalized(dt.term)) continue;

        occupiedRanges.push([start, end]);
        usages.push({
          sourceClauseId: clauseId,
          term: dt.term,
          matchedText: match[0],
          definitionClauseId: dt.definitionClauseId,
          offsetStart: remapOffset(start, offsetMap),
          offsetEnd: remapOffset(end, offsetMap),
        });
      }
    }
  }

  return usages;
}
```

##### 대문자 확인 로직 상세

```typescript
function isCapitalizedMatch(text: string, offset: number, term: string): boolean {
  const firstChar = text[offset];

  // 소문자 정의어 ("day", "year") — 대문자 관계없이 항상 매칭
  if (/^[a-z]/.test(term)) return true;

  // 대문자 정의어 — 본문에서도 대문자여야 매칭
  return /[A-Z]/.test(firstChar);
}

function isSentenceStart(text: string, offset: number): boolean {
  if (offset === 0) return true;
  // 선행 텍스트에서 마지막 비공백 문자 확인
  const before = text.slice(Math.max(0, offset - 5), offset).trimEnd();
  return /[.!?:;]\s*$/.test(before) || /\r?\n/.test(text.slice(Math.max(0, offset - 2), offset));
}

function isAlwaysCapitalized(term: string): boolean {
  // 고유명사이거나 정의어 목록에 있는 대문자 용어는 문장 시작이어도 매칭
  // 예: "Contractor", "Works" — 이들은 어디서든 대문자로 사용되면 정의어
  return /^[A-Z]/.test(term);
}
```

> **결정**: 대문자로 시작하는 정의어(`Contractor`)는 문장 시작 위치여도 매칭합니다. 계약서에서 이런 용어는 거의 항상 정의어를 의미하기 때문입니다. 소문자 정의어(`day`, `year`)만 문장 시작 위치 필터를 적용하지 않고, **모든 위치에서 매칭**합니다.

#### 4.2.8 정의어 추출 결과 예시

실제 파싱 데이터(`parse_after.json`)의 219개 정의어 중 대표 예시:

| clause.number | 추출 정의어 | definitionType | aliases |
|---|---|---|---|
| 1.1.1.1 | Absolute Guarantee | direct | Absolute Performance Levels |
| 1.1.1.4 | Advance Payment | reference | — |
| 1.1.1.24 | Confidential Information | direct | — |
| 1.1.1.24 (inline) | Disclosing Party | direct (sub) | — |
| 1.1.1.24 (inline) | Receiving Party | direct (sub) | — |
| 1.1.1.31 | Contract | direct | EPC Contract |
| 1.1.1.46 | day | direct | — |
| 1.1.1.46 (inline) | year | direct (sub) | — |
| 1.1.1.47 | Defect | enumerated | — |
| 1.1.1.47 (inline) | Defective | direct (sub) | — |
| 1.1.1.143 | Owner | direct | Project Company, QNJSC |
| 1.1.1.216 | Vietnam | direct | — |

예상 추출 수: **약 250개** (주 정의어 219 + 인라인 부정의어 약 20~30 + 별칭 포함)

#### 4.2.9 zone_key 필터링 문제와 대응

실제 데이터에서 definitions 조항의 `zone_hint`가 `"general_conditions"`인 경우가 확인되었습니다. `zone_key` 기반 필터링만으로는 정의어 조항을 놓칠 수 있습니다.

**대응 전략 (우선순위순)**:

1. `zone_key === "definitions"` — 가장 정확
2. `clause.number`가 `1.1.1.*` 또는 `1.1.*` 패턴 — FIDIC 구조에서 높은 정확도
3. `clause.text`에 `"Term" means` 패턴이 포함 + zone이 `general_conditions` — fallback

```typescript
function isDefinitionClause(clause: ClauseForTermExtraction): boolean {
  // 1순위: zone_key
  if (clause.zoneKey === "definitions") return true;

  // 2순위: 조항 번호 패턴 (FIDIC 1.1.x.x)
  if (clause.number && /^1\.1(?:\.\d+)+$/.test(clause.number)) return true;

  // 3순위: 본문 패턴 + general_conditions zone (낮은 정확도)
  if (clause.zoneKey === "general_conditions" && /"[^"]{1,80}"\s+means\b/.test(clause.text)) {
    return true;
  }

  return false;
}
```

#### 4.2.10 DB 저장

정의어 참조도 `cross_references` 테이블에 함께 저장합니다. `pattern_type` 컬럼으로 구분:

| pattern_type | 의미 |
|---|---|
| `fidic_subclause` | Sub-Clause 참조 |
| `clause` | Clause 참조 |
| `article` | Article 참조 |
| `section` | Section 참조 |
| `ko_clause` | 한국어 조/항 참조 |
| `parenthetical` | 괄호 내 참조 |
| `defined_term` | 정의어 사용 |

별도 테이블 없이 동일한 `cross_references` 테이블을 사용하여 구현 복잡도를 낮춥니다.
`target_ref` 컬럼에는 정의어 원형("Contractor")을, `target_clause_id`에는 정의 조항 id를 저장합니다.

#### 4.2.11 정의어 목록 테이블 (필수)

정의어 목록 테이블은 **필수**입니다. 선택이 아닌 이유:

- 정의어 사전 UI (`DefinedTermsPanel`)의 필수 데이터 소스
- `usage_count` 집계의 단일 소스 (cross_references에서 매번 COUNT 쿼리 불필요)
- "미정의 용어 감지" 확장 기능의 기반 (대문자 사용인데 정의 없는 경우 경고)
- 별칭/동의어 관계 저장 (같은 `definition_group_id`로 그룹핑)
- 인라인 부정의어의 부모 관계 저장 (`parent_term_id`)
- 추가 비용: 계약 당 30~50행 수준으로 Supabase Free Tier에 무영향

```sql
-- supabase/migrations/012_add_cross_references.sql에 함께 포함
-- (5절 DB 마이그레이션의 defined_terms 테이블과 동일 — 상세 스키마는 5절 참조)
```

### 4.3 조항 참조 매칭 로직

**신규 파일**: `lib/analysis/cross-reference-resolver.ts`

**함수**: `resolveReferences(rawRefs: CrossReferenceRaw[], clauseIndex: Map<string, string>): CrossReferenceResolved[]`

매칭 전략 (순차 시도):
1. **정확 매칭**: `clauseIndex.get("8.7")` — clause.number === "8.7"
2. **정규화 매칭**: 선행 0 제거, 공백 제거, 대소문자 정규화 후 재시도
3. **영문자 접미사 매칭**: `"4.2A"` → `clauseIndex`에서 `"4.2A"` 검색. 없으면 `"4.2"` fallback
4. **부분 매칭**: "14.1"이 없으면 "14.1.1", "14.1.2" 등 하위 조항 중 첫 번째
5. **미해결(unresolved)**: 매칭 실패 시 `targetClauseId: null, isResolved: false`로 저장

자기참조 필터링: `sourceClauseId === targetClauseId`인 경우 제외

#### 4.3.1 clauseIndex 구축 확장

```typescript
function buildClauseIndex(clauses: { id: string; number: string | null }[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const c of clauses) {
    if (!c.number) continue;
    // 원본 번호
    index.set(c.number, c.id);
    // 정규화: 선행 0, 공백 제거
    const normalized = c.number.replace(/\b0+(\d)/g, "$1").replace(/\s+/g, "");
    if (normalized !== c.number) index.set(normalized, c.id);
    // 영문자 접미사 분리: "4.2A" → "4.2"도 등록 (충돌 시 원본 우선)
    const baseNum = c.number.replace(/[A-Za-z]+$/, "");
    if (baseNum !== c.number && !index.has(baseNum)) {
      index.set(baseNum, c.id);
    }
  }
  return index;
}
```

### 4.4 타입 정의

**신규 파일**: `types/cross-reference.ts`

```typescript
/** 참조 유형 구분 */
type CrossRefType = "clause_ref" | "defined_term";

/** 교차참조 처리 상태 (contracts 테이블 cross_ref_status 컬럼) */
type CrossRefStatus = "pending" | "completed" | "partial" | "failed" | null;

interface CrossReferenceRaw {
  sourceClauseId: string;
  matchedText: string;       // 원문 매칭 텍스트 ("Sub-Clause 8.7에 따라" 또는 "the Contractor's")
  targetRef: string;         // 정규화된 참조 번호 ("8.7") 또는 정의어 원형 ("Contractor")
  offsetStart: number;       // clauseText 내 시작 위치
  offsetEnd: number;         // clauseText 내 종료 위치
  patternType: string;       // 매칭된 패턴 유형 (fidic_subclause, clause, defined_term 등)
  refType: CrossRefType;     // "clause_ref" 또는 "defined_term"
}

interface CrossReferenceResolved {
  sourceClauseId: string;
  targetClauseId: string | null;  // 매칭 성공 시 clause.id, 실패 시 null
  targetRef: string;
  matchedText: string;
  offsetStart: number;
  offsetEnd: number;
  isResolved: boolean;            // targetClauseId가 null이 아니면 true
  refType: CrossRefType;
}

/** DB 행 타입 (defined_terms 테이블 매핑) */
interface DefinedTermRow {
  id: string;                  // UUID (DB PK)
  contract_id: string;
  term: string;                // 원형: "Time for Completion"
  normalized_term: string;     // 소문자: "time for completion"
  definition_clause_id: string;  // 정의된 조항의 clause.id
  definition_clause_number: string; // "1.1.1.5"
  definition_text: string;      // 정의 내용 전체 저장 (UI에서 truncation)
  def_offset_start?: number;    // clause text 내 정의어 위치
  def_offset_end?: number;
  definition_type: "direct" | "reference" | "enumerated";  // 정의 유형
  definition_group_id?: string;  // 동의어 그룹 UUID
  parent_term_id?: string;       // 인라인 부정의어의 부모 정의어 ID
  usage_count: number;           // 본문 내 사용 횟수
}

interface DefinedTermUsage {
  sourceClauseId: string;
  term: string;              // 매칭된 정의어 원형
  matchedText: string;       // 실제 본문 텍스트 ("the Contractor's")
  definitionClauseId: string;
  offsetStart: number;
  offsetEnd: number;
}
```

### 4.5 DB 저장 로직

**신규 파일**: `lib/data/cross-references.ts`

**함수**:
- `extractAndSaveCrossReferences(supabase, contractId, clauses): Promise<CrossRefSaveResult>`
- `getCrossReferencesForContract(contractId): Promise<CrossReferenceRow[]>`
- `getCrossReferencesForClause(clauseId): Promise<{ outgoing: CrossReferenceRow[]; incoming: CrossReferenceRow[] }>`

**반환 타입**:
```typescript
interface CrossRefSaveResult {
  total: number;
  resolved: number;
  definedTermsCount: number;
  skippedClauses: number;     // 개별 clause 추출 실패 시 skip한 수
  elapsedMs: number;          // 전체 처리 시간
}
```

#### 4.5.1 usage_count 집계 전략

`defined_terms.usage_count`는 in-memory 카운터로 집계하여 INSERT 시 함께 저장합니다.

```typescript
// extractAndSaveCrossReferences() 내부
const usageCounter = new Map<string, number>(); // normalizedTerm → count

// detectDefinedTermUsages()에서 매칭된 각 사용건을 카운트
for (const usage of definedTermUsages) {
  const key = usage.term.toLowerCase();
  usageCounter.set(key, (usageCounter.get(key) ?? 0) + 1);
}

// defined_terms INSERT 시 usage_count를 함께 설정
for (const dt of definedTerms) {
  dt.usage_count = usageCounter.get(dt.normalizedTerm) ?? 0;
}
```

> **결정**: `COUNT(*) GROUP BY` 쿼리 방식 대신 in-memory 카운터를 선택. 추가 쿼리 없이 가장 효율적이며, 계약 당 30~50개 정의어 규모에서 메모리 부담 없음.

#### 4.5.2 재처리 멱등성

동일 계약에 대해 재처리 시 기존 데이터를 먼저 삭제합니다.

```typescript
// extractAndSaveCrossReferences() 시작 시
await supabase.from("cross_references").delete().eq("contract_id", contractId);
await supabase.from("defined_terms").delete().eq("contract_id", contractId);
```

이로써 UNIQUE constraint violation 없이 완전한 재생성이 가능합니다. `ON CONFLICT DO NOTHING` 대신 DELETE-then-INSERT 패턴을 사용하여 부분 업데이트로 인한 데이터 불일치를 방지합니다.

#### 4.5.3 RegExp 미리 컴파일 (성능 최적화)

`detectDefinedTermUsages()`에서 매 variant마다 `new RegExp()`를 호출하면 동적 정규식 생성 비용이 큽니다. `buildDefinedTermIndex()` 시점에 미리 컴파일합니다.

```typescript
interface DefinedTermIndex {
  sortedTerms: DefinedTermExtracted[];
  termMap: Map<string, DefinedTermExtracted>;
  // 미리 컴파일된 variant별 RegExp (신규 — 4.2.5의 기본 정의를 확장)
  variantRegexMap: Map<string, RegExp>;  // variant → compiled regex
}

function buildDefinedTermIndex(terms: DefinedTermExtracted[]): DefinedTermIndex {
  const variantRegexMap = new Map<string, RegExp>();
  for (const dt of terms) {
    for (const variant of dt.variants) {
      if (!variantRegexMap.has(variant)) {
        variantRegexMap.set(variant, new RegExp(`\\b${escapeRegex(variant)}\\b`, "g"));
      }
    }
  }
  // ...
}
```

### 4.6 파이프라인 통합 및 에러 격리

#### 4.6.1 에러 격리 전략

교차참조 추출/저장은 **non-fatal** 단계입니다. 실패 시 업로드가 중단되지 않습니다.

**3단계 격리**:

| 레벨 | 범위 | 실패 시 동작 |
|---|---|---|
| **L1: 전체** | `extractAndSaveCrossReferences()` 전체 | catch → warning 로그, contract status 정상 전환 |
| **L2: 조항별** | 개별 clause의 regex 추출 | catch → 해당 clause skip, `skippedClauses++`, 나머지 조항 계속 처리 |
| **L3: DB 저장** | batch INSERT (100건) 실패 | catch → 해당 batch skip, warning 로그, 다음 batch 계속 |

```typescript
// L1: persistParseResult() 내부
try {
  const xrefResult = await extractAndSaveCrossReferences(supabase, contractId, insertedClauses);
  console.log(`[cross-ref] done: ${xrefResult.total} refs, ${xrefResult.resolved} resolved, ${xrefResult.elapsedMs}ms`);
} catch (err) {
  console.warn(`[cross-ref] failed, skipping:`, err);
}

// L2: extractAndSaveCrossReferences() 내부
for (const clause of clauses) {
  try {
    const refs = extractCrossReferences(clause.text, clause.id);
    allRefs.push(...refs);
  } catch (err) {
    console.warn(`[cross-ref] clause ${clause.number} skipped:`, err);
    result.skippedClauses++;
  }
}

// L3: DB batch insert
for (const batch of chunks(allRefs, 100)) {
  try {
    await supabase.from("cross_references").insert(batch);
  } catch (err) {
    console.warn(`[cross-ref] batch insert failed (${batch.length} rows):`, err);
  }
}
```

#### 4.6.2 처리 시간 예산

교차참조 추출은 업로드 파이프라인의 300초 타임아웃 안에 완료되어야 합니다. 기존 파싱+저장이 약 30~120초를 사용하므로, 교차참조에는 **최대 30초**를 할당합니다.

| 항목 | 예산 | 산출 근거 |
|---|---|---|
| 정의어 추출 (definitions zone) | 2초 | 50~100개 조항 × 9개 패턴 |
| 조항참조 추출 (전체 조항) | 10초 | 700개 조항 × 7개 패턴 |
| 정의어 매칭 (전체 조항) | 10초 | 700개 조항 × 50개 정의어 (longest match) |
| 참조 해결 + DB INSERT | 8초 | ~5,000행 batch insert |
| **합계** | **30초** | 300초 파이프라인의 10% |

**타임아웃 구현**:
```typescript
const CROSS_REF_TIMEOUT_MS = 30_000;

async function extractAndSaveCrossReferences(...) {
  const deadline = Date.now() + CROSS_REF_TIMEOUT_MS;

  for (const clause of clauses) {
    if (Date.now() > deadline) {
      console.warn(`[cross-ref] timeout after ${CROSS_REF_TIMEOUT_MS}ms, processed ${processedCount}/${clauses.length} clauses`);
      break;  // 부분 결과 저장 후 종료
    }
    // ... 추출 로직
  }
}
```

#### 4.6.3 contentFormat별 정규식 분기

clause의 `content_format`이 `"markdown"`인 경우 bold markup(`**text**`)이 포함되어 있습니다. 정규식 매칭 전에 markup을 strip해야 offset이 정확합니다.

**전략**: 원본 텍스트와 strip된 텍스트를 **모두 보관**하고, 매칭은 strip 텍스트에서 수행하되 offset은 원본 기준으로 재매핑합니다.

```typescript
function stripMarkdownForMatching(
  text: string,
  contentFormat?: "markdown" | "plain"
): { plain: string; offsetMap: number[] } {
  // plain format이면 strip 불필요
  if (contentFormat === "plain" || !text.includes("**")) {
    // identity map: plain[i] = original[i]
    const offsetMap = Array.from({ length: text.length }, (_, i) => i);
    return { plain: text, offsetMap };
  }

  // offsetMap: plain text의 각 인덱스(i) → 원본 text의 인덱스(offsetMap[i])
  // 즉, plain[i]는 original[offsetMap[i]]에 대응
  const plainChars: string[] = [];
  const offsetMap: number[] = [];
  let i = 0;

  while (i < text.length) {
    // **bold** marker 감지
    if (text[i] === '*' && text[i + 1] === '*') {
      i += 2; // ** 건너뛰기 (offset 매핑에서 제외)
      continue;
    }
    plainChars.push(text[i]);
    offsetMap.push(i);
    i++;
  }

  let plain = plainChars.join("");

  // pdfplumber bold 공백 누락 정규화:
  // "ReceivingParty" → "Receiving Party" (camelCase 분리)
  // 연속 대문자 사이에 공백 삽입: "LNGTerminal" → "LNG Terminal"
  plain = plain.replace(/([a-z])([A-Z])/g, (_, low, up) => {
    // offsetMap 조정은 여기서 하지 않음 — 정의어 추출에만 사용, cross-ref offset은 원본 기준
    return `${low} ${up}`;
  });
  // 주의: 위 정규화 후 offsetMap은 더 이상 1:1 대응이 아님
  // 정의어 추출(term 이름 매칭)에는 정규화된 plain 사용
  // cross-reference offset 저장 시에는 remapOffset()으로 원본 기준 복원

  return { plain, offsetMap };
}

function remapOffset(plainOffset: number, offsetMap: number[]): number {
  // plain text의 offset을 원본 text의 offset으로 변환
  if (plainOffset >= offsetMap.length) return offsetMap[offsetMap.length - 1] + 1;
  if (plainOffset < 0) return 0;
  return offsetMap[plainOffset];
}
```

> **주의**: `content_format === "plain"`이거나 `null`인 경우 strip 불필요 — identity map 반환으로 불필요한 연산 방지. `content_format`이 `null`(마이그레이션 010 이전 데이터)이면 `"plain"`으로 취급합니다.

#### 4.6.4 기존 계약 재처리 시 주의사항 (Phase 6-4)

기존 clauses의 `text`는 `qualityCheck()`를 거친 후의 텍스트입니다. 재처리 시:

1. `content_format` 컬럼을 확인하여 markdown/plain 분기
2. 이미 존재하는 cross_references 행을 **DELETE 후 재생성** (upsert 아님)
3. defined_terms의 `usage_count`도 재집계

### 4.7 API 엔드포인트

서버 컴포넌트에서 직접 조회하므로 별도 REST 엔드포인트는 Phase 5에서 필요시 추가.

```
GET /api/contracts/:id/cross-references (선택적)
```

Response:
```json
{
  "ok": true,
  "references": [
    {
      "id": "uuid",
      "source_clause_id": "uuid",
      "source_clause_number": "4.1",
      "target_clause_id": "uuid",
      "target_clause_number": "8.7",
      "target_ref": "8.7",
      "matched_text": "Sub-Clause 8.7",
      "offset_start": 142,
      "offset_end": 157,
      "is_resolved": true,
      "ref_type": "clause_ref",
      "pattern_type": "fidic_subclause"
    },
    {
      "id": "uuid",
      "source_clause_id": "uuid",
      "source_clause_number": "4.1",
      "target_clause_id": "uuid",
      "target_clause_number": "1.1.2.2",
      "target_ref": "Contractor",
      "matched_text": "the Contractor",
      "offset_start": 4,
      "offset_end": 18,
      "is_resolved": true,
      "ref_type": "defined_term",
      "pattern_type": "defined_term"
    }
  ],
  "stats": {
    "total": 214,
    "resolved": 189,
    "unresolved": 25,
    "clause_refs": 87,
    "defined_term_refs": 127
  },
  "defined_terms": [
    { "term": "Contractor", "clause_number": "1.1.2.2", "usage_count": 42 },
    { "term": "Time for Completion", "clause_number": "1.1.6.5", "usage_count": 18 }
  ]
}
```

---

## 5. DB 마이그레이션

**신규 파일**: `supabase/migrations/012_add_cross_references.sql`

> **주의**: 기존 `011_fix_rls_service_role.sql`이 이미 존재하므로 012번으로 부여합니다.

```sql
-- 교차참조 테이블 (조항 참조 + 정의어 참조 통합)
CREATE TABLE IF NOT EXISTS public.cross_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  source_clause_id UUID NOT NULL REFERENCES public.clauses(id) ON DELETE CASCADE,
  target_clause_id UUID REFERENCES public.clauses(id) ON DELETE SET NULL,
  target_ref TEXT NOT NULL,          -- 조항 번호("8.7") 또는 정의어 원형("Contractor")
  matched_text TEXT NOT NULL,
  offset_start INTEGER NOT NULL,
  offset_end INTEGER NOT NULL,
  pattern_type TEXT NOT NULL,        -- fidic_subclause, clause, article, defined_term 등
  ref_type TEXT NOT NULL DEFAULT 'clause_ref',  -- 'clause_ref' 또는 'defined_term'
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 순방향 조회: "이 조항이 참조하는 조항들"
CREATE INDEX IF NOT EXISTS idx_xref_source
  ON public.cross_references (source_clause_id);

-- 역방향 조회: "이 조항을 참조하는 조항들"
CREATE INDEX IF NOT EXISTS idx_xref_target
  ON public.cross_references (target_clause_id)
  WHERE target_clause_id IS NOT NULL;

-- 계약 단위 전체 조회
CREATE INDEX IF NOT EXISTS idx_xref_contract
  ON public.cross_references (contract_id);

-- 중복 방지
CREATE UNIQUE INDEX IF NOT EXISTS idx_xref_unique_position
  ON public.cross_references (source_clause_id, offset_start, offset_end);

-- ref_type 별 필터링 (정의어만 조회, 조항참조만 조회 등)
CREATE INDEX IF NOT EXISTS idx_xref_ref_type
  ON public.cross_references (contract_id, ref_type);

-- ── 정의어 목록 테이블 (필수) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.defined_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  clause_id UUID NOT NULL REFERENCES public.clauses(id) ON DELETE CASCADE,
  clause_number TEXT,                     -- 비정규화: "1.1.1.36" (JOIN 없이 UI 표시용)
  term TEXT NOT NULL,                     -- 원형: "Time for Completion"
  normalized_term TEXT NOT NULL,          -- 소문자: "time for completion"
  definition_text TEXT,                   -- 정의 내용 전체 저장 (UI에서 truncation 처리)
  definition_type TEXT NOT NULL DEFAULT 'direct',  -- 'direct' | 'reference' | 'enumerated'
  offset_start INTEGER,                   -- clause text 내 정의어 시작 위치
  offset_end INTEGER,                     -- clause text 내 정의어 종료 위치
  usage_count INTEGER NOT NULL DEFAULT 0, -- 본문 내 사용 횟수
  parent_term_id UUID REFERENCES public.defined_terms(id) ON DELETE SET NULL,  -- 인라인 부정의어의 부모
  definition_group_id UUID,               -- 동의어 그룹 ID (별칭끼리 동일값)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_defined_terms_contract
  ON public.defined_terms (contract_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_defined_terms_unique
  ON public.defined_terms (contract_id, normalized_term);

-- 동의어 그룹 조회
CREATE INDEX IF NOT EXISTS idx_defined_terms_group
  ON public.defined_terms (definition_group_id)
  WHERE definition_group_id IS NOT NULL;

-- 인라인 부정의어의 부모 조회
CREATE INDEX IF NOT EXISTS idx_defined_terms_parent
  ON public.defined_terms (parent_term_id)
  WHERE parent_term_id IS NOT NULL;

-- ── contracts 테이블에 교차참조 상태 추적 컬럼 추가 ─────────────────────
ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS cross_ref_status TEXT DEFAULT NULL;
-- 값: 'pending' | 'completed' | 'partial' | 'failed' | null (미실행)

-- ── RLS 정책 (기존 011_fix_rls_service_role.sql 패턴 준수) ─────────────
ALTER TABLE public.cross_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.defined_terms ENABLE ROW LEVEL SECURITY;

-- service_role은 전체 접근
CREATE POLICY "Service role full access on cross_references"
  ON public.cross_references FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role full access on defined_terms"
  ON public.defined_terms FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
```

---

## 6. Frontend 구현 계획

> **UI 목업 참조**: `docs/cross-reference-ui-mockup.html`에 전체 시각 디자인이 정의되어 있습니다. 브라우저에서 열어 실제 렌더링을 확인하세요.

### 6.0 디자인 토큰 + Tailwind 구현 전략

기존 프로젝트 디자인 토큰(`app/globals.css`)에 교차참조 전용 토큰을 추가합니다.

**수정 파일**: `app/globals.css`

```css
/* ── 교차참조 전용 토큰 ── */
--xref-clause: #4C8BF5;          /* 조항 참조 = accent-blue */
--xref-clause-dim: rgba(76,139,245,0.12);
--xref-term: #34D399;            /* 정의어 참조 = accent-green과 동일값. 별도 emerald 토큰 불필요 */
--xref-term-dim: rgba(52,211,153,0.10);
--xref-unresolved: #6B6E82;      /* 미해결 참조 = text-muted */
```

> **토큰 결정**: `--xref-term`은 기존 `--accent-green: #34D399`과 동일값입니다. 의미 분리를 위해 별도 CSS 변수를 정의하되, 실제 렌더링은 같은 색상입니다. 별도 `accent-emerald` 토큰을 추가하지 않습니다.

**수정 파일**: `tailwind.config.ts`

```typescript
// extend.colors에 추가
xref: {
  clause: 'var(--xref-clause)',
  'clause-dim': 'var(--xref-clause-dim)',
  term: 'var(--xref-term)',
  'term-dim': 'var(--xref-term-dim)',
  unresolved: 'var(--xref-unresolved)',
}

// extend.keyframes에 추가
'bounce-down': {
  '0%, 100%': { transform: 'translateY(0)' },
  '50%': { transform: 'translateY(2px)' },
}

// extend.animation에 추가
'bounce-down': 'bounce-down 1.2s infinite',
```

**수정 파일**: `app/globals.css` (Tailwind-only 제약 예외 — 한정적 유틸리티 클래스)

```css
/* ── 교차참조 전용 유틸리티 (Tailwind에 네이티브 대안 없는 경우만) ── */

/* 커스텀 스크롤바 (HoverCard body + DefinedTermsPanel) */
.xref-thin-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: var(--border-light) transparent;
}
.xref-thin-scrollbar::-webkit-scrollbar { width: 4px; }
.xref-thin-scrollbar::-webkit-scrollbar-track { background: transparent; }
.xref-thin-scrollbar::-webkit-scrollbar-thumb {
  background: var(--border-light);
  border-radius: 2px;
}
.xref-thin-scrollbar::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

/* 스크롤 가능 본문 하단 페이드 마스크 */
.xref-preview-fade {
  mask-image: linear-gradient(to bottom, black 85%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 85%, transparent 100%);
}
.xref-preview-fade:hover,
.xref-preview-fade:focus-within {
  mask-image: none;
  -webkit-mask-image: none;
}
```

> **Tailwind 예외 근거**: `mask-image`, `::-webkit-scrollbar`, `scrollbar-width`는 Tailwind에 네이티브 유틸리티가 없으므로 `globals.css`에 한정적 유틸리티 클래스로 추가합니다. `@keyframes`는 `tailwind.config.ts`의 `extend.keyframes`에 등록하여 `animate-bounce-down`으로 사용합니다.

**사전 조건**: `npx shadcn@latest add hover-card` 실행하여 `@radix-ui/react-hover-card` + `components/ui/hover-card.tsx` 설치 필요.

**아이콘 결정**: 목업의 이모지(`📄`, `📖`, `📑`)는 시각 설명용. 구현 시 lucide-react 아이콘으로 대체:
- `📄` → `FileText`
- `📖` → `BookOpen`
- `📑` → `BookOpenCheck`

### 6.1 데이터 페칭 및 가공

**수정 파일**: `lib/data/contracts.ts` (기존 파일 — 이미 `getContractDetail()` 함수 존재)

> **⚠ 선행 작업**: 기존 `getContractDetail()` 함수의 clauses SELECT 컬럼 목록에 `content_format, zone_key, sort_order, parent_clause_number`를 추가하고, 교차참조/정의어 optional 조회 로직을 삽입합니다. 삽입 위치: 기존 clauses 조회 이후, analyses 조회와 **병렬**로 cross_references/defined_terms를 조회합니다.

`getContractDetail()` 반환 타입에 `crossReferences?: CrossReferenceRow[]`와 `definedTerms?: DefinedTermRowWithAliases[]`를 **optional 필드**로 추가합니다.

**하위호환 전략**:

1. 반환 타입의 신규 필드는 모두 `?` (optional) — 기존 컴포넌트에서 타입 에러 발생하지 않음
2. cross_references 테이블이 아직 존재하지 않는 환경(마이그레이션 미적용)에서는 빈 배열 반환
3. ContractDetailView에 crossReferences prop 전달 시에도 optional로 처리

```typescript
// lib/data/contracts.ts
interface ContractDetail {
  // ... 기존 필드 (변경 없음)
  crossReferences?: CrossReferenceRow[];           // 신규, optional
  definedTerms?: DefinedTermRowWithAliases[];      // 신규, optional — aliases 포함
}

// 조회 시 테이블 존재 여부 방어
// ⚠ Supabase는 존재하지 않는 테이블 접근 시 throw하지 않고 error 객체를 반환함
// error.code === "42P01" (relation does not exist) 체크 필요
let crossRefs: CrossReferenceRow[] = [];
let definedTerms: DefinedTermRowWithAliases[] = [];

{
  const { data, error } = await supabase
    .from("cross_references")
    .select("*")
    .eq("contract_id", contractId);
  if (error?.code === "42P01") {
    crossRefs = [];  // 테이블 미존재 (마이그레이션 미적용)
  } else if (error) {
    console.warn("[cross-ref] query failed:", error.message);
    crossRefs = [];
  } else {
    crossRefs = data ?? [];
  }
}

{
  const { data, error } = await supabase
    .from("defined_terms")
    .select("*")
    .eq("contract_id", contractId)
    .order("usage_count", { ascending: false });
  if (error?.code === "42P01") {
    definedTerms = [];
  } else if (error) {
    console.warn("[cross-ref] defined_terms query failed:", error.message);
    definedTerms = [];
  } else {
    // aliases 구성: definition_group_id 기반 그룹핑
    definedTerms = buildTermsWithAliases(data ?? []);
  }
}
```

#### 6.1.1 별칭(aliases) 서버 사이드 그룹핑

`definition_group_id`가 동일한 defined_terms를 그룹핑하여 `aliases: string[]` 필드를 구성합니다.

```typescript
interface DefinedTermRowWithAliases {
  id: string;
  term: string;
  normalized_term: string;
  clause_id: string;
  clause_number: string | null;   // 비정규화 컬럼 (JOIN 불필요)
  definition_text: string | null;
  definition_type: string;
  usage_count: number;
  parent_term_id: string | null;
  definition_group_id: string | null;
  aliases: string[];              // 같은 group의 다른 term들: ["EPC Contract"]
}

function buildTermsWithAliases(rows: DefinedTermRow[]): DefinedTermRowWithAliases[] {
  // Step 1: definition_group_id별 그룹 생성
  const groups = new Map<string, DefinedTermRow[]>();
  for (const row of rows) {
    if (row.definition_group_id) {
      const group = groups.get(row.definition_group_id) ?? [];
      group.push(row);
      groups.set(row.definition_group_id, group);
    }
  }

  // Step 2: 각 row에 aliases 배열 추가
  return rows.map(row => ({
    ...row,
    aliases: row.definition_group_id
      ? (groups.get(row.definition_group_id) ?? [])
          .filter(r => r.id !== row.id)
          .map(r => r.term)
      : [],
  }));
}
```

**수정 파일**: `app/contracts/[id]/page.tsx`

서버 컴포넌트에서 crossReferences, definedTerms를 ContractDetailView에 prop으로 전달.

### 6.2 컴포넌트 구조 및 데이터 흐름

#### 6.2.1 Component Tree

```
ContractDetailView (props: crossReferences?, definedTerms?)
├── page-header
│   └── XrefStatsBar (props: stats)    ← 교차참조 통계 (신규)
│       └── 미해결 경고 배너 (조건부)
│
├── ContractTocPanel (좌측) (props: +definedTerms, +onTermClick)
│   ├── 기존 TOC 목록
│   └── TocTermsSection (props: definedTerms, onTermClick)   ← collapsible 섹션
│       └── DefinedTermsPanel (props: definedTerms, onTermClick)  ← 하단 배치 확정
│
├── 조항 목록 (우측)
│   └── ClauseSectionGroup
│       └── 조항 카드 (인라인 JSX — ContractDetailView 내부)
│           ├── 헤더 (번호 + 제목 + 배지)
│           ├── ClauseTextWithRefs (props: text, refs, termIndex, onClauseClick)
│           │   ├── plain text 구간
│           │   ├── CrossRefLink (clause_ref) (props: ref, onClauseClick)
│           │   │   └── CrossRefPreview (props: targetClause | targetTerm)
│           │   └── CrossRefLink (defined_term) (props: ref, onClauseClick)
│           │       └── CrossRefPreview (props: targetClause | targetTerm)
│           │
│           ├── ClauseInlineAnalysis (기존)
│           └── IncomingReferences (props: incomingRefs, clauseLookup, onClauseClick)
│
└── (DefinedTermsPanel은 TOC 패널 하단에 배치 — 독립 탭 아님)
```

#### 6.2.2 상태 관리 결정

**전달 방식: props + useMemo 인덱싱** (zustand store 확장 없음)

교차참조 데이터는 서버 컴포넌트에서 한 번 로드하여 props로 전달합니다. 기존 zustand store(`useContractDetailViewStore`)에 교차참조 상태를 추가하지 않습니다.

이유:
- 교차참조 데이터는 계약 로드 시 한 번 설정되고 변경되지 않음 (읽기 전용)
- HoverCard 열림/닫힘은 shadcn `HoverCard`의 내부 상태로 자동 관리됨
- 추가 store 없이 props만으로 모든 UI를 렌더링 가능

```typescript
// ContractDetailView.tsx 내부 — 교차참조 인덱싱
interface ContractDetailViewProps {
  // ... 기존 props
  crossReferences?: CrossReferenceRow[];
  definedTerms?: DefinedTermRowWithAliases[];
}

function ContractDetailView({ crossReferences = [], definedTerms = [], ...rest }: ContractDetailViewProps) {
  // ── 교차참조 인덱스 (한 번만 계산) ──
  const xrefIndex = useMemo(() => {
    // clause별 outgoing refs
    const outgoing = new Map<string, CrossReferenceRow[]>();
    // clause별 incoming refs
    const incoming = new Map<string, CrossReferenceRow[]>();
    // 통계
    const stats = { clauseRefs: 0, termRefs: 0, resolved: 0, unresolved: 0 };

    for (const ref of crossReferences) {
      // outgoing
      const out = outgoing.get(ref.source_clause_id) ?? [];
      out.push(ref);
      outgoing.set(ref.source_clause_id, out);

      // incoming (resolved만)
      if (ref.target_clause_id) {
        const inc = incoming.get(ref.target_clause_id) ?? [];
        inc.push(ref);
        incoming.set(ref.target_clause_id, inc);
      }

      // 통계 집계
      if (ref.ref_type === "clause_ref") stats.clauseRefs++;
      else stats.termRefs++;
      if (ref.is_resolved) stats.resolved++;
      else stats.unresolved++;
    }

    return { outgoing, incoming, stats };
  }, [crossReferences]);

  // ── 정의어 인덱스 ──
  const termIndex = useMemo(() => {
    const byNormalized = new Map<string, DefinedTermRowWithAliases>();
    for (const dt of definedTerms) {
      byNormalized.set(dt.normalized_term, dt);
    }
    return { terms: definedTerms, byNormalized };
  }, [definedTerms]);

  // ── clause ID → clause 빠른 조회 (역참조 표시용) ──
  const clauseLookup = useMemo(() => {
    const map = new Map<string, { number: string; title: string | null }>();
    for (const clause of clauseItems) {
      map.set(clause.id, { number: clause.number ?? "", title: clause.title ?? null });
    }
    return map;
  }, [clauseItems]);

  // ... 기존 렌더링 + 교차참조 props 전달
}
```

#### 6.2.3 데이터 전달 경로 요약

```
서버 컴포넌트 (page.tsx)
  │ getContractDetail() → crossReferences[], definedTerms[]
  ▼
ContractDetailView (props 수신)
  │ useMemo → xrefIndex, termIndex, clauseLookup 생성
  │
  ├─→ XrefStatsBar (props: xrefIndex.stats, definedTerms.length)
  │
  ├─→ ContractTocPanel (props: +definedTerms, +onClauseClick)
  │   └─→ TocTermsSection → DefinedTermsPanel
  │
  └─→ 조항 카드 렌더링 (map)
      ├─→ ClauseTextWithRefs
      │     props: text, refs=xrefIndex.outgoing.get(clauseId),
      │            termIndex, clauseLookup, onClauseClick
      │     └─→ CrossRefLink → CrossRefPreview
      │
      └─→ IncomingReferences
            props: refs=xrefIndex.incoming.get(clauseId),
                   clauseLookup, onClauseClick
```

> **설계 원칙**: 모든 교차참조 데이터는 `ContractDetailView`에서 인덱싱하고, 하위 컴포넌트에는 **해당 clause에 필요한 데이터만** props로 전달합니다. Context나 store 추가 없이 prop drilling으로 해결합니다. 깊이가 최대 3단계(ContractDetailView → ClauseTextWithRefs → CrossRefLink)이므로 prop drilling의 복잡도는 수용 가능합니다.

### 6.3 인라인 링크 렌더링 (ClauseTextWithRefs)

**신규 파일**: `components/contract/ClauseTextWithRefs.tsx`

#### 6.3.1 Props

```typescript
interface ClauseTextWithRefsProps {
  text: string;
  refs: CrossReferenceRow[];             // 이 clause의 outgoing refs (이미 필터링됨)
  termIndex: { byNormalized: Map<string, DefinedTermRowWithAliases> };
  clauseLookup: Map<string, { number: string; title: string | null }>;
  onClauseClick: (clauseId: string) => void;
  incomingCountMap: Map<string, number>; // clauseId → incoming clause_ref 수 (CrossRefPreview footer용)
}
```

#### 6.3.2 Text Segmentation 알고리즘

```typescript
interface TextSegment {
  type: "plain" | "clause_ref" | "defined_term" | "unresolved";
  text: string;          // 표시할 텍스트
  ref?: CrossReferenceRow;  // 참조 데이터 (plain이면 undefined)
}

function buildSegments(text: string, refs: CrossReferenceRow[]): TextSegment[] {
  // Step 1: refs를 offset_start 오름차순 정렬
  const sorted = [...refs].sort((a, b) => a.offset_start - b.offset_start);

  // Step 2: 겹침 제거 + stale offset 방어
  const filtered: CrossReferenceRow[] = [];
  let lastEnd = 0;
  for (const ref of sorted) {
    if (ref.offset_start >= lastEnd) {
      // stale offset 방어: 저장된 offset이 현재 텍스트와 불일치하면 skip
      const sliced = text.slice(ref.offset_start, ref.offset_end);
      if (ref.matched_text && sliced.replace(/\*\*/g, "") !== ref.matched_text.replace(/\*\*/g, "")) {
        console.warn(`[xref] stale offset detected: expected "${ref.matched_text}", got "${sliced}"`);
        continue; // plain text로 fallback (링크 렌더링 skip)
      }
      filtered.push(ref);
      lastEnd = ref.offset_end;
    }
    // else: 겹침 → skip (나열형 파서에서 이미 중복 제거했지만 방어)
  }

  // Step 3: text를 plain 구간과 ref 구간으로 교대 분할
  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const ref of filtered) {
    // 유효 범위 검증
    const start = Math.max(0, Math.min(ref.offset_start, text.length));
    const end = Math.max(start, Math.min(ref.offset_end, text.length));

    // plain text 구간 (cursor ~ start)
    if (start > cursor) {
      segments.push({ type: "plain", text: text.slice(cursor, start) });
    }

    // reference 구간
    const refType = !ref.is_resolved ? "unresolved"
      : ref.ref_type === "defined_term" ? "defined_term"
      : "clause_ref";
    segments.push({
      type: refType,
      text: text.slice(start, end),
      ref,
    });

    cursor = end;
  }

  // 마지막 plain text 구간
  if (cursor < text.length) {
    segments.push({ type: "plain", text: text.slice(cursor) });
  }

  return segments;
}
```

#### 6.3.3 React 렌더링 및 Key 전략

```tsx
function ClauseTextWithRefs({ text, refs, termIndex, clauseLookup, onClauseClick }: ClauseTextWithRefsProps) {
  const segments = useMemo(() => buildSegments(text, refs), [text, refs]);

  return (
    <>
      {segments.map((seg, i) => {
        // React key: index 기반 (segments는 text+refs 변경 시에만 재생성)
        if (seg.type === "plain") {
          return <span key={i}>{seg.text}</span>;
        }
        return (
          <CrossRefLink
            key={`${seg.ref!.id}-${i}`}  // ref.id + index로 유일성 보장
            segment={seg}
            termIndex={termIndex}
            clauseLookup={clauseLookup}
            onClauseClick={onClauseClick}
          />
        );
      })}
    </>
  );
}
```

#### 6.3.4 Markdown 태그 경계 교차 처리

`content_format === "markdown"`인 clause의 text에 `**bold**` 마크업이 포함될 수 있습니다. 교차참조 offset은 **원본(markdown 포함) 텍스트 기준**으로 저장됩니다.

offset이 마크업 태그 내부를 가리키는 경우(예: `**Cont` ← offset이 `**` 안에서 시작):
- 백엔드 `stripMarkdownForMatching()`에서 이미 strip → match → remap 처리하므로, 저장된 offset은 원본 기준으로 정확함
- 프론트엔드에서는 **원본 text를 그대로 `slice()`** 하면 됨. 마크업 태그가 참조 구간에 포함되면 그대로 표시 (bold가 유지됨)

> **결정**: 프론트엔드에서 추가 markdown 처리는 **plain 구간에만 적용**합니다.

#### 6.3.5 `renderBoldMarkdown()` 통합 전략

현재 `ContractDetailView.tsx`는 `renderBoldMarkdown()` 함수로 조항 본문의 `**bold**` 마크업을 렌더링합니다. `ClauseTextWithRefs`로 교체 시 이 기능이 손실되므로 다음과 같이 통합합니다:

```tsx
// ClauseTextWithRefs.tsx 렌더링 수정
{segments.map((seg, i) => {
  if (seg.type === "plain") {
    // plain 구간은 기존 renderBoldMarkdown() 함수로 bold 렌더링 유지
    return <span key={i}>{renderBoldMarkdown(seg.text)}</span>;
  }
  // 교차참조 구간은 bold 마크업을 strip한 텍스트를 표시
  // (이미 링크 색상이 적용되므로 bold 불필요)
  const displayText = seg.text.replace(/\*\*/g, "");
  return (
    <CrossRefLink
      key={`${seg.ref!.id}-${i}`}
      segment={{ ...seg, text: displayText }}
      ...
    />
  );
})}
```

> **원칙**: `ClauseTextWithRefs`가 있는 조항에서도 bold 렌더링은 유지합니다. plain 구간은 `renderBoldMarkdown()`, 참조 구간은 bold strip 후 링크 스타일 적용.

**수정 대상**: `ContractDetailView.tsx`

기존 `{clause.text}`를 `<ClauseTextWithRefs>` 컴포넌트로 교체. `crossReferences`가 없거나 빈 배열이면 기존 plain text 렌더링을 유지합니다.

```tsx
// ContractDetailView.tsx 조항 본문 렌더링 부분
{outgoingRefs.length > 0 ? (
  <ClauseTextWithRefs
    text={clause.text}
    refs={outgoingRefs}
    termIndex={termIndex}
    clauseLookup={clauseLookup}
    onClauseClick={handleClauseClick}
  />
) : (
  clause.text  // 기존 plain text 렌더링 유지
)}
```

### 6.4 교차참조 링크 컴포넌트 (CrossRefLink)

**신규 파일**: `components/contract/CrossRefLink.tsx`

**스타일 (목업 기준)**:

| refType | 상태 | 스타일 |
|---|---|---|
| `clause_ref` (해결) | 기본 | `color: var(--xref-clause)`, `underline dotted`, `underline-offset: 3px` |
| `clause_ref` (해결) | 호버 | `background: var(--xref-clause-dim)`, `underline solid` |
| `defined_term` (해결) | 기본 | `color: var(--xref-term)`, `underline dotted`, `underline-offset: 3px` |
| `defined_term` (해결) | 호버 | `background: var(--xref-term-dim)`, `underline solid` |
| 미해결 (공통) | 기본 | `color: var(--xref-unresolved)`, `underline dotted`, `cursor: default` |

기능:
- **조항 참조**: 클릭 → 대상 조항으로 스크롤 이동 + 해당 조항 expand. 기존 `handleClauseClick(clauseId)` 재사용
- **정의어 참조**: 클릭 → 정의 조항으로 스크롤 이동
- **미해결 참조**: `<span>`으로 렌더링 (클릭 불가). `title="미해결 참조 — 외부 문서 참조일 수 있습니다"` 속성으로 안내
- **접근성**: 해결된 참조는 `tabIndex={0}`, `role="link"`, `onKeyDown(Enter/Space → navigate)` 적용. 미해결 참조는 `aria-disabled="true"`

### 6.5 호버 프리뷰 (CrossRefPreview)

**신규 파일**: `components/contract/CrossRefPreview.tsx`

shadcn/ui의 `HoverCard` 활용. **스크롤 가능한 본문**이 핵심 UX입니다.

#### 6.5.1 카드 구조

```
┌────────────────────────────────────┐
│  header: 아이콘 + 참조번호 + 제목   │  ← border-bottom
├────────────────────────────────────┤
│                                    │
│  body: 조항 본문 또는 정의 내용      │  ← 스크롤 가능 영역
│  (max-height: 200px, overflow-y)   │
│                                    │
├────────────────────────────────────┤
│  ↓ 스크롤하여 전체 보기              │  ← 스크롤 힌트 (본문 넘칠 때만)
├────────────────────────────────────┤
│  footer: 통계 + "클릭하여 이동 →"   │  ← border-top
└────────────────────────────────────┘
```

#### 6.5.2 스크롤 가능 본문 구현

```typescript
// CrossRefPreview.tsx 핵심 로직
const bodyRef = useRef<HTMLDivElement>(null);
const [hasScroll, setHasScroll] = useState(false);

useEffect(() => {
  const el = bodyRef.current;
  if (el) setHasScroll(el.scrollHeight > el.clientHeight);
}, [content]);
```

**CSS 스펙**:

```css
.hover-preview {
  width: 340px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  z-index: 50;
}

.hover-preview-body {
  padding: 10px 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  max-height: 200px;
  overflow-y: auto;
  /* 얇은 커스텀 스크롤바 */
  scrollbar-width: thin;
  scrollbar-color: var(--border-light) transparent;
}

/* Webkit 스크롤바 */
.hover-preview-body::-webkit-scrollbar { width: 4px; }
.hover-preview-body::-webkit-scrollbar-track { background: transparent; }
.hover-preview-body::-webkit-scrollbar-thumb {
  background: var(--border-light);
  border-radius: 2px;
}
.hover-preview-body::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

/* 스크롤 가능 힌트: 하단 페이드 마스크 */
.hover-preview-body.has-scroll {
  mask-image: linear-gradient(to bottom, black 85%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 85%, transparent 100%);
}
/* 호버 시 페이드 해제하여 전체 내용 노출 */
.hover-preview-body.has-scroll:hover {
  mask-image: none;
  -webkit-mask-image: none;
}
```

**스크롤 힌트 바** (본문이 `max-height`를 초과할 때만 표시):

```css
.scroll-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 3px 14px;
  font-size: 10px;
  color: var(--text-muted);
  border-top: 1px solid var(--border);
}
.scroll-hint .arrow {
  animation: bounce-down 1.2s infinite;
}
@keyframes bounce-down {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(2px); }
}
```

#### 6.5.3 조항 참조 프리뷰

```
📄  8.7  Delay Damages
────────────────────────────────
If the Contractor fails to comply with Sub-Clause
8.2 [Time for Completion], the Contractor shall
subject to Sub-Clause 2.5 [Employer's Claims] pay
delay damages to the Employer for this default.
These delay damages shall be the amount stated in
the Particular Conditions, and shall be paid for
every day which shall elapse between the relevant
Time for Completion and the date stated in the
Taking-Over Certificate.

However, the total amount due under this Sub-Clause
shall not exceed the maximum amount of delay damages
(if any) stated in the Particular Conditions...
         ↓ 스크롤하여 전체 보기
────────────────────────────────
참조 4건           클릭하여 이동 →
```

- header: `📄` 아이콘 + `clause_ref` 색상 조항 번호 (`font: JetBrains Mono`) + 제목
- body: 조항 본문 전체 (스크롤 가능, `max-height: 200px`)
- footer: `참조 N건` (해당 조항을 참조하는 다른 조항 수) + `클릭하여 이동 →` (accent-blue)

**데이터 소스**: 이미 클라이언트에 있는 `clauseItems` 배열에서 `targetClauseId`로 조회 (추가 API 호출 불필요)

**"참조 N건" 데이터 전달**: `ClauseTextWithRefs` → `CrossRefLink` → `CrossRefPreview`에 `incomingCountMap`을 prop으로 전달합니다.

```typescript
// ClauseTextWithRefs props에 추가
interface ClauseTextWithRefsProps {
  // ... 기존 props
  incomingCountMap: Map<string, number>;  // clauseId → incoming clause_ref 수
}

// ContractDetailView에서 생성
const incomingCountMap = useMemo(() => {
  const map = new Map<string, number>();
  for (const [clauseId, refs] of xrefIndex.incoming) {
    map.set(clauseId, refs.filter(r => r.ref_type === "clause_ref").length);
  }
  return map;
}, [xrefIndex.incoming]);
```

#### 6.5.4 정의어 참조 프리뷰

```
📖  Contractor          정의: 1.1.1.36
────────────────────────────────
"Contractor" means the person(s) named as
contractor in the Letter of Tender accepted by
the Employer and the legal successors in title
to this person(s), but not (except as otherwise
stated in these Conditions) any assignee of the
Contractor.

The Contractor shall be deemed to include the
Contractor's legal successors and permitted
assigns, and references in the Contract to the
Contractor shall be read and construed
accordingly...
         ↓ 스크롤하여 전체 보기
────────────────────────────────
본문에서 42회 사용    클릭하여 정의 이동 →
```

- header: `📖` 아이콘 + `xref-term` 색상 정의어명 + `정의: X.X.X.X` (text-muted)
- body: 정의 내용 전체 (스크롤 가능, `max-height: 200px`)
- footer: `본문에서 N회 사용` + `클릭하여 정의 이동 →` (xref-term)

**데이터 소스**: `definedTerms` 배열에서 `term` 매칭으로 `definitionText` 조회

#### 6.5.5 동의어/별칭 정의어 프리뷰

```
📖  Contract  = EPC Contract    정의: 1.1.1.31
────────────────────────────────
"Contract" or "EPC Contract" means the Contract
Agreement, these Conditions, the Employer's
Requirements, the Schedules, the Contractor's
Proposal, and such further documents (if any)
which are listed in the Contract Agreement or
in the Particular Conditions...
         ↓ 스크롤하여 전체 보기
────────────────────────────────
본문에서 156회 사용   클릭하여 정의 이동 →
```

- header에 `= 별칭` 표시 (text-muted)
- 사용자가 별칭 중 하나를 호버하면 동의어 관계가 드러남

#### 6.5.6 HoverCard 포지셔닝 및 중첩 결정

**포지셔닝**: shadcn `HoverCard`의 `side="bottom"`, `align="start"`. 뷰포트 경계 조정은 Radix Primitives가 처리하되, `collisionPadding`을 설정하여 카드가 화면 가장자리에 밀착되는 것을 방지합니다.

```tsx
<HoverCard openDelay={400} closeDelay={200}>
  <HoverCardTrigger asChild>
    <span className="xref-link ...">...</span>
  </HoverCardTrigger>
  <HoverCardContent
    side="bottom"
    align="start"
    sideOffset={4}
    collisionPadding={16}
  >
    <CrossRefPreview ... />
  </HoverCardContent>
</HoverCard>
```

> **openDelay=400ms**: 기본 700ms보다 짧아 빠른 탐색 가능. 200ms 미만은 의도치 않은 프리뷰 발생. **closeDelay=200ms**: 마우스가 프리뷰로 이동하는 시간 확보.

**프리뷰 내부 교차참조 중첩 금지**:

프리뷰 본문에 `Sub-Clause 8.2`, `Contractor` 등 추가 교차참조가 포함될 수 있지만, 이를 다시 링크로 만들지 **않습니다**.

이유:
1. 무한 중첩 위험 (프리뷰 안의 프리뷰 안의 프리뷰...)
2. 200px 제한된 공간에서 추가 HoverCard 트리거는 UX 저하
3. 프리뷰 목적은 "참조 내용 빠른 확인"이지 "탐색"이 아님

```tsx
// CrossRefPreview 본문은 plain text로 렌더링
<div className="hover-preview-body" ref={bodyRef}>
  {previewText}  {/* <ClauseTextWithRefs> 사용하지 않음 */}
</div>
```

**결정**: 프리뷰 본문은 plain text. 상세 내용을 보려면 `클릭하여 이동 →`으로 해당 조항으로 스크롤 이동.

### 6.6 역참조 목록 (IncomingReferences)

**신규 파일**: `components/contract/IncomingReferences.tsx`

`ClauseInlineAnalysis` 하단에 표시.

#### 6.6.1 Props 및 데이터 소스

```typescript
interface IncomingReferencesProps {
  refs: CrossReferenceRow[];     // xrefIndex.incoming.get(clauseId) ?? []
  clauseLookup: Map<string, { number: string; title: string | null }>;
  onClauseClick: (clauseId: string) => void;
}
```

**데이터 lookup 패턴**: 추가 API 호출 불필요. `clauseLookup`은 `ContractDetailView`에서 `clauseItems[]`로 한 번 생성한 Map입니다.

```tsx
function IncomingReferences({ refs, clauseLookup, onClauseClick }: IncomingReferencesProps) {
  // 조항 참조만 필터링 (정의어 사용은 역참조 목록에 표시하지 않음)
  const clauseRefs = refs.filter(r => r.ref_type === "clause_ref");
  if (clauseRefs.length === 0) return null;

  return (
    <div className="incoming-refs">
      <div className="incoming-refs-title">
        이 조항을 참조하는 조항 <span className="count">{clauseRefs.length}</span>
      </div>
      {clauseRefs.map(ref => {
        const source = clauseLookup.get(ref.source_clause_id);
        if (!source) return null;
        return (
          <button
            key={ref.id}
            className="incoming-ref-item"
            onClick={() => onClauseClick(ref.source_clause_id)}
            type="button"
          >
            <span className="arrow">←</span>
            <span className="ref-number">{source.number}</span>
            <span>{source.title}</span>
          </button>
        );
      })}
    </div>
  );
}
```

> **접근성**: `<div onClick>` 대신 `<button>` 사용하여 키보드 접근성(Tab, Enter) 자동 지원. 스크린리더가 클릭 가능 요소로 인식.

#### 6.6.2 스타일 (목업 기준)

```
┌─────────────────────────────────────┐
│  이 조항을 참조하는 조항  [3]        │  ← uppercase, text-muted, 카운트 배지
│                                     │
│  ← 8.7  Delay Damages              │  ← 클릭 가능, hover: accent-blue
│  ← 12.3 Tests on Completion        │
│  ← 20.1 Claims                     │
└─────────────────────────────────────┘
```

- 배경: `var(--bg-tertiary)`, border: `var(--border)`, border-radius: 6px
- 각 항목: `← 조항번호 제목` 형식, `조항번호`는 `JetBrains Mono, accent-blue`
- 호버 시 전체 행 색상 변경 (`color: var(--accent-blue)`)
- 각 항목 클릭 → 해당 조항으로 스크롤 이동 (기존 `handleClauseClick` 재사용)

### 6.7 교차참조 통계 바 (XrefStatsBar)

**신규 파일**: `components/contract/XrefStatsBar.tsx`

`ContractDetailView.tsx` 필터 바 아래, 조항 목록 위에 표시.

**스타일 (목업 기준)**:

```
┌──────────────────────────────────────────────────────────────┐
│  ● 조항참조 87  ● 정의어참조 127  │  해결 189  미해결 25  │  정의어 219  │
└──────────────────────────────────────────────────────────────┘
```

- `●` dot: 6px 원형, 조항참조=`xref-clause`, 정의어참조=`xref-term`
- 구분자: 1px × 16px 세로선 (`var(--border)`)
- 미해결 수 > 0이면 `accent-yellow` 색상 강조
- 배경: `var(--bg-secondary)`, border: `var(--border)`, border-radius: 6px

**미해결 경고 배너** (통계 바 아래, 미해결 > 0일 때):

```
⚠ 25개 참조가 대상 조항을 찾지 못했습니다. 외부 문서 또는 별도 첨부를 확인하세요.
```

- 배경: `var(--accent-yellow-dim)`, border: `rgba(251,191,36,0.25)`, 색상: `accent-yellow`

### 6.8 정의어 사전 패널 (DefinedTermsPanel)

**신규 파일**: `components/contract/DefinedTermsPanel.tsx`

**배치 확정**: ContractTocPanel **하단에 collapsible 섹션**으로 통합합니다. 독립 탭은 사용하지 않습니다.

배치 결정 이유:
- 독립 탭은 탭 전환 상태 관리 추가 + UI 복잡도 증가
- TOC 하단 배치는 `문서 구조 → 정의어` 자연스러운 탐색 흐름
- TocTermsSection(상위 5개 빠른 탐색)과 DefinedTermsPanel(전체 사전)이 같은 패널에 공존
- TocTermsSection의 `⋮ N개 더 보기` 클릭 시 DefinedTermsPanel을 expand

#### 6.8.1 패널 구조

```
┌──────────────────────────────┐
│  📖 정의어 사전          [219]│  ← header
├──────────────────────────────┤
│  [정의어 검색...]             │  ← 검색 input
├──────────────────────────────┤
│                              │
│  Contract            1.1.1.31│  ← term-name (xref-term) + clause-num
│  [직접]                      │  ← def-type-badge
│  = EPC Contract              │  ← alias badge
│  "Contract" or "EPC Cont...  │  ← definition (2줄 clamp)
│  본문 156회 사용              │  ← usage count
│──────────────────────────────│
│  Contractor          1.1.1.36│
│  [직접]                      │
│  "Contractor" means the p... │
│  본문 42회 사용               │
│──────────────────────────────│
│  Works              1.1.1.219│
│  [직접]                      │
│  "Works" means the Facili... │
│  본문 38회 사용               │
│──────────────────────────────│
│  Advance Payment      1.1.1.4│
│  [참조]                      │  ← reference type
│  has the meaning given to... │
│  본문 12회 사용               │
│──────────────────────────────│
│  Defect              1.1.1.47│
│  [열거]                      │  ← enumerated type
│  "Defect" means: (a) any ... │
│  본문 28회 사용               │
│     ↳ Defective      [파생]  │  ← 인라인 부정의어 (들여쓰기)
│       "Defective" shall be.. │
│       본문 15회 사용          │
│──────────────────────────────│
│  Owner              1.1.1.143│
│  [직접]                      │
│  = Project Company  = QNJSC  │  ← 복수 alias
│  "Owner", "Project Compa...  │
│  본문 35회 사용               │
└──────────────────────────────┘
```

#### 6.8.2 정의 유형 배지

| 유형 | 배지 텍스트 | 스타일 |
|---|---|---|
| `direct` | 직접 | `bg: accent-green-dim`, `color: accent-green` |
| `reference` | 참조 | `bg: accent-blue-dim`, `color: accent-blue` |
| `enumerated` | 열거 | `bg: accent-yellow-dim`, `color: accent-yellow` |
| 인라인 부정의어 | 파생 | `bg: accent-green-dim`, `color: accent-green`, font-size: 8px |

#### 6.8.3 기능

- 사용 횟수 내림차순 정렬 (가장 빈번한 정의어가 상단)
- **파생 정의어 정렬**: `usage_count DESC` 정렬 후, `parent_term_id`가 있는 항목은 부모 항목 직후로 이동. 파생 항목 자체는 usage_count로 정렬하지 않고 부모-자식 관계로 그룹핑
- 정의어 클릭 → 해당 정의 조항으로 스크롤 이동
- 검색 input: 실시간 필터링 (`placeholder: "정의어 검색..."`)
  - 기존 프로젝트의 `focus-visible:ring-2 focus-visible:ring-accent-blue` 패턴 준수
- 동의어: `= alias` 배지로 표시 (배경: `bg-tertiary`, border: `var(--border)`)
- 인라인 부정의어: 부모 정의어 아래 들여쓰기 표시 (`↳` prefix, opacity: 0.7, font-size: 12px, padding-left: 16px)
- 정의 내용: 최대 2줄 clamp (`line-clamp-2` Tailwind 유틸리티)
- 스크롤 가능 목록: `max-height: 400px`, `overflow-y: auto`, `.xref-thin-scrollbar` 클래스 적용
- **DefinedTermsPanel은 부모(TOC 패널)의 너비를 따르며, min-width 200px에서도 정상 표시되도록 truncation 처리**

#### 6.8.4 정의 유형 배지 Tailwind 클래스

```typescript
const DEF_TYPE_BADGE_CLASSES = {
  direct: "bg-accent-green/10 text-accent-green text-[9px] font-semibold px-[5px] py-px rounded-[3px] uppercase tracking-[0.04em]",
  reference: "bg-accent-blue/10 text-accent-blue text-[9px] font-semibold px-[5px] py-px rounded-[3px] uppercase tracking-[0.04em]",
  enumerated: "bg-accent-yellow/10 text-accent-yellow text-[9px] font-semibold px-[5px] py-px rounded-[3px] uppercase tracking-[0.04em]",
  sub: "bg-accent-green/10 text-accent-green text-[8px] font-semibold px-[4px] py-px rounded-[3px] uppercase tracking-[0.04em]",
} as const;
```

### 6.9 TOC 패널 — 정의어 빠른 탐색 (TocTermsSection)

**수정 파일**: `components/contract/ContractTocPanel.tsx`

기존 TOC 패널 하단에 정의어 섹션 추가. 사용 횟수 상위 5개만 표시하고 나머지는 접혀 있음.

```
────────────────────────  ← border-top
▼ 📖 정의어         [219]
  ● Contract          156
  ● Contractor          42
  ● Works               38
  ● Owner               35
  ● Defect              28
  ⋮ 214개 더 보기
```

- 각 항목: `●` dot (5px, xref-term 색상) + 정의어명 + 사용 횟수 (JetBrains Mono, text-muted)
- 호버 시 `bg: var(--bg-hover)`, color 변경
- 클릭 → 해당 정의 조항으로 스크롤 이동
- `⋮ N개 더 보기` 클릭 → DefinedTermsPanel을 expand (같은 패널 내에서 펼침)

**"더 보기" 상태 관리**: `ContractTocPanel` 내부 `useState<boolean>(false)`로 관리. TocTermsSection은 항상 표시되고, "더 보기" 클릭 시 DefinedTermsPanel이 아래에 expand됩니다. zustand store 확장 불필요.

```typescript
// ContractTocPanel.tsx 내부
const [showFullTerms, setShowFullTerms] = useState(false);

// TocTermsSection 렌더링
<TocTermsSection terms={definedTerms?.slice(0, 5)} onShowMore={() => setShowFullTerms(true)} />
{showFullTerms && (
  <DefinedTermsPanel
    definedTerms={definedTerms}
    onTermClick={onTermClick}
    onClose={() => setShowFullTerms(false)}
  />
)}
```

#### 6.9.1 ContractTocPanel props 변경

```typescript
// ContractTocPanel에 추가되는 props
interface ContractTocPanelProps {
  // ... 기존 props
  definedTerms?: DefinedTermRowWithAliases[];   // 신규
  onTermClick?: (clauseId: string) => void;     // 신규 — handleClauseClick 재사용
}
```

**데이터 전달 경로**:
`ContractDetailView` → `ContractTocPanel` (props: `definedTerms`, `onTermClick={handleClauseClick}`)
→ `TocTermsSection` (상위 5개 + 더 보기 버튼)
→ `DefinedTermsPanel` (전체 목록, 기본 collapsed)

정의어 클릭 시 `onTermClick(clauseId)` 호출 → 기존 `handleClauseClick`이 해당 조항으로 스크롤 이동 + expand. 별도 콜백 불필요.

### 6.10 Definitions 조항 전용 렌더링

definitions zone의 조항 카드는 일반 조항과 다르게 렌더링합니다.

**기존 파일 수정**: `components/contract/ContractDetailView.tsx` (조건부 분기)

#### 6.10.1 분기 조건

```typescript
// ContractDetailView.tsx — 조항 카드 렌더링 루프 내부
const isDefClause = (clause: ClauseItem): boolean => {
  // 1순위: zone_key
  if (clause.zone_key === "definitions") return true;
  // 2순위: 번호 패턴 (FIDIC 1.1.x.x)
  if (clause.number && /^1\.1(?:\.\d+)+$/.test(clause.number)) return true;
  return false;
};

// 해당 clause의 정의어 정보 조회
const getTermForClause = (clauseId: string): DefinedTermRowWithAliases | undefined => {
  return definedTerms.find(dt => dt.clause_id === clauseId && !dt.parent_term_id);
};
```

> **주의**: 현재 `ContractDetailView.tsx` 내부에서 조항 카드는 인라인 JSX로 렌더링됩니다 (`ClauseDocumentItem`이라는 별도 컴포넌트 파일은 없음). 분기 조건은 기존 인라인 렌더링 내에 `{isDefClause(clause) ? ... : ...}` 삼항 연산자로 추가합니다.

#### 6.10.2 렌더링 차이점

| 요소 | 일반 조항 | definitions 조항 |
|---|---|---|
| border-left 색상 | 리스크 레벨 (amber, red 등) | `accent-blue` (고정) |
| 제목 | 일반 텍스트 | `"정의어명"` (xref-term 색상, font-weight: 700) |
| 배지 | 리스크 배지 | 정의 유형 배지 (`직접 정의`, `열거 정의` 등) + 사용 횟수 (`N회 사용`) |
| 본문 | `<ClauseTextWithRefs>` | `<ClauseTextWithRefs>` (동일 — 정의어명 자동 하이라이트) |
| 열거형 | — | `(a)`, `(b)` 항목 들여쓰기 (`padding-left: 24px`) |
| 파생 정의어 | — | `the term "Defective" shall be construed...` 내 정의어 하이라이트 |

#### 6.10.3 정의 조항 헤더 렌더링

```tsx
// definitions 조항 헤더 (기존 헤더 JSX 내 조건부)
{isDefClause(clause) ? (
  <>
    <span className="clause-number">{clause.number}</span>
    <span className="clause-title">
      <span style={{ color: 'var(--xref-term)', fontWeight: 700 }}>
        "{termInfo?.term}"
      </span>
      <span className="clause-badges">
        <span className={`def-type-badge ${termInfo?.definition_type}`}>
          {termInfo?.definition_type === 'direct' ? '직접 정의'
            : termInfo?.definition_type === 'reference' ? '참조 정의'
            : '열거 정의'}
        </span>
        <span className="term-usage-badge">{termInfo?.usage_count}회 사용</span>
      </span>
    </span>
  </>
) : (
  // 기존 일반 조항 헤더
)}
```

### 6.11 반응형 전략

| 요소 | sm/md (< 1024px) | lg+ (≥ 1024px) |
|---|---|---|
| 인라인 링크 | 동일 (텍스트 내 색상만) | 동일 |
| HoverCard | `@media (hover: hover)`에서만 활성화. 터치 디바이스에서는 **click-to-open** (Popover로 전환) | hover 기반 |
| XrefStatsBar | `flex-wrap` 적용 (좁은 화면에서 줄바꿈) | 가로 배치 |
| DefinedTermsPanel | TOC 패널이 숨겨지므로 별도 접근 불가. 향후 Sheet/Drawer로 확장 고려 | TOC 하단 collapsible |
| IncomingReferences | 동일 (조항 카드 내부이므로 레이아웃 영향 없음) | 동일 |

```tsx
// HoverCard → Popover 전환 (터치 디바이스 대응)
const isTouchDevice = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;

{isTouchDevice ? (
  <Popover>
    <PopoverTrigger asChild>{trigger}</PopoverTrigger>
    <PopoverContent>{preview}</PopoverContent>
  </Popover>
) : (
  <HoverCard openDelay={400} closeDelay={200}>
    <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
    <HoverCardContent>{preview}</HoverCardContent>
  </HoverCard>
)}
```

### 6.12 접근성 (WCAG 2.1 Level A)

| 요소 | 구현 |
|---|---|
| CrossRefLink (resolved) | `<span tabIndex={0} role="link" onKeyDown={handleKeyPress}>` |
| CrossRefLink (unresolved) | `<span aria-disabled="true" title="미해결 참조">` |
| IncomingReferences 항목 | `<button>` 사용 (자동 keyboard/screenreader 지원) |
| HoverCard body | `.xref-preview-fade:focus-within`에서도 마스크 해제 |
| 검색 input (DefinedTermsPanel) | `focus-visible:ring-2 focus-visible:ring-accent-blue` |
| CrossRefPreview body (스크롤) | `ResizeObserver`로 스크롤 필요 여부 동적 감지 (HoverCard 열림 타이밍 대응) |

```typescript
// ResizeObserver 기반 스크롤 감지 (mount 시점 1회 체크 대신)
useEffect(() => {
  const el = bodyRef.current;
  if (!el) return;
  const observer = new ResizeObserver(() => {
    setHasScroll(el.scrollHeight > el.clientHeight);
  });
  observer.observe(el);
  return () => observer.disconnect();
}, []);
```

---

## 7. 마일스톤

### Phase 0: 선행 작업 (예상 2일) — ⚠ Critical

| 순서 | 작업 | 파일 |
|---|---|---|
| 0-1 | DB 마이그레이션 012번 적용 (cross_references + defined_terms + RLS + cross_ref_status) | `supabase/migrations/012_add_cross_references.sql` |
| 0-2 | shadcn HoverCard 컴포넌트 설치 (`npx shadcn@latest add hover-card`) | `components/ui/hover-card.tsx` |
| 0-3 | `persistParseResult()` clauses INSERT에 `.select()` 추가 (UUID 반환) | `app/api/contracts/route.ts` |
| 0-4 | `lib/data/contracts.ts` 기존 `getContractDetail()`에 교차참조/정의어 optional 조회 추가 + clauses SELECT 컬럼 추가 | `lib/data/contracts.ts` |
| 0-5 | `[id]/route.ts` GET clauses SELECT에 `content_format, zone_key, sort_order` 추가 | `app/api/contracts/[id]/route.ts` |
| 0-6 | 기존 조항 카드 grid 레이아웃 vs 목업 검증 → 불일치 시 리팩토링 | `ContractDetailView.tsx` |

### Phase 1: 코어 엔진 (예상 4일)

| 순서 | 작업 | 파일 |
|---|---|---|
| 1-1 | ~~DB 마이그레이션~~ → Phase 0-1로 이동 | — |
| 1-2 | 타입 정의 (CrossRefType, CrossRefStatus, DefinedTermExtracted, DefinedTermRow, ListRefItem 포함) | `types/cross-reference.ts` |
| 1-3 | CLAUSE_NUM / BRACKET_TITLE 공통 패턴 정의 | `lib/analysis/cross-reference-extractor.ts` |
| 1-4 | 단일 조항 참조 추출 (Simple Patterns — 복수형 + 영문자 지원) | 같은 파일 |
| 1-5 | **나열형 참조 전용 파서** (`extractListReferences`, `parseNumberList`) | 같은 파일 |
| 1-6 | **범위 참조 확장** (`expandRange` — X.Y to X.Z) | 같은 파일 |
| 1-7 | **중복 제거** (`deduplicateRefs` — 나열형 우선) | 같은 파일 |
| 1-8 | 정의어 추출 엔진 | `lib/analysis/defined-term-extractor.ts` |
| 1-9 | 참조 해결 로직 (조항 + 정의어 통합, clauseIndex 영문자 정규화) | `lib/analysis/cross-reference-resolver.ts` |
| 1-10 | 단위 테스트 — 단일 참조 | `lib/analysis/__tests__/cross-reference-extractor.test.ts` |
| 1-11 | 단위 테스트 — **나열형/범위/영문자** (15+ 데이터 기반 케이스) | 같은 파일 |
| 1-12 | 단위 테스트 (정의어) — title+text 결합, self-ref 제외 포함 | `lib/analysis/__tests__/defined-term-extractor.test.ts` |
| 1-13 | DB CRUD | `lib/data/cross-references.ts` |
| 1-14 | Supabase mock factory | `lib/__test-utils__/mock-supabase.ts` |
| 1-15 | 성능 벤치마크 (parse_after.json subset, 20초 이내 검증) | `lib/analysis/__tests__/cross-reference-performance.test.ts` |

### Phase 2: 파이프라인 통합 + API (예상 1.5일)

| 순서 | 작업 | 파일 |
|---|---|---|
| 2-1 | 파이프라인 통합 (정의어 추출 → 조항 참조 추출 → 정의어 매칭 순) | `app/api/contracts/route.ts` (persistParseResult 수정) |
| 2-2 | 3단계 에러 격리 구현 (L1 전체 / L2 조항별 / L3 batch별) | `lib/data/cross-references.ts` |
| 2-3 | 30초 deadline + 부분 저장 로직 | `lib/data/cross-references.ts` |
| 2-4 | contentFormat별 markdown strip + offset 재매핑 | `lib/analysis/cross-reference-extractor.ts` |
| 2-5 | 전체 조회 API (**선택 — 서버 컴포넌트 직접 조회로 대체 가능. 구현 시 Section 9 + Rollback Phase 4에 추가 필요**) | `app/api/contracts/[id]/cross-references/route.ts` |
| 2-6 | 데이터 페칭 수정 (optional 필드 + 마이그레이션 미적용 방어) | `lib/data/contracts.ts` |
| 2-7 | 파싱 품질 보호 체크리스트 검증 (8.4 참조) | 기존 테스트 + 수동 확인 |
| 2-8 | 3-tier 에러 격리 통합 테스트 (L1/L2/L3) | `lib/data/__tests__/cross-references.integration.test.ts` |
| 2-9 | 재처리 멱등성 테스트 (DELETE → re-INSERT) | 같은 파일 |

### Phase 3: 디자인 토큰 + 인라인 링크 렌더링 (예상 3일)

| 순서 | 작업 | 파일 |
|---|---|---|
| 3-1 | 교차참조 CSS 토큰 추가 (xref-clause, xref-term, xref-unresolved) | `app/globals.css`, `tailwind.config.ts` |
| 3-2 | ClauseTextWithRefs (조항 참조 + 정의어 통합 렌더링 + renderBoldMarkdown 통합) | `components/contract/ClauseTextWithRefs.tsx` |
| 3-3 | CrossRefLink (refType별 색상 분기: clause=blue, term=emerald, unresolved=muted) | `components/contract/CrossRefLink.tsx` |
| 3-4 | ContractDetailView 통합 (기존 `{clause.text}` → `<ClauseTextWithRefs>` 교체) | `components/contract/ContractDetailView.tsx` 수정 |
| 3-5 | 스크롤 이동 연동 | 기존 `handleClauseClick` 재사용 |
| 3-6 | `buildSegments()` 단위 테스트 (겹침, stale offset, 빈 refs) | `components/contract/__tests__/ClauseTextWithRefs.test.ts` |

### Phase 4: 호버 프리뷰 + 역참조 + 통계 (예상 2일)

| 순서 | 작업 | 파일 |
|---|---|---|
| 4-0 | ⚠ shadcn HoverCard 설치 확인 (Phase 0-2) | `components/ui/hover-card.tsx` |
| 4-1 | CrossRefPreview — 스크롤 가능 본문 (max-height: 200px, overflow-y: auto) | `components/contract/CrossRefPreview.tsx` |
| 4-2 | CrossRefPreview — 스크롤 힌트 바 (bounce 애니메이션, 조건부 표시) | 같은 파일 |
| 4-3 | CrossRefPreview — 하단 페이드 마스크 (has-scroll 클래스, 호버 시 해제) | 같은 파일 |
| 4-4 | CrossRefPreview — 커스텀 스크롤바 (4px, Webkit + Firefox) | 같은 파일 |
| 4-5 | CrossRefPreview — 조항 프리뷰 / 정의어 프리뷰 / 별칭 프리뷰 3가지 분기 | 같은 파일 |
| 4-6 | IncomingReferences (역참조 목록, bg-tertiary, arrow + ref-number 스타일) | `components/contract/IncomingReferences.tsx` |
| 4-7 | XrefStatsBar (통계 바: dot + 수치 + 구분선 + 미해결 경고 배너) | `components/contract/XrefStatsBar.tsx` |
| 4-8 | ContractDetailView에 통계 바 + 역참조 통합 | `ContractDetailView.tsx` 수정 |

### Phase 5: 정의어 사전 + TOC + 정의 조항 렌더링 (예상 3일)

| 순서 | 작업 | 파일 |
|---|---|---|
| 5-1 | DefinedTermsPanel (정의어 목록 + 검색 + 유형 배지 + 별칭 + 사용 횟수) | `components/contract/DefinedTermsPanel.tsx` |
| 5-2 | DefinedTermsPanel — 인라인 부정의어 들여쓰기 (↳ prefix, opacity: 0.7) | 같은 파일 |
| 5-3 | TocTermsSection (TOC 패널 하단 정의어 빠른 탐색, 상위 5개 + 더 보기) | `components/contract/TocTermsSection.tsx` (신규) + `ContractTocPanel.tsx` (수정: TocTermsSection import + expand 상태) |
| 5-4 | Definitions 조항 전용 렌더링 (border-left blue 오버라이드, 유형 배지, 정의어 하이라이트) | `ContractDetailView.tsx` 수정 |
| 5-5 | ContractDetailView에 패널 통합 | `ContractDetailView.tsx` 수정 |
| 5-6 | 반응형: 터치 디바이스 HoverCard → Popover 전환 (6.11 참조) | `CrossRefLink.tsx` 수정 |
| 5-7 | 접근성: tabIndex, role, onKeyDown, aria 속성 (6.12 참조) | `CrossRefLink.tsx`, `IncomingReferences.tsx` 수정 |

### Phase 6: 최적화 + 엣지케이스 (예상 2일)

| 순서 | 작업 |
|---|---|
| 6-1 | 대형 문서 성능 검증 (700+ 조항, 수천 개 참조) |
| 6-2 | 중첩 참조 처리 (참조 텍스트 내 참조) |
| 6-3 | 겹침 방지 검증 (조항 참조 구간 내 정의어가 있는 경우) |
| 6-4 | 기존 계약 재처리 API (소급 적용) |
| 6-5 | 열거형 multi-line 정의어 처리 (`means:\n(a)...\n(b)...` 패턴) |
| 6-6 | 일괄 정의 clause 내 복수 정의어 offset 기반 스크롤 |
| 6-7 | 한국어 계약서 비표준 정의 패턴 추가 (`~을 말한다`, `~을 의미한다`) |

**총 예상 소요: 20일**

| Phase | 예상 | 변경 사항 |
|---|---|---|
| Phase 0 (신규) | 2일 | 선행 작업 — Critical GAP 7건 해결 |
| Phase 1 | 4일 → 5일 | 성능 벤치마크, Supabase mock factory, parseNumberList 15+ 테스트 추가 |
| Phase 2 | 1.5일 → 2일 | 통합 테스트, 재처리 멱등성 테스트 추가 |
| Phase 3 | 3일 → 3.5일 | renderBoldMarkdown 통합, buildSegments 테스트 추가 |
| Phase 4 | 2일 | 변경 없음 |
| Phase 5 | 3일 → 3.5일 | 반응형, 접근성 추가 |
| Phase 6 | 2일 → 2일 | 변경 없음 |
| **합계** | **15.5일 → 20일** | +4.5일 (선행 작업 2일 + 테스트/품질 2.5일) |

---

## 8. 리스크 및 기술적 고려사항

### 8.1 성능 리스크

| 리스크 | 심각도 | 완화 방안 |
|---|---|---|
| 700+ 조항 문서에서 수천 개 참조 INSERT 부하 | Medium | batch insert (100건씩) |
| 클라이언트에서 수천 개 참조 데이터 로딩 | Medium | 서버 컴포넌트에서 한 번에 로드 (추가 fetch 없음) |
| 정규식 catastrophic backtracking | Medium | `clause.text.length > 50,000` 시 regex 추출 skip + RegExp 미리 컴파일 (4.5.3 참조) |
| 교차참조 처리가 300초 파이프라인 타임아웃 초과 | Medium | 전체 30초 deadline 적용 (4.6.2 참조). 초과 시 부분 결과만 저장하고 종료 |
| markdown bold strip + offset 재매핑 비용 | Low | `content_format === "plain"`이면 strip 생략 (4.6.3 참조) |
| 대형 문서 DOM 노드 폭증 (700조항 × 수십 인라인 링크) | Medium | 기존 조항 목록이 이미 expanded/collapsed로 관리됨. collapsed 조항은 본문을 렌더링하지 않으므로 `ClauseTextWithRefs` 미실행. 전체 expand 시에만 DOM 증가. 필요 시 Phase 6에서 `React.memo` + `useMemo` 기반 최적화 적용. 가상 스크롤은 현재 구조(expand/collapse)와 충돌하므로 도입하지 않음 |
| RegExp 동적 생성 성능 (50개 정의어 × 5 variant × 700 조항) | High | `buildDefinedTermIndex()` 시점에 RegExp 미리 컴파일. `new RegExp()`를 루프 내부에서 호출하지 않음 (4.5.3 참조). 30초 deadline을 45초로 상향 고려 |
| 초기 페이지 로드 시 대량 cross_references 데이터 (5,000+ 행) | Medium | 서버 컴포넌트에서 한 번에 로드. 추후 필요 시 lazy-loading API 엔드포인트로 전환 가능 |
| heading/content 분할 경계 불규칙성 | High | title+text 결합 fallback (4.2.4 참조), content 재스캔 (Step 6), bold 공백 정규화 (stripMarkdownForMatching) |
| pdfplumber bold 텍스트 공백 누락 | High | `stripMarkdownForMatching()`에 camelCase 분리 정규화 로직 추가. `ReceivingParty` → `Receiving Party` |

### 8.2 정확도 리스크

| 리스크 | 심각도 | 완화 방안 | 관련 섹션 |
|---|---|---|---|
| 조항 번호 형식 불일치 | High | `buildClauseIndex()`에서 정규화 맵 복수 생성 + 영문자 접미사 분리 | 4.3.1 |
| 외부 문서 참조 (별도 첨부 문서) | Medium | `is_resolved: false` + "외부 참조" 배지 | — |
| 동일 번호 다른 조항 (GC 8.7 vs PC 8.7) | High | zone_id 기반 스코핑: 같은 zone 우선 매칭 | — |
| ~~연속 참조 파싱 오류~~ | ~~Medium~~ → **해결** | 나열형 전용 파서 `extractListReferences()` 구현 | **4.1.4** |
| ~~복수형 키워드 (Clauses, Sub-Clauses) 미매칭~~ | ~~High~~ → **해결** | 모든 패턴에 `s?` 추가 (`Clauses?`, `Sub-Clauses?`, `Articles?`) | **4.1.3** |
| ~~영문자 조항번호 (4.2A, 8.3B, 3(c)) 미매칭~~ | ~~High~~ → **해결** | `CLAUSE_NUM` 공통 패턴에 `(?:[A-Za-z])?(?:\([a-z]\))?` 추가 | **4.1.1** |
| ~~나열 내 후행 번호 누락 (키워드 없는 bare number)~~ | ~~Critical~~ → **해결** | `parseNumberList()` 구분자(`,` / `and` / `or`) 기반 번호 연속 추출 | **4.1.4** |
| ~~[Title] 대괄호 처리 부재~~ | ~~Medium~~ → **해결** | `BRACKET_TITLE` 선택 매칭 패턴, offset에 포함 | **4.1.2** |
| ~~범위 참조 (X.Y to X.Z) 미대응~~ | ~~Medium~~ → **해결** | `expandRange()` 함수로 범위 내 조항 자동 확장 | **4.1.4 L3** |
| ~~키워드 전환 (Clauses → Sub-Clauses) 스코프 혼동~~ | ~~High~~ → **해결** | `parseNumberList()`에서 새 키워드 감지 시 현재 리스트 종료 | **4.1.4** |
| 나열형/단일 패턴 중복 감지 | Medium | `deduplicateRefs()` offset 기반 중복 제거. 나열형 우선 | 4.1.5 |
| 문장 시작 대문자를 정의어로 오인 | High | 정의어 목록 기반 매칭만 수행 (임의 대문자 매칭 금지). 문장 시작 위치는 선행 `.?!` + 공백 패턴으로 감지하여 추가 검증 | 4.2.7 |
| 복합 정의어 부분 매칭 | Medium | longest match first: "Time for Completion"이 "Time"보다 우선 매칭 | 4.2.5 |
| 정의 조항 형식이 비표준 | Medium | 다양한 정의 패턴 지원 (`means`, `shall mean`, `includes`, `refers to`, 콜론, `이라 한다`, `이라 함은`) + 미감지 정의어는 수동 추가 UI 고려 | 4.2.3 |
| 조항 참조 구간 내 정의어 겹침 | Low | 조항 참조 오프셋 먼저 확정 → 해당 구간은 정의어 스캔에서 제외 | 4.2.7 |
| 일괄 정의 clause 내 복수 정의어 | Medium | `defined_terms`에 `offset_start/end` 저장. FIDIC 개별 heading 구조는 문제 없으나, 단일 clause에 여러 정의어가 나열되는 EPC 구조에서는 clause 내 위치 추적 필요 | 4.2.4 |
| `classifyHeadingRemainder()`로 인한 title 누락 | Low | heading에 `"means"` 포함 시 title=undefined로 분류됨. 정의어 추출 시 `clause.title` 유무에 따른 스캔 분기 로직 필요 | 4.2.1 |
| 열거형 multi-line 정의 | Medium | `"Contractor's Equipment" means:\n(a) all...\n(b) all...` — Phase 6에서 처리. 현재 regex는 단일 행 매칭이므로 누락 가능 | 4.2.3 |
| 대괄호 내 줄바꿈으로 인한 매칭 실패 | Low | `[Title]` 내에 `\n`이 포함될 수 있음. `[^\]]*` 패턴이 줄바꿈 포함 매칭하도록 multiline 모드 또는 `[\s\S]*?` 사용 | 4.1.2 |
| **Schedule/Annex/Appendix 참조 미대응 (130건)** | **High** | 실제 데이터에 130건의 Schedule/Annex 참조 확인. 현재 패턴에 미포함. Phase 6에서 `Schedule`, `Annex`, `Appendix`, `Exhibit` 키워드 패턴 추가하되, clauses 테이블에 매칭 대상이 없으므로 `is_resolved: false`로 저장. 또는 Known Limitation으로 문서화 | — |
| **paragraph 참조 미대응 (51건)** | Medium | `paragraph (b) of Clause 23` 패턴. Phase 6에서 `paragraph` 키워드 추가 검토 | — |
| 대괄호 시작 heading (`["Term" means...`) | Medium | 6건 확인. 정의어 추출 전처리에서 선행 `[` strip 필요. 정규식에 선택적 `\[?` prefix 포함 | 4.2.4 |

### 8.3 기존 시스템 영향 리스크 (2026-03-15 코드베이스 검토 기반)

| 리스크 | 심각도 | 완화 방안 |
|---|---|---|
| `persistParseResult()` 수정으로 업로드 실패 | **Critical** | 3단계 에러 격리 (4.6.1 참조). 교차참조 실패는 non-fatal, contract status 정상 전환 보장 |
| 기존 `isCrossReference()`와 추출 엔진의 패턴 불일치 | Medium | 두 모듈은 완전히 독립적 (4.0 참조). 파싱 시점 함수는 수정하지 않음 |
| `getContractDetail()` 반환 타입 변경으로 기존 컴포넌트 컴파일 에러 | Medium | optional 필드만 추가 (6.1 참조). 마이그레이션 미적용 환경에서도 빈 배열 반환 |
| `content_format="markdown"`에서 bold markup이 정규식 매칭 방해 | Medium | strip → match → offset 재매핑 전략 (4.6.3 참조). plain은 strip 생략 |
| 300초 파이프라인 타임아웃 초과 | Medium | 교차참조 전용 30초 deadline (4.6.2 참조). 초과 시 부분 결과만 저장 |
| 마이그레이션 적용 순서 오류 | Low | **012번**으로 번호 부여 (기존 011번과 충돌 방지). 기존 010, 011번과 독립적 (신규 테이블 CREATE + contracts ALTER 1컬럼만) |

### 8.4 파싱 품질 보호 체크리스트

이 기능 구현 전후로 다음을 검증해야 합니다:

- [ ] 교차참조 추출 전후로 `clauses` 테이블 데이터가 동일한지 확인 (INSERT/UPDATE/DELETE 없음)
- [ ] `processContract()` 함수의 반환값이 변경되지 않았는지 확인
- [ ] `sectionsToClauses()` 함수에 수정이 없는지 git diff로 확인
- [ ] `qualityCheck()` 함수에 수정이 없는지 git diff로 확인
- [ ] 기존 단위 테스트 (`npm test`) 전량 통과 확인
- [ ] 교차참조 추출 실패 시 contract status가 "filtering"으로 정상 전환되는지 확인
- [ ] 교차참조 추출 타임아웃(30초) 시 부분 결과가 저장되고 파이프라인이 계속 진행되는지 확인

### 8.5 제약 조건 영향

| 항목 | 영향 |
|---|---|
| Gemini 쿼터 | 없음 (100% 정규식 기반) |
| Supabase Free Tier (500MB) | 계약 10건 기준 cross_references 약 50,000행 + defined_terms 약 500행 — 범위 내 |
| Docling sidecar | 변경 없음 |
| TypeScript strict | 모든 신규 파일에 strict 타입 적용 |

### 8.6 확장 포인트

- 정규식 패턴을 `lib/layout/cross-ref-patterns.json`으로 외부화 → 코드 수정 없이 패턴 추가 가능
- 교차참조 그래프에서 자주 참조되는 FIDIC 조항 식별 → FIDIC 후보 확장 기초 데이터
- 리스크 분석 시 "참조 많을수록 영향도 큼" 메트릭 도출 가능
- 정의어 사전을 기반으로 "미정의 용어 감지" 기능 확장 가능 (대문자 사용인데 정의 없는 경우 경고)
- 정의어 usage_count로 "핵심 용어 vs 사용되지 않는 정의어" 식별 가능

---

## 9. 파일 변경 요약

### 신규 파일 (21개)

| 파일 | 목적 |
|---|---|
| `types/cross-reference.ts` | 교차참조 + 정의어 타입 정의 |
| `lib/analysis/cross-reference-extractor.ts` | 조항 참조 정규식 추출 (List Parser, Range 확장 포함) |
| `lib/analysis/defined-term-extractor.ts` | 정의어 추출 + 본문 매칭 (title+text 결합, content 재스캔, bold 공백 정규화) |
| `lib/analysis/cross-reference-resolver.ts` | 참조 대상 매칭/해결 (조항 + 정의어 통합) |
| `lib/data/cross-references.ts` | DB CRUD (재처리 멱등성, usage_count 집계 포함) |
| `lib/analysis/__tests__/cross-reference-extractor.test.ts` | 조항 참조 단위 테스트 (15+ parseNumberList 데이터 기반 케이스) |
| `lib/analysis/__tests__/defined-term-extractor.test.ts` | 정의어 추출 단위 테스트 (title+text 결합, self-ref 제외, bracket heading) |
| `lib/analysis/__tests__/cross-reference-resolver.test.ts` | resolver 단위 테스트 (정확/정규화/영문자/부분 매칭, 미해결 참조) |
| `lib/analysis/__tests__/cross-reference-performance.test.ts` | 성능 벤치마크 (20초 이내, backtracking 검증) |
| `lib/data/__tests__/cross-references.integration.test.ts` | 3-tier 에러 격리 통합 테스트 (L1/L2/L3) |
| `lib/__test-utils__/mock-supabase.ts` | Supabase mock factory (chainable stubs) |
| `components/contract/__tests__/ClauseTextWithRefs.test.ts` | buildSegments 단위 테스트 (겹침, stale offset, 빈 refs) |
| `supabase/migrations/012_add_cross_references.sql` | DB 마이그레이션 (cross_references + defined_terms + RLS + cross_ref_status) |
| `components/contract/ClauseTextWithRefs.tsx` | 인라인 참조 링크 렌더링 (renderBoldMarkdown 통합, stale offset 방어) |
| `components/contract/CrossRefLink.tsx` | 링크 컴포넌트 (터치 디바이스 Popover 전환, 접근성: tabIndex, role, aria) |
| `components/contract/CrossRefPreview.tsx` | 스크롤 가능 호버 프리뷰 (ResizeObserver, collisionPadding=16, openDelay=400) |
| `components/contract/IncomingReferences.tsx` | 역참조 목록 (`<button>`, clause_ref 필터) |
| `components/contract/XrefStatsBar.tsx` | 교차참조 통계 바 + 미해결 경고 배너 (flex-wrap 반응형) |
| `components/contract/DefinedTermsPanel.tsx` | 정의어 사전 패널 (유형 배지 Tailwind 클래스, sub-def 정렬, line-clamp-2) |
| `components/contract/TocTermsSection.tsx` | TOC 패널 내 정의어 목록 섹션 ("더 보기" 토글, usage_count 표시) |
| `components/ui/hover-card.tsx` | shadcn HoverCard 컴포넌트 (`npx shadcn@latest add hover-card`) |

### 수정 파일 (9개) — 기존 파싱 로직 수정 없음

| 파일 | 변경 내용 | 기존 로직 영향 |
|---|---|---|
| `lib/data/contracts.ts` | `getContractDetail()`에 crossReferences/definedTerms optional 조회 추가 + clauses SELECT에 `content_format, zone_key, sort_order` 컬럼 추가 | **기존 파일 수정** — 기존 반환값은 유지, 신규 필드는 optional |
| `app/api/contracts/route.ts` | persistParseResult에 교차참조 try-catch + clauses INSERT `.select()` 추가 | non-fatal, 기존 흐름 유지. `.select()`는 반환값만 추가 |
| `app/api/contracts/[id]/route.ts` | GET clauses SELECT에 `content_format, zone_key, sort_order` 컬럼 추가 | API 응답에 필드 추가 (하위호환) |
| `app/contracts/[id]/page.tsx` | crossReferences, definedTerms optional prop 전달 | 기존 렌더링 영향 없음 |
| `app/globals.css` | 교차참조 CSS 토큰 + `.xref-thin-scrollbar`, `.xref-preview-fade` 유틸리티 | 기존 스타일 변경 없음 |
| `tailwind.config.ts` | xref 색상 + `bounce-down` keyframes/animation 확장 | 기존 설정 변경 없음 |
| `components/contract/ContractDetailView.tsx` | ClauseTextWithRefs 교체, XrefStatsBar, 역참조, definitions border-left 오버라이드 | crossReferences 없으면 기존 UI 유지 |
| `components/contract/ContractTocPanel.tsx` | TocTermsSection + DefinedTermsPanel expand 상태 (`useState`) | 기존 TOC 렌더링 영향 없음 |
| `package.json` | `@radix-ui/react-hover-card` 의존성 추가 | 기존 의존성 변경 없음 |

### 수정하지 않는 파일 (파싱 품질 보호)

| 파일 | 보호 대상 |
|---|---|
| `lib/docling-adapter.ts` | `sectionsToClauses()`, `isCrossReference()`, `classifyHeadingRemainder()` |
| `lib/document-parser.ts` | `ParsedClause`, `ParseResult` 타입 |
| `lib/pipeline/process-contract.ts` | `processContract()` 흐름 |
| `lib/pipeline/steps/quality-check.ts` | 품질 검사 로직 |
| `scripts/docling_sidecar.py` | sidecar 파싱 |

---

## 10. 테스트 전략

### 10.1 테스트 파일 목록

| 파일 | 유형 | Phase | 핵심 검증 항목 |
|---|---|---|---|
| `cross-reference-extractor.test.ts` | Unit | 1 | 단일 패턴 6종, parseNumberList 15+ 케이스, expandRange (숫자/알파벳/cross-parent), 중복 제거, Schedule/Annex 미매칭 확인 |
| `defined-term-extractor.test.ts` | Unit | 1 | 패턴 A~E, title+text 결합, bracket heading `["Term"`, content 재스캔, self-ref 제외, "Not Used" skip, 한국어 패턴 |
| `cross-reference-resolver.test.ts` | Unit | 1 | 정확 매칭, 정규화(영문자 A/B/C), 부분 매칭, 미해결 참조(is_resolved=false), 자기참조 필터링 |
| `cross-reference-performance.test.ts` | Perf | 1 | parse_after.json subset, 전체 20초 이내, 각 regex 패턴별 10KB adversarial 문자열 100ms 이내 |
| `cross-references.integration.test.ts` | Integration | 2 | L1 catch → status 정상, L2 → skippedClauses++, L3 → batch skip, 30초 deadline partial, 재처리 DELETE → INSERT 멱등성 |
| `ClauseTextWithRefs.test.ts` | Unit | 3 | buildSegments: 정상 분할, 인접 refs, 겹침 dedup, 빈 refs fallback, offset 범위 초과, stale offset skip, bold 경계 교차 |
| `mock-supabase.ts` | Utility | 1 | chainable `.from().select().eq().insert()` stubs |

### 10.2 데이터 기반 테스트 케이스 (parseNumberList)

| # | 입력 | 예상 결과 |
|---|---|---|
| 1 | `Clauses 1 [GP], 18 [Ins], 20 [CD]` | 3건: Clause 1, 18, 20 |
| 2 | `Sub-Clauses 4.2 [PB], 4.2A [PCG]` | 2건: Sub-Clause 4.2, 4.2A |
| 3 | `Clauses 1, and Sub-Clauses 4.2` | Clause 리스트 종료 → Sub-Clause 새 리스트 |
| 4 | `Sub-Clauses 9.5 to 9.7` | range 확장: 9.5, 9.6, 9.7 |
| 5 | `Clause 1` (단독) | 빈 배열 (items < 2) |
| 6 | `Sub-Clauses 4.2, 4.2A` (no "and") | 2건 |
| 7 | `Articles 5; 6; 7` (세미콜론) | 미매칭 (Known Limitation 또는 구분자 확장) |
| 8 | `Clause 1 or Clause 2` | 나열형 아님 (각각 단일 패턴) |
| 9 | `Sub-Clauses 4.2A to 4.2C` | alpha range: 4.2A, 4.2B, 4.2C |
| 10 | `Sub-Clauses 9.5 to 10.2` (cross-parent) | fallback: 양 끝점만 |
| 11 | `Clauses 1 [...], 18 [...], and Sub-Clauses 4.2 [...], 4.2A [...] and 14.2 [...]` | Clause 2건 + Sub-Clause 3건 |
| 12 | `Sub-Clauses 4.2, 4.2A, and the Contractor shall...` | 2건 (나열 종료: "the" 미매칭) |
| 13 | 빈 문자열 | 빈 배열 |
| 14 | `(vi)` (Roman numeral) | 미매칭 (의도적 제외) |
| 15 | `Schedule 3A [Performance Guarantees]` | 미매칭 (Schedule 패턴 미포함) |

### 10.3 vitest 호환성

- `__tests__/` 디렉토리 패턴: `**/*.test.ts` glob과 호환 (충돌 없음)
- `@/` import alias: `vitest.config.ts`에 설정 완료
- 성능 테스트 timeout: `{ timeout: 60_000 }` 개별 설정 (기본 35초 초과 방지)
- Supabase mock: `lib/__test-utils__/mock-supabase.ts`에 chainable stub factory 구현. 기존 `vi.stubGlobal("fetch")` 패턴과 독립적

---

## 11. 실행 계획 (Execution Plan)

> 작성일: 2026-03-15
> 에이전트: `backend-man`, `ui-designer`, `doc-expert`, `test-runner`, `qa-debugger`
> worktree 격리: 사용 가능 (git worktree 기반 병렬 작업)

---

### 11.1 에이전트별 역할 배정 원칙

| 에이전트 | 담당 영역 | 강점 활용 |
|---|---|---|
| **backend-man** | DB 마이그레이션, API route, 파이프라인 통합, 타입 정의, DB CRUD, resolver | DB/API/regex 엔진, 에러 격리 설계 |
| **doc-expert** | 정규식 추출 엔진, 정의어 추출 엔진, markdown strip/offset 재매핑 | 정의어 패턴 전문성, Docling 파싱 특성 이해, heading/content 분할 |
| **ui-designer** | 모든 신규 컴포넌트, CSS 토큰, Tailwind 설정, 반응형, 접근성 | React 컴포넌트, shadcn/ui, Tailwind, 접근성 |
| **test-runner** | 모든 단위/통합/성능 테스트 작성 및 실행, 벤치마크 | 테스트 설계, vitest 설정, 성능 검증 |
| **qa-debugger** | Stage 간 게이트 검증, 에러 핸들링 검토, edge case 발굴 | 통합 검증, 에러 핸들링, stale offset/겹침 등 경계 조건 |

---

### 11.2 파일 잠금(Lock) 테이블

동일 파일을 여러 에이전트가 수정하면 merge conflict가 발생합니다. 아래 테이블은 **독점 수정 권한**을 명시합니다.

#### 11.2.1 공유 파일 독점 배정

| 파일 | 독점 에이전트 | 이유 |
|---|---|---|
| `components/contract/ContractDetailView.tsx` | **ui-designer** | 가장 큰 변경 범위. 인라인 렌더링 교체, 통계 바, 역참조, definitions 분기 모두 여기서 발생 |
| `app/globals.css` | **ui-designer** | 디자인 토큰, 유틸리티 클래스 추가 |
| `tailwind.config.ts` | **ui-designer** | xref 색상, keyframes 확장 |
| `app/api/contracts/route.ts` | **backend-man** | persistParseResult 수정, clauses INSERT `.select()` 추가, 교차참조 try-catch 통합 |
| `app/api/contracts/[id]/route.ts` | **backend-man** | GET clauses SELECT 컬럼 추가 |
| `app/contracts/[id]/page.tsx` | **backend-man** | 서버 컴포넌트에서 crossReferences/definedTerms prop 전달 |
| `lib/data/contracts.ts` | **backend-man** | 기존 `getContractDetail()`에 교차참조/정의어 optional 조회 추가 |
| `components/contract/ContractTocPanel.tsx` | **ui-designer** | TocTermsSection + DefinedTermsPanel expand 상태 추가 |
| `package.json` | **ui-designer** | `@radix-ui/react-hover-card` 의존성 추가 (shadcn 설치) |

#### 11.2.2 신규 파일 독점 배정

| 파일 | 독점 에이전트 |
|---|---|
| `supabase/migrations/012_add_cross_references.sql` | backend-man |
| `types/cross-reference.ts` | backend-man |
| `lib/analysis/cross-reference-extractor.ts` | doc-expert |
| `lib/analysis/defined-term-extractor.ts` | doc-expert |
| `lib/analysis/cross-reference-resolver.ts` | backend-man |
| `lib/data/cross-references.ts` | backend-man |
| `lib/__test-utils__/mock-supabase.ts` | test-runner |
| `lib/analysis/__tests__/cross-reference-extractor.test.ts` | test-runner |
| `lib/analysis/__tests__/defined-term-extractor.test.ts` | test-runner |
| `lib/analysis/__tests__/cross-reference-resolver.test.ts` | test-runner |
| `lib/analysis/__tests__/cross-reference-performance.test.ts` | test-runner |
| `lib/data/__tests__/cross-references.integration.test.ts` | test-runner |
| `components/contract/__tests__/ClauseTextWithRefs.test.ts` | test-runner |
| `components/contract/ClauseTextWithRefs.tsx` | ui-designer |
| `components/contract/CrossRefLink.tsx` | ui-designer |
| `components/contract/CrossRefPreview.tsx` | ui-designer |
| `components/contract/IncomingReferences.tsx` | ui-designer |
| `components/contract/XrefStatsBar.tsx` | ui-designer |
| `components/contract/DefinedTermsPanel.tsx` | ui-designer |
| `components/contract/TocTermsSection.tsx` | ui-designer |
| `components/ui/hover-card.tsx` | ui-designer |
| `app/api/contracts/[id]/cross-references/route.ts` | backend-man *(선택 — Phase 2-5 구현 시)* |

#### 11.2.3 충돌 방지 규칙

1. **어떤 에이전트도 자신의 독점 파일 외의 파일을 수정하지 않는다.** 필요한 경우 인터페이스(타입 정의)를 먼저 합의한 후 각자 파일에서 import하여 사용한다.
2. **doc-expert와 backend-man의 경계**: doc-expert는 `cross-reference-extractor.ts`와 `defined-term-extractor.ts`만 수정한다. resolver, DB CRUD, 파이프라인 통합은 backend-man이 담당한다. 두 모듈 간 인터페이스는 `types/cross-reference.ts`에 정의되며, backend-man이 먼저 타입을 작성하고 doc-expert가 이를 import한다.
3. **ui-designer와 backend-man의 경계**: `app/contracts/[id]/page.tsx`에서 ContractDetailView에 전달할 props는 backend-man이 정의한다. ui-designer는 해당 props를 받는 컴포넌트만 구현한다. props 인터페이스 변경이 필요하면 backend-man에게 요청한다.
4. **test-runner는 테스트 파일만 생성/수정한다.** 구현 코드를 수정하지 않는다. 테스트 중 발견된 버그는 qa-debugger에게 보고한다.

---

### 11.3 Stage별 실행 계획

#### Stage 0: 선행 작업 (Phase 0) — 순차 필수

**게이트 진입 조건**: 없음 (최초 시작)

| 작업 ID | 작업 | 담당 | 파일 | 병렬/순차 | 예상 시간 |
|---|---|---|---|---|---|
| S0-1 | DB 마이그레이션 012번 SQL 작성 및 적용 | backend-man | `supabase/migrations/012_add_cross_references.sql` | 순차 (최우선) | 2h |
| S0-2 | shadcn HoverCard 설치 (`npx shadcn@latest add hover-card`) | ui-designer | `components/ui/hover-card.tsx`, `package.json` | S0-1과 병렬 | 0.5h |
| S0-3 | 타입 정의 — 모든 인터페이스/타입을 먼저 확정 | backend-man | `types/cross-reference.ts` | S0-1 완료 후 | 2h |
| S0-4 | `persistParseResult()` clauses INSERT에 `.select()` 추가 | backend-man | `app/api/contracts/route.ts` | S0-3 완료 후 | 1h |
| S0-5 | `lib/data/contracts.ts` 신규 생성 + `getContractDetail()` 추출 | backend-man | `lib/data/contracts.ts`, `app/api/contracts/[id]/route.ts` | S0-4와 병렬 | 3h |
| S0-6 | `[id]/route.ts` GET clauses SELECT 컬럼 추가 | backend-man | `app/api/contracts/[id]/route.ts` | S0-5와 통합 | (S0-5에 포함) |
| S0-7 | globals.css + tailwind.config.ts 디자인 토큰 추가 | ui-designer | `app/globals.css`, `tailwind.config.ts` | S0-2 완료 후 | 1h |
| S0-V | **Stage 0 검증**: 마이그레이션 적용 확인, 타입 컴파일, 기존 테스트 통과 | test-runner | — | S0-1~S0-7 전체 완료 후 | 1h |

**Stage 0 calendar 소요**: **2일** (backend-man 크리티컬 패스: S0-1 → S0-3 → S0-4/S0-5 직렬, ui-designer는 병렬 완료)

**게이트 조건 (Stage 0 → Stage 1)**:
- [ ] `012_add_cross_references.sql` 적용 완료 (cross_references, defined_terms 테이블 + RLS)
- [ ] `types/cross-reference.ts` 컴파일 에러 없음
- [ ] `npm test` 기존 테스트 전량 통과
- [ ] `npm run build` 성공
- [ ] `getContractDetail()` 함수가 optional crossReferences/definedTerms 필드 포함
- [ ] clauses INSERT `.select()` 변경이 기존 업로드 흐름에 영향 없음 확인

---

#### Stage 1: 코어 엔진 (Phase 1) — 병렬 가능

**게이트 진입 조건**: Stage 0 게이트 통과

| 작업 ID | 작업 | 담당 | 파일 | 병렬/순차 | 예상 시간 |
|---|---|---|---|---|---|
| S1-1 | 조항 참조 정규식 추출 엔진 (CLAUSE_NUM, BRACKET_TITLE, 단일 패턴 6종, 나열형 파서, 범위 확장, 중복 제거) | doc-expert | `lib/analysis/cross-reference-extractor.ts` | 병렬 A | 12h |
| S1-2 | 정의어 추출 엔진 (패턴 A~E, 동의어 분리, 인라인 부정의어, title+text 결합, content 재스캔, markdown strip) | doc-expert | `lib/analysis/defined-term-extractor.ts` | 병렬 A (S1-1과 순차 권장 — 공유 유틸 `stripMarkdownForMatching` 등) | 12h |
| S1-3 | 참조 해결 로직 (clauseIndex 구축, 정확/정규화/영문자/부분 매칭, 자기참조 필터) | backend-man | `lib/analysis/cross-reference-resolver.ts` | 병렬 B | 6h |
| S1-4 | DB CRUD (extractAndSaveCrossReferences, 재처리 멱등성, usage_count 집계, batch insert) | backend-man | `lib/data/cross-references.ts` | 병렬 B (S1-3 완료 후) | 6h |
| S1-5 | Supabase mock factory | test-runner | `lib/__test-utils__/mock-supabase.ts` | 병렬 C | 3h |
| S1-6 | 조항 참조 단위 테스트 (단일 패턴 + parseNumberList 15+ 케이스 + expandRange) | test-runner | `lib/analysis/__tests__/cross-reference-extractor.test.ts` | S1-1 완료 대기 | 6h |
| S1-7 | 정의어 추출 단위 테스트 (패턴 A~E, title+text 결합, self-ref 제외, bracket heading) | test-runner | `lib/analysis/__tests__/defined-term-extractor.test.ts` | S1-2 완료 대기 | 6h |
| S1-8 | 성능 벤치마크 (parse_after.json subset, 20초 이내, adversarial 문자열 backtracking 검증) | test-runner | `lib/analysis/__tests__/cross-reference-performance.test.ts` | S1-1 + S1-2 완료 대기 | 4h |
| S1-V | **Stage 1 검증**: 전체 테스트 + 정규식 정확도 검토 | qa-debugger | — | S1-6 ~ S1-8 완료 후 | 4h |

**병렬 구조**:
```
[doc-expert]  ──S1-1──→──S1-2──→
[backend-man] ──S1-3──→──S1-4──→
[test-runner] ──S1-5──→     ──S1-6──→──S1-7──→──S1-8──→
                              (S1-1 대기)  (S1-2 대기)  (both 대기)
[qa-debugger]                                          ──S1-V──→
```

**Stage 1 calendar 소요**: **4일** (크리티컬 패스: doc-expert S1-1 + S1-2 = 24h 순차, 이후 test-runner S1-6~S1-8)

**게이트 조건 (Stage 1 → Stage 2)**:
- [ ] `cross-reference-extractor.ts` 단위 테스트 전량 통과 (15+ parseNumberList 케이스 포함)
- [ ] `defined-term-extractor.ts` 단위 테스트 전량 통과
- [ ] 성능 벤치마크: parse_after.json subset 기준 20초 이내
- [ ] 각 regex 패턴별 adversarial 문자열 100ms 이내 (catastrophic backtracking 없음)
- [ ] `cross-reference-resolver.ts` 단위 테스트 통과 (정확/정규화/영문자/부분 매칭)
- [ ] qa-debugger 검증 완료: edge case(빈 text, null number, 자기참조) 처리 확인
- [ ] `npm test` 전체 통과

---

#### Stage 2: 파이프라인 통합 (Phase 2) — 순차 필수

**게이트 진입 조건**: Stage 1 게이트 통과

| 작업 ID | 작업 | 담당 | 파일 | 병렬/순차 | 예상 시간 |
|---|---|---|---|---|---|
| S2-1 | persistParseResult 내 교차참조 호출 통합 (정의어 추출 → 조항 참조 추출 → 매칭 순서) | backend-man | `app/api/contracts/route.ts` | 순차 | 4h |
| S2-2 | 3단계 에러 격리 구현 (L1 전체 / L2 조항별 / L3 batch별) + 30초 deadline | backend-man | `lib/data/cross-references.ts` | S2-1 완료 후 | 3h |
| S2-3 | 기존 `getContractDetail()`에 crossReferences/definedTerms optional 조회 삽입 (clauses 조회 이후, analyses 조회와 병렬. `error.code === "42P01"` 방어 포함) | backend-man | `lib/data/contracts.ts` | S2-2와 병렬 | 2h |
| S2-4 | API 엔드포인트 (선택): GET /api/contracts/:id/cross-references | backend-man | `app/api/contracts/[id]/cross-references/route.ts` | S2-3 완료 후 | 2h |
| S2-5 | 3-tier 에러 격리 통합 테스트 + 재처리 멱등성 테스트 | test-runner | `lib/data/__tests__/cross-references.integration.test.ts` | S2-2 완료 대기 | 4h |
| S2-6 | 파싱 품질 보호 체크리스트 검증 (8.4 항목 전체) | qa-debugger | — | S2-1 ~ S2-4 완료 후 | 3h |
| S2-V | **Stage 2 검증**: 실제 PDF 업로드 → 교차참조 DB 저장 e2e 확인 | qa-debugger | — | S2-5 + S2-6 완료 후 | 3h |

**Stage 2 calendar 소요**: **2.5일** (크리티컬 패스: S2-1 → S2-2 → S2-5/S2-6 → S2-V)

**게이트 조건 (Stage 2 → Stage 3)**:
- [ ] 실제 PDF 업로드 시 cross_references 테이블에 데이터 INSERT 확인
- [ ] 교차참조 실패 시 contract status가 "filtering"으로 정상 전환 확인
- [ ] 30초 타임아웃 시 부분 결과 저장 + 파이프라인 계속 진행 확인
- [ ] 재처리 시 기존 데이터 DELETE → 새 데이터 INSERT 멱등성 확인
- [ ] 파싱 품질 보호 체크리스트 7개 항목 전체 통과
- [ ] `processContract()`, `sectionsToClauses()`, `qualityCheck()` git diff 변경 없음
- [ ] `npm test` 전체 통과

---

#### Stage 3: Frontend 구현 (Phase 3~5) — 부분 병렬

**게이트 진입 조건**: Stage 2 게이트 통과

Stage 3는 크게 3개 트랙으로 나뉩니다. 개별 컴포넌트 파일은 병렬 작업 가능하지만, **ContractDetailView.tsx 통합은 마지막에 단일 에이전트(ui-designer)가 수행**합니다.

##### Stage 3a: 개별 컴포넌트 생성 (병렬 가능)

| 작업 ID | 작업 | 담당 | 파일 | 병렬/순차 | 예상 시간 |
|---|---|---|---|---|---|
| S3a-1 | ClauseTextWithRefs (buildSegments + renderBoldMarkdown 통합 + stale offset 방어) | ui-designer | `components/contract/ClauseTextWithRefs.tsx` | 병렬 A | 6h |
| S3a-2 | CrossRefLink (refType별 색상, tabIndex, role, aria, 터치 Popover 전환) | ui-designer | `components/contract/CrossRefLink.tsx` | S3a-1 완료 후 | 4h |
| S3a-3 | CrossRefPreview (스크롤 본문, ResizeObserver, 페이드 마스크, 스크롤 힌트, 3가지 프리뷰 분기) | ui-designer | `components/contract/CrossRefPreview.tsx` | S3a-2 완료 후 | 5h |
| S3a-4 | IncomingReferences (역참조 목록, button 접근성, clause_ref 필터) | ui-designer | `components/contract/IncomingReferences.tsx` | 병렬 B | 3h |
| S3a-5 | XrefStatsBar (통계 바 + 미해결 경고 배너, flex-wrap 반응형) | ui-designer | `components/contract/XrefStatsBar.tsx` | 병렬 B | 2h |
| S3a-6 | DefinedTermsPanel (검색, 유형 배지, 별칭, 인라인 부정의어 들여쓰기, line-clamp-2, 스크롤) | ui-designer | `components/contract/DefinedTermsPanel.tsx` | 병렬 C | 6h |
| S3a-7 | buildSegments 단위 테스트 | test-runner | `components/contract/__tests__/ClauseTextWithRefs.test.ts` | S3a-1 완료 대기 | 3h |

> **주의**: ui-designer가 S3a-1 ~ S3a-6을 순차적으로 작업하게 되지만, S3a-4/S3a-5는 S3a-1과 의존성이 없으므로 worktree 격리를 사용하면 두 번째 ui-designer 세션에서 병렬 가능합니다. 그러나 현실적으로 한 에이전트가 동시에 두 worktree에서 작업하기 어려우므로, **순차 진행을 기본으로 가정**합니다.

##### Stage 3b: ContractDetailView 통합 (순차 필수, 마지막)

| 작업 ID | 작업 | 담당 | 파일 | 병렬/순차 | 예상 시간 |
|---|---|---|---|---|---|
| S3b-1 | ContractDetailView에 xrefIndex/termIndex/clauseLookup useMemo 추가 | ui-designer | `ContractDetailView.tsx` | S3a-1 ~ S3a-6 전체 완료 후 | 3h |
| S3b-2 | 기존 `{clause.text}` → `<ClauseTextWithRefs>` 교체 (crossReferences 없으면 기존 유지) | ui-designer | `ContractDetailView.tsx` | S3b-1 직후 | 2h |
| S3b-3 | XrefStatsBar 배치 + IncomingReferences 통합 | ui-designer | `ContractDetailView.tsx` | S3b-2 직후 | 2h |
| S3b-4 | Definitions 조항 전용 렌더링 (border-left 오버라이드, 유형 배지, isDefClause 분기) | ui-designer | `ContractDetailView.tsx` | S3b-3 직후 | 3h |
| S3b-5 | ContractTocPanel에 TocTermsSection + DefinedTermsPanel expand 통합 | ui-designer | `ContractTocPanel.tsx` | S3b-4와 병렬 가능 | 3h |
| S3b-6 | `app/contracts/[id]/page.tsx` 서버 컴포넌트에서 crossReferences/definedTerms prop 전달 | backend-man | `app/contracts/[id]/page.tsx` | S3a 완료 후 (S3b-1과 병렬) | 1h |

##### Stage 3c: 검증

| 작업 ID | 작업 | 담당 | 파일 | 병렬/순차 | 예상 시간 |
|---|---|---|---|---|---|
| S3c-1 | 전체 UI 통합 테스트: 교차참조 있는 계약서 / 없는 계약서 양쪽 렌더링 확인 | qa-debugger | — | S3b 전체 완료 후 | 4h |
| S3c-2 | 접근성 검증: keyboard navigation, aria 속성, 스크린리더 호환 | qa-debugger | — | S3c-1 완료 후 | 2h |
| S3c-3 | 반응형 검증: sm/md/lg 브레이크포인트, 터치 디바이스 Popover 전환 | qa-debugger | — | S3c-1 완료 후 | 2h |
| S3c-4 | `npm test` + `npm run build` 전체 통과 확인 | test-runner | — | S3c-1 완료 후 | 1h |

**Stage 3 calendar 소요**: **6일**
- ui-designer 크리티컬 패스: S3a-1 → S3a-2 → S3a-3 (15h) + S3a-4/5/6 병렬(6h) + S3b 통합(13h) = 약 34h
- test-runner: S3a-7 (3h, S3a-1 대기 후)
- qa-debugger: S3c 검증 (8h, S3b 완료 대기)
- backend-man: S3b-6 (1h, 병렬 처리)

**게이트 조건 (Stage 3 → Stage 4)**:
- [ ] 교차참조가 있는 계약서: 인라인 링크 렌더링, 호버 프리뷰, 역참조 목록, 통계 바 정상 표시
- [ ] 교차참조가 없는 계약서: 기존 UI와 동일하게 표시 (regression 없음)
- [ ] DefinedTermsPanel: 검색 필터링, 유형 배지, 별칭, 인라인 부정의어 정상 표시
- [ ] definitions 조항 전용 렌더링: border-left blue, 유형 배지, 사용 횟수 표시
- [ ] 접근성: Tab으로 CrossRefLink 이동 가능, Enter로 네비게이션, 미해결 참조 aria-disabled
- [ ] `npm test` 전체 통과
- [ ] `npm run build` 성공

---

#### Stage 4: 최적화 + Edge Case (Phase 6)

**게이트 진입 조건**: Stage 3 게이트 통과

| 작업 ID | 작업 | 담당 | 파일 | 병렬/순차 | 예상 시간 |
|---|---|---|---|---|---|
| S4-1 | 대형 문서 성능 검증 (700+ 조항, DOM 노드 수 측정, React.memo 적용) | qa-debugger + test-runner | — | 병렬 A | 4h |
| S4-2 | 겹침 방지 검증 (조항 참조 구간 내 정의어) | qa-debugger | — | 병렬 A | 2h |
| S4-3 | 기존 계약 재처리 API (소급 적용) | backend-man | `app/api/contracts/[id]/cross-references/route.ts` | 병렬 B | 4h |
| S4-4 | 열거형 multi-line 정의어 + 한국어 비표준 패턴 추가 | doc-expert | `lib/analysis/defined-term-extractor.ts` | 병렬 B | 4h |
| S4-5 | Schedule/Annex/Appendix 참조 패턴 추가 (Known Limitation 해소) | doc-expert | `lib/analysis/cross-reference-extractor.ts` | 병렬 B | 3h |
| S4-6 | 추가 패턴 테스트 작성 | test-runner | 기존 테스트 파일 확장 | S4-4/S4-5 완료 후 | 3h |
| S4-V | 최종 통합 검증 + 전체 regression 테스트 | qa-debugger + test-runner | — | 전체 완료 후 | 4h |

**Stage 4 calendar 소요**: **2일** (병렬 처리 + 최종 검증)

---

### 11.4 전체 Timeline

```
            Day 1    Day 2    Day 3    Day 4    Day 5    Day 6    Day 7    Day 8    Day 9   Day 10   Day 11   Day 12   Day 13   Day 14
            ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
backend-man [S0-1 S0-3 S0-4 S0-5   ][S1-3 ── S1-4 ──          ][S2-1 ── S2-2 ── S2-3 S2-4][S3b-6]                          [S4-3 ──]
doc-expert                           [S1-1 ──────── S1-2 ──────]                                                             [S4-4 S4-5]
ui-designer [S0-2 S0-7              ]                                              [S3a ────────────── S3b ──────────]
test-runner               [S0-V    ][S1-5][     S1-6  S1-7  S1-8]         [S2-5 ─][S3a-7]                    [S3c-4 ][S4-1    S4-6  S4-V]
qa-debugger                                              [S1-V ─]               [S2-6 S2-V]           [S3c-1 S3c-2 S3c-3]   [S4-1 S4-2 S4-V]
            ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
            ├── Stage 0 ──┤├──────── Stage 1 ─────────────┤├── Stage 2 ──────┤├────────── Stage 3 ──────────────────┤├── Stage 4 ──┤
```

| Stage | Calendar 일수 | 크리티컬 패스 |
|---|---|---|
| Stage 0 | 2일 | backend-man: 마이그레이션 → 타입 정의 → API 수정 |
| Stage 1 | 4일 | doc-expert: extractor + term-extractor (24h 순차) → test-runner 검증 |
| Stage 2 | 2.5일 | backend-man: 파이프라인 통합 → 에러 격리 → qa-debugger 검증 |
| Stage 3 | 6일 | ui-designer: 개별 컴포넌트 (26h) → ContractDetailView 통합 (13h) |
| Stage 4 | 2일 | 병렬 최적화 + 최종 검증 |
| **합계** | **약 14.5일 (3주)** | — |

> **낙관적 추정 경고**: 위 일정은 각 에이전트가 하루 8시간 집중 작업 가능하고, Stage 간 핸드오프에 지연이 없다고 가정합니다. 현실적으로는 다음을 감안해야 합니다:
> - 에이전트 간 인터페이스 불일치 수정: +1~2일
> - 정규식 edge case 발견 후 수정 반복: +1일
> - ContractDetailView 통합 시 예상치 못한 레이아웃 충돌: +1일
> - **현실적 총 소요: 약 18~20일 (4주)**

---

### 11.5 Worktree 격리 전략

Git worktree를 사용하면 같은 repo에서 여러 브랜치를 동시에 체크아웃하여 병렬 작업이 가능합니다.

| Stage | Worktree 활용 | 브랜치명 |
|---|---|---|
| Stage 0 | 단일 worktree (main에서 직접) | `feat/xref-phase0` |
| Stage 1 | 2개 worktree 권장 | `feat/xref-extractor` (doc-expert), `feat/xref-backend` (backend-man) |
| Stage 2 | 단일 worktree (Stage 1 머지 후) | `feat/xref-pipeline` |
| Stage 3 | 단일 worktree (ContractDetailView 독점 방지) | `feat/xref-ui` |
| Stage 4 | 2개 worktree 가능 | `feat/xref-optimize-backend`, `feat/xref-optimize-patterns` |

**머지 전략**:
1. 각 Stage 완료 시 해당 브랜치를 `main`에 머지
2. Stage 1의 두 worktree는 파일이 겹치지 않으므로 (독점 배정 준수 시) conflict 없이 머지 가능
3. Stage 3는 **반드시 단일 worktree**에서 진행 — ContractDetailView.tsx에 대한 동시 수정은 금지

---

### 11.6 리스크 대응 매트릭스

| 리스크 | 발생 시점 | 대응 방안 |
|---|---|---|
| doc-expert의 정규식 엔진이 예상보다 복잡해 Stage 1 지연 | Stage 1, Day 3~4 | 나열형 파서(L1/L2/L3)를 Phase 6로 연기하고, 단일 패턴만으로 Stage 2 진입. 나열형은 Stage 4에서 보강 |
| backend-man과 doc-expert의 타입 인터페이스 불일치 | Stage 1 시작 시 | Stage 0에서 `types/cross-reference.ts`를 먼저 확정하고, PR 리뷰로 양쪽 동의 후 진행 |
| ui-designer의 ContractDetailView 통합이 예상보다 복잡 | Stage 3b | S3b-1~S3b-4를 더 작은 단위로 분할. 각 단계마다 qa-debugger가 중간 검증 수행 |
| 성능 벤치마크 실패 (20초 초과) | Stage 1, S1-8 | RegExp 미리 컴파일 적용 확인, 정의어 매칭 범위를 definitions zone + general_conditions zone으로 제한, deadline을 45초로 상향 |
| 마이그레이션 적용 실패 | Stage 0, S0-1 | SQL을 단위별로 분리 (cross_references CREATE → defined_terms CREATE → ALTER → RLS 각각). 부분 적용 가능하도록 IF NOT EXISTS 사용 |

---

## 12. 롤백 전략 (Rollback Strategy)

> **원칙**: 사용자가 "롤백해" 한마디로 명령하면, 추가 질문 없이 자동으로 코드 + DB를 구현 전 상태로 복원한다.

### 12.1 사전 준비 (구현 착수 전 필수)

구현 시작 전 아래 4단계를 반드시 실행하여 복원 지점을 확보한다.

#### Step A: 현재 변경사항 커밋 (복원 지점)
```bash
# 현재 미커밋 변경 전체를 main에 커밋
git add -A
git commit -m "chore: pre-crossref baseline — 교차참조 구현 전 스냅샷"
```

#### Step B: 태그 생성
```bash
git tag v0.2-baseline -m "교차참조 구현 전 복원 지점"
```

#### Step C: Feature 브랜치 생성
```bash
git checkout -b feature/cross-references
```
> 이후 모든 교차참조 구현은 이 브랜치에서만 진행한다. main은 절대 직접 수정하지 않는다.

#### Step D: DOWN 마이그레이션 작성
`supabase/migrations/012_add_cross_references_DOWN.sql` 파일을 생성한다:
```sql
-- 012_add_cross_references_DOWN.sql
-- 교차참조 기능 롤백용 — 이 파일은 자동 롤백 시 실행됨

-- 1. RLS 정책 제거
DROP POLICY IF EXISTS "Service role full access on cross_references"
  ON public.cross_references;
DROP POLICY IF EXISTS "Service role full access on defined_terms"
  ON public.defined_terms;

-- 2. 테이블 삭제
DROP TABLE IF EXISTS public.cross_references CASCADE;
DROP TABLE IF EXISTS public.defined_terms CASCADE;

-- 3. contracts 테이블에 추가된 컬럼 제거
ALTER TABLE public.contracts
  DROP COLUMN IF EXISTS cross_ref_status;
```

---

### 12.2 자동 롤백 절차

사용자가 **"롤백해"** 또는 **"교차참조 롤백"** 을 명령하면, Claude Code는 아래 절차를 **순서대로 자동 실행**한다. 사용자에게 추가 확인을 요청하지 않는다.

#### Phase 1: Git 롤백 (코드 복원)

```bash
# 1-1. 현재 작업 중인 변경사항 보존 (안전장치)
git stash push -m "rollback-safety-$(date +%Y%m%d-%H%M%S)"

# 1-2. main 브랜치로 전환
git checkout main

# 1-3. feature 브랜치가 main에 머지되었다면 되돌리기
#       (머지 커밋이 있을 경우에만 실행)
MERGE_COMMIT=$(git log --oneline --merges --grep="cross-references" -1 --format="%H")
if [ -n "$MERGE_COMMIT" ]; then
  git revert -m 1 "$MERGE_COMMIT" --no-edit
fi

# 1-4. 태그 기반 복원 (머지 전이라면 이미 main은 깨끗)
#       v0.2-baseline 태그가 현재 HEAD와 다르면 리셋
BASELINE=$(git rev-parse v0.2-baseline 2>/dev/null)
if [ -n "$BASELINE" ] && [ "$BASELINE" != "$(git rev-parse HEAD)" ]; then
  # feature 브랜치가 머지되지 않은 경우, main은 이미 baseline 상태
  echo "[rollback] main is at baseline, no reset needed"
fi
```

#### Phase 2: DB 롤백 (스키마 복원)

```bash
# 2-1. DOWN 마이그레이션 실행
#      Supabase 로컬 환경이라면 psql 또는 Supabase SQL Editor에서 실행
# 방법 A: Supabase CLI (로컬)
supabase db reset

# 방법 B: DOWN SQL 직접 실행 (로컬 psql 사용 가능 시)
# psql "$DATABASE_URL" -f supabase/migrations/012_add_cross_references_DOWN.sql
```

#### Phase 3: Feature 브랜치 정리

```bash
# 3-1. feature 브랜치 삭제 (로컬)
git branch -D feature/cross-references 2>/dev/null

# 3-2. 관련 worktree 정리
git worktree list | grep "xref" | awk '{print $1}' | while read wt; do
  git worktree remove "$wt" --force 2>/dev/null
done

# 3-3. Stage별 브랜치 정리
for branch in feat/xref-phase0 feat/xref-extractor feat/xref-backend feat/xref-pipeline feat/xref-ui feat/xref-optimize-backend feat/xref-optimize-patterns; do
  git branch -D "$branch" 2>/dev/null
done
```

#### Phase 4: 파일 정리

```bash
# 4-1. 교차참조 전용으로 생성된 파일 확인 및 삭제
#      (main에 없는 파일 = 교차참조에서 추가된 파일)
XREF_FILES=(
  # --- 타입/유틸 ---
  "types/cross-reference.ts"
  # --- 백엔드 코어 ---
  "lib/analysis/cross-reference-extractor.ts"
  "lib/analysis/defined-term-extractor.ts"
  "lib/analysis/cross-reference-resolver.ts"
  "lib/data/cross-references.ts"
  # --- 테스트 ---
  "lib/analysis/__tests__/cross-reference-extractor.test.ts"
  "lib/analysis/__tests__/defined-term-extractor.test.ts"
  "lib/analysis/__tests__/cross-reference-resolver.test.ts"
  "lib/analysis/__tests__/cross-reference-performance.test.ts"
  "lib/data/__tests__/cross-references.integration.test.ts"
  "lib/__test-utils__/mock-supabase.ts"
  "components/contract/__tests__/ClauseTextWithRefs.test.ts"
  # --- UI 컴포넌트 ---
  "components/contract/ClauseTextWithRefs.tsx"
  "components/contract/CrossRefLink.tsx"
  "components/contract/CrossRefPreview.tsx"
  "components/contract/IncomingReferences.tsx"
  "components/contract/XrefStatsBar.tsx"
  "components/contract/DefinedTermsPanel.tsx"
  "components/contract/TocTermsSection.tsx"
  "components/ui/hover-card.tsx"
  # --- 마이그레이션 ---
  "supabase/migrations/012_add_cross_references.sql"
)
# ⚠ lib/data/contracts.ts는 기존 파일이므로 삭제 대상이 아님
# ⚠ 수정된 기존 파일(route.ts, globals.css 등)은 git checkout으로 복원됨
for f in "${XREF_FILES[@]}"; do
  [ -f "$f" ] && rm "$f" && echo "[rollback] deleted $f"
  [ -d "$f" ] && rm -rf "$f" && echo "[rollback] deleted dir $f"
done
```

#### Phase 5: 검증

```bash
# 5-1. 현재 브랜치 확인
echo "현재 브랜치: $(git branch --show-current)"

# 5-2. v0.2-baseline 태그와 diff 확인
git diff v0.2-baseline --stat

# 5-3. 교차참조 테이블 존재 여부 확인
# (Supabase 로컬 실행 중일 때)
# supabase db test 또는 직접 쿼리로 확인

# 5-4. 빌드 확인
npm run build 2>&1 | tail -5
```

---

### 12.3 롤백 수준 (Rollback Levels)

상황에 따라 세 가지 수준의 롤백이 가능하다:

| 수준 | 명령어 예시 | 범위 | 실행 Phase |
|------|-------------|------|------------|
| **Full** | "롤백해", "전체 롤백" | 코드 + DB + 브랜치 전부 | Phase 1~5 전체 |
| **Code Only** | "코드만 롤백" | Git만 복원, DB는 유지 | Phase 1, 3, 4, 5 |
| **Stage 롤백** | "Stage 2 롤백" | 해당 Stage 커밋만 revert | 해당 Stage 커밋 revert + 관련 파일 정리 |

> 명시하지 않으면 **Full 롤백**을 기본으로 실행한다.

---

### 12.4 Stage별 중간 커밋 규칙

롤백의 세밀한 제어를 위해 각 Stage 완료 시 아래 형식으로 커밋한다:

```
feat(xref): Stage N 완료 — [요약]

Stage: N
Files: [변경 파일 수]
```

이를 통해 특정 Stage만 선택적으로 revert할 수 있다:
```bash
# 예: Stage 3 커밋만 되돌리기
git log --oneline --grep="Stage: 3" | awk '{print $1}' | xargs git revert --no-edit
```

---

### 12.5 안전장치

1. **main 브랜치 보호**: 구현 작업은 반드시 feature 브랜치에서 진행. main 직접 커밋 금지
2. **태그 불변성**: `v0.2-baseline` 태그는 절대 이동/삭제하지 않음
3. **Stash 보존**: 롤백 시 작업 중이던 변경사항을 stash에 보관 (데이터 유실 방지)
4. **DOWN SQL 동봉**: UP 마이그레이션과 항상 쌍으로 유지
5. **롤백 후 빌드 검증**: Phase 5에서 `npm run build` 성공을 확인

---

### 12.6 Claude Code 자동 롤백 트리거

Claude Code가 다음 키워드를 감지하면 Section 12.2의 절차를 자동 실행한다:

- "롤백해" / "롤백 진행" / "교차참조 롤백" / "crossref rollback"
- "구현 전으로 되돌려" / "baseline으로 복원"

**실행 시 출력 형식**:
```
[ROLLBACK] Phase 1/5: Git 롤백 시작...
[ROLLBACK] Phase 1/5: ✓ main 브랜치 전환 완료
[ROLLBACK] Phase 2/5: DB 롤백 시작...
[ROLLBACK] Phase 2/5: ✓ DOWN 마이그레이션 실행 완료
[ROLLBACK] Phase 3/5: 브랜치 정리...
[ROLLBACK] Phase 3/5: ✓ feature 브랜치 3개 삭제
[ROLLBACK] Phase 4/5: 파일 정리...
[ROLLBACK] Phase 4/5: ✓ 교차참조 파일 18개 삭제
[ROLLBACK] Phase 5/5: 검증...
[ROLLBACK] Phase 5/5: ✓ 빌드 성공, baseline과 diff 0건
[ROLLBACK] === 롤백 완료 ===
```
