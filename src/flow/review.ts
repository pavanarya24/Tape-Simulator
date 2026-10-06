/**
 * Phase 8D — session review.
 *
 * Post-reveal only. Turns the journal of completed trades plus the observable
 * evidence timeline into a review bundle that teaches PROCESS:
 *
 *   WHAT HAPPENED · WHEN IT HAPPENED · WHAT THE FLOW SHOWED
 *   WHAT I THOUGHT · WHAT I DID · WHAT THE RESULT WAS
 *
 * Every review object is derived from data the engine already revealed — the
 * journal's own trades and the observable evidence timeline. Nothing here can
 * see past the event clock, and nothing here re-derives market state.
 *
 * Jump targets resolve to an EVENT INDEX (sequence − 1): sequences are 1-based
 * and dense, so seeking to a jump uses the same deterministic rebuild the
 * timeline uses. Trade markers (entry/exit) are a review affordance only — the
 * replay policy in replay.ts keeps them off the chart while blind.
 */

import type { FlowTradeView } from "./journal";
import type { FlowTimelineEntry } from "./recognition";
import { predictionName } from "./scoring";

/** One objective observation from the tape, as it stood at the entry event. */
export interface FlowEntryEvidence {
  metric: string;
  label: string;
  interpretation: string;
}

export interface FlowTradeReview {
  tradeId: number;
  /** Event index at entry / exit — for deterministic seeking (sequence − 1). */
  entryIndex: number;
  exitIndex: number;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  entryTimestamp: number;
  exitTimestamp: number;
  durationMs: number;
  grossPnL: number;
  costs: number;
  netPnL: number;
  mfe: number;
  mae: number;
  exitReason: string;
  /* --- what I thought (decision captured when the position was opened) --- */
  bias: string;
  prediction: string;
  confidence: number;
  reason: string;
  /* --- what the flow showed at entry (observable only) --- */
  atEntry: FlowEntryEvidence[];
  /** WHAT THE RESULT WAS — short net line, e.g. "+$184.00 net". */
  outcome: string;
}

export type ReviewJumpKind = "START" | "ENTRY" | "EXIT" | "EVIDENCE";

export interface ReviewJump {
  kind: ReviewJumpKind;
  label: string;
  /** Event index to seek to (deterministic seek/rebuild). */
  index: number;
  sequence: number;
  /** Trade this jump belongs to, when it is an entry/exit jump. */
  tradeId: number | null;
}

export interface FlowReview {
  trades: FlowTradeReview[];
  /** Ordered navigation targets: start, then every entry/exit/evidence. */
  jumps: ReviewJump[];
  /** Observable evidence timeline covered so far. */
  evidence: FlowTimelineEntry[];
  /** High-impact observations only (spec §8D "major evidence"). */
  majorEvidence: FlowTimelineEntry[];
}

/**
 * Metrics surfaced first in the "AT ENTRY" block. These are the observable
 * measurements a tape reader actually uses — never a pattern call.
 */
export const REVIEW_ENTRY_METRICS: readonly string[] = [
  "sellAggression",
  "buyAggression",
  "priceResponse",
  "liquidityReplenishment",
  "cvd",
  "sweepEvents",
];

export const REVIEW_EVIDENCE_LIMIT = 6;

function money(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(Math.round(n * 100) / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Latest observation per metric at or before `index` (evidence is index-ordered). */
function evidenceAtEntry(
  entries: readonly FlowTimelineEntry[],
  index: number,
  limit: number,
): FlowEntryEvidence[] {
  const latest = new Map<string, FlowTimelineEntry>();
  for (const e of entries) {
    if (e.index > index) break;
    latest.set(e.metric, e);
  }
  const chosen: FlowTimelineEntry[] = [];
  for (const metric of REVIEW_ENTRY_METRICS) {
    const e = latest.get(metric);
    if (e && e.interpretation !== "NONE") chosen.push(e);
  }
  if (chosen.length === 0) {
    // Fall back to the most recent observations regardless of metric.
    const recent = entries.filter((e) => e.index <= index).slice(-limit);
    for (const e of recent) chosen.push(e);
  }
  return chosen.slice(0, limit).map((e) => ({
    metric: e.metric,
    label: e.label,
    interpretation: e.interpretation,
  }));
}

/**
 * Build the review bundle from the session's own trades and the observable
 * evidence timeline. Post-reveal only — callers must gate on `revealed`.
 */
export function buildFlowReview(
  trades: readonly FlowTradeView[],
  timeline: readonly FlowTimelineEntry[],
): FlowReview {
  const entries = [...timeline].sort((a, b) => a.index - b.index);
  const majorEvidence = entries.filter((e) => e.important);

  const reviews: FlowTradeReview[] = trades.map((t) => ({
    tradeId: t.tradeId,
    entryIndex: Math.max(1, t.entrySequence - 1),
    exitIndex: Math.max(1, t.exitSequence - 1),
    side: t.side,
    quantity: t.quantity,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    entryTimestamp: t.entryTimestamp,
    exitTimestamp: t.exitTimestamp,
    durationMs: t.durationMs,
    grossPnL: t.grossPnL,
    costs: t.costs,
    netPnL: t.netPnL,
    mfe: t.maxFavorableExcursion,
    mae: t.maxAdverseExcursion,
    exitReason: t.exitReason,
    bias: t.entryDecision.bias,
    prediction: predictionName(t.entryDecision.expected),
    confidence: t.entryDecision.level,
    reason: t.entryDecision.reason,
    atEntry: evidenceAtEntry(entries, Math.max(1, t.entrySequence - 1), REVIEW_EVIDENCE_LIMIT),
    outcome: `${money(t.netPnL)} net`,
  }));

  const jumps: ReviewJump[] = [
    { kind: "START", label: "Scenario start", index: 0, sequence: 0, tradeId: null },
  ];
  for (const t of trades) {
    jumps.push({
      kind: "ENTRY",
      label: `Entry ${t.tradeId} · ${t.side} ${t.quantity} @ ${t.entryPrice}`,
      index: Math.max(1, t.entrySequence - 1),
      sequence: t.entrySequence,
      tradeId: t.tradeId,
    });
    jumps.push({
      kind: "EXIT",
      label: `Exit ${t.tradeId} · ${t.exitReason}`,
      index: Math.max(1, t.exitSequence - 1),
      sequence: t.exitSequence,
      tradeId: t.tradeId,
    });
  }
  for (const e of majorEvidence) {
    jumps.push({
      kind: "EVIDENCE",
      label: `${e.label} ${e.interpretation}`,
      index: e.index,
      sequence: e.sequence,
      tradeId: null,
    });
  }
  jumps.sort((a, b) => a.index - b.index || (a.kind === "START" ? -1 : b.kind === "START" ? 1 : 0));

  return { trades: reviews, jumps, evidence: entries, majorEvidence };
}
