# UI/UX 개선 계획: 업로드 & 계약 목록

> 작성일: 2026-03-14
> 상태: Phase 1~4 전체 완료 (QW-1~7, ME-1~5, P-H1/P-H2, LR-1~3) (2026-03-14)

---

## 1. 현재 상태 요약

### 업로드 페이지 (`app/upload/page.tsx`)

**구현됨:**
- zustand 상태 머신 (idle → uploading → parsing → filtering → analyzing → ready/error)
- sessionStorage persist (페이지 이탈 후 복귀 시 상태 복원)
- 6단계 파이프라인 시각화 (step-item 목록)
- 단계별 가짜 진행률 보간 + DB `parse_progress` 실시간 반영
- 4초 주기 사이클링 서브 메시지 (한국어 힌트)
- 경과 시간 카운터 (⏱ 00:00)
- 에러 코드별 재시도 버튼 (`DOCLING_UNAVAILABLE`, `DOCLING_PARSE_FAILED`)
- Zone 검토 UI 인라인 렌더링 (filtering 상태)

**없는 것:**
- FileDropzone: 드래그 중 시각적 피드백 없음 (`isDragging` 상태 미구현)
- 파일 크기 초과 시 UI 메시지 없음 (50MB 태그는 표시되지만 초과 시 안내 없음)
- `<a>` 태그로 계약 상세 링크 — Next.js `<Link>` 미사용
- 모바일 반응형 없음

### 계약 목록 페이지 (`app/contracts/page.tsx`)

**구현됨:**
- RSC 서버사이드 조회
- 계약서명 검색 + 4개 상태 필터 탭 (전체/완료/진행 중/오류)
- 상태별 카운트 표시
- `filtering` 상태 계약 자동 `/zones` 라우팅
- 검색 결과 없을 때 "필터 초기화" 버튼
- 빈 상태 처리 (아이콘 + 설명 + 업로드 버튼)

**없는 것:**
- 정렬 기능 (날짜, 이름, 상태)
- 페이지네이션 (Supabase 기본 limit에 의존)
- 행 전체 클릭 불가 (계약서명 텍스트만 클릭 가능)
- 분석 중 계약의 실시간 상태 갱신 (SSR 스냅샷)

### 대시보드 (`app/page.tsx`)

**구현됨:**
- 4개 통계 카드 (StatsCards)
- 빈 상태: 기능 소개 3칸 그리드 + 업로드 CTA
- 데이터 있을 때: 최근 계약 + 리스크 차트 2열 레이아웃
- GeminiKeySetupWrapper 배너
- Supabase 미설정 데모 배너

### AppShell (`components/layout/AppShell.tsx`)

**구현됨:**
- 260px 고정 사이드바
- 라우터 캐시 무효화 (pathname 변경 시 `router.refresh()`)
- 사이드바 하단 Quota 위젯

**없는 것:**
- 모바일 햄버거 메뉴 / 사이드바 접기
- 사이드바 아이콘이 emoji 문자 — SVG 미사용
- nav-item 키보드 focus ring 없음

---

## 2. 문제점 목록 (우선순위별)

### HIGH

#### H1 — FileDropzone: 드래그 중 시각적 피드백 완전 부재

**파일:** `components/upload/FileDropzone.tsx`

`handleDragEnter` / `handleDragOver` 핸들러가 있지만 `isDragging` 상태 변수가 없다.
파일을 드래그해서 올려놓아도 dropzone이 전혀 변하지 않는다.
CSS의 `.upload-zone:hover`는 마우스 호버에만 반응하며, 드래그 이벤트는 hover pseudo-class를 발동시키지 않는다.

사용자는 "내가 파일을 올바른 위치에 드래그하고 있는가"를 확인할 방법이 없다.

---

#### H2 — 에러 메시지 언어 불일치 + 내부 경로 노출

**파일:** `app/upload/page.tsx` — `mapUploadError()` 함수

| 에러 코드 | 언어 | 문제 |
|-----------|------|------|
| `DOCLING_UNAVAILABLE` | 영어 | `scripts/start_sidecar.bat` 내부 경로 노출 |
| `DOCLING_PARSE_FAILED` | 영어 | 개발자 수준 메시지 |
| `SUPABASE_INSERT_FAILED` | 한국어 | 정상 |
| `SUPABASE_SCHEMA_MISSING` | 한국어 | 정상 |

같은 화면에서 에러 코드에 따라 언어가 바뀌고, 사용자에게 내부 파일 경로가 노출된다.

---

#### H3 — 모바일 레이아웃 완전 미지원

**파일:** `app/globals.css`

```css
.sidebar { width: 260px; position: fixed; }
.main-content { margin-left: 260px; }
```

반응형 breakpoint가 전혀 없다.
모바일/태블릿에서 사이드바가 화면을 차지하고, main content는 오른쪽으로 밀려 보이지 않는다.
`sm:` 이하 화면에서 앱이 사실상 사용 불가능하다.

---

#### H4 — Zone 확정 버튼: 미결정 항목 위치 안내 없음

**파일:** `components/contract/ZoneReviewView.tsx`

```typescript
const allDecided = uncertainZones.every((z) => decisions[z.id] != null);
// ...
disabled={!allDecided || submitting}
```

uncertain zone이 50개면 모든 50개를 결정해야 확정 버튼 활성화.
하나라도 놓치면 버튼이 비활성 상태이지만, **어느 항목이 미결정인지 알려주지 않는다.**
사용자가 스크롤하며 직접 찾아야 한다.

---

### MEDIUM

#### M1 — UploadProgressPanel: raw `<a>` 사용

**파일:** `components/upload/UploadProgressPanel.tsx` (L505, L565)

```tsx
<a href={`/contracts/${contractId}`}>계약 상세 보기</a>
```

Next.js `<Link>`를 써야 prefetch와 클라이언트 사이드 라우팅이 작동한다.
`<a>`는 full page reload를 발생시킨다.

---

#### M2 — 업로드 페이지 헤더의 QuotaDisplayWrapper 중복

**파일:** `app/upload/page.tsx`

AppShell 사이드바 하단에 이미 Quota 위젯이 있다.
업로드 페이지 헤더에서 동일 데이터를 중복 표시하며, 파일 드롭존보다 API 할당량이 더 눈에 띄는 정보 계층 역전이 발생한다.

---

#### M3 — ZoneCard: confidence score 원시 수치 표시

**파일:** `components/contract/ZoneReviewList.tsx`

```tsx
<span className="zone-confidence">conf: {zone.confidence.toFixed(2)}</span>
```

`conf: 0.87` 같은 수치는 일반 사용자에게 의미가 없다.
"이 구역을 포함할지 말지"를 결정하는 데 수치만으로는 도움이 되지 않는다.

---

#### M4 — ContractDetailView 필터 바: `flex-wrap`으로 레이아웃 불안정

**파일:** `components/contract/ContractDetailView.tsx`

`flex-wrap` 적용 상태에서 뷰포트 너비에 따라 "전체 펼치기/접기" 버튼이 혼자 다음 줄로 떨어져 시각적으로 분리된다.
`ml-auto`가 flex-wrap 상황에서 의도대로 동작하지 않는다.

---

#### M5 — RecentContracts: 행 전체 클릭 불가

**파일:** `components/dashboard/RecentContracts.tsx`

테이블 행에 hover 스타일은 있지만 클릭 이벤트는 `<td>` 내부 `<Link>`에만 있다.
상태 배지나 날짜 영역을 클릭해도 아무 일도 일어나지 않는다.
행 전체가 클릭 가능한 것처럼 보이는데 실제로는 그렇지 않다.

---

#### M6 — UploadProgressPanel: 인라인 스타일과 Tailwind 혼용

**파일:** `components/upload/UploadProgressPanel.tsx` (50+ 곳)

