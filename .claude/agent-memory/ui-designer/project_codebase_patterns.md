---
name: Codebase UI Patterns
description: Key UI patterns, component structure, data flow, and design conventions discovered in the contract risk analysis project
type: project
---

## Component Architecture

- Custom CSS variables used heavily alongside Tailwind: `var(--bg-card)`, `var(--text-muted)`, `var(--accent-blue)`, etc. Defined in `app/globals.css`.
- CSS class-based design tokens alongside Tailwind utilities: `.page`, `.page-header`, `.page-title`, `.page-subtitle`, `.page-body`, `.page-actions`, `.btn`, `.btn-primary`, `.btn-outline`, `.card`, `.card-header`, `.card-title`, `.card-body`, `.badge`, `.zone-item`, `.zone-btn`, `.step-item`, `.step-icon`, `.step-content`, `.step-bar`.
- Components mix shadcn/ui primitives with custom CSS classes. The ZoneReview UI uses almost entirely custom CSS classes, not shadcn/ui.
- Risk color tokens: `bg-accent-red-dim text-accent-red` (HIGH), `bg-accent-amber-dim text-accent-amber` (MEDIUM), `bg-accent-green-dim text-accent-green` (LOW), `bg-accent-blue-dim text-accent-blue` (INFO).
- Border-left color coding for clause risk: `border-l-accent-red`, `border-l-accent-amber`, `border-l-accent-green`, `border-l-accent-blue`, `border-l-border-muted`.

## Data Flow: Upload to UI

1. `app/upload/page.tsx` (client) — orchestrates upload + polling
2. `POST /api/contracts/route.ts` — parses, inserts to Supabase, returns 202 or 200 sync
3. `GET /api/contracts/[id]/status` — polled by client for live status
4. `GET /api/contracts/[id]/zones` — fetched when status=filtering to load ZoneReviewView
5. `ZoneReviewView` + `ZoneReviewList` — user confirms uncertain zones
6. `PUT /api/contracts/[id]/zones` — saves zone decisions, fires analyze
7. `app/contracts/[id]/page.tsx` (RSC) — loads via `getContractDetail()` from `lib/data/contracts.ts`
8. `ContractDetailView` (client) — clause list with risk filter + search + inline analysis

## Current DB Schema (key facts)

- `contracts` table: id, user_id, name, status, page_count, source_languages, parse_progress (migration 005), updated_at
- `document_zones` table: id, contract_id, page_from, page_to, zone_type, confidence, is_analysis_target, user_confirmed, text
- `clauses` table: id, contract_id, zone_id, clause_prefix, number, title, text, is_auto_split, needs_review, sort_order (migration 004), content_hash, zone_key VARCHAR (migration 007)
- `clause_analyses` table: clause_id, risk_level, risk_summary, recommendations, fidic_comparisons (jsonb), llm_model
- `toc_entries` exist in the Docling parse response and are stored transiently; no dedicated DB table — passed through zones API response field `toc_entries`

## ZoneReviewView Specifics

- `ZoneItem` interface: `{ id, type, confidence, textPreview, pageFrom?, pageTo?, documentPartTitle?, subDocumentTitle? }` — subDocumentTitle added for 2-depth grouping
- `ZoneReviewView` props: `contractId, contractName, uncertainZones, analysisTargetCount, totalPageInfo?, documentParts?, subDocuments?, tocEntries?, tocWarnings?, warnings?, onConfirm?, inline?`
- `DoclingDocumentPart` interface exported from `ZoneReviewView.tsx`: `{ part_type, page_start, page_end, title }`
- `SubDocument` interface imported from `lib/docling-adapter.ts`
- `TocEntry` interface (from `lib/docling-adapter.ts`): `{ title, page_number: number|null, level, numbering: string|null }`
- `TocPreviewPanel` component (`components/contract/TocPreviewPanel.tsx`): collapsible panel, default collapsed, indent by `(level-1)*16px`, warning banner when `warnings` present. Uses inline styles (not Tailwind) exclusively.
- `totalPageInfo` is a pre-formatted string (e.g. "120페이지") — not a structured object
- Zone list rendering priority:
  1. 2-depth (sub_document -> document_part -> zones) when any zone has `subDocumentTitle`
  2. 1-depth (document_part -> zones) when any zone has `documentPartTitle`
  3. Flat list otherwise (backward compatible)
- Sub-document header: left-bordered card `border-l-[3px] border-accent-blue bg-bg-tertiary` with "문서" label + title
- Group headers: uppercase text-secondary label + muted tabular page range (e.g. "pp.16–180"); uses `var(--border)` bottom border
- `PartGroupList` internal component renders indented when `indented={true}` (used under sub-doc headers)
- `ZoneReviewView` uses inline styles for warning banners (not Tailwind) — CSS variable refs like `var(--accent-yellow-dim)`

## UploadProgressPanel Specifics

- `ProcessSummary` interface (both in `upload/page.tsx` and `UploadProgressPanel.tsx`): `{ pages, analysisTargetCount, uncertainZoneCount, clauseCount, needsReview, documentNumber?, removedHeaderFooterCount?, headerFooterTotalPages? }`
- `HeaderFooterInfo` and `FooterPattern` types defined in `upload/page.tsx` — never sent to component directly, mapped via `extractHeaderFooterMeta()` helper
- `extractHeaderFooterMeta()` in `upload/page.tsx` extracts documentNumber from footer_patterns type=document_number, sums removed_header_count + removed_footer_count
- Summary panel renders new rows conditionally: "헤더/푸터 제거: N건" and "문서 번호: XXX" only when values are present
- `UploadProgressStore` (zustand, sessionStorage): stage, contractId, liveStatus, fileName, error, errorCode, startTime, parseProgress
- Stage 3 cycling messages already mention "헤더/푸터 필터링 중..." which is aspirational — backend doesn't fully do this yet

