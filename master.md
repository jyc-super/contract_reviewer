# master.md (Cursor-only Master Spec) — Contract Risk Review Web App
최종 업데이트: v4.0 (Cursor 단독 개발 / 빠른 아키텍처)

## 목표
PDF/DOCX 건설/EPC 계약서를 업로드하면
1) 비정형 문서에서 계약 조항 영역만 선별
2) 조항 단위로 파싱
3) 각 조항에 대해 "리스크 분석 + FIDIC 비교 편차"를 제공하는 웹앱

## 비용/모델 정책 (비과금 원칙)
- 모든 인프라와 모델은 무료 티어 또는 자체 호스팅만 사용한다.
- 유료 LLM 및 유료 클라우드/SaaS 서비스는 사용하지 않는다.
- 기본 가정 인프라 조합: Vercel Hobby + Supabase Free + Gemini Free Tier + Docling(로컬 Docker 또는 무료 VM).

## 개발 원칙 (속도 5배)
1. 파이프라인 오케스트레이터는 단 1곳: `lib/pipeline/process-contract.ts`
2. 문서 구역 분류는 규칙 기반 우선, 불확실은 사용자 확인으로 품질 보장 (LLM zoning은 옵션)
3. 조항 분석은 Flash 1회 호출로 "리스크+FIDIC비교"를 함께 반환 (2콜→1콜)
4. 실시간 진행률은 DB 상태 + 폴링으로 구현 (Realtime/잡큐는 2차)
5. DB는 MVP에서 4테이블 중심(contracts, document_zones, clauses, clause_analyses). 나머지는 확장 단계

---

## 기술 스택 (고정)
- Next.js 14 App Router + TypeScript strict
- Tailwind CSS + shadcn/ui
- Supabase (Postgres) + Storage
- Gemini API (@google/generative-ai)
- Embedding: text-embedding-004
- 문서 파서(기본): Docling (PDF/DOCX 레이아웃/표/머리글/바닥글 분석, 자체 호스팅, 무료)
- PDF Fallback: pdf-parse (Docling 사용이 불가능한 환경에서만 사용, server-only)
- DOCX Fallback: mammoth (Docling 사용이 불가능한 환경에서만 사용, server-only)
- OCR Fallback: tesseract.js (Docling 미사용 시 스캔본 전용 옵션)
- File-type: file-type (magic bytes)
- Language: franc
- Client state: zustand
- 인프라(무료 티어 조합): Vercel Hobby + Supabase Free + Gemini Free Tier + Docling(로컬 Docker 또는 무료 VM)

---

## 핵심 플로우 (빠른 버전)

### 1) 업로드 & 전처리
POST /api/contracts
- Stage1: file validate (pdf/docx, <=50MB, magic bytes)
- Stage2: Docling 기반 레이아웃+텍스트 추출 (reading order, 표/머리글/바닥글 분리)
- Stage3: zoning (Docling 섹션 정보 + rule-based; confidence<0.7만 uncertain)
- Stage4: zone filter (Docling 출력의 본문/표/머리글 구분을 활용하여 analysis targets + uncertain queue 구성)
- Stage5: clause split (Docling이 태깅한 section_header/heading을 1차 경계로 사용, zone별 독립 파싱, auto split 시 flags)
- Stage6: quality check (간단 체크 + needs_review 표시)

문서 파싱 전략 요약:
- Docling이 페이지 레이아웃, 읽기 순서(reading order), 표 구조, 페이지 머리글/바닥글을 구조적으로 분리한다.
- 조항 경계 인식은 Docling이 추출한 section_header 목록을 1차 기준으로 하며, 애매한 경우에만 LLM(gemini-2.5-flash-lite)로 보정한다.
- Docling 사용이 불가능한 환경에서는 pdf-parse/mammoth + 규칙 기반/LLM 보정 조합을 fallback으로 사용한다.

중단 조건:
- uncertainZones 존재 → contracts.status='filtering' (사용자 확인 필요)

