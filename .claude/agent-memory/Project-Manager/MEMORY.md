# Project Manager - Persistent Memory

## 메모리 파일 인덱스
- [feedback_no_absolute_paths.md](feedback_no_absolute_paths.md) — 절대 경로 사용 금지 정책 (CLAUDE.md 제약 #6)
- [project_wsl2_auto_detect.md](project_wsl2_auto_detect.md) — WSL2 Docker Desktop IP 자동 감지 (CLAUDE.md 제약 #7)
- [project_xref_execution_plan.md](project_xref_execution_plan.md) — 교차참조 실행 계획 Section 11 (2026-03-15)

## 프로젝트 핵심 정책 (CLAUDE.md 기준, 우선순위 최상위)
- PDF/DOCX 파싱: Docling sidecar 필수. fallback 파서 승인 금지.
- 포트: 8766 (start_sidecar.bat, docker-compose.docling.yml, .env.example 모두 8766)
- venv 위치: .venv (프로젝트 루트. scripts\.venv는 비어있음)
- 비용 원칙: Vercel Hobby + Supabase Free + Gemini Free Tier만 허용
- 절대 경로 금지: 모든 설정/문서/에이전트 파일에서 상대 경로 또는 {프로젝트 루트} 표기 사용 (2026-03-13 적용)
- 환경 자동 감지: scripts/ensure-local-env.js가 WSL2 Docker Desktop IP 자동 감지 → .env.local 갱신. 수동 IP 하드코딩 금지 (2026-03-13 적용)

## 아키텍처 정합성 (2026-03-11 문서 전면 재동기화 완료)
- master.md(v5.1)와 CLAUDE.md 모두 실제 코드 기준으로 업데이트됨
- 구버전 내용(Gemini 네이티브 PDF, mammoth) 완전 제거
- 포트 불일치 이슈: start_sidecar.bat이 DOCLING_SIDECAR_PORT를 Python에 미전달
  → sidecar-manager.ts (auto-start)는 명시 전달하여 해소; start_sidecar.bat 직접 실행 시는 여전히 수동 필요

## Sidecar 자동 시작 아키텍처 (2026-03-11 신규)
- 진입점: instrumentation.ts (Next.js 14 Instrumentation Hook)
- 구현: lib/sidecar-manager.ts
- 핵심 설계 결정:
  - 프로젝트 루트: process.cwd() 사용. __dirname 사용 금지 (Next.js build 시 .next/server/ 가리킴)
  - HMR-safe singleton: Symbol.for("docling.sidecarManager") via globalThis
  - spawn 시 DOCLING_PRELOAD_MODEL=true (preload mode — 첫 parse 지연 방지)
  - 실패 시 non-fatal: Next.js 서버는 계속 기동
- 실행 우선순위: npm run dev (auto-start) > run.bat > start_sidecar.bat (수동)
- docling-adapter.ts 타임아웃: parse 300초 (배치 처리 대응), health wait 30초

## Docling Sidecar 이슈 기록 (2026-03-10 qa-debugger 세션)
- 근본 원인: `from transformers import StoppingCriteria` (pipeline_options.py 내)
  → Windows Defender가 PyTorch DLL 수백 개 스캔 → 첫 실행 시 10분~수 시간 hang
  → 첫 실행 후 DLL 캐시 완료되면 이후 정상 동작
- 권장 해결책 (우선순위):
  A) Windows Defender 제외 추가: {프로젝트 루트}\.venv 폴더
  B) 첫 실행 후 대기 (30분~수 시간)
  C) Docker 사용: docker-compose -f docker-compose.docling.yml up

## 주요 파일 위치
- instrumentation.ts: sidecar 자동 시작 진입점 (Next.js 14 Hook)
- lib/sidecar-manager.ts: sidecar 프로세스 라이프사이클 (HMR-safe singleton)
- lib/docling-adapter.ts: parseWithDoclingRequired(), 헬스체크, 재시도 로직
- lib/document-parser.ts: parsePdf(), parseDocx() — Docling 기반
- lib/pipeline/process-contract.ts: 파이프라인 오케스트레이터 (parserUsed: "docling")
- scripts/docling_sidecar.py: FastAPI 서버, HF_HUB_OFFLINE 조건부 설정
- scripts/start_sidecar.bat: venv=%~dp0..\.venv (루트 .venv 참조)
- next.config.mjs: experimental.instrumentationHook: true 필수 설정

