---
name: project_bug_patterns
description: 2026-03-14 전체 UI 감사에서 발견된 버그 패턴 및 컴포넌트별 알려진 이슈
type: project
---

# 전체 UI 감사 결과 요약 (2026-03-14)

**Why:** 첫 전체 감사 시 발견된 버그들을 기록하여 재발 감시 및 후속 세션 참고용으로 활용
**How to apply:** 이 파일들을 수정하거나 관련 컴포넌트 리뷰 시 이 패턴들을 우선 확인

## 확인된 주요 버그 패턴

### 1. Zustand 전체 스토어 구독 (ContractDetailView.tsx)
- `useContractDetailViewStore()` 를 selector 없이 전체 객체로 구독
- Set<string> 타입을 포함한 객체 전체를 반환하므로 얕은 비교 실패 → 매 액션마다 리렌더링

### 2. AppShell.tsx fetch 메모리 누수 (pathname 변경 시)
- pathname 변경마다 새 fetch 요청 발생하지만 AbortController 없어 이전 응답이 언마운트 후 setSupabaseConfigured 호출 가능

### 3. upload/page.tsx store 전체 구독
- `const store = useUploadStore()` 로 전체 스토어 구독 → store 내 어떤 필드가 바뀌어도 페이지 전체 리렌더

### 4. ContractDetailView.tsx runAnalysis 에러 핸들링 누락
- try 블록에서 catch 없음 → 네트워크 오류 시 analyzing=true 상태로 고착

### 5. RecentContracts.tsx 삭제 모달 접근성
- confirmId 모달이 focus trap 없음 → 키보드 사용자가 모달 바깥으로 탈출 가능

### 6. GeminiKeySetupWrapper.tsx SSR 가드 불필요 패턴
- `typeof window !== "undefined"` 체크가 useEffect 내부에서 실행되므로 사실상 불필요하지만 무해함

### 7. settings/page.tsx load 함수 stale closure
- load 함수가 useEffect 의존성 배열에 없음 (load는 컴포넌트 내 함수이며 매 렌더마다 재생성)

### 8. TopRiskCategories 하드코딩 카테고리
- 실제 DB 데이터 없이 count: 0 고정값만 표시 → 실제 분석 결과와 무관한 UI

### 9. ContractDetailView 렌더링 버그 (index key in subdoc headers)
- subdoc 헤더 key에 `clause.subDocumentTitle-${index}` 사용 → 동일 타이틀이 여러 위치에 나타날 때 key 충돌 가능

### 10. UploadProgressPanel Date.now() SSR 비결정적 값
- `stageEnteredAtRef.current = Date.now()` 가 컴포넌트 초기화 시 SSR/CSR 불일치 가능 (useRef 초기값으로 사용)

## 삭제 버그 심층 분석 (2026-03-14 업데이트)

### 버그 핵심: RLS 조용한 실패 + 에러 메시지 부정확

**관련 파일:**
- `app/api/contracts/[id]/route.ts:63-100` — DELETE 핸들러
- `lib/supabase/admin.ts:18-24` — Admin client 생성
- `lib/auth/server.ts:37-55` — 인증 (PLACEHOLDER_USER_ID)
- `components/dashboard/RecentContracts.tsx:146-164` — 클라이언트 삭제 호출
- `supabase/migrations/002_rls_policies.sql` — RLS 정책

**삭제 플로우 분석:**
1. 클라이언트: `fetch('/api/contracts/${id}', { method: "DELETE" })` — Authorization 헤더 없음
2. 서버 인증: dev에서 PLACEHOLDER_USER_ID 반환, prod에서 401
3. DELETE 핸들러: dev에서 user_id 조건 없이 삭제 시도 (line 85)
4. Supabase: Service Role Key가 올바르면 RLS 우회 → 삭제 성공해야 함

**근본 원인 후보 (우선순위순):**
1. `.env.local`의 SUPABASE_SERVICE_ROLE_KEY가 실제 service_role 키가 아닌 anon key일 경우 → RLS 적용 → auth.uid()=NULL → 빈 결과
2. Service Role Key가 맞더라도 `.delete().select("id")` 패턴이 빈 배열 반환하는 Supabase JS 버전 이슈
3. 실제 레코드가 DB에 없는 경우 (이미 삭제되었거나 ID 불일치)

**구조적 문제:**
- DELETE 결과가 빈 배열일 때 RLS 차단 vs 레코드 미존재를 구분하지 못함 (line 94-95)
- deleteError=null + deleted=[] 경로에 대한 서버 로깅 없음 → 디버깅 불가
- GET /api/contracts에 user_id 필터 없음 → prod에서 다른 사용자 계약 보이지만 삭제 불가 불일치

