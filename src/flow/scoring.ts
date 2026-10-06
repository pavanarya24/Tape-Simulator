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
import type { FlowRecognition } from "./recognition";
import type { FlowDifficulty, FlowScenarioId, PatternDirection, ScenarioTruth } from "./scenarios";
import { scenarioName } from "./scenarios";

export type FlowPatternResult = "CORRECT" | "INCORRECT" | "NO PREDICTION";
/** Engine recognition: NO SIGNAL when it returned unknown — never a
 *  correctness claim without a call (spec §7). */
export type FlowRecognitionResult = "CORRECT" | "INCORRECT" | "NO SIGNAL";
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
  /** Scenario difficulty the session was generated at (Phase 8C breakdown). */
  difficulty: FlowDifficulty;
  /** Mean hold time across this session's trades (ms) — null with no trades. */
  avgHoldMs: number | null;
  /* --- Phase 7B: engine recognition vs truth vs trader (spec §12) --- */
  recognitionPattern: FlowScenarioId | "unknown";
  recognitionConfidence: number | null;
  recognitionResult: FlowRecognitionResult;
  recognitionWindow: { startSequence: number; endSequence: number } | null;
  recognitionSignals: string[];
  /** TRUE when trader prediction and engine recognition matched (both known). */
  traderEngineAgreement: boolean | null;
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
  /** Engine's observable-only recognition — never derived from truth. */
  recognition?: FlowRecognition | null;
  /** Difficulty the scenario was generated at (defaults to INTERMEDIATE). */
  difficulty?: FlowDifficulty;
}

/**
 * Raw cross-scenario training metrics (spec §13). Aggregated over every
 * revealed scenario in the training run — kept as individual metrics so a
 * future scoring model can consume them without re-deriving anything.
 */
export interface FlowTrainingStats {
  /** Scenarios revealed and recorded. */
  scenarios: number;
  /* pattern recognition accuracy */
  traderPredictions: number;
  traderCorrect: number;
  /* engine recognition accuracy */
  engineCalls: number;
  engineCorrect: number;
  /* trader vs engine agreement (both made a call) */
  agreements: number;
  agreeCount: number;
  /* direction accuracy (trades with a direction call) */
  directionCalls: number;
  directionCorrect: number;
  /* trading */
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnL: number;
  /* confidence vs result (raw) */
  avgConfidence: number | null;
  avgConfidenceCorrect: number | null;
  avgConfidenceIncorrect: number | null;
  /* excursions */
  avgMfeCapturePct: number | null;
  avgMae: number;
  bestTrade: number;
  worstTrade: number;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}

/** Aggregate revealed scenario results into raw training statistics. */
export function computeFlowTrainingStats(results: readonly FlowSessionResults[]): FlowTrainingStats {
  const traderCalls = results.filter((r) => r.patternResult !== "NO PREDICTION");
  const engineCalls = results.filter((r) => r.recognitionResult !== "NO SIGNAL");
  const agreements = results.filter((r) => r.traderEngineAgreement !== null);
  const directionCalls = results.filter((r) => r.directionResult !== "NO TRADE");
  const withTrades = results.filter((r) => r.trades > 0);
  const mfeCaptures = results.map((r) => r.mfeCapturePct).filter((v): v is number => v !== null);
  const confidences = results.map((r) => r.confidence);
  const confCorrect = results
    .filter((r) => r.patternResult === "CORRECT")
    .map((r) => r.confidence);
  const confIncorrect = results
    .filter((r) => r.patternResult === "INCORRECT")
    .map((r) => r.confidence);
  return {
    scenarios: results.length,
    traderPredictions: traderCalls.length,
    traderCorrect: traderCalls.filter((r) => r.patternResult === "CORRECT").length,
    engineCalls: engineCalls.length,
    engineCorrect: engineCalls.filter((r) => r.recognitionResult === "CORRECT").length,
    agreements: agreements.length,
    agreeCount: agreements.filter((r) => r.traderEngineAgreement).length,
    directionCalls: directionCalls.length,
    directionCorrect: directionCalls.filter((r) => r.directionResult === "CORRECT").length,
    trades: results.reduce((s, r) => s + r.trades, 0),
    wins: results.reduce((s, r) => s + r.wins, 0),
    losses: results.reduce((s, r) => s + r.losses, 0),
    winRatePct:
      results.reduce((s, r) => s + r.trades, 0) > 0
        ? round1(
            (results.reduce((s, r) => s + r.wins, 0) /
              results.reduce((s, r) => s + r.trades, 0)) *
              100,
          )
        : 0,
    netPnL: round2(results.reduce((s, r) => s + r.netPnL, 0)),
    avgConfidence: mean(confidences),
    avgConfidenceCorrect: mean(confCorrect),
    avgConfidenceIncorrect: mean(confIncorrect),
    avgMfeCapturePct: mean(mfeCaptures),
    avgMae: mean(results.map((r) => r.mae)) ?? 0,
    bestTrade: withTrades.length > 0 ? Math.max(...withTrades.map((r) => r.bestTrade)) : 0,
    worstTrade: withTrades.length > 0 ? Math.min(...withTrades.map((r) => r.worstTrade)) : 0,
  };
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
  const { truth, records, decision, risk, contract, orderFlow, dom, recognition } = input;
  const difficulty: FlowDifficulty = input.difficulty ?? "INTERMEDIATE";

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

  /* ---- average hold time across the session's completed trades ---- */
  const avgHoldMs =
    trades > 0 ? Math.round(records.reduce((s, r) => s + r.durationMs, 0) / trades) : null;

  const confidence = decision.level;
  const confidenceVsResult = `${confidence}/5 confidence → ${patternResult}`;

  /* ---- engine recognition vs hidden truth (spec §12) ---- */
  const recognitionPattern = recognition ? recognition.pattern : "unknown";
  const recognitionConfidence = recognition ? recognition.confidence : null;
  const recognitionResult: FlowRecognitionResult =
    !recognition || recognition.pattern === "unknown"
      ? "NO SIGNAL"
      : recognition.pattern === truth.pattern
        ? "CORRECT"
        : "INCORRECT";
  const recognitionWindow = recognition ? recognition.window : null;
  const recognitionSignals = recognition ? recognition.signals : [];
  const traderEngineAgreement =
    decision.expected === "unknown" || recognitionPattern === "unknown"
      ? null
      : decision.expected === recognitionPattern;

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
    difficulty,
    avgHoldMs,
    confidenceVsResult,
    recognitionPattern,
    recognitionConfidence,
    recognitionResult,
    recognitionWindow,
    recognitionSignals,
    traderEngineAgreement,
    narrative: buildFlowNarrative(truth, orderFlow, dom),
  };
}
