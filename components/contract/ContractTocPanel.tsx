"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { BookOpen, ChevronRight, X } from "lucide-react";
import { ZONE_LABELS } from "../../lib/layout/zone-classifier";
import { useContractDetailViewStore } from "../../lib/stores/contract-detail-view";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TocClauseEntry {
  id: string;
  number?: string;
  title?: string;
  riskLevel?: string;
  depth: number;
  children: TocClauseEntry[];
}

export interface TocSection {
  zoneType: string;
  clauses: TocClauseEntry[];
}

interface ContractTocPanelProps {
  /** Ordered sections from ContractDetailView */
  sections: TocSection[];
  /** Currently active clause ID (from IntersectionObserver in parent) */
  activeClauseId: string | null;
  /** Called when a clause item is clicked */
  onClauseClick: (clauseId: string) => void;
  /** Called when a parent clause is expanded in the TOC — receives all child clause IDs */
  onExpandChildren?: (childIds: string[]) => void;
  /** Called when the close button is clicked */
  onClose?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count all clauses in a TocClauseEntry tree (root + all descendants). */
function countAllClauses(entries: TocClauseEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    count += 1 + countAllClauses(entry.children);
  }
  return count;
}

/** Collect all descendant IDs from a TocClauseEntry (not including root). */
function collectChildIds(entry: TocClauseEntry): string[] {
  const ids: string[] = [];
  for (const child of entry.children) {
    ids.push(child.id);
    ids.push(...collectChildIds(child));
  }
  return ids;
}

/** Find a TocClauseEntry by ID across all sections. */
function findEntryById(sections: TocSection[], id: string): TocClauseEntry | null {
  for (const section of sections) {
    const found = findEntryInList(section.clauses, id);
    if (found) return found;
  }
  return null;
}

function findEntryInList(entries: TocClauseEntry[], id: string): TocClauseEntry | null {
  for (const entry of entries) {
    if (entry.id === id) return entry;
    const found = findEntryInList(entry.children, id);
    if (found) return found;
  }
  return null;
}

/** Check if a clause ID exists anywhere in a TocClauseEntry tree. */
function hasClauseId(entries: TocClauseEntry[], id: string): boolean {
  for (const entry of entries) {
    if (entry.id === id) return true;
    if (hasClauseId(entry.children, id)) return true;
  }
  return false;
}

/**
 * Find parent clause IDs that need to be expanded to reveal a given clause.
 * Returns all ancestor IDs (not including the target itself).
 */
function findAncestorIds(entries: TocClauseEntry[], targetId: string): string[] {
  for (const entry of entries) {
    if (entry.id === targetId) return [];
    const childResult = findAncestorIds(entry.children, targetId);
    if (childResult !== null && entry.children.some((c) => c.id === targetId || hasClauseId(c.children, targetId))) {
      return [entry.id, ...childResult];
    }
    // Check recursively through all children
    for (const child of entry.children) {
      if (child.id === targetId) return [entry.id];
      const deeper = findAncestorIds(child.children, targetId);
      if (deeper.length > 0 || hasClauseId(child.children, targetId)) {
        return [entry.id, child.id, ...deeper];
      }
    }
  }
  return [];
}

/**
 * Find all ancestor clause IDs for a target clause across all sections.
 */
function findAncestorsAcrossSections(
  sections: TocSection[],
  targetId: string
): string[] {
  for (const section of sections) {
    for (const entry of section.clauses) {
      if (entry.id === targetId) return [];
      const result = findAncestorsInEntry(entry, targetId);
      if (result) return result;
    }
  }
  return [];
}

/**
 * Find ancestor IDs within a single entry subtree.
 * Returns null if the target is not in this subtree.
 */
