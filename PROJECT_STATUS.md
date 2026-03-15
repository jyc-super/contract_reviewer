# PROJECT_STATUS.md
**프로젝트**: Contract Risk Review
**최종 업데이트**: 2026-03-12
**기준 커밋**: 51f6240 (pdfplumber 파이프라인 통합)

---

## 완료된 작업

### M1: MVP (완료)

**파싱 파이프라인**
- Docling sidecar (FastAPI, Python) 기반 PDF/DOCX 파싱 구현 완료
- `scripts/docling_sidecar.py` v1.3.0 — pdfplumber 우선 + Docling TextOnlyPdfPipeline fallback 이중 구조
  - PDF: pdfplumber 기반 네이티브 텍스트/표 추출 (래스터라이즈 없음, bad_alloc 구조적 불가)
    - 226페이지 EPC Contract: 751 sections, 52초, 에러 없음 (실측 검증 완료)
  - PDF fallback: Docling `TextOnlyPdfPipeline` (DocLayNet/OCR/래스터라이즈 모두 비활성)
  - DOCX: Docling 경로 유지
  - 배치 처리: 대용량 PDF를 20페이지 단위로 분할 (pdfplumber는 배치 없이 스트리밍)
- `lib/docling-adapter.ts`: health 체크(30초 대기) + parse(300초 timeout + 2회 재시도) + 에러 코드 구조화
- `lib/document-parser.ts`: `parsePdf()` / `parseDocx()` — Docling sidecar 경유, `parser: "docling"` 고정
- `lib/pipeline/process-contract.ts`: validate → parse → qualityCheck → DB 형식 변환 파이프라인

**LLM / 분석**
- `lib/gemini.ts`: `MODEL_CONFIG` 중앙화, `callGeminiJsonWithFallback()` fallback 체인 구현
  - Analysis 체인: flash25 → flash25Lite → gemma27b → gemma12b → gemma4b
  - Preprocessing 체인: gemma27b → gemma12b → gemma4b → flash25 → flash25Lite
- `lib/quota-manager.ts`: RPD/RPM 한도 기반 쿼터 관리, 17:00 KST 리셋
- `lib/analysis/analyze-clause.ts`: 캐시 확인 → 긴 조항 요약 → FIDIC 후보 검색 → LLM 분석 → high risk 교차검증
- `lib/analysis/fidic-candidates.ts`: embedding 유사도 기반 FIDIC 후보 3개 반환 (실패 시 규칙 기반 fallback)

**인프라 / 설정**
- Supabase 연동: contracts / document_zones / clauses / clause_analyses 테이블 insert/query
- `app/api/contracts/route.ts`: Path A (Supabase 있음, 202 비동기) / Path B (Supabase 없음, 동기) 분기
  - 비동기 parse+persist 백그라운드 처리 (fire-and-forget, 500ms 이내 응답)
  - `status/route.ts` 폴링으로 파싱 완료 감지
- `lib/supabase-config-store.ts`: AES-256-GCM 암호화, `data/supabase-config.enc` 저장
- UI: 업로드 페이지, 조항 상세, Zone 리뷰, 설정 페이지, FIDIC 리포트 페이지 구현 완료

**Sidecar 자동 시작**
- `instrumentation.ts` (Next.js 14 Instrumentation Hook): `npm run dev` 기동 시 sidecar 자동 spawn
- `lib/sidecar-manager.ts`: HMR-safe singleton, `process.cwd()` 기반 경로 해석, graceful shutdown
- `run.bat`: Docker/Python venv 자동 감지, Supabase 기동, 포트 3000 정리 후 dev 서버 실행

**테스트**
- `lib/docling-adapter.test.ts`: 8개 단위 테스트 (health/parse/retry/Buffer변환)
- `lib/document-parser.test.ts`: 7개 단위 테스트
- `lib/quota-manager.test.ts`: 7개 단위 테스트
- 전체 22/22 PASS (2026-03-12 확인)

---

## 현재 알려진 문제점

### [HIGH] Vercel 배포 시 파싱 불가
`app/api/contracts/route.ts` 주석(28번째 줄)에 명시:
> "On Vercel Hobby the platform caps functions at 60s regardless; the background work will be killed with the function."

pdfplumber 기반으로 속도가 크게 개선되었으나 226페이지 52초라도 Vercel 60초 제한에 걸릴 수 있음. Docling fallback 진입 시 더욱 위험. 현재 로컬 개발 전용.

