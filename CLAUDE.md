# Contract Risk Review - Claude Code 설정

## Claude Code 권한
이 프로젝트에서는 파일 읽기/수정/생성, 명령 실행, 검색을 자동 허용합니다.

---

## 프로젝트 개요
PDF/DOCX 계약서를 업로드하면 다음을 수행합니다.
1. 문서 구역 분류 (zone classification) — Docling sidecar 기반
2. 조항 단위 파싱
3. 리스크 분석 + FIDIC 비교 (Gemini API fallback 체인)

비용 원칙:
- 유료 LLM/SaaS/클라우드 플랜 사용 금지
- Vercel Hobby + Supabase Free + Gemini Free Tier 조합 사용

---

## 기술 스택
- Framework: Next.js 14.2.4 App Router + TypeScript strict
- UI: Tailwind CSS + shadcn/ui
- DB/Auth/Storage: Supabase (@supabase/supabase-js ^2.45.0, @supabase/ssr ^0.5.0)
- LLM: Gemini API (@google/generative-ai ^0.21.0), 모델 목록은 lib/gemini.ts MODEL_CONFIG 참조
- Client state: zustand ^4.5.0
- Parser: Docling sidecar (FastAPI, Python) — 필수 정책
- Test: vitest ^2.0.0

---

## 핵심 정책 (2026-03-11 기준)
- PDF/DOCX 파싱은 Docling sidecar를 필수로 사용
- fallback 파서(pdfjs-dist, mammoth, pdf-parse)는 비활성 상태
  - lib/pipeline/steps/extract-text.ts: extractText() / extractTextByPage() 모두 Error throw
- 업로드 전 sidecar `/health`를 최대 30초 대기 (1초 폴링) — auto-start 시 sidecar 기동 시간 고려
- parse 호출은 180초 timeout + 2회 재시도 (Windows Defender DLL 스캔 대비)
- 실패 시 API는 503 + 아래 코드 반환
  - `DOCLING_UNAVAILABLE` — sidecar 미응답 또는 502/503/504
  - `DOCLING_PARSE_FAILED` — 파싱 실패 또는 빈 섹션 반환

---

## 주요 파일

