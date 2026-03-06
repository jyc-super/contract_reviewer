import { validateFile } from "./steps/validate-file";
import { parseWithDocling } from "../document-parser";
import { applyZoneRules } from "./steps/zone-rules";
import { filterZones } from "./steps/filter-zones";
import { splitClauses } from "./steps/split-clauses";
import { qualityCheck } from "./steps/quality-check";
import { detectLanguage } from "../utils/language";
import { contentHash } from "../cache";

export interface ZoneForDb {
  pageFrom: number;
  pageTo: number;
  zoneType: string;
  confidence: number;
  isAnalysisTarget: boolean;
  text: string;
}

export interface ClauseForDb {
  zoneIndex: number;
  text: string;
  isAutoSplit: boolean;
  needsReview: boolean;
  title?: string;
  number?: string;
  /** 조항 텍스트 기준 해시 (중복/추적용) */
  contentHash?: string;
}

export interface ProcessContractResult {
  contractId?: string;
  pages: number;
  analysisTargetCount: number;
  uncertainZoneCount: number;
  clauseCount: number;
  needsReview: boolean;
  /** 감지된 언어(ISO 639-3). franc 연동 */
  sourceLanguages?: string[];
  zones: ZoneForDb[];
  clauses: ClauseForDb[];
}

export async function processContract(file: File) {
  const validation = await validateFile(file);
  if (!validation.isValid) {
    throw new Error(validation.reason ?? "지원되지 않는 파일이거나 제한을 초과했습니다.");
  }

  // Docling 기반 파싱 (현재는 스텁 구현)
  const parsed = await parseWithDocling(file);

  const fullText = parsed.pages.map((p) => p.text).join("\n\n");
  const zoning = await applyZoneRules(fullText);
  const filtered = filterZones(
    zoning.zones.map((z) => ({
      id: z.id,
      type: z.type,
      confidence: z.confidence,
      text: z.text,
    }))
  );

  const clausesPerZone: Awaited<ReturnType<typeof splitClauses>>[] = [];
  for (const zone of filtered.analysisTargets) {
    clausesPerZone.push(await splitClauses(zone.text));
  }
  const allClauses = clausesPerZone.flat();
  const qc = await qualityCheck(allClauses);

  const zones: ZoneForDb[] = [
    ...filtered.analysisTargets.map((z) => ({
      pageFrom: 1,
      pageTo: 1,
      zoneType: z.type,
      confidence: z.confidence,
      isAnalysisTarget: true,
      text: z.text,
    })),
    ...filtered.uncertainZones.map((z) => ({
      pageFrom: 1,
      pageTo: 1,
      zoneType: z.type,
      confidence: z.confidence,
      isAnalysisTarget: false,
      text: z.text,
    })),
  ];

  const clauses: ClauseForDb[] = [];
  clausesPerZone.forEach((zoneClauses, zoneIndex) => {
    zoneClauses.forEach((c) => {
      clauses.push({
        zoneIndex,
        text: c.text,
        isAutoSplit: c.flags?.includes("auto_split") ?? false,
        needsReview: c.flags?.includes("needs_review") ?? false,
        title: c.text.split(/\n/)[0]?.trim().slice(0, 200),
        contentHash: contentHash(c.text),
      });
    });
  });

  const sourceLanguages: string[] = [];
  try {
    const lang = await detectLanguage(fullText);
    if (lang && lang !== "unknown") sourceLanguages.push(lang);
  } catch {
    // 무시
  }

  const result: ProcessContractResult = {
    pages: parsed.pages.length,
    analysisTargetCount: filtered.analysisTargets.length,
    uncertainZoneCount: filtered.uncertainZones.length,
    clauseCount: qc.clauses.length,
    needsReview: qc.needsReview,
    sourceLanguages: sourceLanguages.length > 0 ? sourceLanguages : undefined,
    zones,
    clauses,
  };

  return result;
}
