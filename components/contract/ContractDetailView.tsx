"use client";

import { useState, useMemo, useEffect, useRef, useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, BookOpen } from "lucide-react";
import { useContractDetailViewStore, type RiskFilter, type ZoneFilter } from "../../lib/stores/contract-detail-view";
import type { ContractDetailContract, ContractDetailAnalysis, ContractDetailZone } from "../../lib/data/contracts";
import { ZONE_ORDER } from "../../lib/layout/zone-classifier";
import { ClauseSectionGroup } from "./ClauseSectionGroup";
import { ContractTocPanel, scrollToClause, type TocSection, type TocClauseEntry } from "./ContractTocPanel";
import { renderBoldMarkdown } from "./render-bold-markdown";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClauseItem {
  id: string;
  title?: string;
  text: string;
  clausePrefix?: string;
  number?: string;
  riskLevel?: string;
  needsReview?: boolean;
  sortOrder: number;
  zoneKey?: string;
  zoneId?: string;
  /**
   * Title of the sub-document this clause belongs to.
   * When present, a section header is inserted whenever this value changes
   * in the filtered clause list. Absent = no sub-document headers shown.
   */
  subDocumentTitle?: string;
}

interface ContractDetailViewProps {
  contractId: string;
  contract: Pick<ContractDetailContract, "name" | "status" | "page_count">;
  clauseItems: ClauseItem[];
  analyses: ContractDetailAnalysis[];
  zones: ContractDetailZone[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RiskLevel = "high" | "medium" | "low" | "info";

function normalizeRisk(level?: string): RiskLevel | undefined {
  if (!level) return undefined;
  const lower = level.toLowerCase();
  if (lower === "high" || lower === "medium" || lower === "low" || lower === "info") {
    return lower;
  }
  return undefined;
}

const RISK_BORDER_COLORS: Record<RiskLevel, string> = {
  high: "border-l-accent-red",
  medium: "border-l-accent-amber",
  low: "border-l-accent-green",
  info: "border-l-accent-blue",
};

const RISK_BADGE_STYLES: Record<RiskLevel, string> = {
  high: "bg-accent-red-dim text-accent-red",
  medium: "bg-accent-amber-dim text-accent-amber border border-accent-amber/30",
  low: "bg-accent-green-dim text-accent-green",
  info: "bg-accent-blue-dim text-accent-blue",
};

const RISK_LABELS: Record<RiskLevel, string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
  info: "INFO",
};

const ZONE_LABELS_LOCAL: Record<string, string> = {
  preamble: "문서 전문",
  general_conditions: "일반조건",
  contract_agreement: "합의서",
  appendices: "부속서",
  contract_body: "계약본문",
  particular_conditions: "특수조건",
  conditions_of_contract: "계약조건",
  commercial_terms: "상업조건",
  definitions: "정의",
};

const ZONE_FILTER_OPTIONS: { value: ZoneFilter; label: string }[] = [
  { value: "ALL", label: "전체 구역" },
  { value: "general_conditions", label: "일반 조건" },
  { value: "contract_agreement", label: "계약 합의" },
  { value: "appendices", label: "부속서" },
  { value: "contract_body", label: "기타" },
];

// ---------------------------------------------------------------------------
// Clause depth helpers
// ---------------------------------------------------------------------------

/**
 * 조항 번호 문자열에서 들여쓰기 깊이를 계산합니다.
 * 0: 최상위 (ARTICLE, 단일 숫자, SCHEDULE)
 * 1: 서브절 (1.1, SECTION 3.1)
 * 2: 알파 소괄호 (a), (b)
 * 3: 로마 소괄호 (i), (ii), (xiv)
 */
function getClauseDepth(number: string | undefined): 0 | 1 | 2 | 3 | 4 {
  if (!number) return 0;
  if (/^\((?:i{1,3}|iv|vi{0,3}|ix|xi{0,3}|xiv|x{1,3})\)$/i.test(number)) return 3;
  if (/^\([a-z]\)$/i.test(number)) return 2;
  const dotMatch = /^(\d+(?:\.\d+)+)$/.exec(number);
  if (dotMatch) return Math.min(dotMatch[1].split(".").length - 1, 4) as 0 | 1 | 2 | 3 | 4;
  if (/^SECTION\s+\d+\.\d/i.test(number)) return 1;
  return 0;
}

/** depth별 카드 배경색: 깊은 조항일수록 약간 어두운 배경 */
const DEPTH_INDENT: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "",
  1: "",
  2: "ml-6",   // 24px
  3: "ml-10",  // 40px
  4: "ml-14",  // 56px
};

const DEPTH_BG: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "bg-bg-card",
  1: "bg-bg-card",
  2: "bg-bg-secondary",
  3: "bg-bg-secondary",
  4: "bg-bg-tertiary",
};

/**
 * 본문/분석 영역 왼쪽 들여쓰기:
 * px-5(1.25rem) + chevron(1.5rem) + gap(0.75rem) + 번호열(4.5rem) + gap(0.75rem) = 8.75rem
 */
const BODY_INDENT = "pl-[8.75rem]";

/** 본문 최대 너비: 0 = 제한 없음, 그 외 ch 단위 */
const CONTENT_WIDTH_MIN = 60;
const CONTENT_WIDTH_MAX = 200;

// ---------------------------------------------------------------------------
// Text indent helpers — (a), (i) 등 하위 항목 줄에 들여쓰기 적용
// ---------------------------------------------------------------------------

