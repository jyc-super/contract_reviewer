# ETA 정확도 분석 보고서 + 수정 계획서

**작성일**: 2026-03-14
**대상**: 업로드 진행률 및 잔여시간(ETA) 표시 시스템

---

## 1. 현재 동작 방식 요약

### 1.1 아키텍처 개요

```
[upload/page.tsx]  →  POST /api/contracts  →  202 + contractId
     │                                            │
     │  ┌─ 3초 간격 polling ────────────────┐     │  (background)
     │  │  GET /api/contracts/[id]/status    │     │
     │  │  → { status, parseProgress, done } │     ▼
     │  └───────────────────────────────────┘  processContract()
     │                                           → parsePdf()       milestone 5→55
     │                                           → zoneMapping()    milestone 60
     │                                           → qualityCheck()   milestone 65→70
     │                                           → detectLanguage() milestone 75→80
     │                                        persistParseResult()  milestone 90→98
     │
     ▼
[UploadProgressPanel]
     │
     ├── useProgressEstimation()  ← 핵심 ETA 로직
     │    ├── stage weights (6단계)
     │    ├── fake progress (ease-out cubic)
     │    ├── real DB parseProgress (stage 2 only)
     │    └── ETA = elapsed × (remaining / completed)
     │
     ├── SegmentedProgressBar
     └── EtaDisplay
```

### 1.2 두 가지 진행률 시스템의 충돌

현재 코드에는 **두 가지 독립적인 진행률 계산 시스템**이 공존하며 서로 간섭합니다:

**시스템 A: upload/page.tsx의 stage-based progress** (라인 373-381)
```typescript
const stageBandWidth = 100 / STAGE_COUNT;   // ~16.67%
const stageFloor = ((stage - 1) / STAGE_COUNT) * 100;
const rawStageProgress = (stage / STAGE_COUNT) * 100;
const progress = liveStatus === "parsing" && typeof parseProgress === "number"
  ? stageFloor + (parseProgress / 100) * stageBandWidth
  : rawStageProgress;
```
- 각 stage를 **균등 분할** (100/6 = 16.67%)
- `parseProgress`를 stage 2의 16.67% 밴드 안에만 적용

**시스템 B: useProgressEstimation 훅의 weight-based progress**
```typescript
const DEFAULT_STAGE_WEIGHTS = [
  { stage: 1, weight: 0.01, expectedDurationMs: 5_000 },
  { stage: 2, weight: 0.85, expectedDurationMs: 300_000 },
  { stage: 3, weight: 0.05, expectedDurationMs: 30_000 },
  { stage: 4, weight: 0.01, expectedDurationMs: 20_000 },
  { stage: 5, weight: 0.00, expectedDurationMs: 60_000 },
  { stage: 6, weight: 0.08, expectedDurationMs: 20_000 },
];
```
- 가중치 기반 분배: stage 2 = 85%, stage 6 = 8% 등
- `parseProgress`를 stage 2의 85% 밴드에 적용
- ETA를 이 가중치 기반 progress로 계산

**`UploadProgressPanel`에서의 사용** (라인 197):
```typescript
const displayProgress = isTerminal ? progress : interpolatedProgress;
```
- 활성 상태: **시스템 B**의 `interpolatedProgress` 사용 (weight-based)
- 터미널 상태: **시스템 A**의 `progress` 사용 (균등 분할)

결론: **ETA 계산에는 시스템 B가 사용되고, 표시되는 퍼센트도 시스템 B의 값이 사용되므로, 시스템 A의 코드(page.tsx 라인 373-381)는 터미널 상태에서만 의미 있고, 활성 상태에서는 사실상 무용 코드**입니다.

---

## 2. ETA 부정확의 구체적 원인들

### 원인 1: 서버 milestone map과 클라이언트 stage mapping의 불일치 (핵심 문제)

**서버 측 milestone map** (`process-contract.ts`):
```
5  → arrayBuffer ready
10 → Docling parse request sent
55 → Docling parse response received
60 → Zone mapping complete
65 → qualityCheck start
70 → qualityCheck complete
75 → Language detection complete
80 → processContract() about to return
90 → persistParseResult start
95 → Zones inserted
98 → Clauses inserted
```

