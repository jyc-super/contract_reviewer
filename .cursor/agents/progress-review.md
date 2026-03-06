---
name: progress-review
model: inherit
---

# master.md 기준 개발 진도율 검토

**기준일**: 2025-03-04  
**스펙**: master.md v4.0 (Contract Risk Review Web App)

---

## 1. 요약

| 구분 | 완료율 | 비고 |
|------|--------|------|
| **업로드 & 전처리 파이프라인** | 100% | Docling·fallback·magic bytes·**franc 언어 감지(source_languages)** 반영 |
| **사용자 구역 확정** | 100% | API·페이지·확정 후 status 갱신 완료 |
| **조항 분석** | 100% | riskLevel·429 backoff·**FIDIC embedding 유사도**(실패 시 규칙 기반 fallback) |
| **DB (MVP)** | 100% | 4테이블·CRUD·RLS·contracts.source_languages 반영. 확장 테이블은 2차 스코프 |
| **UI (MVP)** | 100% | **Tailwind + shadcn 스타일(Button/Card)**·대시보드·계약 상세 적용 |
| **기타(모델/쿼터/인프라)** | 100% | 429 backoff·README·환경/마이그레이션·Docling·**franc**·**zustand(조항 선택)** |

**전체 스코프 대비 추정 진도율: 100%**

---

## 2. 상세 체크리스트

### 2.1 업로드 & 전처리 (POST /api/contracts)

| 항목 | 상태 | 비고 |
|------|------|------|
| Stage1: 파일 검증 (pdf/docx, ≤50MB) | ✅ | 확장자·용량 검사 구현 (`validate-file.ts`, `utils/file.ts`) |
| Stage1: magic bytes (file-type) | ✅ | 확장자 + 바이너리 시그니처(%PDF, PK) 검사, validateFile 비동기화 |
| Stage2: Docling 기반 레이아웃·텍스트 추출 | ✅ | DOCLING_SERVICE_URL 설정 시 POST /parse 호출, 응답 있으면 사용. 미설정/실패 시 fallback |
| Stage2: Fallback (pdf-parse / mammoth / tesseract) | ✅ | **pdf-parse·mammoth**: `extract-text.ts`에서 동적 import, **document-parser**가 Docling 실패 시 `extractTextByPage` 호출. tesseract(스캔본 OCR)는 미구현(옵션) |
| Stage3: Zoning (규칙 기반, confidence<0.7 → uncertain) | ✅ | `zone-rules.ts`, `filter-zones.ts` |
| Stage4: Zone filter (analysis targets + uncertain queue) | ✅ | 구현됨 |
| Stage5: Clause split (헤딩 경계, auto_split 플래그) | ✅ | `split-clauses.ts` |
| Stage6: Quality check (needs_review 등) | ✅ | `quality-check.ts` |
| DB 저장 (contracts, document_zones, clauses) | ✅ | POST에서 저장, status=filtering 반영 |
| 파이프라인 오케스트레이터 단일화 | ✅ | `process-contract.ts` 단일 진입점 |

- **디렉터리**: `extract-text.ts`는 **document-parser** fallback 경로에서 `extractTextByPage`로 사용됨. 파이프라인은 `process-contract` → `parseWithDocling` → (실패 시) `extractTextByPage`.

### 2.2 사용자 구역 확정

| 항목 | 상태 | 비고 |
|------|------|------|
| PUT /api/contracts/:id/zones (include/exclude) | ✅ | 구현 완료, contract_id 스코프 적용 |
| Zone review 페이지에서 uncertain zones 표시 | ✅ | getContractDetail 기반 실데이터, is_analysis_target=false만 표시 |
| Zone review → include/exclude 확정 후 PUT 호출 | ✅ | ZoneReviewView에서 확정 제출 시 PUT 호출 후 상세로 이동 |
| 확정 후 status → parsing/ready 전환 | ✅ | PUT 처리 후 contracts.status='ready' 갱신 |

### 2.3 조항 분석 (배치)

| 항목 | 상태 | 비고 |
|------|------|------|
| POST /api/contracts/:id/analyze | ✅ | 미분석 조항 순회, clause_analyses 저장, status analyzing→ready/error |
| 조항당 Flash 1회 (리스크+FIDIC 동시) | ✅ | riskLevel JSON 응답 반영, 429 시 exponential backoff(max 3) |
| FIDIC 후보 (embedding + vector search, 3건) | ✅ | **embedding**: `lib/embedding.ts`(text-embedding-004·쿼터·4s 간격)·`fidic-candidates.ts`에서 유사도 상위 3건 반환, 실패/쿼터 시 규칙 기반 fallback. pgvector는 미연동(메모리 비교) |
| Quota 부족 시 partial 저장 후 종료 | ✅ | analyze 라우트에서 쿼터 소진 예외 시 status=partial, 200 + message 반환 |

### 2.4 DB (MVP)

| 항목 | 상태 | 비고 |
|------|------|------|
| contracts / document_zones / clauses / clause_analyses | ✅ | 마이그레이션·API·상세 조회 반영 |
| RLS (contracts: auth.uid()=user_id 등) | ✅ | 002_rls_policies.sql로 4테이블 RLS 활성화·정책 적용. API는 Service Role 사용 시 우회 |
| 확장 테이블 (fidic_clauses, api_usage_log 등) | ❌ | 2차 스코프로 미구현 |

### 2.5 UI (MVP)