## 기술 부채 목록 (2026-03-14 조항 분리 이슈 분석 후 최신)
1. Docling sidecar 로컬 의존성 → 클라우드 배포 전 컨테이너화 필요 (Dockerfile.docling 존재)
2. ENCRYPTION_KEY 관리 개선 필요 (현재 .env.local 기반)
3. 테스트 커버리지 낮음 (docling-adapter.test.ts, document-parser.test.ts, quota-manager.test.ts만 존재)
4. start_sidecar.bat이 DOCLING_SIDECAR_PORT를 Python 프로세스에 미전달 (직접 실행 시만 해당)
5. sidecar-manager.ts에 대한 통합 테스트 없음 (sidecar.test.ts 부재)
6. E2E 통합 테스트 부재 — Supabase 포함 전체 업로드→파싱→DB저장 플로우 미검증
7. quota-manager 카운터 인메모리 휘발 — 서버 재시작 시 실제 API 한도 초과 가능
8. FIDIC 후보 모집단 5개 조항으로 빈약 (Red Book 2017 기준 200여 개) — 비교 품질 낮음
9. zone-to-clause 인덱스 매핑 취약 — clause_number 역추적 방식, auto-split 조항 오할당 위험
10. sectionsToClauses()가 섹션 1:1 clause 매핑 — content 내 복수 조항 미분리 (2026-03-14 신규)
11. _DEEP_NUMERIC_PATTERN이 4단계 이상만 보호 — 3단계(1.1.1) 누락 (2026-03-14 신규)
12. _merge_fragmented_headings()에 연번 조항 예외 없음 — 연속 정의 조항 연쇄 병합 가능 (2026-03-14 신규)

## 파싱 품질 이슈 (2026-03-14 신규 접수)
- 이슈 A: 중첩 조항 번호 분리 실패 (1.1.1.1/1.1.1.2 등) — is_heading() 오인식 또는 Phase 3.5 병합
  - 근본 원인: TD-10(sectionsToClauses 1:1 매핑), TD-11(_DEEP_NUMERIC 보호 범위), TD-12(병합 로직)
- 이슈 B: 물리 섹션과 논리 조항 번호 불일치 — pdfplumber 섹션 경계 누락
  - 근본 원인: is_heading()에서 조항 번호 줄 미인식 + TypeScript 재분할 로직 없음
- 해결 계획: docs/parsing-quality-improvement-plan.md 섹션 0~7 참조
  - Task 1,4 (P0): sidecar is_heading() 강화 + _DEEP_NUMERIC_PATTERN 3단계로 확대
  - Task 2 (P0): sidecar content 내 다중 조항 재분할 함수 신규 추가
  - Task 5 (P1): _merge_fragmented_headings 연번 예외
  - Task 3 (P1): TypeScript sectionsToClauses() 재분할
  - Task 6 (P2): content 첫줄 번호 fallback

## docling_sidecar.py 알려진 API 호환성 패턴 (2026-03-12 확정)
- TableItem.export_to_markdown(): doc 인수 전달 필수(2.x). TypeError시 인수 없이 retry. [수정 완료]
- doc.num_pages: 버전에 따라 프로퍼티 또는 메서드. callable() 체크로 이중 처리. [수정 완료]
- iterate_items() 실패 시: 부분 결과 전체 폐기 후 export_to_markdown() fallback. [수정 완료]
- FastAPI lifespan: @app.on_event("startup") → @asynccontextmanager lifespan 사용. [수정 완료]
- 배치 처리: 각 배치 result에도 _check_result_status 호출 필수. [수정 완료]

## M1 재검증 이슈 (2026-03-12 test-runner 보고)
- M1이 "완료"로 표시되어 있으나 Supabase 없이 실제 업로드 미검증 상태
- test-runner 테스트: Unit 22개 PASS, Next.js 3000 PASS, Sidecar 8766 PASS
- 블로커: Docker Desktop 미실행 → Supabase 로컬 인스턴스(54321) ECONNREFUSED
- 판정: 개발 환경 문제 (코드 버그 아님)
  - 근거: contracts/route.ts가 Supabase 없음 감지 시 Path B(동기 파싱)로 자동 폴백
  - Path B는 Supabase 없이도 파싱 결과를 JSON으로 반환함 (DB 저장만 생략)
  - Path A(DB 저장)는 Supabase가 올려져 있어야 테스트 가능
- M1 상태: "완료(조건부)" — Path B 파싱은 검증됨, Path A(DB 저장 전체 플로우)는 미검증
- 신규 기술 부채 #6: E2E 통합 테스트 부재 — Supabase 포함 전체 업로드 플로우 미검증

## pdfplumber 통합 (2026-03-12 커밋 51f6240)
- docling_sidecar.py v1.3.0: pdfplumber 우선 + Docling TextOnlyPdfPipeline fallback 이중 구조
- 실측: 226페이지 EPC Contract → 751 sections, 52초, 에러 없음
- scripts/requirements-docling.txt에 pdfplumber>=0.11.0 추가됨
- DOCLING_PARSE_TIMEOUT_MS: 300_000ms (5분, 배치 처리 대응) — CLAUDE.md의 "180초"는 구버전 기재
- Vercel 60초 제한 충돌 위험 여전함 (로컬 전용)