## Page Layout: contracts/[id]

- `app/contracts/[id]/layout.tsx` (RSC): wraps all contract sub-pages in `<ContractTabNav>` + `{children}`
- `ContractTabNav` (`components/contract/ContractTabNav.tsx`): 3-tab nav — "구역 분류" (`/zones`), "조항 분석" (`/`), "리포트" (`/report`)
  - Active tab uses `border-b-2 border-accent-blue text-accent-blue`; inactive uses `border-transparent text-text-muted`
  - Tab bar: `flex border-b border-border bg-bg-secondary px-8`
- `components/contracts/AutoRefreshWrapper.tsx`: polls `router.refresh()` every 10s when any contract status is in `["analyzing", "parsing", "filtering"]`

## ContractDetailView

- `ClauseItem` interface: `{ id, title?, text, clausePrefix?, number?, riskLevel?, needsReview?, sortOrder, zoneKey?, subDocumentTitle? }`
- `zoneKey` comes from `clauses.zone_key` (migration 007 VARCHAR column); mapped in `app/contracts/[id]/page.tsx` as `zoneKey: c.zone_key ?? undefined`
- `subDocumentTitle` derived in RSC page: zone's page_from matched against `contract.sub_documents` (SubDocument[]) page range
- `lib/data/contracts.ts` `getContractDetail()` selects `zone_key` from clauses; also returns `data.zones` (for zonePageMap) and `contract.sub_documents`
- Zone filter dropdown: only shown when `enrichedClauses.some(c => c.zoneKey)` — uses `<select>` matching risk filter bar style; options from `ZONE_FILTER_OPTIONS` constant
- `ZoneFilter` type + `zoneFilter`/`setZoneFilter` added to `useContractDetailViewStore` (default `"ALL"`)
- `ZoneBadge` sub-component renders small `(10px)` muted badge with `var(--bg-tertiary)` background, placed in clause card header before needsReview and RiskBadge
- `ZONE_LABELS` record covers 8 zone types including `particular_conditions`, `conditions_of_contract`, `commercial_terms`, `definitions`
- `ContractDetailContract` type: id, name, status, page_count, created_at, updated_at
- Sub-document headers in clause list: inserted when `subDocumentTitle` changes across the filtered list; same visual style as ZoneReviewList sub-doc header (`border-l-[3px] border-accent-blue bg-bg-tertiary`)
- Clause expand/collapse state managed entirely in `useContractDetailViewStore` — no local useState in ContractDetailView for this
- Clause depth hierarchy: `getClauseDepth()` parses clause number to determine 0–3 depth; depths 2–3 use `bg-bg-secondary` background vs `bg-bg-card` for 0–1
- Body text indent: `BODY_INDENT = "pl-[6.5rem]"` (number column 4.5rem + px-5 + gap-x-3)
- Analysis expand animation: CSS `grid-rows-[0fr/1fr]` pattern with `overflow-hidden` inner div — no shadcn Collapsible used

**Why:** To inform future UI changes related to the parsing quality improvement plan.
**How to apply:** When proposing new UI for document_parts, header_footer_info, or toc_entries, remember that all three require both new DB columns/tables AND new API query fields before UI can consume them. zone_key is already in DB and UI as of 2026-03-14.

---

## Bug Fixes Applied (2026-03-14) — Important Patterns

### Zustand Selector 패턴
- `useContractDetailViewStore()` 전체 구독 금지. `Set<string>` 타입 필드는 매 업데이트마다 새 참조를 반환하여 무한 리렌더 발생.
- `useUploadStore()` 전체 구독 금지. 폴링 루프(3초 간격) 중 store 업데이트마다 컴포넌트 전체가 리렌더됨.
- 항상 개별 selector: `const field = useStore((s) => s.field);`

### AbortController 패턴
- 모든 useEffect 내 fetch는 반드시 AbortController 사용.
- cleanup: `return () => controller.abort();`
- catch에서 AbortError 구분: `if (e instanceof Error && e.name !== "AbortError")`

### router를 useEffect 의존성에서 제외
- `useRouter()`의 router 객체를 useEffect 의존성에 포함하면 예상치 못한 재실행 발생.
- 해결: `const routerRef = useRef(router); useEffect(() => { routerRef.current = router; });`

### race condition 방지
- 비동기 핸들러가 두 버튼에 연결된 경우 `useRef`로 in-flight 플래그 동기 관리.
- `setSubmitting(true)`는 비동기라 동시 클릭을 막지 못함.

### useRef 초기값
- 타임스탬프 추적 ref는 `useRef(0)`으로 초기화하고 실제 진입 시점에 `Date.now()` 기록.
- `useRef(Date.now())`는 초기 렌더 시점이 실제 사용 시점보다 앞서 진행 추정치가 틀림.

### 접근성
- `role="button"` div: `aria-label`, `aria-disabled={disabled}`, `tabIndex={disabled ? -1 : 0}` 필수.
- 확인 모달: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` + 제목 요소에 매칭 id 필수.
- 아이콘 전용 버튼: `title` 대신 `aria-label` 사용.
- 토글: `<div onClick>` 대신 `<button type="button" aria-expanded={bool}>`.

### navigation
- `window.location.href = url` 대신 `router.push(url)` — Next.js SPA 내비게이션 유지.

### useEffect 의존성 누락
- 의존성 배열 외부에서 정의된 함수(load 등)는 useEffect 내부로 이동하거나 useCallback으로 감싸야 함.