### [HIGH] Vercel에서 Docling sidecar 실행 불가
`instrumentation.ts`가 `VERCEL === "1"` 조건으로 auto-start를 명시 차단함. 클라우드 배포 경로 없음.

### [MEDIUM] E2E 통합 테스트 부재
Supabase 포함 전체 업로드→파싱→DB저장 플로우 미검증. Path A(202 비동기)의 `persistParseResult()` 함수는 단위 테스트가 없음. 2026-03-12 DIAGNOSTIC_REPORT에서 로컬 Supabase Kong timeout으로 Path A 블록 확인.

### [MEDIUM] zone-to-clause 인덱스 매핑 취약
`process-contract.ts` 102번째 줄:
```typescript
const zIdx = zoneKeyToIndex.get(parsed.clause_number.split("-")[0] + "_1") ?? 0;
```
clause_number 접두어로 zone을 역추적하는 방식으로, `auto-` 접두어 조항이나 다중 존 케이스에서 모든 조항이 zoneIndex=0으로 폴백될 수 있음. 또한 `qc.clauses.length !== rawClauses.length` 불일치 시 zoneIndex 오할당 경고가 있으나 수정하지 않고 진행.

### [MEDIUM] FIDIC 후보 데이터 빈약
`lib/analysis/fidic-candidates.ts`의 `FIDIC_REFERENCE_CLAUSES`가 5개 조항(8.7, 14.1, 17.1, 4.1, 20.1)만 포함. 실제 FIDIC Red Book 2017은 200여 개 조항. embedding 검색이지만 후보 모집단 자체가 작아 비교 품질 낮음.

### [MEDIUM] quota-manager 상태가 인메모리 휘발
`lib/quota-manager.ts`의 `state`가 Node.js 프로세스 메모리에만 존재. 서버 재시작(HMR 포함) 시 카운터 리셋. 쿼터 소진 후 재시작하면 실제 API 한도 초과 가능.

### [LOW] start_sidecar.bat 포트 미전달
`scripts/start_sidecar.bat`이 Python 프로세스에 `DOCLING_SIDECAR_PORT` 환경변수를 전달하지 않음. 해당 파일을 직접 실행하면 기본 포트(8766)로만 동작. `sidecar-manager.ts`(auto-start)는 명시 전달하여 해소됨. CLAUDE.md에 주의 사항 명시됨.

### [LOW] DOCLING_PARSE_TIMEOUT_MS 주석과 코드 불일치
`lib/docling-adapter.ts` 47~50번째 줄 주석에 "300s: 180s baseline"으로 설명하나 `DOCLING_PARSE_TIMEOUT_MS = 300_000` (5분)으로 설정됨. CLAUDE.md에는 "180초 timeout"으로 기재. 코드가 정확하나 문서 혼동 가능.

### [LOW] RiskChart UI 전용, 데이터 연결 미완성
`components/dashboard/RiskChart.tsx`가 구현되어 있으나 대시보드/리포트 페이지에서 실제 분석 결과를 집계하여 `high/medium/low/info` 값을 전달하는 로직이 없음. 현재 리포트 페이지(`/contracts/[id]/report`)는 테이블 뷰만 제공.

### [LOW] 분석 진행 UI가 동기식
`ContractDetailView.tsx`의 분석 실행이 단일 POST 요청 완료까지 버튼 비활성화만 함. 100+ 조항의 경우 6초 간격 배치로 수분 소요 — 실시간 진행 표시 없음 (M3 실시간 진행 기능 미구현).

---

## 다음 우선순위 작업

### 1순위: M2 완료 (현재 마일스톤)

**[M2-1] FIDIC 조항 매핑 개선** (가장 낮은 비용, 높은 효과)
- `lib/analysis/fidic-candidates.ts`의 `FIDIC_REFERENCE_CLAUSES` 확장
- FIDIC Red Book 2017 핵심 조항 20~50개 수준으로 보강
- 조항 텍스트를 전문으로 채워 embedding 품질 개선

**[M2-2] 리스크 레벨 시각화 개선**
- `RiskChart` 컴포넌트를 계약 상세 페이지 또는 리포트 페이지에 실제 데이터로 연결
- `clause_analyses` 테이블에서 `risk_level` 집계 로직 추가
- High/Medium/Low/Info 배지가 조항 목록에 일관되게 표시되는지 확인

