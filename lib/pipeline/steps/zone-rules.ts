export interface ZoneDetectionResult {
  zones: Array<{
    id: string;
    type: string;
    confidence: number;
    text: string;
  }>;
}

const VALID_ZONE_TYPES = [
  "contract_body",
  "general_conditions",
  "particular_conditions",
  "technical_specification",
  "drawing_list",
  "schedule",
  "cover_page",
  "other",
] as const;

type ZoneType = (typeof VALID_ZONE_TYPES)[number];

function isValidZoneType(v: unknown): v is ZoneType {
  return typeof v === "string" && VALID_ZONE_TYPES.includes(v as ZoneType);
}

function ruleBasedZoning(text: string): ZoneDetectionResult {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const zones = paragraphs.map((p, index) => {
    const clauseLikeMatches =
      p.match(
        /(^|\n)\s*(Article\s+\d+|Section\s+\d+|Clause\s+\d+|\d+\.\d+[\.\d]*|제\s*\d+\s*조)/gim
      ) ?? [];

    const baseConfidence =
      0.6 + Math.min(clauseLikeMatches.length * 0.05, 0.3);

    return {
      id: `zone-${index + 1}`,
      type: "contract_body" as string,
      confidence: Math.min(1, baseConfidence),
      text: p,
    };
  });

  return { zones };
}

async function gemmaClassifyZone(
  textSample: string
): Promise<{ zone_type: string; confidence: number } | null> {
  try {
    const { callGemmaJson } = await import("../../gemini");
    const { canCall } = await import("../../quota-manager");

    if (!(await canCall("gemma27b"))) return null;

    const result = await callGemmaJson<{
      zone_type?: string;
      confidence?: number;
    }>({
      modelKey: "gemma27b",
      prompt: `Classify this text sample. Reply JSON only.
Types: contract_body, general_conditions, particular_conditions, technical_specification, drawing_list, schedule, cover_page, other

{"zone_type":"..","confidence":0.0}`,
      inputText: textSample,
    });

    if (isValidZoneType(result.zone_type) && typeof result.confidence === "number") {
      return { zone_type: result.zone_type, confidence: result.confidence };
    }
    return null;
  } catch {
    return null;
  }
}

export async function applyZoneRules(
  text: string
): Promise<ZoneDetectionResult> {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const zones: ZoneDetectionResult["zones"] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const sample = p.slice(0, 300);

    const gemmaResult = await gemmaClassifyZone(sample);

    if (gemmaResult && gemmaResult.confidence >= 0.5) {
      zones.push({
        id: `zone-${i + 1}`,
        type: gemmaResult.zone_type,
        confidence: gemmaResult.confidence,
        text: p,
      });
    } else {
      const clauseLikeMatches =
        p.match(
          /(^|\n)\s*(Article\s+\d+|Section\s+\d+|Clause\s+\d+|\d+\.\d+[\.\d]*|제\s*\d+\s*조)/gim
        ) ?? [];
      const baseConfidence =
        0.6 + Math.min(clauseLikeMatches.length * 0.05, 0.3);

      zones.push({
        id: `zone-${i + 1}`,
        type: "contract_body",
        confidence: Math.min(1, baseConfidence),
        text: p,
      });
    }
  }

  return { zones };
}

export { ruleBasedZoning };