**클라이언트 측 stage mapping** (`upload/page.tsx`, `stageFromStatus`):
```
"parsing"          → stage 2
"quality_checking" → stage 3
"filtering"        → stage 5
"analyzing"        → stage 6
"ready"/"partial"  → stage 7 (done)
```

**문제**: 서버 milestone 5~55(Docling 파싱)이 **전체 시간의 90% 이상**을 차지하지만, 클라이언트에서는 이를 모두 `stage 2`로 통합합니다. Stage 4(Zone 분류)에 해당하는 서버 단계(milestone 60)는 Docling 파싱의 일부로 처리되어 별도 status 전환이 없습니다. 즉, **stage 4는 서버에서 별도 status를 보내지 않으므로 클라이언트에서 절대로 활성화되지 않습니다**.

### 원인 2: parseProgress가 DB에 도달하는 데 시간이 걸림

`makeProgressUpdater`의 throttle:
```typescript
const THROTTLE_MS = 3_000;  // 3초에 한 번만 DB 업데이트
```

폴링 간격:
```typescript
const POLL_INTERVAL_MS = 3000;  // 3초마다 status 확인
```

**최악의 경우 지연**: 서버가 progress를 emit → 3초 throttle → DB 기록 → 3초 후 클라이언트 poll → 클라이언트 반영. 즉, 실제 진행 상황이 **최대 6초 지연**되어 표시됩니다. 이 지연은 ETA 계산에 직접 영향을 줍니다.

### 원인 3: Docling sidecar가 세밀한 progress를 제공하지 않음

`processContract`에서 Docling 파싱의 progress는:
- milestone 10 (요청 전송)
- milestone 55 (응답 수신)

**45% 구간 동안 아무런 중간 progress가 없습니다**. 이 기간이 실제로 수 분에서 10분 이상 소요될 수 있으므로, 클라이언트는 이 구간에서 `fakeProgress`(ease-out cubic)에 의존합니다.

`process-contract.ts`의 `onProgress` 호출은 `makeProgressUpdater`를 통해 DB에 기록되지만, Docling 파싱 중에는 10 → 55 사이에 **중간 값이 전혀 없습니다**. `parsePdf()`는 `await parsePdf(buffer, file.name)`으로 호출되며 내부에서 onProgress를 호출하지 않습니다.

따라서 `parseProgress` (status API에서 반환)는 milestone 10에서 멈춘 채 수 분간 변하지 않다가, 갑자기 55로 점프합니다.

### 원인 4: expectedDurationMs 추정이 문서 크기와 무관한 고정값

```typescript
{ stage: 2, weight: 0.85, expectedDurationMs: 300_000 },  // 5분
```

실제로 Docling 파싱 시간은:
- 10페이지 PDF: ~30초
- 100페이지 PDF: ~5분
- 500페이지 PDF: ~15분 이상
- Windows Defender DLL 스캔 첫 실행: +30~60초 추가

**고정된 5분**으로 설정되어 있어:
- 작은 문서: ETA가 실제보다 5배 이상 과대 추정
- 큰 문서: ETA가 실제보다 3배 이상 과소 추정

### 원인 5: ETA 선형 외삽의 근본적 한계

```typescript
const rawEta = (elapsedMs / effectiveProgress) * remaining;
```

이 공식은 **일정한 속도로 진행된다고 가정**합니다. 그러나 실제 파이프라인은:
1. Stage 2 (Docling): 매우 느림 (분 단위)
2. Stage 3~4 (품질검사/분류): 상대적으로 빠름 (초 단위)
3. Stage 5 (사용자 확인): 무한대 (사용자 의존)
4. Stage 6 (DB 저장): 빠름 (초 단위)

Stage 2에서 측정된 속도로 남은 시간을 추정하면, stage 3~6이 실제보다 훨씬 오래 걸릴 것으로 과대 추정됩니다. 반대로 stage 6에 진입한 후에는 이미 대부분 완료된 상태이므로 ETA가 급격히 줄어듭니다.

### 원인 6: Exponential smoothing이 급격한 전환을 억제

```typescript
const ETA_SMOOTHING = 0.7;  // 이전 추정에 70% 가중
```

Stage 전환 시 progress가 급격히 변하지만, smoothing이 0.7로 높게 설정되어 ETA가 새로운 속도에 적응하는 데 수십 초가 걸립니다. 예를 들어:

