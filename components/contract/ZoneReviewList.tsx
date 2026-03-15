"use client";

import { renderBoldMarkdown } from "./render-bold-markdown";

export interface ZoneItem {
  id: string;
  type: string;
  confidence: number;
  textPreview: string;
  /** Page where this zone starts (optional, from document_zones.page_from). */
  pageFrom?: number;
  /** Page where this zone ends (optional, from document_zones.page_to). */
  pageTo?: number;
  /**
   * Title of the parent document_part this zone belongs to.
   * When present, zones sharing the same title are grouped under a section
   * header in the list. Zones without this field fall into an ungrouped
   * section at the top.
   */
  documentPartTitle?: string;
  /**
   * Title of the parent sub_document this zone belongs to.
   * When present alongside documentPartTitle, enables 2-depth grouping:
   * sub_document → document_part → zone cards.
   */
  subDocumentTitle?: string;
}

interface ZoneReviewListProps {
  zones: ZoneItem[];
  /** 선택: zone id → "include" | "exclude" */
  decisions?: Record<string, "include" | "exclude">;
  onInclude?: (zoneId: string) => void;
  onExclude?: (zoneId: string) => void;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ZoneGroup {
  /** undefined = ungrouped (no documentPartTitle) */
  partTitle: string | undefined;
  /** Formatted page range string, e.g. "pp.16–180", or undefined if no page data */
  pageRange: string | undefined;
  zones: ZoneItem[];
}

/** Build an ordered list of groups preserving original zone order. */
function groupZones(zones: ZoneItem[]): ZoneGroup[] {
  const groups: ZoneGroup[] = [];
  const groupIndex = new Map<string | undefined, number>();

  for (const zone of zones) {
    const key = zone.documentPartTitle;
    const existing = groupIndex.get(key);
    if (existing !== undefined) {
      groups[existing].zones.push(zone);
    } else {
      // Derive page range from the first zone in the group that has page data
      const pageRange =
        zone.pageFrom !== undefined && zone.pageTo !== undefined
          ? `pp.${zone.pageFrom}–${zone.pageTo}`
          : undefined;
      groupIndex.set(key, groups.length);
      groups.push({ partTitle: key, pageRange, zones: [zone] });
    }
  }

  return groups;
}

// ---------------------------------------------------------------------------
// 2-depth grouping: sub_document → document_part → zones
// ---------------------------------------------------------------------------

interface SubDocGroup {
  subDocTitle: string | undefined;
  partGroups: ZoneGroup[];
}

/**
 * Build a 2-depth hierarchy when at least one zone has subDocumentTitle.
 * Sub-documents without a title are bucketed under undefined (rendered without
 * the outer header). Within each sub-document, zones are grouped by
 * documentPartTitle using the same logic as groupZones().
 */
function groupZonesTwoDepth(zones: ZoneItem[]): SubDocGroup[] {
  const result: SubDocGroup[] = [];
  const subDocIndex = new Map<string | undefined, number>();

  for (const zone of zones) {
    const subKey = zone.subDocumentTitle;
    let sdIdx = subDocIndex.get(subKey);
    if (sdIdx === undefined) {
      sdIdx = result.length;
      subDocIndex.set(subKey, sdIdx);
      result.push({ subDocTitle: subKey, partGroups: [] });
    }
    const subDocGroup = result[sdIdx];

    // Find or create the inner part group
    const partKey = zone.documentPartTitle;
    let partGroup = subDocGroup.partGroups.find((g) => g.partTitle === partKey);
    if (!partGroup) {
      const pageRange =
        zone.pageFrom !== undefined && zone.pageTo !== undefined
          ? `pp.${zone.pageFrom}–${zone.pageTo}`
          : undefined;
      partGroup = { partTitle: partKey, pageRange, zones: [] };
      subDocGroup.partGroups.push(partGroup);
    }
    partGroup.zones.push(zone);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Zone card — shared between flat and grouped rendering
// ---------------------------------------------------------------------------

interface ZoneCardProps {
  zone: ZoneItem;
  decision: "include" | "exclude" | undefined;
  onInclude?: (id: string) => void;
  onExclude?: (id: string) => void;
  disabled?: boolean;
}

function getConfidenceInfo(confidence: number): { label: string; color: string } {
  if (confidence >= 0.90) return { label: "고신뢰", color: "var(--accent-green)" };
  if (confidence >= 0.82) return { label: "보통", color: "var(--accent-yellow)" };
  return { label: "저신뢰", color: "var(--accent-red)" };
}

function ZoneCard({ zone, decision, onInclude, onExclude, disabled }: ZoneCardProps) {
  const checkIcon =
    decision === "include" ? "\u2611" : decision === "exclude" ? "\u2612" : "\u25A1";
  const checkColor =
    decision === "include"
      ? "var(--accent-green)"
      : decision === "exclude"
        ? "var(--accent-red)"
        : undefined;
  const confidenceInfo = getConfidenceInfo(zone.confidence);

  return (
    <div className="zone-item">
      <span className="zone-check" style={checkColor ? { color: checkColor } : undefined}>
        {checkIcon}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span className="font-medium text-text-primary">{zone.type}</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {zone.pageFrom !== undefined && zone.pageTo !== undefined && (
              <span
                className="text-xs"
                style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}
              >
                p.{zone.pageFrom}–{zone.pageTo}
              </span>
            )}
            <span
              className="zone-confidence text-xs"
              style={{ color: confidenceInfo.color }}
              title="AI 분류 신뢰도"
            >
              {confidenceInfo.label} {Math.round(zone.confidence * 100)}%
            </span>
          </div>
        </div>
        <p className="text-xs text-text-soft line-clamp-2 text-justify">{renderBoldMarkdown(zone.textPreview, `zp-${zone.id}`)}</p>
      </div>
      {onInclude && onExclude && (
        <div className="zone-actions">
          <button
            type="button"
            onClick={() => onInclude(zone.id)}
            disabled={disabled}
            className={`zone-btn zone-btn-include${decision === "include" ? " zone-btn-include-active" : ""}`}
          >
            분석 포함
          </button>
          <button
            type="button"
            onClick={() => onExclude(zone.id)}
            disabled={disabled}
            className={`zone-btn zone-btn-exclude${decision === "exclude" ? " zone-btn-exclude-active" : ""}`}
          >
            분석 제외
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared inner renderer: a flat list of part-groups with their zone cards
// ---------------------------------------------------------------------------

interface PartGroupsProps {
  groups: ZoneGroup[];
  decisions: Record<string, "include" | "exclude">;
  onInclude?: (id: string) => void;
  onExclude?: (id: string) => void;
  disabled?: boolean;
  /** When true, add left-padding to indent part headers under a sub-doc header. */
  indented?: boolean;
}

function PartGroupList({ groups, decisions, onInclude, onExclude, disabled, indented }: PartGroupsProps) {
  return (
    <>
      {groups.map((group, groupIdx) => (
        <div key={group.partTitle ?? `__ungrouped_${groupIdx}`}>
          {group.partTitle !== undefined && (
            <div
              className={`${groupIdx > 0 ? "mt-2.5" : ""} mb-1 flex items-baseline gap-2 border-b border-border-muted pb-1 pt-1.5 ${indented ? "pl-3" : "pl-0"}`}
            >
              <span className="text-xs font-semibold uppercase tracking-[0.04em] text-text-secondary">
                {group.partTitle}
              </span>
              {group.pageRange && (
                <span className="tabular-nums text-xs text-text-muted">
                  {group.pageRange}
                </span>
              )}
            </div>
          )}
          <div className={indented ? "pl-2" : ""}>
            {group.zones.map((zone) => (
              <ZoneCard
                key={zone.id}
                zone={zone}
                decision={decisions[zone.id]}
                onInclude={onInclude}
                onExclude={onExclude}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

export function ZoneReviewList({
  zones,
  decisions = {},
  onInclude,
  onExclude,
  disabled,
}: ZoneReviewListProps) {
  if (!zones.length) {
    return (
      <p className="text-sm text-text-soft">
        검토할 uncertain zone이 없습니다.
      </p>
    );
  }

  const hasAnySubDocTitle = zones.some((z) => z.subDocumentTitle !== undefined);
  const hasAnyPartTitle = zones.some((z) => z.documentPartTitle !== undefined);

  // 2-depth rendering: sub_document → document_part → zones
  if (hasAnySubDocTitle) {
    const subDocGroups = groupZonesTwoDepth(zones);
    return (
      <div>
        {subDocGroups.map((sdGroup, sdIdx) => (
          <div key={sdGroup.subDocTitle ?? `__subdoc_${sdIdx}`}>
            {sdGroup.subDocTitle !== undefined && (
              <div
                className={`${sdIdx > 0 ? "mt-4" : ""} mb-1.5 flex items-center gap-2 rounded-md border-l-[3px] border-accent-blue bg-bg-tertiary px-3 py-2`}
              >
                <span className="text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  문서
                </span>
                <span className="text-xs font-bold tracking-[0.02em] text-text-primary">
                  {sdGroup.subDocTitle}
                </span>
              </div>
            )}
            <PartGroupList
              groups={sdGroup.partGroups}
              decisions={decisions}
              onInclude={onInclude}
              onExclude={onExclude}
              disabled={disabled}
              indented={sdGroup.subDocTitle !== undefined}
            />
          </div>
        ))}
      </div>
    );
  }

  // Flat rendering when no document_part data is available (backward compatible)
  if (!hasAnyPartTitle) {
    return (
      <div>
        {zones.map((zone) => (
          <ZoneCard
            key={zone.id}
            zone={zone}
            decision={decisions[zone.id]}
            onInclude={onInclude}
            onExclude={onExclude}
            disabled={disabled}
          />
        ))}
      </div>
    );
  }

  // 1-depth grouped rendering when document_part titles are available
  const groups = groupZones(zones);

  return (
    <div>
      <PartGroupList
        groups={groups}
        decisions={decisions}
        onInclude={onInclude}
        onExclude={onExclude}
        disabled={disabled}
      />
    </div>
  );
}