const ALPHA_PAREN_RE = /^\(([a-z])\)\s+/i;
const ROMAN_PAREN_RE = /^\((i{1,3}|iv|vi{0,3}|ix|xi{0,3}|xiv|xv|x{1,3})\)\s+/i;
const NUMBERED_PAREN_RE = /^\((\d+)\)\s+/;

/** 마커 매칭 결과: indent 레벨 + 마커 문자열 + 나머지 본문 */
function matchMarker(trimmed: string): { level: "alpha" | "roman"; marker: string; body: string } | null {
  let m = ROMAN_PAREN_RE.exec(trimmed);
  if (m) return { level: "roman", marker: m[0].trimEnd(), body: trimmed.slice(m[0].length) };
  m = ALPHA_PAREN_RE.exec(trimmed);
  if (m) return { level: "alpha", marker: m[0].trimEnd(), body: trimmed.slice(m[0].length) };
  m = NUMBERED_PAREN_RE.exec(trimmed);
  if (m) return { level: "alpha", marker: m[0].trimEnd(), body: trimmed.slice(m[0].length) };
  return null;
}

/** 레벨별 들여쓰기 margin */
const MARKER_INDENT: Record<"alpha" | "roman", string> = {
  alpha: "ml-6",   // 24px
  roman: "ml-12",  // 48px
};

/**
 * 텍스트 노드 내에서 검색어 매칭 부분을 <mark>로 하이라이트합니다.
 * ReactNode 배열을 순회하며 문자열 부분만 처리합니다.
 */
function highlightSearchMatches(
  nodes: React.ReactNode,
  query: string,
  keyPrefix: string,
): React.ReactNode {
  if (!query) return nodes;

  function highlightString(text: string, key: string): React.ReactNode {
    const lower = text.toLowerCase();
    const qLower = query.toLowerCase();
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    let idx = lower.indexOf(qLower);
    let matchCount = 0;

    while (idx !== -1) {
      if (idx > lastIdx) parts.push(text.slice(lastIdx, idx));
      parts.push(
        <mark key={`${key}-hl${matchCount}`} className="bg-accent-yellow-dim text-text-primary rounded-sm px-0.5">
          {text.slice(idx, idx + query.length)}
        </mark>
      );
      matchCount++;
      lastIdx = idx + query.length;
      idx = lower.indexOf(qLower, lastIdx);
    }

    if (matchCount === 0) return text;
    if (lastIdx < text.length) parts.push(text.slice(lastIdx));
    return parts;
  }

  function walk(node: React.ReactNode, key: string): React.ReactNode {
    if (typeof node === "string") return highlightString(node, key);
    if (Array.isArray(node)) return node.map((child, i) => walk(child, `${key}-${i}`));
    return node; // JSX elements (like <strong>) are left as-is
  }

  return walk(nodes, keyPrefix);
}

/**
 * 조항 본문 텍스트를 줄 단위로 파싱하여 (a), (i) 등의 하위 항목에
 * 들여쓰기를 적용하고, **bold** 마크다운을 굵게 렌더링합니다.
 */
function renderIndentedText(text: string, searchQuery?: string): React.ReactNode {
  // Split by double-newline to detect paragraph boundaries
  const paragraphs = text.split(/\n\n+/);

  if (paragraphs.length <= 1) {
    return renderParagraphLines(text, searchQuery);
  }

  return paragraphs.map((para, pi) => (
    <div key={`p${pi}`} className={pi > 0 ? "mt-2" : ""}>
      {renderParagraphLines(para, searchQuery)}
    </div>
  ));
}