```tsx
style={{ marginTop: 16 }}          // → mt-4
style={{ color: "var(--accent-red)" }}  // → text-accent-red
style={{ fontFamily: '"JetBrains Mono", monospace' }}  // → font-mono
```

이미 design token으로 정의된 값을 인라인 스타일로 사용 중이다.
다크 모드 확장이나 테마 변경이 어려워진다.

---

### LOW

#### L1 — 계약 목록: 정렬/페이지네이션 없음

**파일:** `app/contracts/page.tsx`

Supabase 기본 정렬 + 최대 1000개 한번에 로드.
계약이 100개 이상이 되면 성능 저하와 탐색 불편이 발생한다.

---

#### L2 — AppShell nav-item: focus ring 미표시

**파일:** `app/globals.css`

키보드 Tab 탐색 시 어떤 nav item이 포커스되어 있는지 시각적으로 알 수 없다.
WCAG 2.1 SC 2.4.7 (Focus Visible) 위반이다.

---

#### L3 — AppShell 사이드바 아이콘: emoji 문자 사용

**파일:** `components/layout/AppShell.tsx`

```tsx
<NavItem href="/" icon="📊">대시보드</NavItem>
<NavItem href="/upload" icon="📤">계약서 업로드</NavItem>
```

Emoji는 OS/폰트마다 렌더링이 다르고, 스크린 리더가 "chart increasing" 처럼 읽어 노이즈를 발생시킨다.
lucide-react 아이콘으로 전환이 필요하다 (shadcn/ui 설치 시 이미 포함됨).

---

#### L4 — 계약 목록: 분석 중 계약 실시간 상태 미반영

**파일:** `app/contracts/page.tsx`

RSC 페이지라서 서버 렌더 시점의 상태 스냅샷만 보여준다.
분석 중(`analyzing`, `parsing`) 계약이 완료되어도 수동 새로고침 전까지 "분석 중" 배지가 유지된다.

---

#### L5 — UploadProgressPanel: 완료 후 경과 시간 레이블 불명확

**파일:** `components/upload/UploadProgressPanel.tsx`

진행 중·완료 후 모두 `⏱ formatElapsed(elapsedMs)` 동일하게 표시한다.
완료 후에는 "총 소요 시간: X분 Y초"처럼 명확한 레이블이 필요하다.

---

## 3. 개선 방안

### Quick Win (합계 1~2시간)

| ID | 파일 | 작업 | 예상 시간 |
|----|------|------|----------|
| QW-1 | `FileDropzone.tsx` | `isDragging` 상태 추가 + dropzone 색상 변화 | 15분 |
| QW-2 | `upload/page.tsx` | `mapUploadError()` 한국어 통일, 내부 경로 제거 | 10분 |
| QW-3 | `UploadProgressPanel.tsx` | `<a>` → `<Link>` 교체 (L505, L565) | 5분 |
| QW-4 | `upload/page.tsx` | 헤더 `QuotaDisplayWrapper` 제거 | 5분 |
| QW-5 | `RecentContracts.tsx` | `<tr onClick>` + `useRouter` 추가 | 20분 |
| QW-6 | `globals.css` | `.nav-item:focus-visible` focus ring 추가 | 5분 |
| QW-7 | `UploadProgressPanel.tsx` | 완료 후 "총 소요:" prefix 추가 | 5분 |

**QW-1 구현 방향:**
```tsx
// FileDropzone.tsx
const [isDragging, setIsDragging] = useState(false);

const handleDragEnter = (e: DragEvent) => { e.preventDefault(); setIsDragging(true); };
const handleDragLeave = (e: DragEvent) => { e.preventDefault(); setIsDragging(false); };
const handleDrop = (e: DragEvent) => { setIsDragging(false); /* 기존 로직 */ };

<div className={`upload-zone ${isDragging ? "upload-zone--dragging" : ""}`} ...>
```

**QW-2 구현 방향:**
```typescript
// 현재 (영어, 내부 경로 노출)
case "DOCLING_UNAVAILABLE":
  return "Docling sidecar is not running. Please start it via scripts/start_sidecar.bat";

// 변경 후
case "DOCLING_UNAVAILABLE":
  return "문서 파서가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.";
case "DOCLING_PARSE_FAILED":
  return "문서 파싱에 실패했습니다. 파일이 손상되었거나 지원하지 않는 형식일 수 있습니다.";
```

---

### Medium Effort

| ID | 파일 | 작업 | 예상 시간 |
|----|------|------|----------|
| ME-1 | `ZoneReviewView.tsx` | 미결정 항목 카운트 + 가이드 메시지 | 30분 |
| ME-2 | `ZoneReviewList.tsx` | confidence 색상 코딩 (저/중/고) | 30분 |
| ME-3 | `ContractDetailView.tsx` | 필터 바 2행 레이아웃으로 고정 | 45분 |
| ME-4 | `UploadProgressPanel.tsx` | 인라인 스타일 → Tailwind 유틸리티 전환 | 1시간 |
| ME-5 | `AppShell.tsx` | lucide-react 아이콘으로 전환 | 1시간 |

**ME-1 구현 방향:**
```tsx
// ZoneReviewView.tsx
const undecidedCount = uncertainZones.filter((z) => decisions[z.id] == null).length;

// 확정 버튼 위에 표시
{!allDecided && (
  <p className="text-sm text-accent-yellow">
    {undecidedCount}개 항목이 아직 미결정입니다. 모두 결정한 후 확정할 수 있습니다.
  </p>
)}
```

**ME-2 구현 방향:**
```tsx
// ZoneReviewList.tsx
const confidenceColor =
  zone.confidence >= 0.8 ? "text-accent-green" :
  zone.confidence >= 0.5 ? "text-accent-yellow" : "text-accent-red";

const confidenceLabel =
  zone.confidence >= 0.8 ? "고신뢰" :
  zone.confidence >= 0.5 ? "중신뢰" : "저신뢰";

<span className={`zone-confidence text-xs ${confidenceColor}`} title="AI 분류 신뢰도">
  {confidenceLabel} {Math.round(zone.confidence * 100)}%
</span>
```

---

### 큰 리팩터링

| ID | 파일 | 작업 | 예상 시간 |
|----|------|------|----------|
| LR-1 | `globals.css`, `AppShell.tsx` | 모바일 반응형 사이드바 (오버레이 드로어) | 4~6시간 |
| LR-2 | `contracts/page.tsx`, `RecentContracts.tsx` | 페이지네이션 또는 무한 스크롤 | 2~3시간 |
| LR-3 | `contracts/page.tsx` | 분석 중 계약 실시간 상태 갱신 | 3~4시간 |

**LR-1 구현 방향:**
- 사이드바를 `md:` 이상에서만 고정, 모바일에서는 오버레이 드로어
- `globals.css`의 `.main-content { margin-left: 260px }` → `@media (min-width: 768px)`로 이동
- 모바일 상단 헤더 바 + 햄버거 버튼 추가
- zustand로 사이드바 open/close 상태 관리

---

## 4. 우선순위 요약