1. Stage 2에서 300초 남았다고 추정
2. Stage 3으로 전환 → 실제로 5초면 끝남
3. Smoothing 때문에 ETA가 300 → 210 → 147 → ... 식으로 서서히 줄어듦
4. 실제로는 5초 만에 끝났는데 ETA는 아직 100초 이상을 표시

### 원인 7: Stage 4(Zone 분류)는 실제로 도달 불가능

`stageFromStatus` 함수를 보면:
```typescript
case "parsing":          return 2;
case "quality_checking": return 3;
case "filtering":        return 5;
```

Stage 4 (Zone 분류)에 대한 서버 status가 없습니다. Zone 분류는 `processContract()` 내부에서 milestone 60으로 처리되지만, DB status로 전환되지 않습니다. 따라서 클라이언트에서 `currentStage === 4`가 되는 경로가 없습니다.

**결과**: 6단계 UI 중 stage 4는 항상 건너뛰어지며, `quality_checking → filtering` 전환 시 stage 3에서 곧바로 stage 5로 점프합니다. stage 4의 weight(0.01)는 항상 `completed` 합산에서 누락됩니다.

### 원인 8: Stage 5(사용자 확인)의 weight=0.00으로 인한 progress 정체

```typescript
{ stage: 5, weight: 0.00, expectedDurationMs: 60_000 },
```

Weight가 0이므로 stage 5에 진입해도 `interpolatedProgress`는 변하지 않습니다. 이 자체는 의도된 설계이지만, ETA를 null로 반환하므로 사용자가 "얼마나 기다려야 하는지" 전혀 알 수 없습니다.

### 원인 9: status 전환 시점과 실제 작업 완료 시점의 불일치

```
서버에서 status="quality_checking" 설정 시점 = qualityCheck() 호출 직전
서버에서 status="filtering"/"ready" 설정 시점 = persistParseResult() 내부
```

하지만 클라이언트 폴링은 3초 간격이므로:
- `quality_checking` status는 5~30초만 유지
- 클라이언트가 이 status를 아예 놓칠 가능성 높음 (parsing → filtering으로 직접 전환되어 보임)
- 이 경우 stage 3은 건너뛰어지고 stage 2에서 stage 5로 직접 점프

---

## 3. 문제의 실제 영향 시나리오

### 시나리오 A: 50페이지 PDF (Docling 파싱 ~2분)

| 시점 | 실제 진행 | 표시 progress | 표시 ETA | 실제 남은 시간 |
|------|-----------|--------------|---------|-------------|
| 0s   | 업로드 시작 | 1% | 계산 중... | ~3분 |
| 10s  | Docling 요청 전송 | ~12% | ~1:20 | ~2분 50초 |
| 60s  | Docling 파싱 중 | ~45% | ~1:13 | ~2분 |
| 120s | Docling 응답 수신 | ~55% → 85%점프 | ~25s | ~10초 |
| 130s | 완료 | 99% | 1분 미만 | 0초 |

**문제점**: 120초에서 progress가 55%에서 갑자기 85%로 점프. ETA는 smoothing 때문에 갑자기 떨어지지 않아 "25초 남음"으로 표시되나 실제로는 10초 만에 끝남.

### 시나리오 B: 200페이지 PDF (Docling 파싱 ~8분)

| 시점 | 실제 진행 | 표시 progress | 표시 ETA | 실제 남은 시간 |
|------|-----------|--------------|---------|-------------|
| 0s   | 업로드 시작 | 1% | 계산 중... | ~9분 |
| 10s  | Docling 요청 전송 | ~12% | ~1:20 | ~8분 50초 |
| 60s  | Docling 파싱 중 | ~45% | ~1:13 | ~8분 |
| 120s | 파싱 중... | ~65% | ~1:05 | ~7분 |
| 300s | expectedDuration 초과 | ~84%(최대) | **~57s** | **~4분 30초** |
| 480s | Docling 응답 수신 | 85% 점프 | ~53s | ~30초 |

**문제점**: 300초(5분)에 expectedDurationMs를 초과하면 fakeProgress가 85%에 도달해 더 이상 증가하지 않음. ETA는 "57초"로 표시되나 실제로는 4분 30초 남음. **ETA와 현실의 괴리가 약 4배**.

---

## 4. 수정 계획

### 4.1 [P1] Docling 파싱 중 세밀한 progress 전달 (서버 측)

**대상 파일**: `lib/docling-adapter.ts`, `lib/document-parser.ts`, `lib/pipeline/process-contract.ts`

