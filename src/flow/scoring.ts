/**
 * Flow scoring — POST-REVEAL training metrics for Flow Lab sessions.
 *
 * This module (together with TrainingEngine) is the ONLY layer allowed to
 * touch ScenarioTruth. The execution engine never sees it; the journal stores
 * it internally and exposes it solely through the reveal gate.
 *
 * Design goal: keep RAW metrics and one simple, explainable formula set so a
 * richer scoring model can replace it later without re-deriving the data.
 *
 *   Pattern recognition : CORRECT / INCORRECT / NO PREDICTION
 *   Trade direction     : CORRECT / INCORRECT / NO TRADE
 *   Trading result      : PROFIT / LOSS / FLAT
 *   Plus net P&L, W/L, R multiple (when a stop was configured), entry timing
 *   vs the pattern window, MFE capture %, MAE, confidence and
 *   confidence-vs-result.
 */

import type { ContractSpec } from "../market/types";
import type { DOMSnapshot } from "./dom";
import type { FlowBias, FlowDecision, FlowPrediction, FlowRisk } from "./execution";
import type { FlowTradeRecord } from "./journal";
import type { OrderFlowSnapshot } from "./orderFlow";
import type { FlowScenarioId, PatternDirection, ScenarioTruth } from "./scenarios";
import { scenarioName } from "./scenarios";

export type FlowPatternResult = "CORRECT" | "INCORRECT" | "NO PREDICTION";
export type FlowDirectionResult = "CORRECT" | "INCORRECT" | "NO TRADE";
export type FlowTradeResult = "PROFIT" | "LOSS" | "FLAT";
export type FlowEntryTiming = "EARLY" | "INSIDE" | "LATE" | "NONE";

/** Only the measurable fields the narrative needs — satisfied by snapshots. */
export type FlowNarrativeOrderFlow = Pick<
  OrderFlowSnapshot,
  "cumulativeDelta" | "delta" | "buyAggressionPct" | "sellAggressionPct"
>;
export type FlowNarrativeDom = Pick<
  DOMSnapshot,
  "replenishCount" | "pullBidCount" | "pullAskCount" | "sweepBuyCount" | "sweepSellCount"
>;