### 파싱 파이프라인
- `lib/docling-adapter.ts`
  - `parseWithDoclingRequired()` — health 체크 → 파싱 요청 → 재시도
  - `isDoclingAvailable()` — /health 5초 타임아웃 체크
  - Buffer → Uint8Array → Blob 변환 후 multipart form으로 전송
  - timeout: `DOCLING_PARSE_TIMEOUT_MS = 180_000`, 재시도: `DOCLING_PARSE_RETRIES = 2`
  - `DOCLING_READY_WAIT_MS = 30_000` — parse 전 sidecar 기동 대기 (auto-start 연동)
  - `getSidecarUrl()`: 환경변수 `DOCLING_SIDECAR_URL` (기본 http://127.0.0.1:8766)
- `lib/document-parser.ts`
  - `parsePdf()` / `parseDocx()` — 모두 Docling sidecar 경유
  - `DocumentParseError` (code: DoclingErrorCode)
  - 반환 타입 `ParseResult` = DoclingParseResult + `parser: "docling"`
- `lib/pipeline/process-contract.ts`
  - `processContract()` — validate → parsePdf/parseDocx → qualityCheck → DB 형식 변환
  - `parserUsed: "docling"` (항상 고정)
- `lib/pipeline/steps/extract-text.ts`
  - `extractText()` / `extractTextByPage()` — 비활성 (throw Error)

### 분석
- `lib/analysis/analyze-clause.ts`
  - `analyzeClause()` — 캐시 확인 → 긴 조항 요약 → FIDIC 후보 검색 → LLM 분석 → high risk 교차검증
- `lib/analysis/risk-analyzer.ts`
  - `analyzeClauseForDb()` — DB 저장 형식으로 변환
- `lib/analysis/fidic-candidates.ts`
  - embedding + vector search로 FIDIC 후보 3개 반환
- `lib/analysis/model-router.ts`
  - `MODEL_ROUTES`, `getModelKeyForTask()`

### LLM / Quota
- `lib/gemini.ts`
  - `MODEL_CONFIG` — 모델 키/ID 매핑 (여기만 정의, 하드코딩 금지)
  - `callGeminiJson()`, `callGemmaJson()`, `callGeminiJsonWithFallback()`
  - fallback 체인: analysis (flash25 우선), preprocessing (gemma 우선)
- `lib/quota-manager.ts`
  - `canCall()`, `recordCall()`, `waitForRateLimit()`, `getRemaining()`
  - 쿼터 리셋: 매일 17:00 KST
- `lib/gemini-key-store.ts` — Gemini API 키 저장/조회
- `lib/gemini-errors.ts` — `GeminiKeyInvalidError`
- `lib/cache.ts` — `analysisCache`, `contentHash()`

### Supabase / 설정
- `lib/supabase-config-store.ts`
  - Supabase URL + Service Role Key를 AES-256-GCM으로 암호화하여 `data/supabase-config.enc`에 저장
  - `getSupabaseConfig()`: env 우선, 없으면 로컬 파일
  - `ENCRYPTION_KEY` 필수 (32자 이상 또는 64자 hex; production에서 미설정 시 오류)
- `lib/supabase/admin.ts` — `getAdminSupabaseClientIfAvailable()`
- `lib/auth/server.ts` — `requireUserIdFromRequest()`

### API 라우트
- `app/api/contracts/route.ts`
  - POST: 파일 업로드, Docling 파싱, Supabase insert
  - Docling 실패 시 503 + 구조화 코드 응답
  - 처리 타임아웃: 300초
- `app/api/contracts/[id]/analyze/route.ts`
  - POST: 조항 분석 배치, 분석 간격 6초, 쿼터 소진 시 partial 저장
- `app/api/contracts/[id]/zones/route.ts` — PUT: zone 확정
- `app/api/contracts/[id]/status/route.ts`
- `app/api/settings/gemini-key/route.ts`
- `app/api/settings/supabase-config/route.ts`
- `app/api/settings/status/route.ts`
- `app/api/quota/route.ts`

### UI
- `app/upload/page.tsx` — 에러 코드별 사용자 메시지/재시도 안내
- `app/settings/page.tsx` — Gemini 키, Supabase 설정
- `components/contract/ZoneReviewView.tsx`
- `components/dashboard/UploadCard.tsx`, `QuotaDisplayWrapper.tsx`, `SupabaseConfigSetup.tsx`
- `components/upload/FileDropzone.tsx`
- `components/layout/AppShell.tsx`

### Sidecar 자동 시작 (신규, 2026-03-11)
- `instrumentation.ts` — Next.js 14 Instrumentation Hook
  - `npm run dev` 기동 시 서버 프로세스 시작 전에 한 번 실행
  - 조건: `NEXT_RUNTIME === "nodejs"`, `VERCEL !== "1"`, `DOCLING_AUTO_START !== "false"`
  - `lib/sidecar-manager.ts`의 `ensureSidecarRunning()`을 호출
  - 실패해도 Next.js 서버 기동은 계속 진행 (non-fatal)
- `lib/sidecar-manager.ts` — Docling sidecar 프로세스 라이프사이클 관리
  - HMR 안전 singleton: `Symbol.for("docling.sidecarManager")` via `globalThis`
  - `process.cwd()`로 프로젝트 루트 해석 (주의: `__dirname` 사용 금지 — Next.js build 컨텍스트에서 `.next/server/`를 가리킴)
  - `.venv/Scripts/python.exe` (Windows) 또는 `.venv/bin/python` (Unix) 순으로 해석
  - SIGINT/SIGTERM/exit 훅으로 graceful shutdown (SIGKILL fallback 3초)
  - 기동 완료까지 최대 60초 대기 (`HEALTH_POLL_TIMEOUT_MS`)
  - sidecar 스크립트 미존재 시 warning만 출력 후 계속 진행
- `next.config.mjs` — `experimental.instrumentationHook: true` 활성화 필수

### Docling sidecar
- `scripts/docling_sidecar.py` — FastAPI 서버 v1.2.0
  - 포트: `DOCLING_SIDECAR_PORT` 환경변수 (기본 8766)
  - Lazy import: DOCLING_PRELOAD_MODEL=true(기본) / false(lazy)
  - /health: 즉시 응답 (status, docling_imported, models_ready)
  - /parse: PDF/DOCX → sections[] JSON
- `scripts/start_sidecar.bat`
  - SIDECAR_PORT=8766으로 포트 충돌 체크
  - venv 경로: `%~dp0..\.venv` (루트 .venv = D:\coding\contract risk\.venv)
  - Python 미전달 주의: DOCLING_SIDECAR_PORT 환경변수를 명시 설정해야 포트 일치
- `run.bat` — 전체 스택 기동 (Docker 컨테이너 우선 → Python venv fallback)
  - run.bat에서 8766 포트로 health 체크 수행

---

## 환경 변수 (`.env.local`)

```env
# Supabase (필수 또는 UI 설정으로 대체 가능)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Gemini (UI에서 입력 가능; ENCRYPTION_KEY가 있으면 암호화 저장됨)
GEMINI_API_KEY=your-gemini-api-key

# 암호화 키 — production에서는 32자 이상 필수, 64자 hex도 가능
# ENCRYPTION_KEY=your-32-byte-or-longer-secret-key

# Admin API 토큰 — /api/settings/* POST 엔드포인트 보호
# ADMIN_API_TOKEN=replace-with-a-long-random-secret

# Docling sidecar (필수)
DOCLING_SIDECAR_URL=http://127.0.0.1:8766
DOCLING_REQUIRED=true

# Sidecar 자동 시작 제어 (선택)
# "false"로 설정하면 instrumentation.ts가 sidecar를 자동 기동하지 않음
# → 수동으로 scripts\start_sidecar.bat 실행 필요
# DOCLING_AUTO_START=false
```

**포트 설정 주의:**
- `.env.local`의 `DOCLING_SIDECAR_URL`을 8766으로 설정하면, sidecar 실행 시에도
  `DOCLING_SIDECAR_PORT=8766` 환경변수를 함께 지정해야 합니다.
- `start_sidecar.bat`은 포트 충돌 체크만 8766으로 수행하며, Python 프로세스에
  `DOCLING_SIDECAR_PORT` 환경변수를 자동 전달하지 않습니다.

---

## 실행

```bash
# 방법 1: npm run dev (권장 — sidecar 자동 시작 포함)
# instrumentation.ts가 서버 기동 시 sidecar를 자동으로 spawn
npm run dev

# 방법 2: run.bat (Windows 전체 스택 기동)
# Docker 확인 → Supabase 기동 → sidecar 자동 시작 모드로 npm run dev 실행
run.bat

# Docling sidecar만 별도 실행 (DOCLING_AUTO_START=false 시 필요)
scripts\start_sidecar.bat

# 빌드
npm run build

# 테스트
npm test
npm run test:watch
```

---

## DB 마이그레이션

Supabase 대시보드 또는 CLI에서 순서대로 실행:
1. `supabase/migrations/001_init_core_tables.sql`
2. `supabase/migrations/002_rls_policies.sql`
3. `supabase/migrations/003_app_settings.sql`

스키마 미적용 시 contracts insert에서 `SUPABASE_SCHEMA_MISSING` 오류 반환.

---

## 아키텍처 제약 (Claude Code 작업 시 반드시 준수)

1. **Docling sidecar 필수** — fallback 파서(pdfjs, mammoth, pdf-parse) 활성화 금지
2. **비용 제로** — 유료 LLM, SaaS, 클라우드 플랜 추가 금지
3. **TypeScript strict** — any 타입, strict 우회 금지
4. **MODEL_CONFIG는 lib/gemini.ts에만** — 모델 ID 하드코딩 금지
5. **모든 Gemini 호출 전 canCall() 확인** — quota-manager 우회 금지