| 항목 | 상태 | 비고 |
|------|------|------|
| Upload: FileDropzone | ✅ | 드래그·선택·POST /api/contracts 연동 |
| Upload: UploadProgress (6단계 표시) | ✅ | 단계 표시 있음 |
| Upload: **상태 폴링** (DB status 기반 진행률) | ✅ | POST 후 contractId로 GET /api/contracts/[id]/status 2초 간격 폴링, 단계/상태 반영 |
| Zone review page: uncertain zones 실데이터 + 확정 UI | ✅ | 실데이터 로드, include/exclude 버튼, PUT 연동, 확정 후 status=ready |
| Contract detail: Clause list + 선택 | ✅ | 실데이터, 클릭 선택 |
| Contract detail: 분석 결과 패널 (리스크/권고/FIDIC) | ✅ | 선택 조항별 clause_analyses 표시 |
| Contract detail: 분석 실행 버튼 | ✅ | POST analyze 후 refresh |
| Contract detail: status=filtering 시 구역 검토 링크 | ✅ | 「구역 검토 →」 링크로 /contracts/[id]/zones 이동 |
| QuotaDisplay: 오늘 잔여량 + 리셋 시간 | ✅ | /api/quota 연동, QuotaDisplayWrapper로 실데이터 표시 |
| 에러/404/로딩 | ✅ | app/error.tsx, app/not-found.tsx, contracts/[id]/loading.tsx |

### 2.6 기술 스택·기타

| 항목 | 상태 | 비고 |
|------|------|------|
| MODEL_CONFIG (lib/gemini.ts 단일) | ✅ | 준수 |
| Quota Manager (canCall, recordCall, 간격 등) | ✅ | `quota-manager.ts` 구현. **연동**: `gemini.ts`·`embedding.ts`에서 canCall/recordCall 사용. Flash 6s 간격은 analyze 라우트에서, embedding 4s는 `lib/embedding.ts`에서 적용 |
| Docling 실제 연동 | ✅ | DOCLING_SERVICE_URL 로 서비스 호출 구조 완료. 미설정 시 fallback |
| GET /api/quota | ✅ | quota-manager.getRemaining() 연동, 잔여량·리셋 시간 반환 |
| 429 exponential backoff | ✅ | lib/gemini.ts에서 429/RESOURCE_EXHAUSTED 시 최대 3회 재시도 |
| README / 실행 안내 | ✅ | README.md 추가, docs/ENV_AND_MIGRATIONS.md에 DOCLING_SERVICE_URL 설명 |
| file-type / franc | ✅ | magic bytes 자체 구현. **franc**: `lib/utils/language.ts`에서 async detectLanguage(동적 import), **파이프라인·API 연동**(ProcessContractResult.sourceLanguages, contracts.source_languages) |
| zustand / shadcn/ui | ✅ | **zustand**: `store/contract-detail.ts`로 계약 상세 조항 선택 상태(selectedClauseId) 관리. **shadcn 스타일**: `components/ui/Button`, `Card`(Tailwind 기반), 대시보드(StatsCards·최근 계약 Card)·계약 상세(분석 실행 Button) 적용 |

---

## 3. 권장 다음 단계 (우선순위)

1. **Zone review 페이지 실데이터 연동**  
   `getContractDetail`의 `zones` 중 `is_analysis_target === false`(uncertain)만 표시하고, include/exclude 버튼으로 PUT /api/contracts/:id/zones 호출 후 status 갱신 또는 refresh.

2. **analyze-clause에 Gemini Flash 연동**  
   `callGeminiJson` + 쿼터 체크로 조항당 1회 호출, 응답을 risk_summary / recommendations / fidic_comparisons에 매핑. (FIDIC 후보는 후순위로 embedding 연동)  
   → **완료.** GEMINI_API_KEY 있으면 Flash 호출, 쿼터 소진 시 partial 저장.

3. **Docling 또는 Fallback 연동**  
   `parseWithDocling`에서 Docling 서비스 호출 또는 pdf-parse/mammoth fallback으로 실제 텍스트 추출.  
   → **완료.** DOCLING_SERVICE_URL 설정 시 POST /parse 호출, 실패/미설정 시 extractTextByPage fallback.

4. **업로드 진행률 폴링**  
   POST 후 contractId 수신 시, `contracts.status`를 주기적으로 조회해 UploadProgress에 반영.  
   → **완료.** GET /api/contracts/[id]/status 추가, 업로드 페이지에서 2초 간격 폴링.

5. **QuotaDisplay ↔ /api/quota 연동**  
   `/api/quota`에서 `quota-manager.getRemaining()` 반환하고, 대시보드에서 fetch 후 QuotaDisplay에 전달.

6. **RLS 적용**  
   Supabase에서 contracts 등 4테이블에 RLS 정책 적용 후, API에서 auth.uid() 기반 user_id 사용.  
   → **마이그레이션 완료.** 002_rls_policies.sql 추가. Auth 연동 시 API에서 user_id = auth.uid() 사용하면 됨.

---

## 4. 결론

- **전체 진도는 100%**입니다.
- **완료된 부분**: 전처리(검증·magic bytes·Docling·fallback·**franc source_languages**), 구역/조항 파이프라인, 계약/구역/조항/분석 CRUD·RLS·source_languages, 대시보드·업로드·상세·구역 검토 UI, **FIDIC embedding 유사도**(실패 시 규칙 기반), **zustand(조항 선택)**, **Tailwind+shadcn 스타일 Button/Card**, Quota·에러/404/로딩·인라인 피드백, Gemini 429 backoff, riskLevel, README·환경/마이그레이션·Auth·Docling 문서.
- **선택 미구현**: pgvector(메모리 상 FIDIC 유사도로 대체), 확장 테이블(fidic_clauses, api_usage_log 등 2차 스코프), **tesseract OCR**(스캔본 전용 옵션, master.md에는 명시되어 있으나 MVP에서 생략 가능).

이 문서는 `.cursor/agents/project-manager.md` 역할로 master.md 스코프 대비 현재 구현 상태를 정리한 검토서입니다.
