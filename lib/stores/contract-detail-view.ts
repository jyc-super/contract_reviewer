import { create } from "zustand";

export type RiskFilter = "ALL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type ZoneFilter = "ALL" | "general_conditions" | "contract_agreement" | "appendices" | "contract_body";

interface ContractDetailViewState {
  /** Record of clause IDs whose analysis section is expanded */
  expandedClauseIds: Record<string, true>;
  /** Record of zone_type keys whose section is collapsed */
  collapsedSectionKeys: Record<string, true>;
  /** Currently active risk level filter */
  riskFilter: RiskFilter;
  /** Currently active zone filter */
  zoneFilter: ZoneFilter;
  /** Text search query for filtering clauses */
  searchQuery: string;
  /** Whether the left-side TOC panel is open */
  tocOpen: boolean;
  /** TOC panel width in pixels (persists across toggle) */
  tocWidth: number;
  /** TOC section zone keys that are collapsed (empty = all expanded) */
  tocCollapsedSections: Record<string, true>;
  /** Clause body max-width in ch units (60–200, 0 = unlimited) */
  contentWidthCh: number;

  toggleClause: (id: string) => void;
  expandAll: (ids: string[]) => void;
  collapseAll: () => void;
  expandHighRisk: (highRiskClauseIds: string[]) => void;
  setRiskFilter: (filter: RiskFilter) => void;
  setZoneFilter: (zone: ZoneFilter) => void;
  setSearchQuery: (query: string) => void;
  /** Toggle a section's collapsed state by zone_type key */
  toggleSection: (zoneType: string) => void;
  /** Collapse all sections (requires the list of active zone types) */
  collapseAllSections: (zoneTypes: string[]) => void;
  /** Expand all sections (clear collapsed state) */
  expandAllSections: (zoneTypes: string[]) => void;
  /** Expand all clauses within a specific section (merge, not replace) */
  expandSectionClauses: (ids: string[]) => void;
  /** Collapse all clauses within a specific section */
  collapseSectionClauses: (ids: string[]) => void;
  /** Reset all UI state when switching contracts */
  resetForContract: () => void;
  /** Toggle TOC panel open/closed */
  toggleToc: () => void;
  /** Set TOC panel open state explicitly */
  setTocOpen: (open: boolean) => void;
  /** Set TOC panel width */
  setTocWidth: (width: number) => void;
  /** Toggle a TOC section's collapsed state (user preference persists across contracts) */
  toggleTocSection: (sectionKey: string) => void;
  /** Initialize all TOC sections to expanded (call when sections first load) */
  initTocCollapsed: () => void;
  /** Set clause body content width in ch units (0 = unlimited) */
  setContentWidthCh: (ch: number) => void;
}

export const useContractDetailViewStore = create<ContractDetailViewState>((set) => ({
  expandedClauseIds: {},
  collapsedSectionKeys: {},
  riskFilter: "ALL",
  zoneFilter: "ALL",
  searchQuery: "",
  tocOpen: false,
  tocWidth: 224,
  tocCollapsedSections: {},
  contentWidthCh: 0,

  toggleClause: (id) =>
    set((state) => {
      if (state.expandedClauseIds[id]) {
        const { [id]: _, ...rest } = state.expandedClauseIds;
        return { expandedClauseIds: rest };
      }
      return { expandedClauseIds: { ...state.expandedClauseIds, [id]: true } };
    }),

  expandAll: (ids) =>
    set(() => ({
      expandedClauseIds: Object.fromEntries(ids.map((id) => [id, true])) as Record<string, true>,
    })),

  collapseAll: () =>
    set(() => ({ expandedClauseIds: {} })),

  expandHighRisk: (highRiskClauseIds) =>
    set(() => ({
      expandedClauseIds: Object.fromEntries(highRiskClauseIds.map((id) => [id, true])) as Record<string, true>,
    })),

  setRiskFilter: (filter) =>
    set(() => ({ riskFilter: filter })),

  setZoneFilter: (zone) =>
    set(() => ({ zoneFilter: zone })),

  setSearchQuery: (query) =>
    set(() => ({ searchQuery: query })),

  toggleSection: (zoneType) =>
    set((state) => {
      if (state.collapsedSectionKeys[zoneType]) {
        const { [zoneType]: _, ...rest } = state.collapsedSectionKeys;
        return { collapsedSectionKeys: rest };
      }
      return { collapsedSectionKeys: { ...state.collapsedSectionKeys, [zoneType]: true } };
    }),

  collapseAllSections: (zoneTypes) =>
    set(() => ({
      collapsedSectionKeys: Object.fromEntries(zoneTypes.map((k) => [k, true])) as Record<string, true>,
    })),

  expandAllSections: (_zoneTypes) =>
    set(() => ({
      collapsedSectionKeys: {},
    })),

  expandSectionClauses: (ids) =>
    set((state) => ({
      expandedClauseIds: {
        ...state.expandedClauseIds,
        ...Object.fromEntries(ids.map((id) => [id, true])) as Record<string, true>,
      },
    })),

  collapseSectionClauses: (ids) =>
    set((state) => {
      const next = { ...state.expandedClauseIds };
      for (const id of ids) delete next[id];
      return { expandedClauseIds: next };
    }),

  resetForContract: () =>
    set(() => ({
      expandedClauseIds: {},
      // preamble 섹션은 기본 접힘 — 참조용이므로 분석 조항에 집중
      collapsedSectionKeys: { preamble: true } as Record<string, true>,
      riskFilter: "ALL",
      zoneFilter: "ALL",
      searchQuery: "",
      // tocOpen is intentionally not reset — the user's TOC preference persists across contracts
    })),

  toggleToc: () =>
    set((state) => ({ tocOpen: !state.tocOpen })),

  setTocOpen: (open) =>
    set(() => ({ tocOpen: open })),

  setTocWidth: (width) =>
    set(() => ({ tocWidth: Math.max(160, Math.min(480, width)) })),

  toggleTocSection: (sectionKey) =>
    set((state) => {
      if (state.tocCollapsedSections[sectionKey]) {
        const { [sectionKey]: _, ...rest } = state.tocCollapsedSections;
        return { tocCollapsedSections: rest };
      }
      return { tocCollapsedSections: { ...state.tocCollapsedSections, [sectionKey]: true } };
    }),

  initTocCollapsed: () =>
    set((state) => {
      return { tocCollapsedSections: state.tocCollapsedSections };
    }),

  setContentWidthCh: (ch) =>
    set(() => ({ contentWidthCh: ch })),
}));
