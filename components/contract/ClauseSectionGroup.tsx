"use client";

import { useMemo } from "react";
import { ChevronRight, Lock, FileText } from "lucide-react";
import { useContractDetailViewStore } from "../../lib/stores/contract-detail-view";
import { ZONE_LABELS, ANALYSIS_TARGET_ZONES } from "../../lib/layout/zone-classifier";
import type { ContractDetailAnalysis } from "../../lib/data/contracts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClauseItemForSection {
  id: string;
  riskLevel?: string;
  analysis?: ContractDetailAnalysis;
}

interface ClauseSectionGroupProps {
  zoneType: string;
  /** Total clause count — used for display only */
  clauseCount: number;
  /** Enriched clause items with optional analysis attached */
  clauses: ClauseItemForSection[];
  /** Whether this is the first section (no top border) */
  isFirst: boolean;
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Risk stat pill
// ---------------------------------------------------------------------------

function RiskPill({
  count,
  color,
  label,
}: {
  count: number;
  color: string;
  label: string;
}) {
  if (count === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${color}`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {label} {count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ClauseSectionGroup
// ---------------------------------------------------------------------------

export function ClauseSectionGroup({
  zoneType,
  clauseCount,
  clauses,
  isFirst,
  children,
}: ClauseSectionGroupProps) {
  const collapsedSectionKeys = useContractDetailViewStore((s) => s.collapsedSectionKeys);
  const toggleSection = useContractDetailViewStore((s) => s.toggleSection);
  const expandSectionClauses = useContractDetailViewStore((s) => s.expandSectionClauses);
  const collapseSectionClauses = useContractDetailViewStore((s) => s.collapseSectionClauses);
  const expandedClauseIds = useContractDetailViewStore((s) => s.expandedClauseIds);

  const clauseIds = useMemo(() => clauses.map((c) => c.id), [clauses]);
  const allExpanded = clauseIds.length > 0 && clauseIds.every((id) => !!expandedClauseIds[id]);
  const anyExpanded = clauseIds.some((id) => !!expandedClauseIds[id]);

  const isCollapsed = !!collapsedSectionKeys[zoneType];
  const isAnalysisTarget = ANALYSIS_TARGET_ZONES.has(zoneType);
  const isPreamble = zoneType === "preamble";
  const label = ZONE_LABELS[zoneType] ?? zoneType;

  const stats = useMemo(() => {
    let high = 0;
    let medium = 0;
    let low = 0;
    let unanalyzed = 0;
    for (const c of clauses) {
      const level = c.riskLevel?.toLowerCase();
      if (!c.analysis && !level) {
        unanalyzed++;
      } else if (level === "high") {
        high++;
      } else if (level === "medium") {
        medium++;
      } else if (level === "low") {
        low++;
      }
    }
    return { high, medium, low, unanalyzed };
  }, [clauses]);

  const hasStats = stats.high + stats.medium + stats.low > 0;

  return (
    <div className={`rounded-lg overflow-hidden ${isFirst ? "" : "mt-2"}`}>
      {/* Section header */}
      <button
        type="button"
        onClick={() => toggleSection(zoneType)}
        className={`
          w-full flex items-center gap-2.5 px-4 py-3
          bg-bg-secondary hover:bg-bg-hover
          ${isFirst ? "" : "border-t border-border-muted"}
          transition-colors duration-150 text-left
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue focus-visible:ring-inset
          ${isAnalysisTarget ? "" : "opacity-70"}
        `}
        aria-expanded={!isCollapsed}
        aria-label={`${label} 섹션 ${isCollapsed ? "펼치기" : "접기"}`}
      >
        {/* Chevron */}
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform duration-200 ${
            isCollapsed ? "" : "rotate-90"
          }`}
        />

        {/* Zone name */}
        <span
          className={`text-sm font-semibold leading-none ${
            isAnalysisTarget ? "text-text-primary" : "text-text-secondary"
          }`}
        >
          {label}
        </span>

        {/* Non-analysis target icon */}
        {isPreamble && (
          <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-label="참조용" />
        )}
        {!isAnalysisTarget && !isPreamble && (
          <Lock className="h-3 w-3 shrink-0 text-text-muted" aria-label="분석 미대상" />
        )}

        {/* Clause count badge */}
        <span className="ml-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-muted">
          {clauseCount}
        </span>

        {/* Preamble: "분석 제외" 태그 */}
        {isPreamble && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-tertiary text-text-muted">
            참조
          </span>
        )}

        {/* Risk stats + 섹션 내 조항 전체 펼치기/접기 — 섹션이 열려 있을 때만 */}
        {!isCollapsed && (
          <span className="ml-auto flex items-center gap-3 pr-1">
            {hasStats && (
              <>
                <RiskPill count={stats.high} color="text-accent-red" label="HIGH" />
                <RiskPill count={stats.medium} color="text-accent-amber" label="MED" />
                <RiskPill count={stats.low} color="text-accent-green" label="LOW" />
                <span className="h-3 w-px bg-border-muted" />
              </>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); expandSectionClauses(clauseIds); }}
              disabled={allExpanded}
              className="text-[11px] text-text-muted hover:text-accent-blue disabled:opacity-30 transition-colors"
            >
              전체 펼치기
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); collapseSectionClauses(clauseIds); }}
              disabled={!anyExpanded}
              className="text-[11px] text-text-muted hover:text-accent-blue disabled:opacity-30 transition-colors"
            >
              전체 접기
            </button>
          </span>
        )}
      </button>

      {/* Collapsible clause list (CSS grid trick — same pattern as individual clause toggle) */}
      <div
        className={`grid transition-all duration-300 ease-in-out will-change-[grid-template-rows] ${
          isCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
        }`}
      >
        <div className="overflow-hidden">
          <div className="space-y-3 pt-3 pb-1">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
