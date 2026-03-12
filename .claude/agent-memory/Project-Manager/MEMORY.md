# Project Manager - Persistent Memory

## 프로젝트 핵심 정책 (CLAUDE.md 기준, 우선순위 최상위)
- PDF/DOCX 파싱: Docling sidecar 필수. fallback 파서 승인 금지.
- 포트: 8766 (start_sidecar.bat, docker-compose.docling.yml, .env.example 모두 8766)
- venv 위치: D:\coding\contract risk\.venv (루트. scripts\.venv는 비어있음)
- 비용 원칙: Vercel Hobby + Supabase Free + Gemini Free Tier만 허용

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
  - spawn 시 DOCLING_PRELOAD_MODEL=false (lazy mode, 서버 즉시 기동)
  - 실패 시 non-fatal: Next.js 서버는 계속 기동
- 실행 우선순위: npm run dev (auto-start) > run.bat > start_sidecar.bat (수동)
- docling-adapter.ts 타임아웃 변경: parse 180초 (구 120초), health wait 30초 (구 10초)

## Docling Sidecar 이슈 기록 (2026-03-10 qa-debugger 세션)
- 근본 원인: `from transformers import StoppingCriteria` (pipeline_options.py 내)
  → Windows Defender가 PyTorch DLL 수백 개 스캔 → 첫 실행 시 10분~수 시간 hang
  → 첫 실행 후 DLL 캐시 완료되면 이후 정상 동작
- 권장 해결책 (우선순위):
  A) Windows Defender 제외 추가: D:\coding\contract risk\.venv 폴더
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

## 기술 부채 목록 (2026-03-12 기준)
1. Docling sidecar 로컬 의존성 → 클라우드 배포 전 컨테이너화 필요 (Dockerfile.docling 존재)
2. ENCRYPTION_KEY 관리 개선 필요 (현재 .env.local 기반)
3. 테스트 커버리지 낮음 (docling-adapter.test.ts, document-parser.test.ts, quota-manager.test.ts만 존재)
4. start_sidecar.bat이 DOCLING_SIDECAR_PORT를 Python 프로세스에 미전달 → 포트 불일치 위험 (start_sidecar.bat 직접 실행 시만 해당; auto-start는 해소됨)
5. sidecar-manager.ts에 대한 통합 테스트 없음 (sidecar.test.ts 부재)
6. E2E 통합 테스트 부재 — Supabase 포함 전체 업로드→파싱→DB저장 플로우 미검증 (2026-03-12 test-runner 테스트에서 드러남)
7. [RESOLVED 2026-03-12] SimplePipeline PDF 불가 버그 → 코드는 SimplePipeline+ConvertPipelineOptions 조합 유지 (메모리에서 유리). 추가로 iterate_items fallback 개선, num_pages 프로퍼티/메서드 이중 호환, TableItem.export_to_markdown(doc) deprecated 수정, _check_result_status 배치 누락 수정, on_event→lifespan 교체 완료

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

## M2 진행 상태 (2026-03-12 기준)
- [ ] FIDIC 조항 매핑 개선
- [ ] 리스크 레벨 시각화 (High/Medium/Low)
- [ ] 조항별 상세 설명 생성
- [ ] 비교 리포트 PDF 내보내기
- Sidecar 자동 시작 기능(instrumentation.ts + sidecar-manager.ts) 구현 완료 → M2 진입 블로커 해소
