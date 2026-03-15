---
name: Section Grouping Feature
description: Zone-based section collapse/expand feature added to ContractDetailView — architecture decisions and data flow
type: project
---

Zone grouping (section collapse/expand) was implemented 2026-03-14.

**Why:** ContractDetailView rendered a flat clause list with no visual grouping. With 100+ clauses across 14 zone types, users needed a way to navigate by section.

**How to apply:** When editing ContractDetailView or related components, keep these design decisions in mind:

- `zones` prop was added to `ContractDetailView` (was missing before). `page.tsx` passes `data.zones` directly.
- `clauseItems` now includes `zoneId?: string` (maps to `document_zones.id`) in addition to the existing `zoneKey` (legacy fallback).
- Grouping logic: `zone_id → zoneMap.get(id) → zone.zone_type`. Falls back to `zoneKey` if `zoneId` is absent. Clauses with neither become `"unknown"`.
- `hasZoneGrouping` flag (`zones.length > 0`) gates the grouped view — falls back to the old flat list renderer when no zones exist.
- `ZONE_ORDER` and `ZONE_LABELS` are exported from `lib/layout/zone-classifier.ts` (added 2026-03-14).
- `ANALYSIS_TARGET_ZONES` (Set) is also exported from `lib/layout/zone-classifier.ts`.
- Section state lives in Zustand: `collapsedSectionKeys: Record<string, true>` — present key = collapsed. Actions: `toggleSection`, `collapseAllSections(zoneTypes[])`, `expandAllSections(zoneTypes[])`. All reset on `resetForContract()`.
- `ClauseSectionGroup` component at `components/contract/ClauseSectionGroup.tsx` renders the header + animated collapse wrapper. Uses the same CSS grid trick as individual clause toggle: `grid-rows-[0fr]/[1fr]` with `opacity-0/100`.
- Non-analysis-target zones get `opacity-70` + a `Lock` icon in the section header.
- Risk stats (HIGH/MED/LOW counts) appear in the section header only when the section is expanded and has analysis data.
- "섹션 전체 접기 / 펼치기" buttons appear in the filter bar only when `hasZoneGrouping && activeSectionZoneTypes.length > 0`.
