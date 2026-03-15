---
name: QNLP EPC Contract 파싱 품질 분석
description: QNLP.ITB.P2 EPC Contract.pdf 파싱 이슈 분석 및 수정 이력 (2026-03-14 ~ 2026-03-14 v2)
type: project
---

# QNLP EPC Contract 파싱 품질 분석

## 문서 기본 정보
- 파일: QNLP.ITB.P2 EPC Contract.pdf (226페이지, EPC 계약서, 영문)
- 파싱 시간: ~77-90초
- 총 섹션(최종 수정 후): 536개 (v2: 528->536)
- toc_entries: 356개

## 실제 문서 구조 (PDF 내용 기반)
- p1-2:   Preamble (Note to Bidders)
- p3-12:  CONTRACT AGREEMENT (Articles 1-7, 'THIS CONTRACT AGREEMENT...' 로 시작)
- p13-23: TABLE OF CONTENTS (CONTENTS 제목, 점선 형식)
- p24-172: CONDITIONS OF CONTRACT (Clauses 1-23, '1 General Provisions' 로 시작)
- p173-226: SCHEDULES (Schedule 1~30)

## 구조적 특이점
1. TOC가 p13에 위치 (Contract Agreement 본문 p3-12 이후) — 비정형 레이아웃
2. 조항 번호 체계 두 가지 혼재: '1. DEFINITIONS' (Article, Contract Agreement) vs '1.1 Definitions' (Conditions)
3. Clause 12 의도적 생략 (11->13으로 건너뜀)
4. 각 페이지 하단 푸터: 'SINGAPORE 655229378.1 30-Sep-25 19:00' + 페이지번호
5. [Note to Bidders ...] 텍스트가 BoldItalic 폰트로 조판 -> heading 오인 주의
6. 정의 항목 '1.1.1.X ["Term"...]' -- 숫자 prefix + bracket 혼재
7. Parent-child heading 구조: "7 Equipment..." (parent) + "7.1 Manner..." (child) 연속 배치

## v2 수정 이력 (2026-03-14, 6 Task 구현)

### Task 1 (P0): Parent-child heading 병합 방지 (수정 완료)
**증상:** "1 General Provisions" + "1.1 Definitions" 가 "1 General Provisions 1.1 Definitions" 로 병합
  - 영향: 15개 parent heading (1-20) 및 13개 child heading (N.1) 누락
**원인:** `_merge_fragmented_headings()` 의 while 루프가 heading-only 섹션을 무조건 수집하고,
  병합 대상(content 있는 섹션)과의 parent-child 관계도 체크하지 않음
**수정:**
  1. `_is_parent_child_heading()` 헬퍼 함수 추가 (조항 번호 prefix 비교)
  2. while 루프 내: heading-only 수집 시 parent-child 관계 감지 -> break
  3. while 루프 후: 병합 대상 섹션도 parent-child 체크 -> 병합 방지, 독립 섹션 보존
**결과:** 15개 parent + 13개 child heading 복구

### Task 2 (P0): FIDIC 인라인 참조 필터 (수정 완료)
**증상:** "8.3 [Programme]," "7.6 [Remedial Work]; or" 등 7개가 heading으로 오인
**원인:** `is_heading()` 에 FIDIC 인라인 참조 패턴 필터 없음
**수정:** `is_heading()` 에 3개 필터 추가 (ends_punct 직후):
  - Filter 2a: `N.N [Title],/;/:` -> False
  - Filter 2b: `N.N [Title] + preposition/conjunction` -> False
  - Filter 2c: `N.N [Title] + 30자+ trailing text` -> False
**결과:** is_heading 레벨에서 7개 제거

### Task 2 보완: _split_multi_clause_sections 인라인 참조 필터 (수정 완료)
**증상:** 위 7개가 `_split_multi_clause_sections()` 에서 auto_split 으로 재생성
**원인:** `_CLAUSE_BOUNDARY_PATTERN` 이 content 내 인라인 참조 줄도 분할 경계로 인식
**수정:** valid_matches 필터에 `_INLINE_REF_PATTERN` / `_INLINE_REF_CONTINUATION` 추가
**결과:** 0개 거짓 heading

### Task 3 (P1): 따옴표 시작 줄 필터 (수정 완료)
`is_heading()` 에 `t[0] in ('"', '\u201c', "'")` -> False 추가

### Task 4 (P1): 단일 번호 heading 패턴 추가 (수정 완료)
**증상:** "7 Equipment...", "18 Insurance", "20 Claims..." 가 heading으로 감지 안됨
**원인:** `STRUCT_HEADING_PATTERNS[0]` 가 `(\d+\.){1,}` 를 요구 -> 점 없는 번호 비매칭
**수정:** `STRUCT_HEADING_PATTERNS` 에 `r'^\s*\d{1,2}\s+[A-Z][a-z]'` 추가 (인덱스 5)
  - 80자 이하, 10단어 이하 제한으로 body text 오탐 방지
**결과:** 3개 parent heading (7, 8, 20) 복구 + 전체 parent headings (1-23) 감지

### Task 5 (P2): _split_multi_clause_sections 단일 번호 heading 지원 (수정 완료)
- heading 번호 regex `\d+(?:\.\d+)+` -> `\d+(?:\.\d+)*` (점 없는 번호도 매칭)
- `_is_sibling_or_child_clause()` 에 단일 번호 heading 자식 판별 로직 추가

### Task 6 (P2): Body continuation 필터 (수정 완료, 버그 수정 포함)
**수정:** `is_heading()` 에 bare 숫자 + 단위/전치사 패턴 필터 추가
**버그:** 최초 구현에서 `\b` 없이 "in", "for" 매칭 -> "18 Insurance", "19 Force" 오필터
**수정:** 모든 전치사에 `\b` word boundary 추가
**결과:** body text "14 days", "30 calendar" 필터링 + heading "18 Insurance" 보존

## v2 최종 결과 (Before -> After)
```
총 섹션:          528 -> 536 (+8)
번호 heading:     432 -> 441 (+9)
누락 조항 복구:   15개 (parent + child headings)
거짓 heading:     7 -> 0 (-7)
중복 조항:        22 -> 18 (-4, 해결: 7.6, 8.3, 9.3, 14.8, 20.3)
리그레션:         0
```

## 잔존 중복 조항 (18개)
5.1-5.8, 6.2-6.7: Particular Conditions (same number as General Conditions)
10.3, 11.7, 16.2, 20.1: 원인 미조사

## 수정 파일
- `scripts/docling_sidecar.py`:
  - `_is_parent_child_heading()` 신규 함수
  - `_merge_fragmented_headings()` parent-child 병합 방지
  - `is_heading()` FIDIC inline ref filter, quote filter, bare number pattern, body continuation filter
  - `_split_multi_clause_sections()` inline ref filter, single number support
  - `_is_sibling_or_child_clause()` single number heading support
