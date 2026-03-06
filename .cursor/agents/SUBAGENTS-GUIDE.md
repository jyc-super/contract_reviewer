# Contract Review App — Subagent 구성 가이드

> `.claude/agents/` 디렉토리에 배치할 subagent 파일들과 사용 가이드입니다.
> **v2.0** — 비정형 문서 전처리, Gemini 무료 티어 최적화 반영

---

## Subagent 역할 매트릭스

| Agent | 역할 | 모델 | Tools | 핵심 포인트 |
|-------|------|------|-------|------------|
| contract-parser | 6단계 전처리 파이프라인 전체 | sonnet | Read,Write,Edit,Bash,Glob,Grep | 비정형 문서, OCR, 구역 분류 |
| risk-analyzer | 리스크 분석 + 할당량 관리 | sonnet | Read,Write,Edit,Bash,Glob,Grep | Flash 모델, 재시도/폴백 |
| fidic-expert | FIDIC 비교 + 벡터 검색 | opus | Read,Write,Edit,Bash,Glob,Grep | 임베딩, 시드 데이터 |
| supabase-engineer | DB/RLS/마이그레이션 | sonnet | Read,Write,Edit,Bash,Glob,Grep | 7테이블, pgvector |
| ui-developer | React 컴포넌트 + 인터랙션 | sonnet | Read,Write,Edit,Bash,Glob,Grep | 구역확인UI, 할당량위젯 |
| prompt-engineer | LLM 프롬프트 최적화 | opus | Read,Write,Edit | 토큰 절약, JSON 모드 |
| qa-reviewer | 코드 리뷰 (Read-only) | sonnet | Read,Grep,Glob | 보안, 할당량 체크 검증 |

---

## Phase별 Subagent 활용 순서

```
Phase 1: Foundation
  ├── supabase-engineer → 7테이블 스키마, 마이그레이션, 클라이언트 설정
  └── (main) → 타입 정의, gemini.ts, quota-manager.ts

Phase 2: Upload & Preprocessing
  ├── contract-parser → 6단계 파서 전체 구현
  ├── prompt-engineer → DOCUMENT_ZONING_PROMPT, CLAUSE_SPLIT_PROMPT 최적화
  ├── ui-developer → FileDropzone, UploadProgress(6단계), DocumentZoneReview
  └── qa-reviewer → Phase 2 코드 리뷰

Phase 3: Analysis Engine
  ├── prompt-engineer → RISK_ANALYSIS_PROMPT, FIDIC_COMPARE_PROMPT 최적화 (먼저!)
  ├── risk-analyzer → 리스크 분석 API + 할당량 관리 + 폴백 체인
  ├── fidic-expert → FIDIC 비교 + 벡터 검색 + 시드 데이터
  ├── supabase-engineer → match_fidic_clauses() 튜닝
  └── qa-reviewer → Phase 3 코드 리뷰

Phase 4: UI
  ├── ui-developer → ClauseCard, FidicCompareModal, QuotaDisplay 등 전체
  └── qa-reviewer → Phase 4 코드 리뷰

Phase 5: Polish & Deploy
  ├── qa-reviewer → 전체 최종 리뷰 (보안 + 할당량 체크 + RLS)
  └── supabase-engineer → RLS 최종 점검
```

### 병렬 실행 가능 조합 (Phase 2)

```
Agent A: prompt-engineer  → 전처리용 프롬프트 작성
Agent B: contract-parser  → 파일 검증 + 텍스트 추출 (프롬프트 미사용 부분)
  ↓ (프롬프트 완성 후)
Agent C: contract-parser  → 구역 분류 + 조항 파싱 (프롬프트 사용 부분)
Agent D: ui-developer     → 업로드/진행률 UI
```

---

## 사용 방법

### 설치

```bash
mkdir -p .claude/agents
# 아래 개별 .md 파일들을 .claude/agents/ 에 복사
```

### Claude Code에서 직접 생성

```bash
/agents
→ "Create new agent" 선택
→ 아래 파일 내용 붙여넣기
→ 모델/도구 선택 → 저장
```

### 명시적 호출

```text
"contract-parser 에이전트로 document-zoner.ts를 구현해줘"
"risk-analyzer 에이전트로 할당량 폴백 체인을 구현해줘"
"qa-reviewer 에이전트로 Phase 2 코드를 리뷰해줘"
```

---

## 팁 & 주의사항

1. **Opus는 비싸다** — fidic-expert와 prompt-engineer만 Opus, 나머지는 Sonnet
2. **qa-reviewer는 Read-only** — 코드 수정 불가, 리뷰만 수행
3. **CLAUDE.md와 연동** — subagent는 CLAUDE.md를 상속받으므로 CLAUDE.md가 정확해야 함
4. **파일 소유권** — 각 subagent의 File Ownership을 확인하여 충돌 방지
5. **할당량 인식** — risk-analyzer와 fidic-expert는 반드시 quota-manager를 사용