**[M2-3] 비교 리포트 PDF 내보내기**
- `/contracts/[id]/report` 페이지에 PDF export 버튼 추가
- 비용 제로 제약 → 브라우저 `window.print()` 또는 `@react-pdf/renderer` (MIT) 활용
- 유료 PDF API 사용 금지

**[M2-4] 조항별 상세 설명 생성**
- `analyzeClause()` 출력에 `detailedExplanation` 필드 추가
- `ClauseAnalysisPanel.tsx`에 확장 가능한 상세 설명 섹션 추가

### 2순위: 기술 부채 해소

**[DEBT-1] zone-to-clause 인덱스 매핑 수정**
- `process-contract.ts`의 clause_number 기반 역추적 로직 개선
- `rawClauses[i]`와 `qc.clauses[i]` 1:1 대응이 깨지는 케이스 처리

**[DEBT-2] quota-manager 영속성**
- 파일 또는 Supabase `app_settings` 테이블에 카운터 저장
- 서버 재시작 시 쿼터 상태 복원

**[DEBT-3] FIDIC 후보 캐시 개선**
- `cachedRefEmbeddings`가 인메모리 모듈 변수 — 서버 재시작 시 초기화
- `analysisCache` / `embeddingCache`도 동일 문제

### 2.5순위: UI/UX 개선 (M2 병행 진행 가능)

> 상세 계획: `docs/ui-improvement-plan.md` 참조 (2026-03-14 작성, 섹션 6~8 포함)

**[P0] Quick Win — 총 ~65분, M2와 병행 가능**

| ID | 파일 | 작업 | 상태 |
|----|------|------|------|
| QW-1 | `FileDropzone.tsx` + `globals.css` | 드래그 중 시각 피드백 (`isDragging` 상태 + `.upload-zone--dragging` CSS) | 미완료 |
| QW-2 | `upload/page.tsx` + `UploadProgressPanel.tsx` | 에러 메시지 한국어 통일, 내부 경로 제거 | 미완료 |
| QW-3 | `UploadProgressPanel.tsx` | `<a>` → `<Link>` 교체 (L505, L565), `import Link` 추가 | 미완료 |
| QW-4 | `upload/page.tsx` | 헤더 QuotaDisplayWrapper 제거 (skeleton + 메인 두 블록) | 미완료 |
| QW-5 | `RecentContracts.tsx` | `<tr onClick>` + `useRouter` 추가, `e.stopPropagation()` 처리 | 미완료 |
| QW-6 | `globals.css` | `.nav-item:focus-visible` focus ring 추가 | 미완료 |
| QW-7 | `UploadProgressPanel.tsx` | 완료 후 "총 소요:" prefix 추가 (QW-3과 동일 PR 권장) | 미완료 |

**[P1] Medium Effort — M2 완료 후 착수 권장**
- ME-1: `ZoneReviewView.tsx` — 미결정 항목 카운트 + 가이드 메시지
- ME-2: `ZoneReviewList.tsx` — confidence 색상 코딩
- ME-3: `ContractDetailView.tsx` — 필터 바 레이아웃 고정
- ME-4: `UploadProgressPanel.tsx` — 인라인 스타일 → Tailwind 전환
- ME-5: `AppShell.tsx` — lucide-react 아이콘 전환

**[P2] 큰 리팩터링 — M2 완료 후 M3 범위로 진행**
- LR-1: 모바일 반응형 사이드바 (4~6시간)
- LR-2: 계약 목록 페이지네이션 (`getContractList()` offset/limit/sort 파라미터 추가, 2~3시간)
- LR-3: 분석 중 계약 실시간 상태 갱신 (Client Component 래핑 + `router.refresh()` 폴링, 3~4시간)

**백엔드 변경 필요 항목:**
- LR-2: `lib/data/contracts.ts` `getContractList()` 시그니처 변경 + `app/contracts/page.tsx` searchParams 연결
- LR-3: 신규 API 불필요 (옵션 C: `router.refresh()` 방식 선택 시)
- 나머지 모든 P0/P1 항목: 백엔드 변경 없음

### 3순위: M3 예정 기능

- 대시보드 (계약 목록/이력)
- 실시간 분석 진행 표시 (SSE 또는 폴링 강화)
- 결과 공유 링크
- 모바일 반응형 최적화 (LR-1과 연계)

---

## 아키텍처 제약 (반드시 유지)

