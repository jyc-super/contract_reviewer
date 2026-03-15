---
name: TOC Panel Feature
description: Left-side sticky TOC panel in ContractDetailView — layout, state, scroll spy; updated 2026-03-14 to left-sticky inline layout
type: project
---

TOC (목차) panel on the clause analysis page (`/contracts/[id]`).

**Why:** Users need to navigate long contracts with many clauses without scrolling; TOC provides jump-to-clause and active-highlight.

**How to apply:** When extending navigation, clause display, or store state for this page, be aware of the TOC integration points below.

## Architecture (current — left sticky inline panel)

- `ContractTocPanel` at `components/contract/ContractTocPanel.tsx`
  - Props: `sections: TocSection[]`, `activeClauseId: string | null`, `onClauseClick: (id: string) => void`, `className?: string`
  - `isOpen` prop **removed** — parent conditionally renders the panel
  - Desktop only (`hidden lg:flex`)
  - `sticky top-0`, `height: calc(100vh - 48px)` (48px = ContractTabNav height)
  - `w-56` (224px), `border-r border-border-muted`, `bg-bg-secondary`
  - Active clause: `box-shadow: inset 2px 0 0 var(--accent-blue)` + `bg-accent-blue-dim`
  - Section headers: collapsible via `toggleTocSection` from Zustand store (chevron rotates)
  - Also exports `scrollToClause(clauseId)` — imperative helper for click handlers

- IntersectionObserver scroll spy lives in `ContractDetailView`:
  - `rootMargin: "-10% 0px -70% 0px"`, `threshold: 0`
  - Re-runs when `filteredClauses.length` changes (uses `requestAnimationFrame` for DOM settle)
  - Active clause ID stored in local `useState<string | null>` in `ContractDetailView`
  - Passed down as `activeClauseId` prop to `ContractTocPanel`

- `ContractDetailView` layout:
  - Page wrapper: `<div className="page">` (no paddingRight adjustment)
  - Content row: `<div className="flex items-start gap-0">`
  - Left: `{tocOpen && <ContractTocPanel ... />}` — conditionally rendered
  - Right: `<div className="flex-1 min-w-0"><div className="page-body">...</div></div>`

- Each `ClauseDocumentItem` wrapper div has `data-clause-id={clause.id}` for IntersectionObserver

## State (zustand — `lib/stores/contract-detail-view.ts`)

New fields:
- `tocOpen: boolean` — initial `false`
- `tocCollapsedSections: Set<string>` — zone keys the user has collapsed in TOC (initial empty Set)
- `toggleToc: () => void`
- `setTocOpen: (open: boolean) => void`
- `toggleTocSection: (sectionKey: string) => void` — adds/removes from Set
- `initTocCollapsed: (_sectionKeys: string[]) => void` — no-op hook for future use

`resetForContract` does NOT reset `tocOpen` or `tocCollapsedSections` — both preferences persist across contract navigation.

## TOC Data

`tocSections` (useMemo in ContractDetailView):
- When zone grouping is active: one `TocSection` per `orderedSection`, with only depth-0 clauses
- When no zone data: single section with zone_type `"contract_body"` and all depth-0 clauses
- Risk level dots shown per clause (red=high / amber=medium / green=low / blue=info)
- Section label color turns accent-blue when active clause is within that section
