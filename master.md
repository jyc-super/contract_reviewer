# master.md — Contract Risk Review Web App
최종 업데이트: v5.1 (2026-03-11, sidecar 자동 시작 기능 반영)

## 목표
PDF/DOCX 건설/EPC 계약서를 업로드하면
1) 문서 구역 분류 (zone classification)
2) 조항 단위 파싱
3) 각 조항에 대해 "리스크 분석 + FIDIC 비교 편차"를 제공하는 웹앱

---

## 비용/모델 정책 (비과금 원칙)
- 모든 인프라와 모델은 무료 티어 또는 자체 호스팅만 사용한다.
- 유료 LLM 및 유료 클라우드/SaaS 서비스는 사용하지 않는다.
- 인프라 조합: Vercel Hobby + Supabase Free + Gemini Free Tier
- **문서 파서: Docling sidecar 필수 (PDF/DOCX 모두). fallback 파서 없음.**

---

## 기술 스택 (package.json 기준)
- Framework: Next.js 14.2.4 App Router + TypeScript strict
- UI: Tailwind CSS + shadcn/ui
- DB/Auth/Storage: Supabase (Postgres + Storage, @supabase/supabase-js ^2.45.0, @supabase/ssr ^0.5.0)
- LLM: Gemini API (@google/generative-ai ^0.21.0)
- Client state: zustand ^4.5.0
- 문서 파서: Docling sidecar (FastAPI + Python, 포트 8766) — PDF/DOCX 모두 동일 경로
- optionalDependencies: franc(언어 감지), mammoth(미사용), pdf-parse(미사용)
  - mammoth, pdf-parse는 package.json에 optional로 남아 있으나 실제 코드에서 비활성 상태
- 테스트: vitest ^2.0.0

---

## 개발 원칙
1. 파이프라인 오케스트레이터는 단 1곳: `lib/pipeline/process-contract.ts`
2. 문서 구역 분류는 Docling sidecar가 반환한 섹션 기반 (규칙 + zone keyword map)
3. 조항 분석은 Gemini fallback 체인 1회 호출로 "리스크+FIDIC비교"를 함께 반환
4. 실시간 진행률은 DB 상태 폴링으로 구현 (SSE/WebSocket은 M3 예정)
5. DB는 4테이블 중심 (contracts, document_zones, clauses, clause_analyses)

---

## 핵심 플로우

### 1) 업로드 & 파싱
POST /api/contracts
- file validate (pdf/docx, magic bytes, 크기 제한)
- Docling sidecar health 체크 (최대 30초 대기, 1초 폴링) — auto-start 기동 시간 고려
- parseWithDoclingRequired() → Docling /parse 엔드포인트로 파일 전송
  - timeout: 180초, 재시도: 2회 (Windows Defender DLL 스캔 대비)
  - 실패 시 503 + DOCLING_UNAVAILABLE 또는 DOCLING_PARSE_FAILED 코드 반환
- DoclingResponse(sections[]) → DocumentZone[] + ParsedClause[] 변환
  - zone_hint 키워드 매핑으로 zone_type 결정
  - ANALYSIS_TARGET_ZONES: contract_agreement, general_conditions, particular_conditions, conditions_of_contract, commercial_terms, definitions, contract_body
- qualityCheck: 조항 텍스트 검증, needs_review 플래그
- 언어 감지 (franc optional, 실패 시 무시)
- Supabase insert: contracts → document_zones → clauses
- uncertainZoneCount > 0 → contracts.status='filtering'

### 2) 사용자 구역 확정
PUT /api/contracts/:id/zones
- uncertain zones include/exclude 확정
- 확정 후 contracts.status='parsing' 또는 'ready'

### 3) 조항 분석 (배치)
POST /api/contracts/:id/analyze
- 이미 분석된 clause_id는 스킵 (idempotent)
- analyzeClauseForDb() → analyzeClause() 호출
  - 조항 길이 > 2000자: summarizeLongClause (preprocessing 체인)
  - FIDIC 후보 3개 embedding 검색 후 프롬프트에 포함
  - callGeminiJsonWithFallback (analysis 체인): 리스크+FIDIC 동시 분석
  - riskLevel="high" 시 crossValidateHighRisk (analysis 체인 재호출)