function findAncestorsInEntry(
  entry: TocClauseEntry,
  targetId: string
): string[] | null {
  for (const child of entry.children) {
    if (child.id === targetId) return [entry.id];
    const deeper = findAncestorsInEntry(child, targetId);
    if (deeper) return [entry.id, ...deeper];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Risk indicator dot
// ---------------------------------------------------------------------------

const RISK_DOT_COLORS: Record<string, string> = {
  high: "bg-accent-red",
  medium: "bg-accent-amber",
  low: "bg-accent-green",
  info: "bg-accent-blue",
};

function RiskDot({ level }: { level?: string }) {
  if (!level) return null;
  const color = RISK_DOT_COLORS[level.toLowerCase()] ?? "bg-border-light";
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`}
      aria-hidden="true"
    />
  );
}

// ---------------------------------------------------------------------------
// TocClauseItem — recursive clause entry with optional children toggle
// ---------------------------------------------------------------------------

interface TocClauseItemProps {
  clause: TocClauseEntry;
  activeClauseId: string | null;
  onClauseClick: (id: string) => void;
  expandedClauses: Record<string, true>;
  onToggleExpand: (id: string) => void;
}

function TocClauseItem({
  clause,
  activeClauseId,
  onClauseClick,
  expandedClauses,
  onToggleExpand,
}: TocClauseItemProps) {
  const isActive = clause.id === activeClauseId;
  const hasChildren = clause.children.length > 0;
  const isExpanded = !!expandedClauses[clause.id];
  const indentPx = clause.depth * 16;

  const displayText =
    clause.title
      ? clause.title
      : clause.number
        ? `조항 ${clause.number}`
        : "제목 없음";

  return (
    <>
      <li>
        <div
          className={`
            w-full flex items-center py-1.5 text-left
            text-[12px] leading-snug transition-colors duration-100
            hover:bg-bg-hover
            ${
              isActive
                ? "bg-accent-blue-dim text-accent-blue font-medium"
                : clause.depth > 0
                  ? "text-text-muted hover:text-text-secondary"
                  : "text-text-secondary hover:text-text-primary"
            }
          `}
          style={{
            paddingLeft: "16px",
            paddingRight: "16px",
            ...(isActive
              ? { boxShadow: "inset 2px 0 0 var(--accent-blue)" }
              : {}),
          }}
        >
          {/* Indent spacer for child depth */}
          {indentPx > 0 && (
            <span style={{ width: indentPx }} className="shrink-0" aria-hidden="true" />
          )}

          {/* Chevron for parent clauses / spacer for leaf clauses */}
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(clause.id);
              }}
              className="flex items-center justify-start w-4 h-4 shrink-0 mr-1 rounded-sm hover:bg-bg-tertiary transition-colors"
              aria-label={isExpanded ? "하위 조항 접기" : "하위 조항 펼치기"}
              aria-expanded={isExpanded}
            >
              <ChevronRight
                className={`h-2.5 w-2.5 text-text-muted transition-transform duration-150 ${
                  isExpanded ? "rotate-90" : ""
                }`}
                aria-hidden="true"
              />
            </button>
          ) : (
            <span className="w-4 h-4 shrink-0 mr-1" aria-hidden="true" />
          )}

          {/* Clickable area — clause number + title + risk dot */}
          <button
            type="button"
            data-toc-clause-id={clause.id}
            onClick={() => onClauseClick(clause.id)}
            className="flex-1 min-w-0 flex items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-blue focus-visible:ring-inset rounded-sm"
            aria-current={isActive ? "location" : undefined}
          >
            {/* Clause number */}
            {clause.number && (
              <span
                className={`shrink-0 font-mono text-[10px] min-w-[2.5rem] ${
                  isActive ? "text-accent-blue" : "text-text-muted"
                }`}
              >
                {clause.number}
              </span>
            )}

            {/* Clause title */}
            <span className="flex-1 truncate">{displayText}</span>

            {/* Risk dot */}
            <RiskDot level={clause.riskLevel} />
          </button>
        </div>
      </li>

      {/* Children — rendered when expanded */}
      {hasChildren && isExpanded && (
        clause.children.map((child) => (
          <TocClauseItem
            key={child.id}
            clause={child}
            activeClauseId={activeClauseId}
            onClauseClick={onClauseClick}
            expandedClauses={expandedClauses}
            onToggleExpand={onToggleExpand}
          />
        ))
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// TocSectionItem — one zone section in the TOC
// ---------------------------------------------------------------------------

interface TocSectionItemProps {
  section: TocSection;
  activeClauseId: string | null;
  onClauseClick: (id: string) => void;
  expandedClauses: Record<string, true>;
  onToggleExpand: (id: string) => void;
}

function TocSectionItem({
  section,
  activeClauseId,
  onClauseClick,
  expandedClauses,
  onToggleExpand,
}: TocSectionItemProps) {
  const label = ZONE_LABELS[section.zoneType] ?? section.zoneType;
  const hasActive = hasClauseId(section.clauses, activeClauseId ?? "");

  const tocCollapsedSections = useContractDetailViewStore((s) => s.tocCollapsedSections);
  const toggleTocSection = useContractDetailViewStore((s) => s.toggleTocSection);

  const isCollapsed = !!tocCollapsedSections[section.zoneType];

  return (
    <div className="mb-1">
      {/* Zone section header — clickable to collapse/expand */}
      <button
        type="button"
        onClick={() => toggleTocSection(section.zoneType)}
        className="w-full flex items-center gap-1.5 px-4 py-1.5 group hover:bg-bg-hover transition-colors text-left"
        aria-expanded={!isCollapsed}
      >
        <ChevronRight
          className={`h-3 w-3 text-text-muted shrink-0 transition-transform duration-200 ${
            isCollapsed ? "" : "rotate-90"
          }`}
          aria-hidden="true"
        />
        <span
          className={`flex-1 text-[10px] font-bold uppercase tracking-widest transition-colors text-left ${
            hasActive ? "text-accent-blue" : "text-text-muted group-hover:text-text-secondary"
          }`}
        >
          {label}
        </span>
      </button>

      {/* Clause list */}
      {!isCollapsed && (
        <ul role="list" className="space-y-px">
          {section.clauses.map((clause) => (
            <TocClauseItem
              key={clause.id}
              clause={clause}
              activeClauseId={activeClauseId}
              onClauseClick={onClauseClick}
              expandedClauses={expandedClauses}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContractTocPanel — left panel inside a flex row
// ---------------------------------------------------------------------------

export function ContractTocPanel({
  sections,
  activeClauseId,
  onClauseClick,
  onExpandChildren,
  onClose,
  className = "",
}: ContractTocPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const tocWidth = useContractDetailViewStore((s) => s.tocWidth);
  const setTocWidth = useContractDetailViewStore((s) => s.setTocWidth);
  const isDragging = useRef(false);

  // Resize drag handler
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      const startX = e.clientX;
      const startWidth = tocWidth;

      const onMouseMove = (ev: MouseEvent) => {
        if (!isDragging.current) return;
        const newWidth = startWidth + (ev.clientX - startX);
        setTocWidth(newWidth);
      };

      const onMouseUp = () => {
        isDragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [tocWidth, setTocWidth]
  );

  // Local state: which parent clauses have their children expanded
  const [expandedClauses, setExpandedClauses] = useState<Record<string, true>>({});

  const toggleExpand = useCallback((id: string) => {
    setExpandedClauses((prev) => {
      const wasExpanded = !!prev[id];
      if (wasExpanded) {
        const { [id]: _, ...rest } = prev;
        return rest;
      }
      // Expanding — also expand the corresponding clause card in the main view
      if (onExpandChildren) {
        const entry = findEntryById(sections, id);
        if (entry) {
          const childIds = collectChildIds(entry);
          if (childIds.length > 0) {
            onExpandChildren(childIds);
          }
        }
      }
      return { ...prev, [id]: true as const };
    });
  }, [onExpandChildren, sections]);

  // Auto-expand ancestors when the active clause is a child clause
  useEffect(() => {
    if (!activeClauseId) return;
    const ancestors = findAncestorsAcrossSections(sections, activeClauseId);
    if (ancestors.length === 0) return;

    setExpandedClauses((prev) => {
      // Check if all ancestors are already expanded
      const allExpanded = ancestors.every((id) => prev[id]);
      if (allExpanded) return prev;
      // Merge ancestor IDs into expanded state
      const next = { ...prev };
      for (const id of ancestors) {
        next[id] = true as const;
      }
      return next;
    });
  }, [activeClauseId, sections]);

  const totalClauses = sections.reduce(
    (sum, s) => sum + countAllClauses(s.clauses),
    0
  );

  // Auto-scroll the active TOC item into view within the panel
  useEffect(() => {
    if (!activeClauseId || !panelRef.current) return;
    const activeEl = panelRef.current.querySelector(
      `[data-toc-clause-id="${activeClauseId}"]`
    );
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [activeClauseId]);

  return (
    <aside
      id="contract-toc-panel"
      className={`
        hidden lg:flex shrink-0 h-full relative
        ${className}
      `}
      style={{ width: tocWidth }}
      aria-label="문서 목차"
    >
      {/* Panel content */}
      <div className="flex flex-col flex-1 min-w-0 border-r border-border-muted bg-bg-secondary overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen className="h-3.5 w-3.5 text-text-muted shrink-0" aria-hidden="true" />
          <span className="text-[10px] font-bold text-text-secondary uppercase tracking-[2px] text-left">
            목차
          </span>
          {totalClauses > 0 && (
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-muted">
              {totalClauses}
            </span>
          )}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            aria-label="목차 닫기"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* TOC content */}
      <div
        ref={panelRef}
        className="flex-1 overflow-y-auto py-2"
        style={{ scrollbarWidth: "thin", scrollbarColor: "var(--border) transparent" }}
        role="navigation"
        aria-label="조항 목차"
      >
        {sections.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-text-muted">
            목차를 불러올 수 없습니다.
          </div>
        ) : (
          sections.map((section) => (
            <TocSectionItem
              key={section.zoneType}
              section={section}
              activeClauseId={activeClauseId}
              onClauseClick={onClauseClick}
              expandedClauses={expandedClauses}
              onToggleExpand={toggleExpand}
            />
          ))
        )}
      </div>
      </div>

      {/* Resize drag handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize group z-10 flex items-center justify-center hover:bg-accent-blue/30 transition-colors"
        role="separator"
        aria-orientation="vertical"
        aria-label="목차 크기 조절"
      >
        <div className="w-px h-full bg-transparent group-hover:bg-accent-blue/50 transition-colors" />
      </div>
    </aside>
  );
}

/**
 * Imperative scroll-to-clause helper — safe to call from click handlers.
 */
export function scrollToClause(clauseId: string): void {
  const el = document.querySelector(`[data-clause-id="${clauseId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}