/** Render individual lines within a paragraph, applying indent for (a), (i), (1) patterns. */
function renderParagraphLines(text: string, searchQuery?: string): React.ReactNode {
  const lines = text.split("\n");
  const result: React.ReactNode[] = [];
  const activeQuery = searchQuery?.trim() || "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    let rendered: React.ReactNode = renderBoldMarkdown(line, `l${i}`);

    // Apply keyword highlighting if search query is active
    if (activeQuery) {
      rendered = highlightSearchMatches(rendered, activeQuery, `l${i}`);
    }

    // 내어쓰기 (hanging indent): 마커와 본문을 flex로 분리
    const match = matchMarker(trimmed);

    if (match) {
      let bodyRendered: React.ReactNode = renderBoldMarkdown(match.body, `l${i}`);
      if (activeQuery) {
        bodyRendered = highlightSearchMatches(bodyRendered, activeQuery, `l${i}`);
      }
      result.push(
        <div key={i} className={`${MARKER_INDENT[match.level]} flex whitespace-normal`}>
          <span className="shrink-0 mr-3">{match.marker}</span>
          <span className="flex-1">{bodyRendered}</span>
        </div>
      );
    } else {
      result.push(rendered);
      if (i < lines.length - 1) result.push("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Clause tree
// ---------------------------------------------------------------------------

interface ClauseTreeNode {
  clause: ClauseItem;
  children: ClauseTreeNode[];
  depth: 0 | 1 | 2 | 3 | 4;
}

/**
 * flat 조항 배열을 스택 기반으로 트리로 변환합니다.
 * 더 낮은 depth를 만나면 현재 스택의 상위 노드를 부모로 사용합니다.
 */
function buildClauseTree(clauses: ClauseItem[]): ClauseTreeNode[] {
  const roots: ClauseTreeNode[] = [];
  const stack: ClauseTreeNode[] = [];

  for (const clause of clauses) {
    const depth = getClauseDepth(clause.number);
    const node: ClauseTreeNode = { clause, children: [], depth };

    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  return roots;
}

function parseRecommendations(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/\n|;|;/)
    .map((s) => s.replace(/^[-\u2022*]\s*/, "").trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold ${RISK_BADGE_STYLES[level]}`}
    >
      {RISK_LABELS[level]}
    </span>
  );
}

function ZoneBadge({ zoneKey }: { zoneKey: string }) {
  const label = ZONE_LABELS_LOCAL[zoneKey] ?? zoneKey;
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color: "var(--text-muted)", background: "var(--bg-tertiary)" }}
    >
      {label}
    </span>
  );
}

function ClauseInlineAnalysis({ analysis }: { analysis: ContractDetailAnalysis }) {
  const recs = parseRecommendations(analysis.recommendations);

  const fidicDisplay =
    analysis.fidic_comparisons != null
      ? typeof analysis.fidic_comparisons === "string"
        ? analysis.fidic_comparisons
        : JSON.stringify(analysis.fidic_comparisons)
      : undefined;

  return (
    <div className="mt-3 space-y-3 rounded-lg bg-bg-secondary p-4 text-sm border-t border-border-muted">
      {/* Risk summary */}
      <div>
        <div className="mb-1 text-xs font-semibold text-text-muted uppercase tracking-wide">
          리스크 요약
        </div>
        <p className="text-[13px] leading-relaxed text-text-secondary text-justify">
          {analysis.risk_summary || "\u2014"}
        </p>
      </div>

      {/* Recommendations */}
      <div>
        <div className="mb-1 text-xs font-semibold text-text-muted uppercase tracking-wide">
          수정 권고사항
        </div>
        {recs.length > 0 ? (
          <ul className="space-y-1">
            {recs.map((rec, i) => (
              // BUG-09: 인덱스 대신 내용 기반 key 사용
              <li key={`rec-${i}-${rec.slice(0, 20)}`} className="flex items-start gap-2 text-[13px] text-text-secondary">
                <span className="mt-0.5 text-accent-blue shrink-0">&rarr;</span>
                <span>{rec}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-text-muted">&mdash;</p>
        )}
      </div>

      {/* FIDIC comparison */}
      <div>
        <div className="mb-1 text-xs font-semibold text-text-muted uppercase tracking-wide">
          FIDIC 비교
        </div>
        {fidicDisplay ? (
          <div className="rounded bg-bg-tertiary p-3">
            <div className="text-[13px] font-medium">FIDIC 편차 분석</div>
            <div className="mt-1 text-[13px] text-text-muted leading-relaxed text-justify">
              {fidicDisplay}
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-text-muted">&mdash;</p>
        )}
      </div>

      {/* Model info */}
      {analysis.llm_model && (
        <div className="text-[11px] text-text-muted">
          모델: {analysis.llm_model}
        </div>
      )}
    </div>
  );
}

interface ClauseDocumentItemProps {
  clause: ClauseItem;
  index: number;
  analysis: ContractDetailAnalysis | undefined;
  isExpanded: boolean;
  onToggle: () => void;
  searchQuery?: string;
  children?: React.ReactNode;
}

function ClauseDocumentItem({
  clause,
  index,
  analysis,
  isExpanded,
  onToggle,
  searchQuery: itemSearchQuery,
  children,
}: ClauseDocumentItemProps) {
  const contentWidthCh = useContractDetailViewStore((s) => s.contentWidthCh);
  const risk = normalizeRisk(clause.riskLevel);
  const borderClass = risk ? RISK_BORDER_COLORS[risk] : "border-l-border-muted";
  const hasAnalysis = !!analysis;
  const depth = getClauseDepth(clause.number);
  const bgClass = DEPTH_BG[depth];
  const indentClass = DEPTH_INDENT[depth];
  // 자동생성된 번호 (preamble-1, *-auto-*) → 번호/제목 숨김
  // 자동생성된 번호 (preamble-1, *-auto-*, *-intro, zone-N) → 번호/제목 숨김
  const isAutoNumber = !clause.number
    || clause.number.includes("-auto-")
    || clause.number.startsWith("preamble")
    || clause.number.endsWith("-intro")
    || /^[a-z_]+-\d+$/.test(clause.number);

  return (
    <div
      data-clause-id={clause.id}
      className={`border-l-4 ${borderClass} ${bgClass} ${indentClass} rounded-lg shadow-card transition-all duration-200 hover:ring-1 hover:ring-border-muted`}
    >

      {/* ── Header: 클릭으로 본문 토글 ───────────────────────────────── */}
      <button
        type="button"
        onClick={onToggle}
        className={`w-full text-left grid ${isAutoNumber ? "grid-cols-[1.5rem_1fr]" : "grid-cols-[1.5rem_minmax(4.5rem,auto)_1fr]"} gap-x-3 px-5 pt-4 pb-3 items-start hover:bg-black/5 transition-colors rounded-t-lg`}
      >
        {/* 토글 화살표 */}
        <ChevronRight
          className={`h-4 w-4 text-text-muted mt-0.5 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`}
        />

        {/* 번호 열 — 자동생성 번호는 숨김 */}
        {!isAutoNumber && (
          <div className="flex flex-col items-start gap-0.5 min-w-0">
            {clause.clausePrefix && (
              <span className="text-[10px] text-text-muted font-mono uppercase tracking-wide leading-none w-full truncate">
                {clause.clausePrefix}
              </span>
            )}
            <span className="text-sm font-semibold text-accent-blue font-mono leading-snug break-all">
              {clause.number ?? String(index + 1)}
            </span>
          </div>
        )}

        {/* 제목 + 배지 열 */}
        <div className="flex items-start justify-between gap-2 min-w-0">
          {!isAutoNumber && (
            <span className="text-sm font-semibold text-text-primary leading-snug">
              {clause.title ?? ""}
            </span>
          )}
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            {clause.zoneKey && <ZoneBadge zoneKey={clause.zoneKey} />}
            {clause.needsReview && (
              <span className="inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium bg-accent-yellow-dim text-accent-yellow border border-accent-yellow/30">
                검토 필요
              </span>
            )}
            {risk && <RiskBadge level={risk} />}
          </div>
        </div>
      </button>

      {/* ── 본문 + 분석: 접힘 애니메이션 ────────────────────────────── */}
      <div
        className={`grid transition-all duration-300 ease-in-out will-change-[grid-template-rows] ${
          isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          {/* 본문 텍스트 — (a), (i) 등 하위 항목 들여쓰기 적용 */}
          <div
            className={`${BODY_INDENT} pr-5 pb-3 text-[13px] leading-[1.75] text-text-primary/80 whitespace-pre-wrap break-words text-justify`}
            style={contentWidthCh > 0 ? { maxWidth: `${contentWidthCh}ch` } : undefined}
          >
            {renderIndentedText(clause.text, itemSearchQuery)}
          </div>

          {/* 분석 결과 */}
          {hasAnalysis && (
            <div className={`${BODY_INDENT} pr-5 pb-4`}>
              <ClauseInlineAnalysis analysis={analysis} />
            </div>
          )}

          {!hasAnalysis && (
            <div className={`${BODY_INDENT} pr-5 pb-4 flex items-center gap-1.5 text-xs text-text-muted`}>
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-border-light" />
              분석 대기 중
            </div>
          )}

          {/* 하위 조항 (재귀) — depth별 들여쓰기는 각 카드 자체에 적용 */}
          {children && (
            <div className="pr-2 pb-3 space-y-2">
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recursive tree item
// ---------------------------------------------------------------------------

function ClauseTreeItem({
  node,
  index,
  analysisMap,
  expandedClauseIds,
  toggleClause,
  searchQuery: treeSearchQuery,
}: {
  node: ClauseTreeNode;
  index: number;
  analysisMap: Map<string, ContractDetailAnalysis>;
  expandedClauseIds: Record<string, true>;
  toggleClause: (id: string) => void;
  searchQuery?: string;
}) {
  return (
    <ClauseDocumentItem
      clause={node.clause}
      index={index}
      analysis={analysisMap.get(node.clause.id)}
      isExpanded={!!expandedClauseIds[node.clause.id]}
      onToggle={() => toggleClause(node.clause.id)}
      searchQuery={treeSearchQuery}
    >
      {node.children.length > 0
        ? node.children.map((child, i) => (
            <ClauseTreeItem
              key={child.clause.id}
              node={child}
              index={i}
              analysisMap={analysisMap}
              expandedClauseIds={expandedClauseIds}
              toggleClause={toggleClause}
              searchQuery={treeSearchQuery}
            />
          ))
        : null}
    </ClauseDocumentItem>
  );
}

// ---------------------------------------------------------------------------
// Filter tabs
// ---------------------------------------------------------------------------

const FILTER_TABS: { value: RiskFilter; label: string }[] = [
  { value: "ALL", label: "전체" },
  { value: "HIGH", label: "HIGH" },
  { value: "MEDIUM", label: "MEDIUM" },
  { value: "LOW", label: "LOW" },
  { value: "INFO", label: "INFO" },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ContractDetailView({
  contractId,
  contract,
  clauseItems,
  analyses,
  zones,
}: ContractDetailViewProps) {
  const router = useRouter();
  const [analyzing, setAnalyzing] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // IntersectionObserver for TOC scroll spy
  const [activeClauseId, setActiveClauseId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const clauseScrollRef = useRef<HTMLDivElement | null>(null);
  // Interaction lock: suppress IntersectionObserver updates after TOC clicks
  const tocInteractionLockRef = useRef(false);
  const tocLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const expandedClauseIds = useContractDetailViewStore((s) => s.expandedClauseIds);
  const riskFilter = useContractDetailViewStore((s) => s.riskFilter);
  const zoneFilter = useContractDetailViewStore((s) => s.zoneFilter);
  const searchQuery = useContractDetailViewStore((s) => s.searchQuery);
  const tocOpen = useContractDetailViewStore((s) => s.tocOpen);
  const toggleClause = useContractDetailViewStore((s) => s.toggleClause);
  const expandAll = useContractDetailViewStore((s) => s.expandAll);
  const collapseAll = useContractDetailViewStore((s) => s.collapseAll);
  const expandHighRisk = useContractDetailViewStore((s) => s.expandHighRisk);
  const setRiskFilter = useContractDetailViewStore((s) => s.setRiskFilter);
  const setZoneFilter = useContractDetailViewStore((s) => s.setZoneFilter);
  const setSearchQuery = useContractDetailViewStore((s) => s.setSearchQuery);
  const resetForContract = useContractDetailViewStore((s) => s.resetForContract);
  const collapseAllSections = useContractDetailViewStore((s) => s.collapseAllSections);
  const expandAllSections = useContractDetailViewStore((s) => s.expandAllSections);
  const toggleToc = useContractDetailViewStore((s) => s.toggleToc);
  const expandSectionClauses = useContractDetailViewStore((s) => s.expandSectionClauses);
  const collapsedSectionKeys = useContractDetailViewStore((s) => s.collapsedSectionKeys);
  const toggleSection = useContractDetailViewStore((s) => s.toggleSection);
  const contentWidthCh = useContractDetailViewStore((s) => s.contentWidthCh);
  const setContentWidthCh = useContractDetailViewStore((s) => s.setContentWidthCh);

  // 계약 변경 시 필터/펼침 상태 리셋 (BUG-10)
  useEffect(() => {
    resetForContract();
    return () => {
      abortControllerRef.current?.abort();
      if (tocLockTimerRef.current) clearTimeout(tocLockTimerRef.current);
    };
  }, [contractId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build analysis map
  const analysisMap = useMemo(
    () => new Map(analyses.map((a) => [a.clause_id, a])),
    [analyses]
  );

  // zones를 Map으로 인덱싱 (id → zone)
  const zoneMap = useMemo(
    () => new Map(zones.map((z) => [z.id, z])),
    [zones]
  );

  // Enrich clauses with risk from analysis
  const enrichedClauses = useMemo(
    () =>
      clauseItems.map((c) => {
        const a = analysisMap.get(c.id);
        return {
          ...c,
          riskLevel: c.riskLevel ?? a?.risk_level,
        };
      }),
    [clauseItems, analysisMap]
  );

  // Whether any clause carries a zoneKey — determines if zone dropdown is shown
  const hasZoneData = useMemo(
    () => enrichedClauses.some((c) => c.zoneKey),
    [enrichedClauses]
  );

  // Filter clauses
  const filteredClauses = useMemo(() => {
    let result = enrichedClauses;

    if (riskFilter !== "ALL") {
      result = result.filter(
        (c) => c.riskLevel?.toUpperCase() === riskFilter
      );
    }

    if (zoneFilter !== "ALL") {
      result = result.filter(
        (c) => !c.zoneKey || c.zoneKey === zoneFilter
      );
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) =>
          c.text.toLowerCase().includes(q) ||
          (c.title?.toLowerCase().includes(q) ?? false) ||
          (c.number?.toLowerCase().includes(q) ?? false)
      );
    }

    return result;
  }, [enrichedClauses, riskFilter, zoneFilter, searchQuery]);

  // Group filtered clauses by zone_type (via zone_id → zoneMap)
  const groupedByZone = useMemo(() => {
    const grouped = new Map<string, typeof filteredClauses>();
    for (const clause of filteredClauses) {
      // Prefer zone_id lookup; fall back to zoneKey for backward compat
      const zone = clause.zoneId ? zoneMap.get(clause.zoneId) : undefined;
      const key = zone?.zone_type ?? clause.zoneKey ?? "unknown";
      const existing = grouped.get(key);
      if (existing) {
        existing.push(clause);
      } else {
        grouped.set(key, [clause]);
      }
    }
    return grouped;
  }, [filteredClauses, zoneMap]);

  // Sort sections by ZONE_ORDER, then unknown at the end
  const orderedSections = useMemo(() => {
    const result: Array<{ zoneType: string; clauses: typeof filteredClauses }> = [];
    for (const zoneType of ZONE_ORDER) {
      const sectionClauses = groupedByZone.get(zoneType);
      if (sectionClauses && sectionClauses.length > 0) {
        result.push({ zoneType, clauses: sectionClauses });
      }
    }
    // Append zones not in ZONE_ORDER (e.g. "unknown", legacy keys)
    for (const [key, sectionClauses] of groupedByZone) {
      if (!ZONE_ORDER.includes(key) && sectionClauses.length > 0) {
        result.push({ zoneType: key, clauses: sectionClauses });
      }
    }
    return result;
  }, [groupedByZone]);

  // Whether zone grouping is usable (zones data present)
  const hasZoneGrouping = zones.length > 0;

  // Build TOC sections with hierarchical clause tree structure
  const tocSections = useMemo<TocSection[]>(() => {
    /** Convert a flat clause list to a hierarchical TocClauseEntry tree. */
    function buildTocTree(clauses: typeof filteredClauses): TocClauseEntry[] {
      const roots: TocClauseEntry[] = [];
      const stack: TocClauseEntry[] = [];

      for (const clause of clauses) {
        const depth = getClauseDepth(clause.number);
        const entry: TocClauseEntry = {
          id: clause.id,
          number: clause.number,
          title: clause.title,
          riskLevel: clause.riskLevel,
          depth,
          children: [],
        };

        // Pop stack until we find a parent with smaller depth
        while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
          stack.pop();
        }

        if (stack.length === 0) {
          roots.push(entry);
        } else {
          stack[stack.length - 1].children.push(entry);
        }
        stack.push(entry);
      }

      return roots;
    }

    if (!hasZoneGrouping) {
      // Fallback: single section with all clauses in tree form
      if (filteredClauses.length === 0) return [];
      return [
        {
          zoneType: "contract_body",
          clauses: buildTocTree(filteredClauses),
        },
      ];
    }
    return orderedSections.map(({ zoneType, clauses: sectionClauses }) => ({
      zoneType,
      clauses: buildTocTree(sectionClauses),
    }));
  }, [orderedSections, hasZoneGrouping, filteredClauses]);

  // Build a child→parent map so we can expand ancestors on TOC click
  const childToParentMap = useMemo(() => {
    const map = new Map<string, string[]>();
    function walk(nodes: ClauseTreeNode[], ancestors: string[]) {
      for (const node of nodes) {
        if (ancestors.length > 0) {
          map.set(node.clause.id, [...ancestors]);
        }
        walk(node.children, [...ancestors, node.clause.id]);
      }
    }
    // Build tree from all filtered clauses across all sections
    if (hasZoneGrouping) {
      for (const section of orderedSections) {
        walk(buildClauseTree(section.clauses), []);
      }
    } else {
      walk(buildClauseTree(filteredClauses), []);
    }
    return map;
  }, [filteredClauses, orderedSections, hasZoneGrouping]);

  // Lock helper: suppress IntersectionObserver for a duration after TOC interaction
  const lockTocInteraction = useCallback((durationMs = 1500) => {
    tocInteractionLockRef.current = true;
    if (tocLockTimerRef.current) clearTimeout(tocLockTimerRef.current);
    tocLockTimerRef.current = setTimeout(() => {
      tocInteractionLockRef.current = false;
    }, durationMs);
  }, []);

  // TOC 조항 클릭 → 부모 포함 카드 펼치기 + 섹션 펼치기 + 스크롤 이동
  const handleClauseClick = useCallback((clauseId: string) => {
    lockTocInteraction();
    setActiveClauseId(clauseId);

    const store = useContractDetailViewStore.getState();

    // 1) 해당 조항 + 모든 조상 카드를 펼치기 (부모가 접혀있으면 자식이 보이지 않으므로)
    const ancestors = childToParentMap.get(clauseId) ?? [];
    const toExpand = [...ancestors, clauseId].filter((id) => !store.expandedClauseIds[id]);
    if (toExpand.length > 0) {
      expandSectionClauses(toExpand);
    }

    // 2) 해당 조항이 속한 zone 섹션이 접혀있으면 펼치기
    const sectionKeys = store.collapsedSectionKeys;
    for (const section of orderedSections) {
      if (section.clauses.some((c) => c.id === clauseId)) {
        if (sectionKeys[section.zoneType]) {
          toggleSection(section.zoneType);
        }
        break;
      }
    }

    // 3) DOM 업데이트 후 스크롤 이동 — 두 프레임 대기하여 펼치기 애니메이션 시작 보장
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToClause(clauseId);
      });
    });
  }, [lockTocInteraction, expandSectionClauses, toggleSection, orderedSections, childToParentMap]);

  // Risk distribution stats
  const riskStats = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0, info: 0 };
    for (const c of enrichedClauses) {
      const r = normalizeRisk(c.riskLevel);
      if (r) counts[r]++;
    }
    return counts;
  }, [enrichedClauses]);

  const analyzedCount = useMemo(
    () => clauseItems.filter((c) => analysisMap.has(c.id)).length,
    [clauseItems, analysisMap]
  );
  const unanalyzedCount = clauseItems.length - analyzedCount;

  // IDs for bulk expand
  const allAnalyzedIds = useMemo(
    () => enrichedClauses.filter((c) => analysisMap.has(c.id)).map((c) => c.id),
    [enrichedClauses, analysisMap]
  );
  const highRiskIds = useMemo(
    () =>
      enrichedClauses
        .filter((c) => normalizeRisk(c.riskLevel) === "high" && analysisMap.has(c.id))
        .map((c) => c.id),
    [enrichedClauses, analysisMap]
  );

  // Active zone type keys for section collapse/expand
  const activeSectionZoneTypes = useMemo(
    () => orderedSections.map((s) => s.zoneType),
    [orderedSections]
  );

  // TOC 펼침 화살표 클릭 시 lock 적용 (IntersectionObserver 억제)
  const handleExpandChildren = useCallback((childIds: string[]) => {
    lockTocInteraction();
    expandSectionClauses(childIds);
  }, [lockTocInteraction, expandSectionClauses]);

  // IntersectionObserver — scroll spy for TOC active highlighting
  // Re-runs when the visible clause count changes (filter changes mount/unmount cards)
  const filteredClausesLength = filteredClauses.length;
  useEffect(() => {
    observerRef.current?.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        // TOC 상호작용 중에는 observer 업데이트 억제
        if (tocInteractionLockRef.current) return;

        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

        if (visible.length > 0) {
          const id = visible[0].target.getAttribute("data-clause-id");
          if (id) setActiveClauseId(id);
        }
      },
      { root: clauseScrollRef.current, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    );

    observerRef.current = observer;

    // Small delay to let the DOM settle after filter changes
    // Only observe top-level clause cards (not children nested inside parents)
    // to prevent parent elements from overshadowing child in scroll spy
    const rafId = requestAnimationFrame(() => {
      const cards = document.querySelectorAll("[data-clause-id]");
      cards.forEach((el) => {
        const parent = el.parentElement?.closest("[data-clause-id]");
        if (!parent) {
          observer.observe(el);
        }
      });
    });

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [filteredClausesLength]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Analysis handler (preserved from original)
  // ---------------------------------------------------------------------------
  const runAnalysis = async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setMessage(null);
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/analyze`, {
        method: "POST",
        signal: controller.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401 && body?.code === "GEMINI_KEY_INVALID") {
          router.push("/?geminiKeyInvalid=1");
          return;
        }
        setMessage({ type: "error", text: body?.error ?? "분석 요청에 실패했습니다." });
        return;
      }
      const text =
        body.message ??
        (body.analyzed != null
          ? `${body.analyzed}건 분석 완료${body.total != null ? ` (전체 ${body.total}건)` : ""}.`
          : "분석이 완료되었습니다.");
      setMessage({ type: "success", text });
      router.refresh();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setMessage({ type: "error", text: "네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." });
    } finally {
      setAnalyzing(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  /**
   * Flat clause list renderer (fallback when no zone data is available).
   * Preserves the original subDocumentTitle header logic.
   */
  function renderFlatClauses(clauses: typeof filteredClauses): ReactNode {
    const hasSubDocHeaders = clauses.some((c) => c.subDocumentTitle !== undefined);

    if (!hasSubDocHeaders) {
      return buildClauseTree(clauses).map((node, i) => (
        <ClauseTreeItem
          key={node.clause.id}
          node={node}
          index={i}
          analysisMap={analysisMap}
          expandedClauseIds={expandedClauseIds}
          toggleClause={toggleClause}
          searchQuery={searchQuery}
        />
      ));
    }

    // subDocumentTitle 그룹별로 트리를 빌드
    const groups: { title: string | undefined; items: typeof filteredClauses }[] = [];
    let current: typeof filteredClauses = [];
    let currentTitle: string | undefined = undefined;
    for (const clause of clauses) {
      if (clause.subDocumentTitle !== currentTitle) {
        if (current.length > 0) groups.push({ title: currentTitle, items: current });
        currentTitle = clause.subDocumentTitle;
        current = [];
      }
      current.push(clause);
    }
    if (current.length > 0) groups.push({ title: currentTitle, items: current });

    return groups.map((group, gi) => (
      <div key={group.title ?? `group-${gi}`} className={gi > 0 ? "mt-5" : ""}>
        {group.title !== undefined && (
          <div className="mb-2 flex items-center gap-2 rounded-md border-l-[3px] border-accent-blue bg-bg-tertiary px-3 py-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
              문서
            </span>
            <span className="text-xs font-bold text-text-primary">{group.title}</span>
          </div>
        )}
        <div className="space-y-2">
          {buildClauseTree(group.items).map((node, i) => (
            <ClauseTreeItem
              key={node.clause.id}
              node={node}
              index={i}
              analysisMap={analysisMap}
              expandedClauseIds={expandedClauseIds}
              toggleClause={toggleClause}
              searchQuery={searchQuery}
            />
          ))}
        </div>
      </div>
    ));
  }

  return (
    <div className="flex" style={{ height: "calc(100vh - 3rem)" }}>
      {/* ── Left TOC panel — full height from tab-nav to bottom ── */}
      {tocOpen && (
        <ContractTocPanel
          sections={tocSections}
          activeClauseId={activeClauseId}
          onClauseClick={handleClauseClick}
          onExpandChildren={handleExpandChildren}
          onClose={toggleToc}
        />
      )}

      {/* ── Clause area — flex column ── */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* ---- Header ---- */}
        <div className="page-header shrink-0">
            <div>
              <div className="page-title">조항 분석</div>
              <div className="page-subtitle">
                {contract.name} &middot; {clauseItems.length}개 조항
                {analyzedCount > 0 && ` \u00B7 분석 ${analyzedCount}건`}
              </div>
              {/* Risk distribution summary */}
              {analyzedCount > 0 && (
                <div className="mt-2 flex items-center gap-3 text-xs">
                  {riskStats.high > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-accent-red" />
                      <span className="text-text-secondary">High {riskStats.high}</span>
                    </span>
                  )}
                  {riskStats.medium > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-accent-amber" />
                      <span className="text-text-secondary">Medium {riskStats.medium}</span>
                    </span>
                  )}
                  {riskStats.low > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-accent-green" />
                      <span className="text-text-secondary">Low {riskStats.low}</span>
                    </span>
                  )}
                  {riskStats.info > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-2 h-2 rounded-full bg-accent-blue" />
                      <span className="text-text-secondary">Info {riskStats.info}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="page-actions">
              {/* TOC toggle button — desktop only */}
              <button
                type="button"
                onClick={toggleToc}
                className={`hidden lg:inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  tocOpen
                    ? "bg-accent-blue-dim text-accent-blue"
                    : "bg-bg-secondary text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                }`}
                aria-label={tocOpen ? "목차 닫기" : "목차 열기"}
                aria-expanded={tocOpen}
                aria-controls="contract-toc-panel"
              >
                <BookOpen className="h-3.5 w-3.5" />
                목차
              </button>

              {unanalyzedCount > 0 && (
                <button
                  className="btn btn-primary"
                  onClick={runAnalysis}
                  disabled={analyzing || contract.status === "analyzing"}
                >
                  {analyzing || contract.status === "analyzing"
                    ? "\u27F3 분석 중\u2026"
                    : `\u26A1 분석 실행 (${unanalyzedCount}건)`}
                </button>
              )}
              {unanalyzedCount === 0 && analyzedCount > 0 && (
                <button
                  className="btn btn-primary"
                  onClick={runAnalysis}
                  disabled={analyzing || contract.status === "analyzing"}
                >
                  {analyzing || contract.status === "analyzing"
                    ? "\u27F3 분석 중\u2026"
                    : "\u26A1 재분석"}
                </button>
              )}
            </div>
        </div>

        {/* ---- Message bar ---- */}
        {message && (
            <div
              className={`shrink-0 mx-8 mt-3 rounded-lg px-4 py-2.5 text-[13px] ${
                message.type === "success"
                  ? "bg-accent-green-dim text-accent-green"
                  : "bg-accent-red-dim text-accent-red"
              }`}
            >
              {message.text}
            </div>
        )}

        {/* ---- Filter bar (sticky, outside scroll area) ---- */}
        <div className="shrink-0 px-8 pt-6 pb-3 space-y-3">
          {/* Row 1: Risk filter tabs + Zone dropdown */}
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-lg bg-bg-secondary p-1 gap-0.5">
              {FILTER_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setRiskFilter(tab.value)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    riskFilter === tab.value
                      ? "bg-bg-hover text-text-primary"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {hasZoneData && (
              <select
                value={zoneFilter}
                onChange={(e) => setZoneFilter(e.target.value as ZoneFilter)}
                className="rounded-lg border border-border-muted bg-bg-secondary px-2.5 py-1.5 text-xs text-text-secondary focus:outline-none focus:border-accent-blue transition-colors"
                aria-label="구역 필터"
              >
                {ZONE_FILTER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}

            {/* 본문 너비 조절 슬라이더 */}
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-muted whitespace-nowrap">너비</span>
              <input
                type="range"
                min={CONTENT_WIDTH_MIN}
                max={CONTENT_WIDTH_MAX}
                step={10}
                value={contentWidthCh === 0 ? CONTENT_WIDTH_MAX : contentWidthCh}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setContentWidthCh(v >= CONTENT_WIDTH_MAX ? 0 : v);
                }}
                className="w-[80px] h-1 accent-accent-blue cursor-pointer"
                aria-label="본문 너비 조절"
              />
              <span className="text-[11px] text-text-muted tabular-nums w-[3.5ch] text-right">
                {contentWidthCh === 0 ? "∞" : contentWidthCh}
              </span>
            </div>
          </div>

          {/* Row 2: Search + Bulk expand/collapse */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1 min-w-[200px] max-w-[360px]">
              <input
                type="text"
                placeholder="조항 텍스트 검색..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-lg border border-border-muted bg-bg-secondary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue transition-colors"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary text-xs"
                  aria-label="검색 초기화"
                >
                  &#x2715;
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 ml-auto">
              {/* Section collapse/expand — only shown when zone grouping is active */}
              {hasZoneGrouping && activeSectionZoneTypes.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => collapseAllSections(activeSectionZoneTypes)}
                    className="rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary bg-bg-secondary hover:bg-bg-hover transition-colors"
                  >
                    섹션 전체 접기
                  </button>
                  <button
                    type="button"
                    onClick={() => expandAllSections(activeSectionZoneTypes)}
                    className="rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary bg-bg-secondary hover:bg-bg-hover transition-colors"
                  >
                    섹션 전체 펼치기
                  </button>
                </>
              )}
              {highRiskIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => expandHighRisk(highRiskIds)}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-accent-red bg-accent-red-dim hover:bg-accent-red/20 transition-colors"
                >
                  고위험만 펼치기
                </button>
              )}
              <button
                type="button"
                onClick={() => expandAll(allAnalyzedIds)}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary bg-bg-secondary hover:bg-bg-hover transition-colors"
              >
                전체 펼치기
              </button>
              <button
                type="button"
                onClick={() => collapseAll()}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary bg-bg-secondary hover:bg-bg-hover transition-colors"
              >
                전체 접기
              </button>
            </div>
          </div>
        </div>

        {/* ---- Scrollable clause list ---- */}
        <div ref={clauseScrollRef} className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-8 pb-8">
            {/* ---- Document view ---- */}
            {filteredClauses.length === 0 ? (
              <div className="rounded-lg bg-bg-card p-8 text-center text-sm text-text-muted">
                {clauseItems.length === 0
                  ? "아직 파싱된 조항이 없습니다."
                  : "필터 조건에 맞는 조항이 없습니다."}
              </div>
            ) : hasZoneGrouping ? (
              /* ---- Grouped by zone (when zones data is available) ---- */
              <div className="space-y-0">
                {orderedSections.map(({ zoneType, clauses: sectionClauses }, sectionIndex) => (
                  <ClauseSectionGroup
                    key={zoneType}
                    zoneType={zoneType}
                    clauseCount={sectionClauses.length}
                    clauses={sectionClauses.map((c) => ({
                      id: c.id,
                      riskLevel: c.riskLevel,
                      analysis: analysisMap.get(c.id),
                    }))}
                    isFirst={sectionIndex === 0}
                  >
                    {buildClauseTree(sectionClauses).map((node, index) => (
                      <ClauseTreeItem
                        key={node.clause.id}
                        node={node}
                        index={index}
                        analysisMap={analysisMap}
                        expandedClauseIds={expandedClauseIds}
                        toggleClause={toggleClause}
                        searchQuery={searchQuery}
                      />
                    ))}
                  </ClauseSectionGroup>
                ))}
              </div>
            ) : (
              /* ---- Flat list fallback (no zones data) ---- */
              <div className="space-y-3">
                {renderFlatClauses(filteredClauses)}
              </div>
            )}

            {/* Filtered count info */}
            {(riskFilter !== "ALL" || zoneFilter !== "ALL" || searchQuery.trim()) ? (
              <div className="mt-3 text-xs text-text-muted text-center">
                {filteredClauses.length} / {clauseItems.length}개 조항 표시
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