**현재 문제**: Docling 파싱(milestone 10~55) 사이에 중간 progress가 없음

**수정 방안**:
- Docling sidecar가 progress를 직접 보고하지 않으므로, **서버 측에서 시간 기반 합성 progress**를 생성
- `processContract()`에서 `parsePdf()` 호출 전에 타이머를 시작하여, 예상 시간 대비 경과 비율을 DB에 주기적으로 기록
- 예상 파싱 시간은 파일 크기 기반으로 동적 계산: `estimatedMs = baseMs + (fileSizeKB * msPerKB)`

```typescript
// process-contract.ts 수정 개요
// parsePdf() 호출 전에 progress 타이머 시작
const estimatedParseMs = estimateDoclingParseTime(file.size);
const progressTimer = setInterval(() => {
  const elapsed = Date.now() - parseStartTime;
  const ratio = Math.min(elapsed / estimatedParseMs, 0.95);
  const milestone = 10 + Math.round(ratio * 45); // 10~55 범위
  onProgress?.(milestone);
}, 5_000); // 5초마다

try {
  const result = await parsePdf(buffer, file.name);
  clearInterval(progressTimer);
  onProgress?.(55);
} catch (e) {
  clearInterval(progressTimer);
  throw e;
}
```

**예상 영향**:
- `lib/pipeline/process-contract.ts`: processPdf/processDocx에 타이머 로직 추가
- `app/api/contracts/route.ts`: `makeProgressUpdater`의 throttle 간격을 5초로 유지 (현재 3초, 타이머도 5초이므로 호환)
- Stage 2에서 progress가 부드럽게 증가하여 ETA 정확도 향상

### 4.2 [P1] stage weight와 expectedDurationMs를 파일 크기에 따라 동적 조정

**대상 파일**: `components/upload/useProgressEstimation.ts`, `components/upload/UploadProgressPanel.tsx`

**현재 문제**: 고정된 `expectedDurationMs: 300_000` (5분)

**수정 방안**:
- `UploadProgressPanel`에 `fileSize` prop 추가
- `useProgressEstimation`에 `fileSizeBytes` 옵션 추가
- `expectedDurationMs`를 파일 크기 기반으로 동적 계산:

```typescript
function estimateDoclingDuration(fileSizeBytes: number): number {
  const sizeMB = fileSizeBytes / (1024 * 1024);
  // 경험적 추정: 기본 30초 + MB당 15초
  // 최소 30초, 최대 600초 (10분)
  return Math.max(30_000, Math.min(600_000, 30_000 + sizeMB * 15_000));
}
```

**예상 영향**:
- `components/upload/useProgressEstimation.ts`: `fileSizeBytes` 옵션 추가, 동적 weight 계산
- `components/upload/UploadProgressPanel.tsx`: `fileSize` prop 수신 및 전달
- `app/upload/page.tsx`: `fileSize` state 관리 및 전달

### 4.3 [P1] 두 진행률 시스템 통합

**대상 파일**: `app/upload/page.tsx`

**현재 문제**: 시스템 A(균등 분할)와 시스템 B(weight 기반)가 혼재

**수정 방안**:
- `upload/page.tsx` 라인 373-385의 시스템 A 코드 제거
- `progress` prop에 항상 `interpolatedProgress`를 전달 (또는 isTerminal일 때 100)
- `UploadProgressPanel`이 유일한 progress 계산 소스가 되도록 정리

```typescript
// 수정 전 (upload/page.tsx)
const progress = liveStatus === "parsing" && typeof parseProgress === "number"
  ? stageFloor + (parseProgress / 100) * stageBandWidth
  : rawStageProgress;
const displayProgress = isIdle ? 0 : progress;

// 수정 후
const displayProgress = isIdle ? 0 : 100;  // terminal fallback only
// UploadProgressPanel 내부에서 interpolatedProgress 사용
```

**예상 영향**: `app/upload/page.tsx`만 변경, 중복 코드 제거

### 4.4 [P2] Stage 4(Zone 분류)를 위한 서버 status 추가 또는 stage 통합

**대상 파일**: `app/upload/page.tsx`, `lib/pipeline/process-contract.ts`, `app/api/contracts/route.ts`

**현재 문제**: Stage 4에 도달하는 서버 status가 없음