export interface FlowSessionResults {
  /* revealed truth */
  pattern: string;
  patternId: FlowScenarioId;
  direction: PatternDirection;
  /* trader inputs */
  bias: FlowBias;
  prediction: FlowPrediction;
  predictionName: string;
  confidence: number;
  /* scores */
  patternResult: FlowPatternResult;
  directionResult: FlowDirectionResult;
  tradeResult: FlowTradeResult;
  confidenceVsResult: string;
  /* raw metrics */
  trades: number;
  wins: number;
  losses: number;
  grossPnL: number;
  costs: number;
  netPnL: number;
  bestTrade: number;
  worstTrade: number;
  mfe: number;
  mae: number;
  rMultiple: number | null;
  entryTiming: FlowEntryTiming;
  mfeCapturePct: number | null;
  /** "WHAT THE FLOW WAS TELLING YOU" — post-reveal prose only. */
  narrative: string[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function predictionName(p: FlowPrediction): string {
  return p === "unknown" ? "Unknown" : scenarioName(p);
}

/** Build the post-reveal "WHAT THE FLOW WAS TELLING YOU" explanation. */
export function buildFlowNarrative(
  truth: ScenarioTruth,
  orderFlow: FlowNarrativeOrderFlow,
  dom: FlowNarrativeDom,
): string[] {
  const lines: string[] = [];
  const cvd = orderFlow.cumulativeDelta;
  if (cvd > 0) {
    lines.push(`Cumulative delta climbed to +${cvd} — aggressive buyers stayed in control as the sequence developed.`);
  } else if (cvd < 0) {
    lines.push(`Cumulative delta fell to ${cvd} — aggressive sellers drove the tape while price reacted.`);
  } else {
    lines.push("Cumulative delta ended flat — two-sided aggression with no persistent edge.");
  }
  if (orderFlow.buyAggressionPct >= 60) {
    lines.push(`Buying aggression dominated (${orderFlow.buyAggressionPct.toFixed(0)}% of volume) — initiative buyers lifting offers.`);
  } else if (orderFlow.sellAggressionPct >= 60) {
    lines.push(`Aggressive selling increased (${orderFlow.sellAggressionPct.toFixed(0)}% of volume) — sellers hitting bids all the way down.`);
  } else {
    lines.push(
      `Aggression was two-sided (${orderFlow.buyAggressionPct.toFixed(0)}% buy / ${orderFlow.sellAggressionPct.toFixed(0)}% sell) — no persistent aggressor advantage.`,
    );
  }
  const pulls = dom.pullBidCount + dom.pullAskCount;
  if (dom.replenishCount > 0) {
    lines.push(
      `Liquidity replenished ${dom.replenishCount}× after ${pulls} pull${pulls === 1 ? "" : "s"} — passive orders kept refilling the book.`,
    );
  }
  const sweeps = dom.sweepBuyCount + dom.sweepSellCount;
  if (sweeps > 0) {
    lines.push(`${sweeps} book sweep${sweeps === 1 ? "" : "s"} (${dom.sweepSellCount} down / ${dom.sweepBuyCount} up) — stops taken through displayed size.`);
  }
  for (const c of truth.characteristics) lines.push(c);
  lines.push(`This is a ${scenarioName(truth.pattern).toLowerCase()}-style sequence.`);
  return lines;
}

export interface FlowScoreInput {
  truth: ScenarioTruth;
  records: readonly FlowTradeRecord[];
  decision: FlowDecision;
  risk: FlowRisk;
  contract: ContractSpec;
  orderFlow: FlowNarrativeOrderFlow;
  dom: FlowNarrativeDom;
}

/** Direction of the bulk of the traded quantity (last trade breaks ties). */
function majorityDirection(records: readonly FlowTradeRecord[]): "LONG" | "SHORT" {
  let long = 0;
  let short = 0;
  for (const r of records) {
    if (r.side === "LONG") long += r.quantity;
    else short += r.quantity;
  }
  if (long > short) return "LONG";
  if (short > long) return "SHORT";
  return records.length > 0 ? records[records.length - 1].side : "LONG";
}

export function scoreFlowSession(input: FlowScoreInput): FlowSessionResults {
  const { truth, records, decision, risk, contract, orderFlow, dom } = input;

  const trades = records.length;
  const wins = records.filter((r) => r.netPnL > 0).length;
  const losses = records.filter((r) => r.netPnL < 0).length;
  const netPnL = round2(records.reduce((s, r) => s + r.netPnL, 0));
  const grossPnL = round2(records.reduce((s, r) => s + r.grossPnL, 0));
  const costs = round2(records.reduce((s, r) => s + r.costs, 0));
  const bestTrade = trades > 0 ? Math.max(...records.map((r) => r.netPnL)) : 0;
  const worstTrade = trades > 0 ? Math.min(...records.map((r) => r.netPnL)) : 0;
  const mfe = trades > 0 ? Math.max(...records.map((r) => r.maxFavorableExcursion)) : 0;
  const mae = trades > 0 ? Math.max(...records.map((r) => r.maxAdverseExcursion)) : 0;

  /* ---- pattern recognition (trader's own prediction vs hidden answer) ---- */
  const patternResult: FlowPatternResult =
    decision.expected === "unknown"
      ? "NO PREDICTION"
      : decision.expected === truth.pattern
        ? "CORRECT"
        : "INCORRECT";

  /* ---- trade direction ---- */
  let directionResult: FlowDirectionResult;
  if (trades === 0) {
    directionResult = "NO TRADE";
  } else {
    const dir = decision.bias === "NEUTRAL" ? majorityDirection(records) : decision.bias;
    const expectedDir = truth.direction === "bullish" ? "LONG" : "SHORT";
    directionResult = dir === expectedDir ? "CORRECT" : "INCORRECT";
  }

  /* ---- trading result ---- */
  const tradeResult: FlowTradeResult = netPnL > 0 ? "PROFIT" : netPnL < 0 ? "LOSS" : "FLAT";

  /* ---- R multiple (only when a stop configured the risk per trade) ---- */
  let rMultiple: number | null = null;
  const stopTicks = risk.stopLossTicks;
  if (stopTicks !== null && stopTicks > 0) {
    const riskPerContract = stopTicks * contract.tickValue;
    const denominator = records.reduce((s, r) => s + riskPerContract * r.quantity, 0);
    if (denominator > 0) rMultiple = round2(netPnL / denominator);
  }

  /* ---- entry timing vs the hidden pattern window ---- */
  let entryTiming: FlowEntryTiming = "NONE";
  if (trades > 0) {
    const seq = records[0].entrySequence;
    entryTiming =
      seq < truth.startEvent ? "EARLY" : seq > truth.endEvent ? "LATE" : "INSIDE";
  }

  /* ---- MFE capture: how much of the favourable excursion became net P&L ---- */
  const capturable = records.filter((r) => r.maxFavorableExcursion > 0);
  let mfeCapturePct: number | null = null;
  if (capturable.length > 0) {
    const netOfCapturable = capturable.reduce((s, r) => s + r.netPnL, 0);
    const mfeOfCapturable = capturable.reduce((s, r) => s + r.maxFavorableExcursion, 0);
    mfeCapturePct = mfeOfCapturable > 0 ? round1((netOfCapturable / mfeOfCapturable) * 100) : null;
  }

  const confidence = decision.level;
  const confidenceVsResult = `${confidence}/5 confidence → ${patternResult}`;

  return {
    pattern: scenarioName(truth.pattern),
    patternId: truth.pattern,
    direction: truth.direction,
    bias: decision.bias,
    prediction: decision.expected,
    predictionName: predictionName(decision.expected),
    confidence,
    patternResult,
    directionResult,
    tradeResult,
    trades,
    wins,
    losses,
    grossPnL,
    costs,
    netPnL,
    bestTrade,
    worstTrade,
    mfe,
    mae,
    rMultiple,
    entryTiming,
    mfeCapturePct,
    confidenceVsResult,
    narrative: buildFlowNarrative(truth, orderFlow, dom),
  };
}
