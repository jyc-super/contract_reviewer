interface Zone {
  id: string;
  type: string;
  confidence: number;
  text: string;
}

export interface FilterZonesResult {
  analysisTargets: Zone[];
  uncertainZones: Zone[];
}

export function filterZones(zones: Zone[], threshold = 0.7): FilterZonesResult {
  const analysisTargets: Zone[] = [];
  const uncertainZones: Zone[] = [];

  for (const zone of zones) {
    if (zone.confidence >= threshold) {
      analysisTargets.push(zone);
    } else {
      uncertainZones.push(zone);
    }
  }

  return {
    analysisTargets,
    uncertainZones,
  };
}