| 우선도 | ID | 파일 | 설명 | 예상 시간 | 상태 |
|--------|----|----|------|---------|------|
| **P0** | QW-1 | `FileDropzone.tsx` | 드래그 시각 피드백 추가 | 15분 | ✅ 완료 |
| **P0** | QW-2 | `upload/page.tsx` | 에러 메시지 한국어 통일 + 내부 경로 제거 | 10분 | ✅ 완료 |
| **P0** | QW-3 | `UploadProgressPanel.tsx` | `<a>` → `<Link>` 교체 | 5분 | ✅ 완료 |
| **P0** | QW-4 | `upload/page.tsx` | 헤더 QuotaDisplayWrapper 중복 제거 | 5분 | ✅ 완료 |
| **P0** | QW-5 | `RecentContracts.tsx` | 테이블 행 전체 클릭 가능하게 | 20분 | ✅ 완료 |
| **P0** | QW-6 | `globals.css` | nav-item focus ring 추가 | 5분 | ✅ 완료 |
| **P0** | QW-7 | `UploadProgressPanel.tsx` | 완료 후 경과 시간 레이블 개선 | 5분 | ✅ 완료 |
| **P1** | ME-1 | `ZoneReviewView.tsx` | 미결정 항목 카운트 + 가이드 메시지 | 30분 | ✅ 완료 |
| **P1** | ME-2 | `ZoneReviewList.tsx` | confidence 색상 코딩 (저/중/고) | 30분 | ✅ 완료 |
| **P1** | ME-3 | `ContractDetailView.tsx` | 필터 바 2행 레이아웃 고정 | 45분 | ✅ 완료 |
| **P1** | ME-4 | `UploadProgressPanel.tsx` | 인라인 스타일 → Tailwind 전환 | 1시간 | ✅ 완료 |
| **P1** | ME-5 | `AppShell.tsx` | lucide-react 아이콘 전환 | 1시간 | ✅ 완료 |
| **P2** | LR-1 | `globals.css`, `AppShell.tsx` | 모바일 반응형 사이드바 | 4~6시간 | ✅ 완료 |
| **P2** | LR-2 | `contracts/page.tsx` | 계약 목록 페이지네이션 | 2~3시간 | ✅ 완료 |
| **P3** | LR-3 | `contracts/page.tsx` | 분석 중 계약 실시간 상태 갱신 | 3~4시간 | ✅ 완료 |

---

## 5. 아키텍처 결정 사항

### 결정 1: 모바일 반응형 전략

**권장: CSS media query + 오버레이 드로어 패턴**

- 전용 모바일 앱을 만들 것이 아니므로 breakpoint 기반이 가장 단순
- 사이드바를 `md:` 이하에서 숨기고, 상단 바 + 햄버거로 토글
- zustand store 하나 추가 (`useSidebarStore`)

### 결정 2: 계약 목록 페이지네이션 방식

**권장: URL 파라미터 기반 페이지네이션 (무한 스크롤 아님)**

- RSC와 자연스럽게 통합됨 (`searchParams.page`)
- SEO, 뒤로가기 호환성 유지
- `getContractList(offset, limit)` 함수 파라미터 추가만으로 구현 가능

### 결정 3: 실시간 상태 갱신 방식

**권장: Client Component 전환 + 폴링 (SSE/WebSocket 아님)**

- Supabase Realtime 채널을 추가하는 것도 가능하나 Supabase Free Tier 연결 수 제한 고려
- "analyzing/parsing 상태 계약 존재 시" 조건부 폴링 (10초 간격)이 가장 단순
- `router.refresh()` 호출로 RSC 리렌더 트리거

---

## 6. 백엔드 연동 필요 사항

> 분석 기준: 2026-03-14. 코드 직접 검토 기반 (backend-architect 관점).

### LR-2: 계약 목록 페이지네이션

**현황 파악:**
- `lib/data/contracts.ts`의 `getContractList(limit)` 함수: `limit=0`이면 전체 조회, `limit > 0`이면 `.limit(limit)` 적용
- offset 파라미터 없음. Supabase `.range(from, to)` 미사용
- 정렬 컬럼 고정: `order('updated_at', { ascending: false })`
- `app/contracts/page.tsx`는 RSC 구조로 `searchParams` prop을 받을 수 있으나 현재 미사용

**필요한 백엔드 변경:**

1. `lib/data/contracts.ts` — `getContractList()` 시그니처 변경
   - 현재: `getContractList(limit = 0)`
   - 변경 후: `getContractList(options: { offset?: number; limit?: number; sort?: 'updated_at' | 'created_at' | 'name' | 'status'; ascending?: boolean })`
   - Supabase `.range(offset, offset + limit - 1)` 사용 시 `totalContracts`는 별도 count 쿼리로 분리 필요 (현재 이미 분리되어 있어 변경 최소화 가능)

2. `app/contracts/page.tsx` — `searchParams` 수신 및 파싱 추가
   - `searchParams.page` (1-based) → `offset = (page - 1) * PAGE_SIZE`
   - `searchParams.sort` → `getContractList`에 전달
   - RSC 구조 유지 가능 — Client Component 전환 불필요

3. 프론트엔드 페이지네이션 UI (`RecentContracts.tsx`)에 페이지 버튼 추가 시 현재 클라이언트 필터(`search`, `statusFilter`)와 페이지네이션 상태가 충돌할 수 있음
   - 해결: 클라이언트 검색/필터는 로컬 데이터 기반 유지, URL 파라미터 기반 페이지 이동은 서버 재조회 트리거 방식으로 분리

**API 엔드포인트 신규 추가 불필요.** `lib/data/contracts.ts` 함수 변경 + RSC `searchParams` 연결로 충분.

---

### LR-3: 분석 중 계약 실시간 상태 갱신

**현황 파악:**
- `app/api/contracts/[id]/status/route.ts`: 단일 계약 조회 전용, 다중 id 입력 불가
- 반환 필드: `{ status, name, updatedAt, createdAt, pageCount, parseProgress, done }`
- `app/contracts/page.tsx`는 RSC — 클라이언트 폴링 불가

**옵션 비교:**

| 옵션 | 방식 | API 변경 | Supabase 연결 영향 | 복잡도 |
|------|------|---------|-------------------|--------|
| A | 각 계약별 `/api/contracts/[id]/status` 병렬 호출 | 없음 | 계약 수만큼 연결 증가 | 낮음 |
| B | 신규 `/api/contracts/status-batch` 엔드포인트 | 신규 추가 | 단 1회 쿼리 | 중간 |
| C | `router.refresh()` 기반 RSC 리렌더 | 없음 | 페이지 전체 Supabase 재조회 | 낮음 |

**권장 방향 (옵션 C 우선, B는 50건 초과 시 고려):**

- 계약 목록 페이지를 Client Component로 래핑하고 `analyzing`/`parsing` 상태 계약이 1개 이상 존재할 때만 10초 interval `router.refresh()` 실행
- Supabase Free Tier 연결 수 제한 고려 시 옵션 A (병렬 개별 호출)보다 유리
- 계약이 50건 미만인 경우 옵션 C가 가장 단순하고 안전
- 옵션 B 구현 시 신규 route 파일 `app/api/contracts/status-batch/route.ts` 추가 필요:
  ```
  POST body: { ids: string[] }
  Response: { [id: string]: { status: string; done: boolean } }
  Supabase: .from("contracts").select("id, status").in("id", ids)
  ```

**신규 API 엔드포인트:** 옵션 C 선택 시 불필요. 옵션 B 선택 시 `status-batch` route 신규 추가.

---

### QW-5: RecentContracts 행 전체 클릭

**백엔드 변경 불필요.** 순수 프론트엔드 변경.

현재 `<tr>`에 `onClick`이 없고 `<td>` 내부 `<Link>`에만 라우팅이 연결되어 있다. `useRouter`를 추가하고 `<tr onClick={() => router.push(href)}`를 추가하는 것으로 완결된다.

주의: `RecentContracts.tsx`는 이미 `"use client"` 지시어가 있고 `useRouter`를 임포트하지 않은 상태이므로 임포트 추가 필요.

라우팅 대상 URL 로직은 이미 `<Link>` 내에 구현되어 있다:
- `item.status === "filtering"` → `/contracts/${item.id}/zones`
- 그 외 → `/contracts/${item.id}`

동일 로직을 `<tr onClick>` 핸들러에 재사용하면 된다.

---

### 기타 UI 개선 항목 중 숨겨진 백엔드 의존성

**QW-3 (`<a>` → `<Link>` 교체):**
- `UploadProgressPanel.tsx` L505, L565에서 `<a href>` 사용 확인 (각각 async 완료 블록과 sync summary 블록)
- `<Link>` 교체는 순수 프론트엔드 변경. 백엔드 영향 없음.
- 단, `UploadProgressPanel.tsx`는 이미 `"use client"`이지만 `import Link from "next/link"` 누락 상태. 임포트 추가 필요.