### 2) 사용자 구역 확정
PUT /api/contracts/:id/zones
- uncertain zones에 대해 include/exclude 확정
- 확정 후 contracts.status='parsing' 또는 'ready'

### 3) 조항 분석 (배치)
POST /api/contracts/:id/analyze
- clause 분석은 조항당 Flash 1회 (리스크+FIDIC 동시)
- FIDIC 후보는 embedding+vector search로 3개 후보 요약을 가져와 prompt에 포함
- Quota 부족 시 partial 저장 후 종료

---

## 모델 라우팅 (필수)
MODEL_CONFIG는 lib/gemini.ts에만 존재. 하드코딩 금지.

- 전처리(가능하면 LLM 없이): 기본 rule-based
- 전처리 LLM 옵션(사용 시): gemini-2.5-flash-lite
- 분석: gemini-2.5-flash (1콜로 risk+fidic)
- embedding: text-embedding-004
- Pro는 사용자 "심층 분석" 클릭 시만
- 조항 경계 보정: Docling이 추출한 section_header 목록을 기준으로, 필요 시 gemini-2.5-flash-lite로 조항 번호 누락/오탐을 검증한다 (계약서당 1~3콜 내).
- 무료 티어 보호: 계약서 1건 기준 Flash/Pro/embedding 호출 수에 상한을 두고 설계하며, 일일 한도 내에서 안정적으로 동작하도록 한다.

---

## Quota Manager 규칙
- 모든 Gemini 호출 전 canCall()
- 성공 시 recordCall()
- Flash call interval >= 6s
- embedding interval >= 4s (가능하면 batch)
- 429는 exponential backoff (max 3)
- 소진 시 partial 결과 저장 + "내일 17:00 KST 리셋" 안내

---

## DB (MVP 우선)
### 필수 4 테이블
- contracts
- document_zones
- clauses
- clause_analyses (여기에 fidicComparison JSONB를 함께 저장 가능)

### 확장 테이블(2차)
- fidic_clauses, fidic_comparisons (정규화/재사용)
- api_usage_log (정밀 사용량 트래킹)

RLS는 최소 범위부터 시작:
- contracts: auth.uid()=user_id
- document_zones/clauses/analyses: contract_id join으로 소유권 체크

---

## UI (MVP)
- Upload page: FileDropzone + UploadProgress (상태 폴링)
- Zone review page: uncertain zones 확인/결정
- Contract detail: Clause list + 분석 결과 (리스크/권고/FIDIC 편차)
- QuotaDisplay: 오늘 잔여량 + 리셋 시간
---

## 디렉토리 (빠른 버전)
lib/
  pipeline/
    process-contract.ts
    steps/
      validate-file.ts
      extract-text.ts
      zone-rules.ts
      filter-zones.ts
      split-clauses.ts
      quality-check.ts
  analysis/
    analyze-clause.ts (risk+fidic 단일 호출)
    fidic-candidates.ts (embedding+match)
  document-parser.ts (Docling 기반 PDF/DOCX 파서 래퍼)
  gemini.ts
  quota-manager.ts
  supabase/
app/api/
  contracts/route.ts
  contracts/[id]/zones/route.ts
  contracts/[id]/analyze/route.ts
  quota/route.ts
components/
  upload/*
  contract/*
  dashboard/*

---

## 인프라 & 비용 규칙 (무료 티어)
- Frontend/API: Vercel Hobby (서버리스 함수 + 정적 호스팅, 무료 티어 내에서 운영)
- DB/Auth/Storage: Supabase Free (Postgres + Storage, 무료 티어 범위 내 사용)
- LLM/Embedding: Gemini Free Tier (gemini-2.5-flash, gemini-2.5-flash-lite, text-embedding-004 등 무료 할당량 내에서만 호출)
- 문서 파서: Docling (로컬 Docker 또는 무료 VM에서 자체 호스팅, 별도 유료 과금 없음)
- 상위 원칙: 유료 LLM, 유료 SaaS/호스팅, 유료 클라우드 플랜은 사용하지 않는다.
