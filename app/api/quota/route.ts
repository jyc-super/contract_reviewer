import { NextResponse } from "next/server";
import { getRemaining, type ModelKey } from "../../../lib/quota-manager";

function formatResetAt(date: Date): string {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day} 17:00 KST`;
}

function fmt(entry: { used: number; limit: number }) {
  return {
    used: entry.used,
    remaining: Math.max(0, entry.limit - entry.used),
    limit: entry.limit,
  };
}

function sumGroup(
  state: Record<ModelKey, { used: number; limit: number }>,
  keys: ModelKey[]
) {
  let usedTotal = 0;
  let limitTotal = 0;
  const models: Record<string, ReturnType<typeof fmt>> = {};
  for (const k of keys) {
    const f = fmt(state[k]);
    usedTotal += f.used;
    limitTotal += f.limit;
    models[k] = f;
  }
  return {
    used: usedTotal,
    remaining: Math.max(0, limitTotal - usedTotal),
    limit: limitTotal,
    models,
  };
}

export async function GET() {
  const state = await getRemaining();

  const analysis = fmt(state.flash31Lite);
  const crossValidation = sumGroup(state, [
    "flash25",
    "flash25Lite",
    "flash3",
  ]);
  const preprocessing = sumGroup(state, ["gemma27b", "gemma12b", "gemma4b"]);
  const embedding = fmt(state.embedding);

  const estimatedAdditional = Math.floor(
    Math.min(
      (analysis.limit - analysis.used) / 80,
      (embedding.limit - embedding.used) / 40
    )
  );

  return NextResponse.json({
    resetAt: formatResetAt(state.flash31Lite.resetAt),
    resetAtIso: state.flash31Lite.resetAt.toISOString(),
    estimatedAdditionalContracts: Math.max(0, estimatedAdditional),

    analysis,
    crossValidation,
    preprocessing,
    embedding,

    flash31Lite: fmt(state.flash31Lite),
    flash25: fmt(state.flash25),
    flash25Lite: fmt(state.flash25Lite),
    flash3: fmt(state.flash3),
    gemma27b: fmt(state.gemma27b),
    gemma12b: fmt(state.gemma12b),
    gemma4b: fmt(state.gemma4b),
  });
}