**ME-5 (lucide-react 아이콘 전환):**
- `AppShell.tsx`의 `NavItem`이 `icon?: string` prop을 emoji 문자열로 받음
- lucide-react는 이미 shadcn/ui와 함께 설치되어 있어 추가 패키지 불필요 (비용 제로 준수)
- `NavItemProps.icon` 타입을 `string | ReactNode`로 변경하면 하위 호환 가능

**LR-1 (모바일 반응형 사이드바):**
- `globals.css`의 `.sidebar { position: fixed; width: 260px }` + `.main-content { margin-left: 260px }` 구조가 breakpoint 없이 전역 적용
- `AppShell.tsx`에 zustand `useSidebarStore` 신규 추가 필요 (M3 범위이므로 신규 store 파일 생성 포함)
- 백엔드 변경 없음

---

## 7. 구현 시 주의사항 (QA 관점)

> 코드 직접 검토 기반 (qa-debugger 관점). 각 Quick Win 구현 시 발생할 수 있는 버그/사이드이펙트.

### QW-1: FileDropzone `isDragging` 상태 추가

**현재 코드 분석:**
- `handleDragEnter`: `e.preventDefault()` + `e.stopPropagation()` 후 상태 변경 없음
- `handleDragOver`: `e.preventDefault()` + `dropEffect = "copy"` — 드래그 지속 중 반복 호출됨
- `handleDrop`: `e.stopPropagation()` 있음, `isDragging` 리셋 로직 없음
- `handleDragLeave` 핸들러 자체가 없음 (파일을 컴포넌트 위로 이동만 해도 `dragLeave`가 발생하지 않음)

**엣지케이스 및 주의사항:**

1. `dragLeave` 이벤트 버블링 문제: 드롭존 내부의 자식 요소(`upload-icon`, `upload-title` 등) 위로 마우스가 이동할 때마다 부모에서 `dragLeave`가 발생 → `isDragging`이 false로 리셋되어 깜빡임 발생
   - 해결: `e.relatedTarget`이 드롭존 내부인지 확인하는 로직 필요, 또는 `dragLeave`에서 `e.currentTarget.contains(e.relatedTarget as Node)` 체크
   - 자식 요소들이 모두 `style={{ pointerEvents: "none" }}`이므로 이 문제는 실제로 발생하지 않을 수 있음 — 실행 환경 확인 필요

2. `disabled` 상태일 때 `handleDragEnter`가 `setIsDragging(true)`를 호출하지 않아야 함 — 현재 `handleDragEnter`에는 `if (disabled) return` 분기 없음. 일관성을 위해 추가 필요.

3. CSS `.upload-zone--dragging` 클래스가 `globals.css`에 아직 정의되지 않음 — 클래스 추가와 동시에 CSS도 추가 필요.

---

### QW-2: mapUploadError() 한국어 통일

**현재 코드 분석 (`app/upload/page.tsx` L112~126):**
```
"DOCLING_UNAVAILABLE" → 영어, 내부 경로 노출
"DOCLING_PARSE_FAILED" → 영어, 개발자 수준 메시지
"SUPABASE_INSERT_FAILED" / "SUPABASE_UNREACHABLE" → 한국어
"SUPABASE_SCHEMA_MISSING" → 한국어
fallback → 영어 ("Upload processing failed.")
```

**주의사항:**

1. `UploadProgressPanel.tsx` L459에 별도 하드코딩된 가이드 메시지 존재:
   ```
   가이드: `scripts/start_sidecar.bat` 실행 후, sidecar 준비 완료 상태에서 다시 업로드하세요.
   ```
   이 메시지는 `mapUploadError()`와 별개로 `showRetry` 조건일 때 렌더링됨. 한국어 통일 시 이 메시지도 함께 수정 필요.

2. 마지막 fallback `"Upload processing failed."`도 영어. 한국어 통일 대상에 포함할 것.

3. `UploadProgressPanel.tsx` L424~432에 `AbortError` 메시지와 일반 에러 메시지도 영어로 하드코딩됨 (`app/upload/page.tsx` L424~432). 종합적 한국어 통일 필요.

---

### QW-3: UploadProgressPanel `<a>` → `<Link>` 교체

**현재 코드 분석:**
- L505 (async 완료 블록): `<a href="/contracts/${contractId}">계약 상세 보기 →</a>`
- L565 (sync summary 블록): `<a href="/contracts/${contractId}">계약 상세 보기</a>`

**버그 주의:**

1. L486~513의 `!summary && contractId && liveStatus !== "parsing" && liveStatus !== "uploading" && liveStatus !== "error" && liveStatus !== "filtering"` 조건에서 `liveStatus === "analyzing"` 상태도 통과함
   - `analyzing` 상태에서 "파싱이 완료되었습니다" 메시지가 표시되는데, 실제로는 아직 분석 중 — 문구 수정 병행 권장
   - 이는 계획서 섹션 2에서 이미 H2 버그로 기록된 내용과 별개의 문구 이슈

2. `import Link from "next/link"` 누락 — 추가 필요. 현재 `UploadProgressPanel.tsx` import 목록에 없음.

---

### QW-4: 헤더 QuotaDisplayWrapper 제거

**현재 코드 분석 (`app/upload/page.tsx`):**
- L466 (hydration skeleton): `<QuotaDisplayWrapper />`
- L488 (메인 렌더): `<QuotaDisplayWrapper />`
- 두 곳 모두 `<header className="page-header">` 내부에 위치

**주의사항:**

1. hydration skeleton(L457~478)과 메인 렌더(L480~) 두 블록 모두 수정 필요. 하나만 제거하면 hydration mismatch 발생 가능.

2. `<div style={{ minWidth: 260 }}>` 래퍼도 함께 제거 필요. 단순히 `<QuotaDisplayWrapper />`만 제거하면 빈 `<div>` 잔류.

3. AppShell 사이드바의 `<QuotaDisplayWrapper />`가 `/upload` 경로에서도 정상 표시되는지 확인 필요. AppShell은 모든 경로에 감싸져 있으므로 이슈 없을 것으로 예상.

---

### QW-5: RecentContracts 행 전체 클릭

**현재 코드 분석 (`components/dashboard/RecentContracts.tsx`):**
- `<tr className="group border-b ... hover:bg-bg-hover">` — hover 스타일은 있으나 `onClick` 없음
- `<td>` 내부 `<Link>` — `filtering` 상태 분기 로직 포함

**엣지케이스 및 주의사항:**

1. `<tr onClick>` + 내부 `<Link>` 중복 내비게이션: `<Link>` 클릭 시 Link의 기본 동작 + `<tr onClick>` 모두 실행됨. 이중 라우팅 방지를 위해 `<Link>` 내부의 클릭 이벤트에 `e.stopPropagation()` 추가 또는 `<tr onClick>` 핸들러에서 이벤트 타겟 확인 필요.

2. 텍스트 선택 UX: `<tr>` 전체에 `cursor-pointer`를 추가해야 함. 현재 hover 스타일만 있고 cursor 스타일 없음.

3. 키보드 접근성: `<tr>`은 기본적으로 포커스 불가. `tabIndex={0}`과 `onKeyDown` (Enter/Space) 핸들러 추가가 WCAG 2.1 준수에 필요. 단, Quick Win 범위에서는 마우스 클릭만 구현하고 키보드 접근성은 별도 이슈로 분리 가능.

4. `fullList` 모드가 아닐 때(대시보드 위젯)에도 동일 컴포넌트가 사용됨. 행 클릭 동작이 두 컨텍스트 모두에서 일관되게 동작하는지 확인 필요.

---

### QW-6: nav-item focus ring 추가