| 정책 | 내용 |
|------|------|
| **Docling sidecar 필수** | PDF/DOCX 파싱은 반드시 `scripts/docling_sidecar.py` 경유. pdfjs-dist, mammoth, pdf-parse 활성화 금지. `lib/pipeline/steps/extract-text.ts`의 `extractText()`는 Error throw 상태 유지. |
| **비용 제로** | Vercel Hobby + Supabase Free + Gemini Free Tier 조합만 허용. 유료 LLM, SaaS, PDF 변환 API 추가 금지. |
| **TypeScript strict** | `any` 타입, `strict` 우회 금지. |
| **MODEL_CONFIG 중앙화** | 모델 ID는 `lib/gemini.ts`의 `MODEL_CONFIG`에만 정의. 파일 내 하드코딩 금지. |
| **quota-manager 우회 금지** | 모든 Gemini 호출 전 `canCall()` 확인 필수. |
| **포트 8766** | Docling sidecar 기본 포트. `.env.local`, `start_sidecar.bat`, `docker-compose.docling.yml` 모두 8766. |
| **process.cwd() 사용** | `sidecar-manager.ts` 내 경로 해석은 `process.cwd()` 사용. `__dirname` 사용 금지 (Next.js build 컨텍스트에서 `.next/server/` 가리킴). |
| **절대 경로 사용 금지** | 설정/문서/에이전트 파일에서 절대 경로 대신 상대 경로 또는 `{프로젝트 루트}` 표기 사용. 이식성 보장. |
| **환경별 설정 자동 감지** | `scripts/ensure-local-env.js`가 WSL2 Docker Desktop IP 자동 감지. 수동 IP 하드코딩 금지. |

---

## 기술 부채 목록

| ID | 내용 | 심각도 |
|----|------|--------|
| TD-1 | Docling sidecar 로컬 의존성 — 클라우드 배포 전 컨테이너화 필요 (Dockerfile.docling 존재) | Medium |
| TD-2 | ENCRYPTION_KEY 관리 개선 필요 (현재 .env.local 기반, rotation 불가) | Medium |
| TD-3 | 테스트 커버리지 낮음 — 3개 파일만 단위 테스트 존재, E2E 통합 테스트 부재 | Medium |
| TD-4 | start_sidecar.bat이 DOCLING_SIDECAR_PORT 미전달 (직접 실행 시만 해당, auto-start는 해소) | Low |
| TD-5 | sidecar-manager.ts 통합 테스트 없음 | Low |
| TD-6 | quota-manager 카운터 인메모리 휘발 — 서버 재시작 시 실제 API 한도 초과 가능 | Medium |
| TD-7 | FIDIC 후보 모집단 5개 조항으로 빈약 — 비교 품질 낮음 | Medium |
| TD-8 | zone-to-clause 인덱스 매핑이 clause_number 역추적 방식 — auto-split 조항에서 오할당 위험 | Medium |

---

## 환경 구성 요약

```
파이썬 venv:   .venv  (프로젝트 루트)
sidecar 포트:  8766
Next.js 포트:  3000
Supabase 포트: 54321 (로컬 Docker)
설정 파일:     .env.local
암호화 저장:   data/supabase-config.enc
```

**Supabase URL 자동 감지 (2026-03-13 추가)**
- `scripts/ensure-local-env.js`가 매 실행 시 WSL2 Docker Desktop IP를 자동 감지
- Windows Docker Desktop WSL2 백엔드 환경에서 `127.0.0.1` 대신 WSL2 eth0 IP로 `.env.local`의 `NEXT_PUBLIC_SUPABASE_URL`을 자동 갱신
- WSL2가 아닌 환경에서는 기본값 `127.0.0.1` 유지
- 수동 IP 하드코딩 금지 (아키텍처 제약 #7)

**경로 정책 (2026-03-13 추가)**
- 프로젝트 내 모든 설정/문서/에이전트 파일에서 절대 경로 사용 금지
- `.venv`, `.claude/agent-memory/...` 등 상대 경로 또는 `{프로젝트 루트}` 표기 사용
- `scripts/ensure-local-env.js`, `.claude/agents/*.md`, `CLAUDE.md` 등 모두 적용 완료

**실행 방법 (권장 순서)**
1. `npm run dev` — instrumentation.ts가 sidecar 자동 기동, ensure-local-env.js가 WSL2 IP 자동 감지
2. `run.bat` — Docker Supabase 포함 전체 스택 기동
3. `scripts\start_sidecar.bat` — sidecar 수동 기동 (DOCLING_AUTO_START=false 시)
