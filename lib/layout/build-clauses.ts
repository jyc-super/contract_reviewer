/**
 * Simplified port of lpr/legal/structure.py:build_rule_tree() —
 * converts LayoutBlocks into flat ParsedClause[] for DB storage.
 * Zero API calls.
 */

import type { LayoutBlock } from "./types";
import type { DocumentZoneInfo } from "./zone-classifier";

export interface ParsedClause {
  clauseNumber: string;
  title?: string;
  content: string;
  orderIndex: number;
  isAutoSplit: boolean;
  zoneKey: string;
}

function isScheduleKind(block: LayoutBlock): boolean {
  return block.numberingHint?.kind === "schedule";
}

/**
 * Build clauses from LayoutBlocks within a single zone.
 * Headings act as clause boundaries. Paragraphs are merged under their heading.
 */
export function buildClausesFromZone(
  zone: DocumentZoneInfo,
  startOrderIndex = 0
): ParsedClause[] {
  const clauses: ParsedClause[] = [];
  let orderIndex = startOrderIndex;

  let currentHeading: LayoutBlock | null = null;
  let currentBodyParts: string[] = [];

  const flushClause = () => {
    if (!currentBodyParts.length && !currentHeading) return;

    const body = currentBodyParts.join("\n").trim();
    const heading = currentHeading;

    if (!body && !heading) return;

    if (heading && !body) {
      // Heading with no body — keep it as a short clause
      clauses.push({
        clauseNumber: heading.numberingHint?.normalized ?? `${zone.key}-${orderIndex + 1}`,
        title: heading.text.trim(),
        content: heading.text.trim(),
        orderIndex: orderIndex++,
        isAutoSplit: false,
        zoneKey: zone.key,
      });
    } else if (heading) {
      clauses.push({
        clauseNumber: heading.numberingHint?.normalized ?? `${zone.key}-${orderIndex + 1}`,
        title: heading.text.trim(),
        content: (heading.text.trim() + "\n" + body).trim(),
        orderIndex: orderIndex++,
        isAutoSplit: false,
        zoneKey: zone.key,
      });
    } else {
      // Body only (no heading) — auto split
      clauses.push({
        clauseNumber: `${zone.key}-auto-${orderIndex + 1}`,
        title: undefined,
        content: body,
        orderIndex: orderIndex++,
        isAutoSplit: true,
        zoneKey: zone.key,
      });
    }

    currentHeading = null;
    currentBodyParts = [];
  };

  for (const block of zone.blocks) {
    if (!block.text.trim()) continue;

    if (block.blockType === "heading" || isScheduleKind(block)) {
      // Each heading starts a new clause
      flushClause();
      currentHeading = block;
    } else {
      currentBodyParts.push(block.text.trim());
    }
  }

  flushClause();

  // If still nothing, treat whole zone as one auto-split clause
  if (!clauses.length) {
    const allText = zone.blocks.map((b) => b.text.trim()).filter(Boolean).join("\n");
    if (allText) {
      clauses.push({
        clauseNumber: `${zone.key}-auto-1`,
        title: zone.title,
        content: allText,
        orderIndex: orderIndex,
        isAutoSplit: true,
        zoneKey: zone.key,
      });
    }
  }

  return clauses;
}

/**
 * Build clauses from all zones.
 */
export function buildClauses(
  zones: DocumentZoneInfo[]
): ParsedClause[] {
  const result: ParsedClause[] = [];
  let orderIndex = 0;

  for (const zone of zones) {
    if (!zone.isAnalysisTarget) continue;
    const zoneClauses = buildClausesFromZone(zone, orderIndex);
    result.push(...zoneClauses);
    orderIndex += zoneClauses.length;
  }

  return result;
}