**현재 코드 분석 (`app/globals.css`):**
- `.nav-item { ... }` 정의 확인
- `.nav-item:hover` 정의 있음
- `.nav-item.active` 정의 있음
- `:focus-visible` pseudo-class 정의 없음

**주의사항:**

1. `AppShell.tsx`의 `NavItem`이 `<Link href ...>` 컴포넌트 — Next.js `<Link>`는 기본적으로 `<a>` 태그로 렌더링되므로 브라우저 기본 focus ring이 존재하나 `.nav-item`의 전역 `outline: none`(또는 `* { outline: none }` 리셋)으로 억제되었을 수 있음. `globals.css` 상단의 `* { margin: 0; padding: 0; box-sizing: border-box; }` 리셋에는 outline 제거가 없으므로 브라우저 기본 ring이 살아있을 수 있음 — 실제 렌더 확인 필요.

2. `:focus-visible`은 마우스 클릭 시에는 발동하지 않고 키보드 탐색 시에만 발동 — UX에 적합함.

3. 다크 테마 배경(`--bg-secondary: #161821`)에서 기본 브라우저 focus ring(파란색 outline)이 잘 보이지 않을 수 있음. `outline: 2px solid var(--accent-blue)` + `outline-offset: 2px` 명시 권장.

---

### QW-7: UploadProgressPanel 완료 후 경과 시간 레이블 개선

**현재 코드 분석 (`components/upload/UploadProgressPanel.tsx`):**
- L321~333 (진행 중): `⏱ {formatElapsed(elapsedMs)}`
- L334~348 (완료 후, error 없을 때): `⏱ {formatElapsed(elapsedMs)}` — 동일한 포맷

**주의사항:**

1. `elapsedMs`가 `isTerminal = true`가 된 시점에 업데이트를 멈추도록 `useEffect`가 구성되어 있음 (L156: `if (!startTime || isTerminal) return`). 완료 시점의 `elapsedMs` 값이 고정되어 정확한 총 소요 시간 표시됨 — 동작 자체는 올바름.

2. 현재 완료 블록에 `aria-label="총 소요 시간: ..."` 이미 설정되어 있음 (L343). 시각적 레이블("⏱")만 "총:" 또는 "완료:" prefix로 변경하면 됨.

3. `!error` 조건으로 에러 시 완료 elapsed 블록이 숨겨짐 — 에러 상태에서도 소요 시간을 보여줄지 결정 필요. 현재 계획(QW-7)은 성공 완료 시만 대상으로 보임.

---

## 8. 구현 순서 권장

> PM 관점 — 의존성, 리스크, 테스트 용이성 기반 순서.

### Phase 1 — 독립 Quick Win (병렬 진행 가능, 각 1~20분)

아래 항목들은 서로 파일이 겹치지 않아 병렬 개발 가능.

| 순서 | ID | 파일 | 의존성 | 주의 |
|------|----|----|--------|------|
| 1-A | QW-6 | `globals.css` | 없음 | focus ring CSS 1줄 추가 |
| 1-B | QW-2 | `upload/page.tsx` | 없음 | `mapUploadError()` 한국어 + `UploadProgressPanel.tsx` L459 병행 |
| 1-C | QW-4 | `upload/page.tsx` | 없음 | skeleton + 메인 두 블록 모두 수정 |

### Phase 2 — Quick Win (단일 파일, 순차 권장)

| 순서 | ID | 파일 | 의존성 | 주의 |
|------|----|----|--------|------|
| 2-A | QW-1 | `FileDropzone.tsx` | `globals.css`에 `.upload-zone--dragging` 클래스 추가 필요 (1-A 이후) | dragLeave 버블링 처리 |
| 2-B | QW-3 | `UploadProgressPanel.tsx` | Link import 추가 | `analyzing` 상태 문구도 병행 수정 |
| 2-C | QW-7 | `UploadProgressPanel.tsx` | QW-3과 같은 파일 — 동일 PR에 묶는 것 권장 | |
| 2-D | QW-5 | `RecentContracts.tsx` | 없음 | `useRouter` import + `e.stopPropagation()` 처리 |

### Phase 3 — Medium Effort (P1, 순차 개발)

| 순서 | ID | 파일 | 의존성 | 주의 |
|------|----|----|--------|------|
| 3-A | ME-1 | `ZoneReviewView.tsx` | 없음 | undecidedCount 계산 + 가이드 메시지 |
| 3-B | ME-2 | `ZoneReviewList.tsx` | 없음 | confidence 색상/레이블 변환 |
| 3-C | ME-5 | `AppShell.tsx` | lucide-react 설치 완료 | NavItem props 타입 변경 |
| 3-D | ME-4 | `UploadProgressPanel.tsx` | 없음 | 인라인 스타일 Tailwind 전환 (가장 작업량 많음) |
| 3-E | ME-3 | `ContractDetailView.tsx` | 없음 | 필터 바 레이아웃 고정 |

### Phase 4 — 큰 리팩터링 (P2/P3, M2 완료 후 착수)

| 순서 | ID | 파일 | 백엔드 변경 | 예상 시간 |
|------|----|----|------------|---------|
| 4-A | LR-2 | `lib/data/contracts.ts`, `app/contracts/page.tsx` | `getContractList()` offset/limit/sort 파라미터 추가 | 2~3시간 |
| 4-B | LR-3 | `app/contracts/page.tsx` → Client Component 래핑 | 신규 API 불필요 (옵션 C 선택 시) | 3~4시간 |
| 4-C | LR-1 | `globals.css`, `AppShell.tsx` | 없음 (zustand store 추가) | 4~6시간 |

### 우선순위 결정 원칙

1. **Phase 1~2 (Quick Win)를 먼저 완료**: 총 ~65분, 가시적 품질 향상, 리그레션 리스크 낮음
2. **M2 핵심 기능(FIDIC 매핑, 리스크 시각화)과 병행**: UI Quick Win은 M2 진행을 블로킹하지 않음
3. **Phase 4 (LR-*)는 M2 완료 후 착수**: 백엔드 변경 포함, 충분한 테스트 시간 확보 필요
4. **LR-3을 LR-2보다 낮은 우선순위로 유지**: 폴링 로직 추가는 Supabase 연결 수에 영향을 줄 수 있어 Free Tier 제약 하에서 신중하게 접근

---

## 9. 파싱-UI 연결 검토 (doc-expert 관점)

> 분석 기준: 2026-03-14. Docling sidecar, docling-adapter.ts, ZoneReviewView, parsing-quality-improvement-plan.md 직접 검토 기반.

---

### 9-1. 파싱-UI 연결 갭

#### `header_footer_info` — 데이터 전달은 되나 핵심 정보 미표시

`UploadProgressPanel`의 `ProcessSummary`가 `documentNumber`, `removedHeaderFooterCount`만 표시하고, sidecar가 반환하는 더 풍부한 데이터(`header_pattern` 반복 헤더 텍스트, `footer_patterns` 전체 목록, `page_number_style`)는 버려진다.

반복 헤더 감지("General Conditions of Contract"가 118페이지에서 제거됨)는 파싱이 올바르게 작동했다는 신뢰 신호인데, "헤더/푸터 제거: N건"으로만 뭉뚱그려 표시해 낭비하고 있다.

#### `document_parts` — adapter↔UI 연결은 완성, **DB 저장이 누락**

`ZoneReviewView`는 `documentParts` prop을 받아 그룹핑을 수행하고, `ZoneReviewList`는 렌더링 코드가 있다. 그러나 `process-contract.ts`의 비구조화에서 `documentParts`가 폐기되고 DB에 저장되지 않으므로, `/api/contracts/[id]/zones` GET이 항상 `undefined`를 반환한다. 즉 그룹핑 UI는 구현됐으나 실제로 동작하지 않는다.

> **영향:** ME-1(미결정 항목 카운트), ME-2(confidence 색상)는 document_parts 그룹핑이 동작해야 온전한 효과를 발휘한다. DB 저장 갭 해소가 Phase 3 착수 전 선행 조건이다.