**수정 방안 (옵션 A — 권장: stage 통합)**:
- 6단계를 5단계로 축소: File validation / Docling parse / Quality & Zone / User confirmation / Finalize
- Stage 3에 quality_checking과 zone classification을 통합
- UI에서 건너뛰어지는 stage가 없어져 progress 흐름이 자연스러워짐

**수정 방안 (옵션 B — zone_classifying status 추가)**:
- `processContract()`에 `onZoneClassifyStart` 콜백 추가
- `runParseAndPersist()`에서 milestone 60 시점에 status="zone_classifying" DB 업데이트
- `stageFromStatus()`에 `"zone_classifying": 4` 추가

**예상 영향**: 옵션 A가 더 깔끔 — UI stage 정의, weights, PIPELINE_STAGES, stages 배열 모두 수정

### 4.5 [P2] ETA 계산 알고리즘 개선

**대상 파일**: `components/upload/useProgressEstimation.ts`

**현재 문제**: 선형 외삽 + 높은 smoothing으로 부정확

**수정 방안**:
1. **Stage-aware ETA**: 각 stage의 남은 시간을 개별 추정
   ```typescript
   // 현재 stage의 남은 시간
   const stageRemainingMs = expectedDurationMs * (1 - stageProgress/100);
   // 미래 stage들의 예상 시간 합산
   const futureStagesMs = weights
     .filter(w => w.stage > currentStage)
     .reduce((sum, w) => sum + w.expectedDurationMs, 0);
   const eta = stageRemainingMs + futureStagesMs;
   ```
2. **Smoothing 계수를 0.3으로 낮춤**: 새로운 추정에 더 빠르게 적응
3. **Stage 전환 시 smoothing 리셋**: 새 stage 진입 시 `smoothedEtaRef.current = null`로 초기화

**예상 영향**: `useProgressEstimation.ts`만 변경, 인터페이스 변경 없음

### 4.6 [P2] parseProgress DB 업데이트 주기 최적화

**대상 파일**: `app/api/contracts/route.ts`

**현재 문제**: 3초 throttle + 3초 polling = 최대 6초 지연

**수정 방안**:
- Throttle을 **2초**로 변경 (Supabase Free Tier 한도 내에서 가능)
- polling 간격을 파싱 중일 때 **2초**로 변경, 그 외 status에서는 3초 유지

```typescript
// upload/page.tsx
const POLL_INTERVAL_MS = liveStatus === "parsing" ? 2000 : 3000;
```

**예상 영향**:
- `app/api/contracts/route.ts`: `THROTTLE_MS` 상수 변경
- `app/upload/page.tsx`: 조건부 polling 간격

### 4.7 [P3] ETA 표시 형식 개선

**대상 파일**: `components/upload/EtaDisplay.tsx`

**현재 문제**:
- 60초 미만은 항상 "1분 미만" — 55초든 5초든 동일하게 표시
- 분:초 형식이 긴 대기에서 부정확하게 느껴짐

**수정 방안**:
- 60초 미만: "약 30초" / "약 10초" 등 10초 단위로 표시
- 5분 이상: "약 7분"처럼 분 단위로 반올림
- 30초 미만: "곧 완료" 표시

```typescript
function formatEta(etaMs: number | null, elapsedMs: number, currentStage: number): string {
  if (currentStage === 5) return "검토 대기 중";
  if (etaMs === null || elapsedMs < 10_000) return "계산 중...";
  if (etaMs < 30_000) return "곧 완료";
  if (etaMs < 60_000) return `약 ${Math.ceil(etaMs / 10_000) * 10}초`;
  if (etaMs >= 300_000) return `약 ${Math.round(etaMs / 60_000)}분`;
  return `약 ${formatDuration(etaMs)}`;
}
```

### 4.8 [P3] fakeProgress의 ease 곡선을 expectedDuration 초과 시 대비 개선

**대상 파일**: `components/upload/useProgressEstimation.ts`

**현재 문제**: `expectedMs`를 초과하면 progress가 85%에 고정되어 ETA가 부정확

**수정 방안**:
- `easedFakeProgress`에서 `t > 1` (초과 시) 대비 로직 추가
- 초과 시간의 비율에 따라 85% → 95%로 천천히 증가하는 별도 곡선 적용:

