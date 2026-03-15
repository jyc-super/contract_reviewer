# Gemini Tier-1 전환 시 예상 과금 분석

> 작성일: 2026-03-14
> 상태: 검토 대기 (미전환)

---

## 1. 현재 문제 (Free Tier)

| 모델 | 일일 한도 (RPD) | 호출 간격 | 실질 처리량 |
|---|---|---|---|
| flash25 (분석 주력) | **20회/일** | 12초 | 10~20개 조항/일 |
| flash25Lite | 20회/일 | 6초 | fallback |
| flash3 | 1,500회/일 | 4초 | fallback |
| gemma27b/12b/4b | 14,400회/일 | 2초 | preprocessing (여유) |

**병목**: EPC 계약서 1건(200~700조항) 분석 완료에 **10~35일** 소요.
쿼터 소진 시 `status: "partial"` → 다음 날 17:00 KST 리셋 후 이어서 분석해야 함.

---

## 2. 조항 1개당 LLM 호출 구조

| 단계 | 모델 | 조건 | Input 토큰 | Output 토큰 |
|---|---|---|---|---|
| 긴 조항 요약 | gemma27b (preprocessing) | 2,000자 초과 시만 | ~600 | ~100 |
| FIDIC 후보 embedding | gemini-embedding-001 | 항상 | ~200 | — |
| **리스크 분석** | **flash25** (analysis) | 항상 | **~3,500** | **~300** |
| 교차검증 | flash25 (analysis) | high risk만 (~20%) | ~1,200 | ~100 |
| 품질 체크 | gemma12b | 1회/계약 | ~200 | ~50 |

### Fallback 체인

- **analysis**: flash25 → flash25Lite → gemma27b → gemma12b → gemma4b
- **preprocessing**: gemma27b → gemma12b → gemma4b → flash25

---

## 3. Gemini Tier-1 가격 (2025년 기준)

| 모델 | Input ($/1M tokens) | Output ($/1M tokens) | 비고 |
|---|---|---|---|
| gemini-2.5-flash | $0.15 | $0.60 | 분석 주력 |
| gemini-2.5-flash-lite | $0.075 | $0.30 | fallback |
| gemma-3-27b-it | 무료 | 무료 | preprocessing |
| gemma-3-12b-it | 무료 | 무료 | preprocessing |
| gemini-embedding-001 | 무료 | — | 월 1,500 RPD 유지 |

---

## 4. 계약서 1건 비용 계산

**가정**: 조항 300개, 그 중 60개가 high risk (20%)

| 항목 | 호출 수 | Input 토큰 | Output 토큰 | 비용 |
|---|---|---|---|---|
| 긴 조항 요약 (gemma) | ~150건 | 90,000 | 15,000 | $0 (무료) |
| FIDIC embedding | ~300건 | 60,000 | — | $0 (무료) |
| 리스크 분석 (flash25) | 300건 | 1,050,000 | 90,000 | $0.21 |
| 교차검증 (flash25) | 60건 | 72,000 | 6,000 | $0.01 |
| 품질 체크 (gemma) | 1건 | 200 | 50 | $0 (무료) |
| **합계** | | **1,272,200** | **111,050** | **~$0.23** |

---

## 5. 월간 시나리오

| 사용량 | 월 비용 | 사용 사례 |
|---|---|---|
| 계약 5건/월 | **~$1.15** | 개인/소규모 |
| 계약 20건/월 | **~$4.60** | 중소 법무팀 |
| 계약 50건/월 | **~$11.50** | 활발한 사용 |
| 계약 100건/월 | **~$23.00** | 대형 프로젝트 |

참고: 상업 계약서 분석 SaaS (Kira, Luminance 등)는 연 $50K~$500K.

---

## 6. Tier-1 전환 시 성능 개선

| 항목 | Free Tier | Tier-1 |
|---|---|---|
| RPD 한도 | 20회/일 (flash25) | **무제한** |
| RPM 한도 | 5 RPM | **2,000 RPM** |
| 호출 간격 | 6~12초 대기 필수 | **대기 불필요** |
| 300조항 분석 시간 | **30분+** (partial 발생) | **5분 이내** |
| 300조항 완료까지 | **10~35일** | **1회 요청으로 완료** |

---

## 7. 전환 시 코드 변경 사항

### 7.1 quota-manager.ts

```
변경 전: RPD_LIMITS = { flash25: 20, flash25Lite: 20, ... }
변경 후: RPD_LIMITS = { flash25: 10000, flash25Lite: 10000, ... }
         MIN_INTERVAL = { flash25: 500, flash25Lite: 500, ... }
```

### 7.2 analyze/route.ts

```
변경 전: await new Promise((r) => setTimeout(r, 6000));  // 6초 대기
변경 후: await new Promise((r) => setTimeout(r, 500));    // 0.5초 대기 (or 제거)
```

### 7.3 CLAUDE.md 아키텍처 제약 업데이트

```
변경 전: "비용 제로 — 유료 LLM, SaaS, 클라우드 플랜 추가 금지"
변경 후: "Gemini Tier-1 (종량제) 사용. 월 $25 이내 유지 목표"
```

---

## 8. 전환 절차

1. Google AI Studio에서 결제 정보 등록
2. Gemini API 키를 Tier-1 프로젝트로 재발급
3. `quota-manager.ts`의 RPD/RPM/MIN_INTERVAL 값 조정
4. `analyze/route.ts`의 6초 대기 제거 또는 축소
5. CLAUDE.md 비용 정책 업데이트
6. 테스트: 대형 계약서(300+ 조항) 1건 분석하여 비용/시간 검증

---

## 9. 판단 기준

**전환 추천 시점**:
- 실 사용자가 생겨서 "분석에 며칠 걸린다"는 피드백이 올 때
- 계약서 분석을 데모/영업 목적으로 빠르게 보여줘야 할 때
- 월 $5~$25를 투자할 가치가 있다고 판단될 때

**유지 추천 시점**:
- 아직 개발/테스트 단계로 파싱 품질 개선이 우선일 때
- 분석 결과 품질이 과금 가치를 증명하지 못할 때