#### `toc_entries` — UI 컴포넌트 구현됨, **데이터 경로 단절**

`ZoneReviewView`에 `TocPreviewPanel` 연결 코드가 있고, `upload/page.tsx`의 `ZonesApiResponse`가 `toc_entries`를 기다리고 있으나, `/api/contracts/[id]/zones` GET이 실제로 반환하지 않아 항상 `undefined`다. `TocPreviewPanel`은 현재 dead code 상태.

#### `sub_documents` — 2-depth 그룹핑 UI 미완

sidecar가 `sub_documents`를 반환하고, adapter에 `subDocuments?` 필드가 있으나, `ZoneReviewList`의 2-depth 렌더링이 구현되지 않았다. `parsing-quality-improvement-plan.md` P3(미완료)와 일치.

---

### 9-2. 현재 UI에서 표시되지 않는 중요 파싱 정보

#### `warnings` — 파싱 품질 경고가 사용자에게 전혀 전달되지 않음

sidecar의 `warnings[]`는 TOC 불일치, 부분 파싱 실패, 스캔 문서 감지 등을 포함한다. `DoclingParseResult.warnings`가 존재하지만 `UploadProgressPanel`이나 `ZoneReviewView` 어디에서도 렌더링하지 않는다.

"TOC에 p16 표기된 'General Conditions'가 document_part로 미감지되어 TOC 기반 삽입됨"이라는 경고는 zone 검토 단계에서 사용자 이해를 결정적으로 돕는 정보다.

#### `scan_detected` — 스캔 문서 업로드 시 구별 안내 없음

sidecar는 텍스트 레이어 없는 스캔 PDF를 HTTP 422 + `scan_detected: true`로 반환하지만, adapter는 이를 일반 `DOCLING_PARSE_FAILED`로 매핑한다. 사용자는 "파싱 실패" 메시지만 보고 왜 실패했는지, 어떻게 해결해야 하는지 알 수 없다.

QW-2(에러 메시지 개선)와 함께 처리해야 한다.

#### `models_ready: false` — 파싱 지연 원인 미표시

sidecar `/health` 응답의 `models_ready: false`는 모델 로딩 중임을 의미한다. 이 상태에서 parse 요청 시 대기가 길어지는데, UI는 시간 기반 cycling 메시지("Docling 모델 초기화 중...")만 보여준다. 실제 상태를 폴링해 "최초 실행 — 파서 모델 준비 중(1~3분)" 안내를 제공할 수 있다.

---

### 9-3. ME-2 confidence 기준 재조정 필요

`docling-adapter.ts`의 실제 confidence 분포는 다음과 같다.

| 감지 방법 | confidence |
|-----------|-----------|
| document_parts 패턴 매칭 + TOC 확인 | 0.95 |
| 분석 대상 zone (section fallback) | 0.92 |
| TOC/커버페이지 | 0.85 |
| level ≤ 1 section | 0.80 |
| level > 1 section | 0.75 |

ME-2에서 제안한 색상 기준(0.8 / 0.5)은 이 분포에서 "저신뢰(< 0.5)" 케이스가 실질적으로 없어 의미 없는 구분이 된다. **기준을 0.90 / 0.82로 조정**해야 실제 zone의 감지 품질 차이를 의미 있게 색상으로 표현할 수 있다.

---

### 9-4. Zone 검토 UX 보완 권장 사항

**`zone_type` 레이블 미표시**

`ZoneCard`는 confidence만 표시하고 `zone_type`(`general_conditions`, `appendices` 등)은 표시하지 않는다. `is_analysis_target: false` zone(TOC, 커버페이지, 부록)은 기본 제외 권장, `true`는 기본 포함 권장임을 "분석 대상" / "비분석 대상" 레이블로 표시하면 사용자 결정을 돕는다.

**Zone 텍스트 미리보기 부재**

zone_type이 `contract_body`(분류 실패 fallback)인 경우 내용을 보지 않으면 포함/제외 결정이 불가능하다. `ZoneItem.text`를 접힘/펼침 방식으로 첫 200자 미리보기로 제공하는 것을 권장한다.

**ME-1 보완 제안**

미결정 카운트에 더해 "저신뢰(confidence < 0.82) 항목 N개 미결정"처럼 파싱 품질 맥락을 함께 표시하고, document_parts 그룹핑이 활성화된 경우 "X 파트에 미결정 항목 있음"으로 위치를 안내하면 UX가 대폭 향상된다.

---

### 9-5. 두 계획 간 불일치 및 누락

| 구분 | 내용 | 권장 조치 |
|------|------|----------|
| **모순** | ME-2(confidence 색상)가 `parsing-quality-improvement-plan.md` 완료 목록과 중복 가능 — 실제 구현 여부 확인 필요 | 코드 확인 후 중복 시 ME-2 닫기 |
| **우선순위 불일치** | Phase 3(ME-1, ME-2)가 DB 저장 완료를 전제하나 명시적 선행 조건 없음 | Phase 3 착수 조건에 "migrations 006 + zones GET 갱신 완료" 추가 |
| **누락** | `warnings` 배열 UI 표시 — 두 계획 모두 없음 | 아래 추가 권장 항목 참조 |
| **누락** | 스캔 문서 전용 에러 분기 — 두 계획 모두 없음 | QW-2와 병합 처리 |
| **누락** | `models_ready` 상태 기반 파싱 지연 안내 — 두 계획 모두 없음 | 아래 추가 권장 항목 참조 |

---

### 9-6. 추가 권장 UI 항목

#### HIGH

| ID | 항목 | 파일 | 선행 조건 |
|----|------|------|----------|
| P-H1 | 파싱 `warnings` 배너: ZoneReviewView 상단 또는 UploadProgressPanel 완료 요약에 경고 목록 표시 | `ZoneReviewView.tsx`, `UploadProgressPanel.tsx` | 없음 (warnings 필드 이미 존재) | ✅ 완료 |
| P-H2 | 스캔 문서 전용 에러 메시지: `DOCLING_PARSE_FAILED` + `scan_detected: true` 시 "OCR 처리 후 재업로드" 안내 분기 | `app/upload/page.tsx` | QW-2와 동시 처리 | ✅ 완료 |
| P-H3 | Phase 3 착수 조건 명시: `migrations/006`, `process-contract.ts` 갱신, `zones GET` 갱신 완료를 ME-1/ME-2 선행 조건으로 문서화 | `docs/ui-improvement-plan.md` | — |

#### MEDIUM

| ID | 항목 | 파일 | 선행 조건 |
|----|------|------|----------|
| P-M1 | ME-2 confidence 기준 재조정: 0.8/0.5 → **0.90/0.82** | `ZoneReviewList.tsx` | 없음 |
| P-M2 | ZoneCard에 `zone_type` 레이블 추가: "분석 대상" / "비분석 대상" 구분 | `ZoneReviewList.tsx` | 없음 |
| P-M3 | TocPreviewPanel 데이터 경로 연결: zones GET에서 `toc_entries` 반환 후 `upload/page.tsx` prop 전달 | `zones/route.ts`, `upload/page.tsx` | DB 저장 선행 |
| P-M4 | `models_ready: false` 감지 시 "파서 모델 준비 중(1~3분)" 안내 | `app/upload/page.tsx` | 없음 |

#### LOW

| ID | 항목 | 파일 | 선행 조건 |
|----|------|------|----------|
| P-L1 | Zone 텍스트 미리보기: ZoneCard 접힘/펼침으로 본문 첫 200자 표시 | `ZoneReviewList.tsx` | 없음 |
| P-L2 | ContractDetailView 헤더에 문서 번호 + 총 페이지 표시 | `ContractDetailView.tsx`, `lib/data/contracts.ts` | DB 저장 선행 |
| P-L3 | UploadProgressPanel 완료 요약에 감지된 헤더 패턴 표시 | `UploadProgressPanel.tsx` | 없음 |

