"use client";

export interface ZoneItem {
  id: string;
  type: string;
  confidence: number;
  textPreview: string;
}

interface ZoneReviewListProps {
  zones: ZoneItem[];
  /** 선택: zone id → "include" | "exclude" */
  decisions?: Record<string, "include" | "exclude">;
  onInclude?: (zoneId: string) => void;
  onExclude?: (zoneId: string) => void;
  disabled?: boolean;
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

  return (
    <div>
      {zones.map((zone) => {
        const decision = decisions[zone.id];
        return (
          <div key={zone.id} className="zone-item">
            <span className="zone-check">□</span>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span className="font-medium text-text-primary">{zone.type}</span>
                <span className="zone-confidence">
                  conf: {zone.confidence.toFixed(2)}
                </span>
              </div>
              <p className="text-xs text-text-soft line-clamp-2">{zone.textPreview}</p>
            </div>
            {onInclude && onExclude && (
              <div className="zone-actions">
                <button
                  type="button"
                  onClick={() => onInclude(zone.id)}
                  disabled={disabled}
                  className={`zone-btn zone-btn-include${decision === "include" ? "" : ""}`}
                >
                  분석 포함
                </button>
                <button
                  type="button"
                  onClick={() => onExclude(zone.id)}
                  disabled={disabled}
                  className={`zone-btn zone-btn-exclude${decision === "exclude" ? "" : ""}`}
                >
                  분석 제외
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

