"use client";

interface QuotaRow {
  used: number;
  remaining: number;
  limit: number;
}

interface GroupQuota extends QuotaRow {
  models?: Record<string, QuotaRow>;
}

interface QuotaDisplayProps {
  analysis: QuotaRow;
  crossValidation: GroupQuota;
  preprocessing: GroupQuota;
  embedding: QuotaRow;
  resetAt?: string;
  estimatedAdditionalContracts?: number;
}

function Bar({
  used,
  limit,
  color = "var(--accent-blue)",
}: {
  used: number;
  limit: number;
  color?: string;
}) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  if (limit === 0) return <div className="quota-bar-track" />;
  return (
    <div className="quota-bar-track">
      <div
        className="quota-bar-fill"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

function GroupHeader({ label }: { label: string }) {
  return <div className="quota-group-label">{label}</div>;
}

function Row({
  label,
  row,
  color,
}: {
  label: string;
  row: QuotaRow;
  color: string;
}) {
  return (
    <div className="quota-row">
      <div className="quota-row-header">
        <span className="quota-row-label">{label}</span>
        <span className="quota-row-value">
          {row.used.toLocaleString()} / {row.limit.toLocaleString()}
        </span>
      </div>
      <Bar used={row.used} limit={row.limit} color={color} />
    </div>
  );
}

export function QuotaDisplay({
  analysis,
  crossValidation,
  preprocessing,
  embedding,
  resetAt,
  estimatedAdditionalContracts,
}: QuotaDisplayProps) {
  const analysisHigh =
    analysis.limit > 0 && (analysis.used / analysis.limit) * 100 >= 50;

  return (
    <section className="quota-display">
      <div className="quota-header">
        <span className="quota-title-text">오늘의 API 사용량</span>
        {resetAt && <span className="quota-reset">리셋: {resetAt}</span>}
      </div>

      <GroupHeader label="핵심 분석" />
      <Row label="3.1 Flash Lite" row={analysis} color="var(--accent-blue)" />

      <GroupHeader label="교차 검증 (Flash 계열)" />
      {crossValidation.models?.flash25 && (
        <Row
          label="2.5 Flash"
          row={crossValidation.models.flash25}
          color="var(--accent-purple)"
        />
      )}
      {crossValidation.models?.flash25Lite && (
        <Row
          label="2.5 Flash Lite"
          row={crossValidation.models.flash25Lite}
          color="var(--accent-purple)"
        />
      )}
      {crossValidation.models?.flash3 && (
        <Row
          label="3 Flash"
          row={crossValidation.models.flash3}
          color="var(--accent-purple)"
        />
      )}
      <div className="quota-row-header" style={{ fontSize: "10px", opacity: 0.7 }}>
        <span>소계</span>
        <span>
          {crossValidation.used} / {crossValidation.limit}
        </span>
      </div>

      <GroupHeader label="전처리 (Gemma)" />
      {preprocessing.models?.gemma27b && (
        <Row
          label="Gemma 27B"
          row={preprocessing.models.gemma27b}
          color="var(--accent-green)"
        />
      )}
      {preprocessing.models?.gemma12b && (
        <Row
          label="Gemma 12B"
          row={preprocessing.models.gemma12b}
          color="var(--accent-green)"
        />
      )}

      <GroupHeader label="임베딩" />
      <Row label="Embedding" row={embedding} color="var(--accent-yellow)" />

      {estimatedAdditionalContracts !== undefined && (
        <div className="quota-estimate">
          오늘 분석 가능: ~{estimatedAdditionalContracts}건 추가
        </div>
      )}

      {analysisHigh && (
        <p className="quota-warning">
          Flash Lite 50% 이상 사용됨 — 대량 분석은 내일로 미루는 것을 권장합니다.
        </p>
      )}
    </section>
  );
}