---

### 9-7. 핵심 결론

두 계획은 전반적으로 일관성이 높고 상호 보완적으로 설계되어 있다.

**가장 큰 구조적 문제 하나:**

> `parsing-quality-improvement-plan.md`의 DB 저장 갭(`migrations/006`, `process-contract.ts`, `zones/route.ts` 수정)이 완료되지 않으면, `zones GET`이 항상 빈 `document_parts`·`toc_entries`를 반환한다. `ZoneReviewView` 그룹핑 UI, `TocPreviewPanel`, warnings 표시가 모두 이 데이터에 의존하므로, **Phase 3 착수 전 DB 저장 갭 해소가 필수 선행 조건**이다.

**두 계획 모두에서 빠진 항목:**

- `warnings` 배열 UI 표시
- 스캔 문서 전용 에러 분기 (`scan_detected`)
- `models_ready` 상태 기반 파싱 지연 안내

---

## 10. 문장 정렬 (Text Alignment) 분석 및 계획

> 분석 기준: 2026-03-14. `ContractDetailView.tsx`, `globals.css`, `tailwind.config.ts` 직접 검토 기반.

---

### 10-1. 현황 분석

#### 조항 본문 (`clause.text`) — `ClauseDocumentItem` line 242

현재 클래스:
```
text-[13px] leading-relaxed text-text-primary/80 whitespace-pre-wrap break-words
```

**핵심 충돌: `whitespace-pre-wrap`과 `text-justify`는 병용 불가능하다.**

CSS Text Level 3 스펙(§7.3)은 forced line break(강제 줄바꿈) 위치에서 justification을 억제한다. `whitespace-pre-wrap`은 원본 텍스트의 모든 `\n`을 forced line break로 변환하므로, 조항 본문의 각 문단 끝은 항상 forced break로 끝난다. 이 상태에서 `text-align: justify`를 적용하면 브라우저는 거의 모든 줄을 "마지막 줄"로 간주하여 정렬 효과를 억제한다. 실제 렌더링은 `text-left`와 구별 불가능하며, 일부 줄에서만 우연히 justify가 적용되어 시각적 불일치가 발생한다.

**결론: `clause.text` 영역에는 `text-justify`를 적용하지 않는다.**

#### 한국어+영어 혼합 문서와 `text-justify` 렌더링 품질

Noto Sans KR은 비례폭(proportional) 폰트로, 브라우저의 자동 하이픈 사전(CSS `hyphens: auto`)이 한국어 언어(`lang="ko"`)에 대해 지원되지 않는다. 한국어+영어 혼합 문서에 justify를 적용하면:

- 한국어 어절 사이 자간이 불규칙하게 늘어남 (어색한 공백)
- 영어 단어는 `hyphens: auto` 적용 시 하이픈 처리되지만, 동일 줄의 한국어 부분은 하이픈 없이 강제 확장
- 특히 FIDIC 조항 번호, 영문 법률 용어, 한국어 설명이 혼재하는 줄에서 가독성이 좌측 정렬보다 오히려 낮아짐

**결론: 조항 본문과 분석 텍스트 전체에 `text-left`를 유지한다. 한국어 법률 문서에서 `text-justify`는 가독성 개선이 아닌 저하를 유발한다.**

#### `hyphens: auto` 적용 가능성

`hyphens: auto`를 적용하려면 요소 또는 조상에 `lang="en"` 속성이 있어야 영어 하이픈 사전이 활성화된다. 이 앱의 계약서는 한국어 주언어이므로 `lang="en"` 설정은 부정확하다. `hyphens: auto`는 이 프로젝트에 적합하지 않으므로 적용하지 않는다.

#### `text-justify` + `text-align-last: left` 패턴

Tailwind의 `last:text-left`는 flex/grid 자식 요소의 마지막 _항목_에 적용되며, 텍스트 블록의 마지막 _줄_에는 적용되지 않는다. 텍스트 마지막 줄 단독 처리는 `text-align-last: left`(CSS 네이티브 속성)를 `globals.css`에 추가해야 하나, `whitespace-pre-wrap` 충돌이 해소되지 않은 상태에서 이 패턴은 의미가 없다. 구조적 개선(아래 참조) 이후에 재검토한다.

---

### 10-2. 영역별 정렬 방침 결정

| 영역 | 현재 정렬 | 권장 정렬 | 이유 |
|------|----------|----------|------|
| `clause.text` 본문 | `text-left` (implicit, `pre-wrap`) | `text-left` 유지 | `pre-wrap` 충돌 + 한국어 justify 품질 문제 |
| `risk_summary` | `text-left` (implicit) | `text-left` 유지 | 한국어+영어 혼합, 짧은 단락 |
| `recommendations` 목록 항목 | `text-left` (implicit) | `text-left` 유지 | 목록 아이템은 justify 효과 없음 |
| FIDIC 비교 텍스트 | `text-left` (implicit) | `text-left` 유지 | 11px + 저대비 색상, justify 금지 |
| 조항 헤더 (prefix, number, title) | `text-left` (flex row 내부) | `text-left` 유지 | 단일 줄 요소, justify 효과 없음 |
| 배지 / 레이블 | `inline-flex` 중앙 | 변경 없음 | 정렬 방식 관계 없음 |
| 서브도큐먼트 헤더 | `text-left` (inline style) | `text-left` 유지, Tailwind로 전환 | P3 항목 (아래 TA-3) |
| 필터 탭 / 버튼 텍스트 | `text-left` / 중앙 | 변경 없음 | UI 컨트롤, 정렬 변경 불필요 |

---

### 10-3. 구조적 개선 기회 (중장기)

현재 `clause.text`는 하나의 `<div>`에 전체 조항 원문을 `whitespace-pre-wrap`으로 덤프한다. 이 구조를 유지하는 한 `text-justify`는 실용적으로 적용 불가능하다.

향후 조항 본문의 가독성을 높이려면 다음 구조적 전제가 필요하다:

1. `whitespace-pre-wrap`을 제거하고 `\n\n` 구분자 기준으로 텍스트를 `<p>` 태그로 분리
2. 단일 줄 `\n`은 `<br>`로 처리하거나 공백으로 병합
3. 각 `<p>`에 `text-left leading-relaxed`와 `mb-3` 간격 적용
4. 이 구조 완성 후 `text-align-last: left`와 함께 `text-justify` 시험 적용 가능

이 작업은 최소 2시간 이상의 리팩터링이므로 Quick Win이 아닌 중급 리팩터링으로 분류한다.

---

### 10-4. 실행 항목 (Text Alignment)

| ID | 파일 | 작업 | 예상 시간 | 우선도 |
|----|------|------|----------|-------|
| TA-1 | `ContractDetailView.tsx` | `clause.text` 렌더링을 `<div whitespace-pre-wrap>` → `\n\n` 분할 `<p>` 구조로 전환. `whitespace-pre-wrap` 제거, `text-left leading-relaxed mb-3` 각 단락 적용 | 1.5시간 | P2 |
| TA-2 | `ContractDetailView.tsx` (`ClauseInlineAnalysis`) | `risk_summary` `<p>`: 현재 `text-left` 유지 확인 — 별도 변경 불필요. FIDIC 비교 텍스트 `text-[11px]` → `text-xs` 통일 + 대비 개선 연계 (Readability Audit P3 항목과 병합) | 30분 | P3 |
| TA-3 | `ContractDetailView.tsx` (서브도큐먼트 헤더) | 인라인 `style` 객체 → Tailwind 클래스 전환. `border-l-2 border-accent-blue bg-bg-tertiary rounded px-3 py-2 mt-5 mb-1` | 20분 | P3 |
| TA-4 | `globals.css` (`.clause-body`) | 이미 `text-align` 미지정 상태 — `text-align: left` 명시적으로 추가하여 의도 문서화. 향후 전역 justify 시도 시 회귀 방지용 | 5분 | P4 |