```typescript
function easedFakeProgress(elapsedMs: number, expectedMs: number): number {
  const t = elapsedMs / expectedMs;
  if (t <= 1) {
    // Normal range: ease-out cubic
    const eased = 1 - (1 - t) * (1 - t) * (1 - t);
    return Math.round(eased * FAKE_MAX_PERCENT);
  }
  // Over-time: slowly creep from 85% toward 95%
  const overRatio = Math.min((t - 1) / 2, 1);  // 0~1 over 2x expected
  const overEased = 1 - (1 - overRatio) * (1 - overRatio);
  return Math.round(FAKE_MAX_PERCENT + overEased * 10);  // 85% → 95%
}
```

---

## 5. 수정 우선순위 및 구현 순서

| 순서 | 항목 | 우선순위 | 예상 작업량 | 영향 파일 수 |
|------|------|---------|-----------|------------|
| 1 | 4.3 두 시스템 통합 | P1 | 소 | 1 |
| 2 | 4.1 서버 측 합성 progress | P1 | 중 | 2 |
| 3 | 4.2 파일 크기 기반 동적 duration | P1 | 중 | 3 |
| 4 | 4.5 ETA 알고리즘 개선 | P2 | 중 | 1 |
| 5 | 4.4 Stage 통합 (6→5) | P2 | 대 | 5+ |
| 6 | 4.8 fakeProgress 초과 대비 | P3 | 소 | 1 |
| 7 | 4.7 ETA 표시 형식 | P3 | 소 | 1 |
| 8 | 4.6 polling 주기 최적화 | P2 | 소 | 2 |

**권장 구현 순서**: 1 → 2 → 3 → 4 → 8 → 6 → 7 순서로 진행. 4.4(stage 통합)는 UI 변경 범위가 크므로 별도 PR로 분리.

---

## 6. 예상 영향 범위

### 변경되는 파일
| 파일 | 변경 내용 |
|------|----------|
| `app/upload/page.tsx` | 시스템 A 코드 제거, fileSize 전달, polling 간격 조건부 |
| `components/upload/useProgressEstimation.ts` | 동적 duration, ETA 알고리즘, fakeProgress 초과 대비 |
| `components/upload/UploadProgressPanel.tsx` | fileSize prop 추가 |
| `components/upload/EtaDisplay.tsx` | 표시 형식 개선 |
| `lib/pipeline/process-contract.ts` | 합성 progress 타이머 |
| `app/api/contracts/route.ts` | throttle 간격 변경 |

### 변경되지 않는 파일
| 파일 | 이유 |
|------|------|
| `components/upload/SegmentedProgressBar.tsx` | 입력값만 바뀌고 렌더링 로직 자체는 동일 |
| `app/api/contracts/[id]/status/route.ts` | 기존 parseProgress 필드를 그대로 활용 |
| `lib/stores/upload-store.ts` | 기존 state 스키마 그대로 사용 |
| `lib/docling-adapter.ts` | Docling sidecar API 자체에 progress 콜백이 없음 |

### 비호환 변경 없음
- 모든 수정은 기존 인터페이스를 확장하는 방식 (optional prop 추가)
- 기존 동작은 fallback으로 유지 (fileSize 미제공 시 현재 고정값 사용)
- DB 스키마 변경 없음

---

## 7. 부록: 현재 코드에서 발견된 추가 문제

### A. `UploadProgress.tsx`는 미사용 컴포넌트
`UploadProgress` 컴포넌트는 어디에서도 import되지 않으며, `UploadProgressPanel`이 이를 완전히 대체했습니다. 정리 대상입니다.

### B. `upload/page.tsx`의 `UPLOAD_TIMEOUT_MS = 30_000`
POST 요청에 30초 timeout이 설정되어 있으나, 서버가 즉시 202를 반환하므로 사실상 의미 없습니다 (Supabase insert 5초 + network). 값 자체에 문제는 없지만 주석으로 명확히 해야 합니다.

### C. TERMINAL_STATUSES 정의 불일치
- `upload/page.tsx` 라인 136: `"filtering"`을 terminal에 포함
- `status/route.ts` 라인 79: `"filtering"`을 terminal에서 제외

`filtering`은 polling을 멈추되 UI에서는 zone review를 표시하는 "semi-terminal" 상태입니다. 현재 동작은 올바르지만, 두 파일의 TERMINAL_STATUSES 정의가 다른 것은 혼란을 유발합니다.