- 분석 간격: 6초 (무료 티어 보호)
- 쿼터 소진 시 partial 저장 + "내일 17:00 KST 리셋" 메시지
- Gemini 키 무효 시 clearStoredGeminiKey() + 401 반환

---

## 모델 라우팅

### MODEL_CONFIG (lib/gemini.ts)
| Key | 모델 ID |
|-----|---------|
| flash25 | gemini-2.5-flash |
| flash25Lite / flash31Lite | gemini-2.5-flash-lite |
| flash3 | gemini-2.0-flash |
| gemma27b | gemma-3-27b-it |
| gemma12b | gemma-3-12b-it |
| gemma4b | gemma-3-4b-it |
| embedding | gemini-embedding-001 |

### MODEL_ROUTES (lib/analysis/model-router.ts)
| 작업 | 모델 |
|------|------|
| RISK_ANALYSIS | gemini-2.5-flash-lite |
| FIDIC_COMPARISON | gemini-2.5-flash-lite |
| CROSS_VALIDATION | gemini-2.5-flash |
| DEEP_ANALYSIS | gemini-2.0-flash |
| DOCUMENT_ZONING | gemma-3-27b-it |
| CLAUSE_SPLIT_VERIFY | gemma-3-12b-it |
| EMBEDDING | gemini-embedding-001 |

### Fallback 체인 (callGeminiJsonWithFallback)
- analysis 체인: flash25 → flash25Lite → gemma27b → gemma12b → gemma4b
- preprocessing 체인: gemma27b → gemma12b → gemma4b → flash25 → flash25Lite
- 429/RESOURCE_EXHAUSTED 발생 시 해당 모델 즉시 스킵 (같은 모델 재시도 없음)

---

## Quota Manager (lib/quota-manager.ts)
- 모델별 RPD 한도:
  - flash25 / flash25Lite / flash31Lite: 20/일 (보수적 설정)
  - flash3 (gemini-2.0-flash): 1500/일
  - gemma27b / gemma12b / gemma4b: 14400/일
  - embedding: 1000/일
- 모델별 최소 호출 간격(MIN_INTERVAL):
  - flash25: 12초, flash25Lite / flash31Lite: 6초, flash3: 4초
  - gemma 계열: 2초, embedding: 0.6초
- 쿼터 리셋: 매일 17:00 KST (Asia/Seoul)
- 모든 Gemini 호출 전 canCall() → 성공 시 recordCall()
- 429는 exponential backoff (max 3회)
- 분석 응답 캐시: analysisCache (lib/cache.ts, contentHash 키)

---

## DB (MVP 4테이블)
- contracts: id, user_id, name, status, page_count, source_languages
- document_zones: id, contract_id, page_from, page_to, zone_type, confidence, is_analysis_target, text
- clauses: id, contract_id, zone_id, title, number, text, is_auto_split, needs_review, content_hash
- clause_analyses: id, clause_id, risk_level, risk_summary, recommendations, fidic_comparisons(JSONB), llm_model

contracts.status 흐름:
- filtering (uncertain zones 존재) → ready 또는 parsing
- analyzing → ready 또는 partial (쿼터 소진) 또는 error

RLS:
- contracts: auth.uid() = user_id
- document_zones / clauses / clause_analyses: contract_id join으로 소유권 체크

### 확장 테이블 (2차)
- fidic_clauses, fidic_comparisons (정규화/재사용)
- api_usage_log (정밀 사용량 트래킹)

---