**FK CASCADE 상태:** 모든 자식 테이블 (document_zones, clauses, clause_analyses)에 ON DELETE CASCADE 설정 확인 → FK는 원인 아님

**확인 방법:**
1. supabase status 명령으로 service_role key 확인
2. curl -X DELETE http://localhost:3000/api/contracts/<id> 실행 후 서버 로그 확인
3. Supabase Dashboard에서 contracts 테이블 직접 조회

---

## 계약 상세 페이지 집중 감사 (2026-03-14)

검사 파일:
- app/contracts/[id]/page.tsx
- app/contracts/[id]/layout.tsx
- app/contracts/[id]/report/page.tsx
- app/contracts/page.tsx
- components/contract/ContractDetailView.tsx
- components/contract/ZoneReviewView.tsx
- components/contract/ZoneReviewList.tsx
- components/contract/ContractTabNav.tsx
- components/contract/TocPreviewPanel.tsx
- components/contracts/AutoRefreshWrapper.tsx
- lib/stores/contract-detail-view.ts
- lib/stores/upload-store.ts

### BUG-A: Zustand Set<string> 동일성 비교 실패 → 과도한 리렌더링
파일: components/contract/ContractDetailView.tsx:308
- expandedClauseIds를 개별 selector로 구독하지만 Set<string>은 매 set() 호출 시 new Set()으로 새 참조가 생성됨
- zustand 기본 비교(Object.is)가 항상 false → expandedClauseIds selector를 사용하는 모든 컴포넌트가 매번 리렌더
- 해결: shallow 비교가 Set에 적용되지 않으므로 useShallow 혹은 Set→Array 전환 필요

### BUG-B: ContractDetailView searchParams 타입 – Next.js 15 비호환
파일: app/contracts/page.tsx:26
- searchParams 타입이 `{ page?: string; sort?: string; order?: string }` (동기 객체)
- Next.js 15부터 searchParams는 Promise<...>가 됨 — 이미 params는 Promise로 처리하면서 searchParams는 동기 타입으로 선언
- 현재 Next.js 14 사용 중이므로 런타임 오류는 없으나, params를 Promise로 처리한 것과 불일치

### BUG-C: ZoneReviewView warnings 리스트 key=index
파일: components/contract/ZoneReviewView.tsx:224
- warnings 배열에서 key={i} 사용
- 경고 메시지가 동적으로 변경될 경우 React reconciliation 오작동 가능

### BUG-D: TocPreviewPanel warnings 리스트 key=index
파일: components/contract/TocPreviewPanel.tsx:44
- warnings 배열, tocEntries 배열 모두 key={i} 사용 (라인 44, 99)
- 목차 항목이 재정렬되거나 동적 변경 시 DOM 재사용 오류

### BUG-E: ContractTabNav - "구역 분류" 탭 href 미등록 라우트
파일: components/contract/ContractTabNav.tsx:14
- tabs[0].href = `/contracts/${contractId}/zones` 인데, 해당 라우트(app/contracts/[id]/zones/page.tsx)가 이 프로젝트에 존재하지 않을 가능성
- 실제 zone 리뷰는 upload flow 완료 후 ZoneReviewView가 렌더되는 구조이므로, 분석 후 해당 탭 클릭 시 404

### BUG-F: ContractDetailView - runAnalysis가 "use client" 컴포넌트 내 async 이벤트 핸들러, AbortController 없음
파일: components/contract/ContractDetailView.tsx:403-434
- 사용자가 분석 실행 버튼을 빠르게 두 번 클릭하면 두 번째 클릭은 `analyzing` 상태로 막히지만, 첫 번째 fetch 완료 전 컴포넌트 언마운트 시 setMessage / setAnalyzing이 언마운트된 컴포넌트에서 호출됨
- AbortController 미사용, cleanup 없음