---

### 10-5. 전체 통합 구현 계획 — 최종 우선순위 표

기존 계획(Phase 1~4, P-H/P-M/P-L 항목)과 Readability Audit(P1~P4 항목), Text Alignment 항목(TA-1~4)을 통합한 단일 우선순위 표.

> 상태 범례: ✅ 완료 / 미착수(빈칸)

#### 즉시 실행 가능 (Quick Win, ~65분 총합) — 전부 완료

| 우선도 | ID | 파일 | 설명 | 예상 시간 | 상태 |
|--------|----|----|------|---------|------|
| P0 | QW-1 | `FileDropzone.tsx` | 드래그 시각 피드백 추가 | 15분 | ✅ |
| P0 | QW-2 | `upload/page.tsx` | 에러 메시지 한국어 통일 + 내부 경로 제거 | 10분 | ✅ |
| P0 | QW-3 | `UploadProgressPanel.tsx` | `<a>` → `<Link>` 교체 | 5분 | ✅ |
| P0 | QW-4 | `upload/page.tsx` | 헤더 QuotaDisplayWrapper 중복 제거 | 5분 | ✅ |
| P0 | QW-5 | `RecentContracts.tsx` | 테이블 행 전체 클릭 가능하게 | 20분 | ✅ |
| P0 | QW-6 | `globals.css` | nav-item focus ring 추가 | 5분 | ✅ |
| P0 | QW-7 | `UploadProgressPanel.tsx` | 완료 후 경과 시간 레이블 개선 | 5분 | ✅ |

#### P1 — 고우선도 (파싱-UI 연결 + 조항 가독성 핵심)

| 우선도 | ID | 파일 | 설명 | 예상 시간 | 상태 |
|--------|----|----|------|---------|------|
| P1 | ME-1 | `ZoneReviewView.tsx` | 미결정 항목 카운트 + 가이드 메시지 | 30분 | ✅ |
| P1 | ME-2 | `ZoneReviewList.tsx` | confidence 색상 코딩 (기준 0.90/0.82) | 30분 | ✅ |
| P1 | ME-3 | `ContractDetailView.tsx` | 필터 바 2행 레이아웃 고정 | 45분 | ✅ |
| P1 | ME-4 | `UploadProgressPanel.tsx` | 인라인 스타일 → Tailwind 전환 | 1시간 | ✅ |
| P1 | ME-5 | `AppShell.tsx` | lucide-react 아이콘 전환 | 1시간 | ✅ |
| P1 | P-H1 | `ZoneReviewView.tsx`, `UploadProgressPanel.tsx` | 파싱 warnings 배너 표시 | — | ✅ |
| P1 | P-H2 | `app/upload/page.tsx` | 스캔 문서 전용 에러 분기 | — | ✅ |
| **P1** | **RA-1** | `ContractDetailView.tsx` | **조항 본문 폰트: `font-mono` 제거 → Noto Sans KR 상속** | **20분** | |
| **P1** | **RA-2** | `globals.css` | **`--text-secondary` 대비 개선: `#9496A8` → `#B0B2C3` (4.5:1 달성)** | **10분** | |

#### P2 — 중우선도 (레이아웃 구조 + 조항 본문 구조 개선)

| 우선도 | ID | 파일 | 설명 | 예상 시간 | 상태 |
|--------|----|----|------|---------|------|
| P2 | LR-1 | `globals.css`, `AppShell.tsx` | 모바일 반응형 사이드바 | 4~6시간 | ✅ |
| P2 | LR-2 | `contracts/page.tsx` | 계약 목록 페이지네이션 | 2~3시간 | ✅ |
| **P2** | **TA-1** | `ContractDetailView.tsx` | **`clause.text` 렌더링: `whitespace-pre-wrap` 단일 div → `\n\n` 분할 `<p>` 구조 전환** | **1.5시간** | |
| **P2** | **RA-3** | `ContractDetailView.tsx` | **카드 간격 `space-y-3` → `space-y-4` 또는 `space-y-5`, 선택적 구분선 추가** | **15분** | |
| P2 | P-M1 | `ZoneReviewList.tsx` | ME-2 confidence 기준 재조정: 0.90/0.82 반영 확인 | — | |
| P2 | P-M2 | `ZoneReviewList.tsx` | ZoneCard에 `zone_type` 레이블 ("분석 대상" / "비분석 대상") 추가 | — | |
| P2 | P-M4 | `app/upload/page.tsx` | `models_ready: false` 감지 시 "파서 모델 준비 중" 안내 | — | |

#### P3 — 저우선도 (폴리시 + 인라인 스타일 정리)

| 우선도 | ID | 파일 | 설명 | 예상 시간 | 상태 |
|--------|----|----|------|---------|------|
| P3 | LR-3 | `contracts/page.tsx` | 분석 중 계약 실시간 상태 갱신 | 3~4시간 | ✅ |
| **P3** | **TA-2** | `ContractDetailView.tsx` | **분석 패널 텍스트 크기 통일 + FIDIC 섹션 대비 개선 (Readability Audit P3-12와 병합)** | **30분** | |
| **P3** | **TA-3** | `ContractDetailView.tsx` | **서브도큐먼트 헤더 인라인 style → Tailwind 전환** | **20분** | |
| P3 | RA-4 | `ContractDetailView.tsx` | 분석 섹션 레이블 `text-xs uppercase` → `text-[11px] font-semibold` (uppercase 제거) | 10분 | |
| P3 | RA-5 | `ContractDetailView.tsx` | "분석 미완료" 상태에 아이콘 + 간단한 액션 힌트 추가 | 15분 | |
| P3 | RA-6 | `ContractDetailView.tsx` | collapsible 애니메이션 `grid-rows` 트릭 유지, `opacity` 트랜지션 개선 | 20분 | |
| P3 | P-M3 | `zones/route.ts`, `upload/page.tsx` | TocPreviewPanel 데이터 경로 연결 (DB 저장 선행 필요) | — | |

#### P4 — 향후 고려 (구조적 재설계 필요)

| 우선도 | ID | 파일 | 설명 | 예상 시간 | 상태 |
|--------|----|----|------|---------|------|
| **P4** | **TA-4** | `globals.css` | **`.clause-body`에 `text-align: left` 명시 추가 (의도 문서화)** | **5분** | |
| P4 | P-L1 | `ZoneReviewList.tsx` | Zone 텍스트 접힘/펼침 200자 미리보기 | — | |
| P4 | P-L2 | `ContractDetailView.tsx` | 헤더에 문서 번호 + 총 페이지 표시 (DB 저장 선행) | — | |
| P4 | P-L3 | `UploadProgressPanel.tsx` | 완료 요약에 감지된 헤더 패턴 표시 | — | |

---

### 10-6. Text Alignment 결정 사항 요약

1. **이 프로젝트에서 `text-justify`를 clause 본문에 적용하지 않는다.** `whitespace-pre-wrap`과의 CSS 스펙 충돌, 한국어 justify 렌더링 품질 저하가 주요 이유다.

2. **`hyphens: auto`는 적용하지 않는다.** 한국어 주언어 문서에서 `lang="en"` 설정이 부정확하며, 혼합 텍스트에서 렌더링 불일치를 유발한다.

3. **TA-1(clause.text 구조 개선)은 P2 우선도로 분류한다.** `whitespace-pre-wrap` 제거와 `<p>` 분리가 완료된 이후에만 `text-justify` 재검토가 의미 있다. 해당 시점에서 `risk_summary` 영역을 파일럿 대상으로 검토한다.

4. **즉시 적용 가능한 정렬 개선은 RA-1(폰트 전환)과 RA-2(대비 개선)다.** 정렬 방식이 아닌 폰트와 색상 개선이 조항 본문 가독성에 더 즉각적인 효과를 낸다.