## M2 진행 상태 (2026-03-14 기준)
- [ ] FIDIC 조항 매핑 개선 (1순위: FIDIC_REFERENCE_CLAUSES 5개 → 20~50개 확장)
- [ ] 리스크 레벨 시각화 (RiskChart 컴포넌트 존재하나 데이터 연결 미완)
- [ ] 조항별 상세 설명 생성 (analyzeClause 출력 확장)
- [ ] 비교 리포트 PDF 내보내기 (window.print 또는 @react-pdf/renderer)
- Sidecar 자동 시작 기능(instrumentation.ts + sidecar-manager.ts) 구현 완료

## 파싱 품질 개선 구현 현황 (2026-03-14)
- P0/P1 Python 작업(1A~1D): 완료 (zone 패턴, 헤더/푸터 감지, document_boundaries 등)
- P1 DB/백엔드 작업: 2026-03-14 완료
  - 006_add_document_parts_hfi.sql: document_parts, header_footer_info, toc_entries 컬럼 추가
  - process-contract.ts: ProcessContractResult에 documentParts, headerFooterInfo 추가
  - contracts/route.ts: persistParseResult UPDATE에 두 컬럼 추가
  - zones/route.ts: contracts select 확장, zones에 page_from/page_to, uncertainZones에 pageFrom/pageTo 매핑
- P2 TOC(2A/2B/2C): 2026-03-14 완료
  - docling_sidecar.py: TocEntry dataclass, _detect_toc_pages(), _parse_toc_entries(), _validate_structure_against_toc()
  - /parse 응답에 toc_entries 필드 추가
- P2 UI (TocPreviewPanel): 미완료 — toc_entries DB 저장 로직 미구현 (zones/route.ts가 toc_entries 미반환)
- P3 (zoneKey, ContractDetailView 필터): 미완료

## Skill 툴 에이전트 호출 이슈 (2026-03-14 확인)
- Skill 툴이 현재 환경에서 Unknown skill 에러 반환 (파일명/name 필드 모두 시도)
- 대안: PM이 직접 에이전트 역할 수행

## UI/UX 개선 계획 현황 (2026-03-14 작성)
- 상세 계획: docs/ui-improvement-plan.md (섹션 1~8, 2026-03-14 완성)
- P0 Quick Win 7개 (QW-1~7): 총 65분, 백엔드 변경 없음, M2 병행 가능
- P1 Medium Effort 5개 (ME-1~5): M2 완료 후 착수
- P2 큰 리팩터링 3개 (LR-1~3): M3 범위
- 백엔드 변경 필요 항목: LR-2(getContractList offset/sort 파라미터), LR-3(선택적, router.refresh 방식 선택 시 불필요)
- QW-1 dragLeave 버블링 주의: 자식 요소 pointerEvents:none으로 실제 발생 가능성 낮음 — 실행 확인 필요
- QW-3/QW-7은 같은 파일(UploadProgressPanel.tsx) — 동일 PR 묶음 권장
- QW-5(행 클릭): e.stopPropagation() 처리 + <Link>와 <tr onClick> 이중 내비게이션 방지 필요

## 플로우 버그 및 리스크 (2026-03-12 코드 리뷰)
- [버그] upload/page.tsx: liveStatus==="error"일 때 "파싱이 완료되었습니다" 링크 표시 — 에러를 정상으로 오해
  - 위치: upload/page.tsx 303~327행, 조건 `liveStatus !== "parsing" && liveStatus !== "uploading"` 에서 "error" 미제외
- [버그] ZoneReviewView.tsx 건너뛰기 버튼: zones PUT 미호출 + analyze 미트리거 → DB status "filtering" 고착
  - 위치: ZoneReviewView.tsx 119행, Link 컴포넌트로 단순 이동
- [설계 이슈] analyze fire-and-forget: ZoneReviewView에서 analyze 호출 후 즉시 router.push → 진행 상태 불투명
  - analyze API 자체가 동기 블로킹 (742조항 × 6초 = 74분+) → 클라이언트가 연결 끊음
  - 상세 페이지에 analyzing 상태 폴링 없음 — router.refresh()로 수동 새로고침만 가능
- [설계 이슈] zone text 필드 항상 공백: process-contract.ts 73행 `text: z.title ?? ""` — zone review에서 내용 미표시
- [알려진 제약] analyze/route.ts 6초 하드코딩 대기 (97~99행) + quota-manager MIN_INTERVAL 중복 — 대형 문서 시 충돌 위험