### BUG-G: report/page.tsx - 테이블 key를 배열 인덱스(row.no)로 사용
파일: app/contracts/[id]/report/page.tsx:78
- rows.map((row) => <tr key={row.no}> — row.no는 index+1이므로 사실상 인덱스 key와 동일
- 조항이 정렬/필터되면 key 충돌 발생 가능

### BUG-H: ContractDetailView 필터된 조항 수 표시 조건식 — 0 렌더 위험 없음(확인됨)
파일: components/contract/ContractDetailView.tsx:661
- `{(조건) ? <div>...</div> : null}` 패턴으로 `&&` 단락 평가를 사용하지 않아 0 렌더 버그는 없음 — 이상 없음

### BUG-I: AutoRefreshWrapper - router 객체가 useEffect 의존성에 포함되어 있으나 router는 안정적이지 않은 참조
파일: components/contracts/AutoRefreshWrapper.tsx:47
- [hasActiveContracts, router] 중 router는 Next.js useRouter() 반환값
- Next.js 14 App Router에서 useRouter()는 stable reference이나, 이는 암묵적 가정에 의존
- 실질적 버그 가능성은 낮으나 router를 의존성에서 제거하는 것이 더 안전

### BUG-J: upload-store - sessionStorage persist가 SSR에서 hydration 불일치 유발
파일: lib/stores/upload-store.ts:59-92
- persist middleware + createJSONStorage(() => sessionStorage)
- SSR 시 sessionStorage가 없으므로 서버에서는 INITIAL_STATE, 클라이언트에서는 persisted state로 hydration → mismatch
- zustand-persist는 이를 자동으로 skip하지만, 사용처에서 SSR 중 값을 읽는 경우(e.g. 서버 컴포넌트로 props 전달) 불일치 발생 가능



---

## TOC 패널 CSS 붕괴 수정 (2026-03-14)

### 원인 분석: 3개 복합 버그

**BUG-TOC-1: sticky top-0 h-screen이 flex row 레이아웃 강제 확장**
파일: components/contract/ContractTocPanel.tsx (수정됨)
- ContractTocPanel aside에 sticky top-0 h-screen 적용됨
- h-screen이 flex row 자식으로 배치되면 전체 레이아웃 높이를 뷰포트 높이로 강제
- 스크롤 영역 깨짐 + 메인 컬럼 압축 현상 발생

**BUG-TOC-2: 동적 w-0 / w-64 클래스 충돌**
파일: components/contract/ContractTocPanel.tsx (수정됨)
- isOpen false 시 w-0 xl:w-0을 추가했으나 기본 클래스 w-64 xl:w-72가 동시에 존재
- Tailwind 동적 클래스는 기본 클래스를 override하지 못함 (같은 specificity)
- 결과: TOC가 닫혀도 항상 w-64 너비를 점유

**BUG-TOC-3: flex row wrapper로 인한 .page 레이아웃 파괴**
파일: components/contract/ContractDetailView.tsx (수정됨)
- TOC 추가 시 루트를 flex min-h-0로 감싸고 flex-1 min-w-0 page로 중첩
- globals.css의 .page는 display: block 정의 → flex 자식으로 배치 시 page-header/page-body padding/width가 예상과 다르게 작동

### 적용된 수정

1. ContractTocPanel: fixed top-0 right-0 bottom-0으로 전환
   - sticky h-screen 제거 → fixed positioning
   - xl:w-72 제거, w-64 고정
   - w-0/w-64 충돌 제거 → translate-x-full/translate-x-0 transform 토글
   - id="contract-toc-panel" 추가 (aria-controls 연결)

2. ContractDetailView: flex row 구조 제거
   - 루트를 className="page" + style paddingRight 조건부 inline style로 단순화
   - TOC 오픈 시 calc(16rem + 1px) padding-right 보정 (fixed TOC가 컨텐츠를 가리지 않도록)
   - flex-1 min-w-0 wrapper div 제거

### 교훈 (재발 방지)

- flex row 내 h-screen: 자식에 h-screen을 쓰면 flex 부모 전체 높이가 강제 확장됨. 항상 fixed/absolute로 처리
- Tailwind 동적 width 토글: w-0과 w-64를 동시에 className에 포함하면 override 안 됨. translate-x 방식 사용
- .page class와 flex 혼용 금지: globals.css의 .page는 display:block. flex 컨텍스트에서 쓰면 page-header/page-body가 예상과 다르게 작동

---

## TOC 클릭 → 스크롤 이동 + 토글 열림 버그 (2026-03-14)

### BUG-TOC-CLICK-1: handleClauseClick에서 toggleClause/expandSectionClauses 미호출 (Critical)
파일: components/contract/ContractDetailView.tsx:455-458
- handleClauseClick은 setActiveClauseId + scrollToClause만 수행
- expandedClauseIds에 해당 ID가 추가되지 않아 조항 카드의 분석 섹션이 열리지 않음
- 수정: expandSectionClauses([clauseId]) 호출 추가

### BUG-TOC-CLICK-2: scrollToClause가 DOM 업데이트 전에 호출됨 (High)
파일: components/contract/ContractTocPanel.tsx:553-557, ContractDetailView.tsx:457
- React 상태 업데이트(expandSectionClauses)와 scrollIntoView가 동기적으로 실행
- DOM 반영 전에 scrollIntoView가 호출되어 접힌 상태에서 스크롤 시도
- 수정: requestAnimationFrame으로 scrollToClause 지연

### BUG-TOC-CLICK-3: IntersectionObserver root가 null일 수 있음 (High)
파일: components/contract/ContractDetailView.tsx:672-701
- clauseScrollRef.current가 첫 마운트 시 null → observer root가 viewport 전체로 설정됨
- 의도된 동작은 clauseScrollRef 컨테이너 내부 감시
- document.querySelectorAll로 전체 document 검색도 container 내부로 한정해야 함

### BUG-TOC-CLICK-4: 접힌 zone 섹션의 조항 클릭 시 섹션 자동 펼침 없음 (Medium)
파일: components/contract/ContractDetailView.tsx:455-458, ClauseSectionGroup.tsx:174-184
- collapsedSectionKeys에 해당 zoneType이 있으면 조항이 grid-rows-[0fr] + overflow-hidden 상태
- handleClauseClick이 해당 섹션을 펼치지 않아 스크롤 이동 실패

### 패턴 메모
- handleClauseClick 수정 시 useCallback 의존성 배열에 expandSectionClauses, toggleSection 추가 필수
- scrollToClause는 모듈 수준 함수로 clauseScrollRef를 받지 않음 → container 기반 검색으로 전환 권장

---

## 대시보드/계약 목록 데이터 불일치 근본 원인 (2026-03-15)

### 핵심: Service Role + user_id 필터 누락

`lib/data/contracts.ts`의 모든 서버 전용 함수가 Admin (Service Role) Supabase 클라이언트를 사용하여 RLS를 우회하면서도 user_id 필터를 적용하지 않음:
- `getContractListStats()`: 대시보드용 — user_id 파라미터 없음, 전체 DB 조회
- `getContractList()`: 계약 목록용 — user_id 파라미터 없음, 전체 DB 조회
- `getContractDetail()`: 계약 상세용 — contractId로만 필터, user_id 없음
- `GET /api/contracts` (route.ts): auth에서 userId 획득하지만 쿼리에 미사용

POST insert 시에는 `user_id: userId`를 저장하므로 데이터는 올바르게 기록됨.
문제는 읽기 쿼리에서 user_id를 무시하는 것.

### 부차 이슈
- 대시보드 completedContracts/inProgressContracts: 상위 20건 샘플에서만 계산 (21건 이상이면 부정확)
- TopRiskCategories: props 없이 호출 → 항상 0건 기본값 표시
- app/page.tsx:41 — createdAt에 updated_at 값 사용
- 대시보드에 AutoRefreshWrapper 없음 → 업로드 후 Router Cache로 이전 데이터 노출

---

## 업로드 Progress Bar 100% 미도달 버그 (2026-03-15)

### 근본 원인: "filtering" 상태의 TERMINAL_STATUSES 불일치

**클라이언트** (app/upload/page.tsx:137): `["ready", "partial", "error", "filtering"]` — filtering 포함
**서버** (app/api/contracts/[id]/status/route.ts:79): `["ready", "partial", "error"]` — filtering 미포함

**결과:**
1. "filtering" 도달 시 클라이언트 polling 중단 + isTerminal=true → progress 100% + "완료" badge
2. 사용자가 zone 확인 후 "analyzing" 전환 → isTerminal=false → progress 92%로 역행
3. 사용자가 100%→92% 역행을 목격 + "완료" 표시 후 갑자기 "처리중"으로 전환

**연쇄 문제:**
- Stage 4 (Zone 분류): 서버에 대응 status 없어 항상 건너뛰어짐
- Stage 5 confirm weight=0.00: 대기 중 progress 정체
- "analyzing" 무한 polling: 최대 시간/횟수 제한 없음

**수정 방향:**
1. 클라이언트 TERMINAL_STATUSES에서 "filtering" 제거
2. UploadProgressPanel의 isTerminal에서 "filtering" 제외
3. "filtering"에서는 stage 5 weighted progress (~92%) 표시

---

## 업로드 후 목록 미표시 & 삭제 미반영 심층 분석 (2026-03-14, 업데이트)

### Bug 1: 삭제 후 목록에 남아있는 문제

**1-A: deletedIds 로컬 상태 소멸 (Critical)**
- RecentContracts.tsx:139 — deletedIds는 useState로 관리, 컴포넌트 언마운트 시 소멸
- 다른 페이지 갔다가 /contracts 재방문 시 빈 Set으로 초기화
- Router Cache에 삭제 전 stale 데이터 남아있으면 삭제된 항목이 다시 보임

**1-B: CASCADE DELETE vs router.refresh() race condition (High)**
- RecentContracts.tsx:156-158 — DELETE 응답 직후 동기적으로 router.refresh() 호출
- CASCADE DELETE(zones->clauses->analyses) 커밋 전에 SELECT 실행될 수 있음
- 특히 큰 문서(조항 수백 개)에서 발생 확률 높음

**1-C: Router Cache stale RSC 페이로드 (High)**
- AppShell.tsx:34-43 의 router.refresh() 보정이 useEffect에서 비동기 실행
- 첫 렌더에서 1프레임+ stale 데이터 노출 (flicker)

### Bug 2: 업로드 완료 후 목록 미갱신 문제

**2-A: 업로드 페이지 언마운트 시 폴링 중단 (Critical, 가장 흔한 재현 경로)**
- upload/page.tsx:365 — useEffect cleanup에서 stopPolling 실행
- 사용자가 업로드 시작 후 /contracts로 이동하면 폴링이 중단됨
- 백그라운드 파싱 완료를 감지 못해 lastCompletedContractId가 설정 안 됨
- AutoRefreshWrapper가 refresh할 트리거를 받지 못함

**2-B: AutoRefreshWrapper가 신규 계약 등장 감지 불가 (Medium)**
- AutoRefreshWrapper.tsx:29,53 — statuses 배열이 현재 렌더된 items 기준
- 새 계약이 RSC 페이로드에 없으면 hasActiveContracts=false → 주기적 폴링 미시작
- lastCompletedContractId 기반 일회성 refresh도 2-A로 인해 동작 안 함

**2-C: Router Cache stale RSC 페이로드 (Bug 1-C와 동일) (High)**
- force-dynamic은 서버 fetch 캐시만 비활성화, 클라이언트 Router Cache는 별도 동작
- Link 네비게이션 시 최대 30초 캐시된 RSC 페이로드 사용

**참고: 현재 구현된 보정 메커니즘**
- upload-store의 lastCompletedContractId + AutoRefreshWrapper: 업로드 완료 감지→refresh
- AppShell.tsx의 pathname 변경 시 router.refresh(): stale cache 보정
- 두 메커니즘 모두 부분적으로만 동작 (2-A가 핵심 gap)

---

## TOC 클릭 → 엉뚱한 조항 스크롤 + 잘못된 active 표시 (2026-03-15)

### 3개 복합 버그가 보고된 증상을 구성

**BUG-TOC-TREE-1: 자식 조항 클릭 시 부모 카드 미펼침 → 숨겨진 요소로 스크롤 (Critical)**
파일: components/contract/ContractDetailView.tsx:657-682
- handleClauseClick에서 expandSectionClauses([clauseId])로 클릭 조항만 expand
- 자식 조항 카드는 부모 ClauseDocumentItem의 접힌 body 안에 렌더됨 (line 382-386)
- 부모 미펼침 → 자식은 grid-rows-[0fr] + overflow:hidden → scrollIntoView가 0px 높이 요소 대상
- 해결: 클릭 조항의 모든 조상 clause ID를 함께 expand해야 함

**BUG-TOC-TREE-2: IntersectionObserver가 중첩 data-clause-id 전부 관찰 → 부모가 active됨 (High)**
파일: components/contract/ContractDetailView.tsx:728-760
- querySelectorAll("[data-clause-id]")가 부모+자식 모두 선택
- 부모 요소가 더 큰 영역 점유 → rootMargin "-10% 0px -70% 0px"에서 부모 우선 intersect
- visible 배열 top 정렬 시 부모.top <= 자식.top → 부모가 선택됨
- 해결: 리프 노드만 observe하거나, 가장 깊은 중첩 요소 우선 선택

**BUG-TOC-TREE-3: lock 800ms < smooth scroll 소요 시간 → 스크롤 중 active 변경 (High)**
파일: components/contract/ContractDetailView.tsx:648-654
- lockTocInteraction(800)으로 고정 시간 lock
- 긴 거리 smooth scroll은 800ms 초과 가능
- lock 해제 후 observer가 중간 조항 감지 → activeClauseId 변경
- 해결: scrollend 이벤트 기반 lock 해제로 전환

### 3개 버그 상호작용
1. 자식 조항 클릭 → BUG-1로 부모 미펼침 → 숨겨진 요소로 스크롤 → 엉뚱한 위치
2. 스크롤 후 → BUG-2로 observer가 부모 감지 → 잘못된 active 하이라이트
3. 먼 거리 스크롤 → BUG-3로 lock 해제 후 중간 조항으로 active 깜빡임

수정 우선순위: BUG-1 (조상 expand) → BUG-2 (observer 리프 필터) → BUG-3 (scrollend)