## Supabase 설정 우선순위
1. 환경변수 (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
2. 로컬 암호화 파일 (data/supabase-config.enc, AES-256-GCM)
   - lib/supabase-config-store.ts: getSupabaseConfig() / setSupabaseConfig()
   - ENCRYPTION_KEY 필수 (32자 이상 또는 64자 hex)
   - UI에서 /api/settings/supabase-config로 설정 가능

---

## Docling Sidecar

### 자동 시작 (기본값, 2026-03-11 신규)
- `instrumentation.ts` (Next.js 14 Instrumentation Hook) + `lib/sidecar-manager.ts`로 구현
- `npm run dev` 기동 시 Next.js 서버가 sidecar를 자동으로 spawn
- 실행 조건: `VERCEL !== "1"` AND `DOCLING_AUTO_START !== "false"`
- 이미 포트가 열려 있으면 spawn 생략 (run.bat 또는 start_sidecar.bat 선실행 호환)
- sidecar-manager.ts 핵심 설계:
  - 프로젝트 루트: `process.cwd()` 사용 (주의: `__dirname`은 Next.js build 출력 디렉토리를 가리켜 사용 불가)
  - HMR-safe singleton: `Symbol.for("docling.sidecarManager")` via `globalThis.__docling_sidecar__`
  - spawn 환경변수: `DOCLING_SIDECAR_PORT`, `DOCLING_PRELOAD_MODEL=false`, `PYTHONIOENCODING=utf-8`
  - 기동 대기: /health 폴링, 최대 60초 (`HEALTH_POLL_TIMEOUT_MS`)
  - graceful shutdown: SIGINT/SIGTERM/exit → SIGTERM, 3초 후 SIGKILL (Windows 대비)

### 수동 시작 (DOCLING_AUTO_START=false 또는 선행 실행 필요 시)
- `scripts/start_sidecar.bat` 직접 실행
- `run.bat`에서 DOCLING_AUTO_START=false 로 설정 시 수동 모드 진입

### 공통 사항
- FastAPI 서버 (scripts/docling_sidecar.py), 버전 1.2.0
- 포트: 환경변수 DOCLING_SIDECAR_PORT (기본 8766)
  - .env.local: `DOCLING_SIDECAR_URL=http://127.0.0.1:8766` 와 일치해야 함
  - sidecar-manager.ts가 spawn 시 DOCLING_SIDECAR_PORT를 명시 전달 (start_sidecar.bat 미전달 이슈 해소)
- Lazy import 전략:
  - DOCLING_PRELOAD_MODEL=false (auto-start 기본): 서버 즉시 기동, 첫 /parse 요청 시 lazy load
  - DOCLING_PRELOAD_MODEL=true: startup 시 백그라운드 스레드로 preload
- /health: 항상 즉시 응답 (status, docling_imported, models_ready)
- /parse: PDF/DOCX → sections[] + total_pages + warnings

### Windows Defender 이슈 (알려진 문제)
- PyTorch DLL 수백 개 스캔으로 첫 실행 시 10분~수 시간 hang 가능
- 해결책: .venv 폴더를 Windows Defender 제외 목록에 추가

---

## UI 페이지/컴포넌트 구조
- app/upload/page.tsx: FileDropzone + 업로드 진행, Docling 에러 코드별 사용자 안내
- app/settings/page.tsx: Gemini API 키, Supabase 연결 설정
- components/contract/ZoneReviewView.tsx: uncertain zones 확인/결정
- components/dashboard/: QuotaDisplayWrapper, SupabaseConfigSetup, UploadCard
- components/upload/FileDropzone.tsx
- components/layout/AppShell.tsx

---

## 디렉토리 구조 (실제 기준)
```
lib/
  pipeline/
    process-contract.ts       # 파이프라인 오케스트레이터 (parserUsed: "docling")
    steps/
      validate-file.ts
      extract-text.ts         # 비활성 (throw Error - Docling 사용 안내만)
      zone-rules.ts
      filter-zones.ts
      split-clauses.ts        # regexSplitClauses (detectNumberingHint 기반)
      quality-check.ts
  analysis/
    analyze-clause.ts         # risk+fidic 단일 fallback 호출, 캐시
    risk-analyzer.ts          # analyzeClauseForDb() — DB 저장 형식 변환
    fidic-candidates.ts       # embedding + vector search
    model-router.ts           # MODEL_ROUTES, getModelKeyForTask()
  layout/
    types.ts                  # PdfLine, LayoutBlock, NumberingHint 등
    numbering.ts              # detectNumberingHint()
    blockify.ts, build-clauses.ts, header-footer.ts, layout-extract.ts
    normalize.ts, zone-classifier.ts
    document-part-patterns.json
  sidecar-manager.ts          # Docling sidecar 프로세스 라이프사이클 관리 (HMR-safe singleton)
  docling-adapter.ts          # parseWithDoclingRequired(), health check, retry
  document-parser.ts          # parsePdf() / parseDocx() → Docling 경유
  gemini.ts                   # MODEL_CONFIG, callGeminiJson, callGeminiJsonWithFallback
  quota-manager.ts            # canCall, recordCall, waitForRateLimit
  gemini-key-store.ts         # Gemini API 키 저장/조회
  gemini-errors.ts            # GeminiKeyInvalidError
  supabase-config-store.ts    # Supabase URL/키 암호화 저장 (AES-256-GCM)
  embedding.ts
  cache.ts                    # analysisCache, contentHash
  logger.ts
  auth/server.ts              # requireUserIdFromRequest()
  supabase/admin.ts           # getAdminSupabaseClientIfAvailable()
  utils/language.ts, file.ts, text.ts
app/api/
  contracts/route.ts          # POST: 업로드·파싱·DB 저장
  contracts/[id]/route.ts
  contracts/[id]/analyze/route.ts   # POST: 조항 분석 배치
  contracts/[id]/status/route.ts
  contracts/[id]/zones/route.ts     # PUT: zone 확정
  settings/gemini-key/route.ts
  settings/supabase-config/route.ts
  settings/status/route.ts
  quota/route.ts
  log/route.ts
scripts/
  docling_sidecar.py          # FastAPI 서버 v1.2.0
  start_sidecar.bat           # Python venv 직접 실행 (포트 8766 체크)
  requirements-docling.txt
  ensure-local-env.js
run.bat                       # 전체 스택 기동; 기본값은 npm run dev (sidecar auto-start)
instrumentation.ts            # Next.js 14 Instrumentation Hook — sidecar 자동 시작 진입점
next.config.mjs               # experimental.instrumentationHook: true 활성화
docker-compose.docling.yml
Dockerfile.docling
```

---

## 인프라 & 비용 규칙
- Frontend/API: Vercel Hobby (서버리스 함수 + 정적 호스팅)
- DB/Auth/Storage: Supabase Free
- LLM/Embedding: Gemini Free Tier (gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash, gemma-3-*-it, gemini-embedding-001)
- 문서 파서: Docling sidecar (무료, 자체 호스팅) — fallback 파서 없음
- 상위 원칙: 유료 LLM, 유료 SaaS/호스팅, 유료 클라우드 플랜 사용 금지

---

## 기술 부채 (알려진 항목)
1. Docling sidecar 로컬 의존성 → 클라우드 배포 전 컨테이너화 필요 (Dockerfile.docling 존재)
2. ENCRYPTION_KEY 관리 개선 필요 (현재 .env.local 기반)
3. 테스트 커버리지 낮음 (vitest, docling-adapter.test.ts, document-parser.test.ts, quota-manager.test.ts만 존재)
4. start_sidecar.bat이 DOCLING_SIDECAR_PORT 환경변수를 Python 프로세스에 전달하지 않아 포트 불일치 가능
   - 해결: sidecar-manager.ts (auto-start)는 DOCLING_SIDECAR_PORT를 명시 전달하여 해소됨
   - start_sidecar.bat 직접 실행 시는 여전히 수동 환경변수 설정 필요
5. sidecar-manager.ts에 sidecar.test.ts 없음 — 통합 테스트 부재

---

## 마일스톤 현황 (2026-03-11)

### M1: MVP (완료)
- 파일 업로드 UI, PDF/DOCX 파싱 (Docling), Gemini API 연동, Supabase 저장, 기본 리스크 분석 완료

### M2: 리스크 분석 고도화 (진행 중)
- [ ] FIDIC 조항 매핑 개선
- [ ] 리스크 레벨 시각화 (High/Medium/Low)
- [ ] 조항별 상세 설명 생성
- [ ] 비교 리포트 PDF 내보내기

### M3: 사용자 경험 (예정)
- [ ] 대시보드 (계약 목록/이력)
- [ ] 실시간 분석 진행률 (SSE/WebSocket)
- [ ] 결과 공유 링크
- [ ] 모바일 반응형 최적화

### M4: 안정성 & 운영 (예정)
- [ ] 에러 모니터링 (Sentry)
- [ ] 로그 집계
- [ ] 성능 테스트
- [ ] CI/CD 파이프라인
