/**
 * FlowRecognition — observable-only pattern recognition for Flow Lab.
 *
 * Architecture (Phase 7B):
 *
 *   TrainingSnapshot  ──►  recognizeFlow()  ──►  FlowRecognition
 *   (revealed data only)    (pure function)       (pattern + confidence +
 *                                                  objective evidence)
 *
 * HARD RULES:
 *  - This module consumes ONLY TrainingSnapshot projections: price series,
 *    trades, delta, CVD, volume at price, aggression, spread, imbalance,
 *    bid/ask liquidity, stacking, pulling, replenishment, sweeps, velocity
 *    and DOM state.
 *  - It NEVER receives ScenarioTruth, scenario ids, generator phases, hidden
 *    direction/confidence, seeds or generator internals. The same snapshot
 *    with or without truth attached produces byte-identical recognition.
 *  - Before Reveal the UI shows only `evidence` (objective observations).
 *    The `pattern` / `confidence` / `window` fields are gated behind the
 *    reveal layer in FlowTrainingSession / the controller.
 *  - Pure + deterministic: identical snapshot ⇒ identical recognition, so
 *    seek/replay/restart reproduce it exactly.
 *  - Thresholds are exported constants so they can later be calibrated
 *    against real market data without touching the heuristics.
 */

import type { OrderFlowSnapshot } from "./orderFlow";
import type { FlowScenarioId } from "./scenarios";
import type { TrainingSnapshot } from "./training";

/* ------------------------------ types ------------------------------ */

export type FlowEvidenceCategory = "aggression" | "price" | "liquidity" | "flow" | "structure";

/** One objective, measurable observation derived from revealed data. */
export interface FlowEvidence {
  sequence: number;
  timestamp: number;
  category: FlowEvidenceCategory;
  /** Stable metric key — never contains a pattern name. */
  metric: string;
  /** Current raw value (count, percent or price-based figure). */
  value: number | string;
  /** Strength label: HIGH / LOW / MODERATE / WEAK / STRONG / DETECTED … */
  interpretation: string;
}

export interface FlowRecognition {
  /** Engine's classification — hidden from the trader until Reveal. */
  pattern: FlowScenarioId | "unknown";
  /** 0..1, derived from observed evidence strength (never random). */
  confidence: number;
  /** Observable sequence window where the signature formed (null if unknown). */
  window: { startSequence: number; endSequence: number } | null;
  /** Short objective phrases describing why the score was assigned. */
  signals: string[];
  /** Objective current-state observations — safe to show while blind. */
  evidence: FlowEvidence[];
}

/** What recognizeFlow() needs — a strict subset of TrainingSnapshot. */
export type FlowAnalysisInput = Pick<
  TrainingSnapshot,
  "sequence" | "timestamp" | "priceSeries" | "orderFlow" | "dom"
>;

/**
 * Chart marker types (annotation labels are objective before Reveal).
 *
 * NOTE: "concentration" is used where §9 suggested "absorption" — that word
 * doubles as a pattern name, and blind state must never contain pattern
 * vocabulary (§14) while the trader is still guessing.
 */
export type FlowAnnotationType =
  | "aggression"
  | "concentration"
  | "sweep"
  | "divergence"
  | "breakout"
  | "rejection"
  | "replenishment";

export interface FlowAnnotation {
  /** Event timestamp — mapped on the chart by time, never by array index. */
  t: number;
  seq: number;
  type: FlowAnnotationType;
  label: string;
  /** True when the label is an interpretation (post-reveal only). */
  interpretive: boolean;
}

/**
 * One observable event in the evidence timeline (spec §8). Derived purely
 * from metric state changes on the event clock — never from ScenarioTruth.
 */
export interface FlowTimelineEntry {
  /** Event index where the change was observed (used for index filtering). */
  index: number;
  sequence: number;
  timestamp: number;
  metric: string;
  /** Human label, e.g. "Sell aggression" (no pattern names). */
  label: string;
  interpretation: string;
  /** True for high-impact one-shot observations. */
  important: boolean;
}

/* ----------------------- calibratable thresholds ----------------------- */

/** Best detector must reach this score to claim a pattern. */
export const RECOGNITION_MIN_SCORE = 0.55;
/** Best must beat the runner-up by this margin, else the call is ambiguous. */
export const RECOGNITION_AMBIGUITY_MARGIN = 0.05;
/** Minimum traded-price points before any classification is attempted. */
export const RECOGNITION_MIN_POINTS = 80;
/** Busiest-level share of total volume that reads as concentration. */
export const CONCENTRATION_HIGH = 0.1;
export const CONCENTRATION_MODERATE = 0.07;
/** One-side aggression percent that reads as dominant. */
export const AGGRESSION_DOMINANT = 55;
export const AGGRESSION_HIGH = 58;

/* ------------------------------ analysis ------------------------------ */

interface Analysis {
  n: number;
  seq: number;
  ts: number;
  prices: number[];
  p0: number;
  pL: number;
  lo: number;
  hi: number;
  range: number;
  lowIdx: number;
  highIdx: number;
  /** (pL − lo) / range — how much of the drawdown was recovered. */
  recoveredFromLow: number;
  /** (hi − pL) / range — how much of the advance was given back. */
  gaveBackFromHigh: number;
  /** (p0 − lo) / range — downside extension from the start. */
  declineFromStart: number;
  /** (hi − p0) / range — upside extension from the start. */
  advanceFromStart: number;
  /** (pL − p0) / range — net progress over the whole sequence, signed. */
  netProgress: number;
  earlyLo: number;
  earlyHi: number;
  lateMin: number;
  lateMax: number;
  vwapPos: number;
  busyPrice: number;
  maxLevelShare: number;
  busyZoneShare: number;
  topZoneShare: number;
  buyAgg: number;
  sellAgg: number;
  delta: number;
  cvdRising: boolean;
  cvdFalling: boolean;
  replenish: number;
  pullBids: number;
  pullAsks: number;
  sweepBuy: number;
  sweepSell: number;
  velocity: number;
  velocityRef: number;
  /** Cumulative delta compared across the two halves of the path. */
  divergenceDown: boolean;
  divergenceUp: boolean;
}

function buildAnalysis(input: FlowAnalysisInput): Analysis {
  const { orderFlow: of, dom } = input;
  const points = input.priceSeries;
  const prices = points.map((p) => p.price);
  const n = prices.length;
  const lo = n > 0 ? Math.min(...prices) : 0;
  const hi = n > 0 ? Math.max(...prices) : 0;
  const range = Math.max(hi - lo, 0.25);
  let lowIdx = 0;
  let highIdx = 0;
  for (let i = 0; i < n; i++) {
    if (prices[i] < prices[lowIdx]) lowIdx = i;
    if (prices[i] > prices[highIdx]) highIdx = i;
  }
  const p0 = n > 0 ? prices[0] : 0;
  const pL = n > 0 ? prices[n - 1] : 0;

  const earlyEnd = Math.max(1, Math.floor(n * 0.45));
  const lateStart = Math.min(n, Math.floor(n * 0.85));
  let earlyLo = Infinity;
  let earlyHi = -Infinity;
  for (let i = 0; i < earlyEnd; i++) {
    if (prices[i] < earlyLo) earlyLo = prices[i];
    if (prices[i] > earlyHi) earlyHi = prices[i];
  }
  if (!Number.isFinite(earlyLo)) {
    earlyLo = lo;
    earlyHi = hi;
  }
  let lateMin = Infinity;
  let lateMax = -Infinity;
  for (let i = lateStart; i < n; i++) {
    if (prices[i] < lateMin) lateMin = prices[i];
    if (prices[i] > lateMax) lateMax = prices[i];
  }
  if (!Number.isFinite(lateMin)) {
    lateMin = pL;
    lateMax = pL;
  }

  // Volume concentration from the revealed profile.
  const profile = of.volumeAtPrice;
  const totalVolume = Math.max(1, of.totalVolume);
  let busyPrice = pL;
  let busyTotal = 0;
  for (const level of profile) {
    if (level.total > busyTotal) {
      busyTotal = level.total;
      busyPrice = level.price;
    }
  }
  let busyZone = 0;
  let topZone = 0;
  const topThreshold = hi - 0.25 * range;
  for (const level of profile) {
    if (Math.abs(level.price - busyPrice) <= 0.5) busyZone += level.total;
    if (level.price >= topThreshold) topZone += level.total;
  }

  // CVD direction across the revealed series (coarse but stable).
  const cvd = of.cvdSeries;
  const cvdFirst = cvd.length > 0 ? cvd[0] : 0;
  const cvdLast = cvd.length > 0 ? cvd[cvd.length - 1] : of.cumulativeDelta;
  const cvdMid = cvd.length > 1 ? cvd[Math.floor(cvd.length / 2)] : cvdLast;
  const eps = Math.max(2, Math.abs(cvdFirst) * 0.02);
  const cvdRising = cvdLast > cvdFirst + eps;
  const cvdFalling = cvdLast < cvdFirst - eps;

  // Divergence: second half of the path vs second half of the CVD series.
  const midIdx = Math.floor(n / 2);
  const priceSecondHalf = n > 0 ? pL - prices[midIdx] : 0;
  const cvdSecondHalf = cvdLast - cvdMid;
  const divergenceDown = priceSecondHalf > 0.12 * range && cvdSecondHalf < -2;
  const divergenceUp = priceSecondHalf < -0.12 * range && cvdSecondHalf > 2;

  const nowTs = input.timestamp ?? 0;
  const firstT = n > 0 ? points[0].t : nowTs;
  const elapsedMin = Math.max((nowTs - firstT) / 60_000, 0.05);
  const velocityRef = Math.max(of.tradeCount / elapsedMin, 1);

  return {
    n,
    seq: input.sequence,
    ts: nowTs,
    prices,
    p0,
    pL,
    lo,
    hi,
    range,
    lowIdx,
    highIdx,
    recoveredFromLow: (pL - lo) / range,
    gaveBackFromHigh: (hi - pL) / range,
    declineFromStart: (p0 - lo) / range,
    advanceFromStart: (hi - p0) / range,
    netProgress: (pL - p0) / range,
    earlyLo,
    earlyHi,
    lateMin,
    lateMax,
    vwapPos: of.vwap > 0 ? (of.vwap - lo) / range : 0.5,
    busyPrice,
    maxLevelShare: busyTotal / totalVolume,
    busyZoneShare: busyZone / totalVolume,
    topZoneShare: topZone / totalVolume,
    buyAgg: of.buyAggressionPct,
    sellAgg: of.sellAggressionPct,
    delta: of.delta,
    cvdRising,
    cvdFalling,
    replenish: dom.replenishCount,
    pullBids: dom.pullBidCount,
    pullAsks: dom.pullAskCount,
    sweepBuy: dom.sweepBuyCount,
    sweepSell: dom.sweepSellCount,
    velocity: of.velocityPerMin,
    velocityRef,
    divergenceDown,
    divergenceUp,
  };
}

/* ----------------------------- evidence ----------------------------- */

/** Human label for an evidence metric key (UI + timeline rendering). */
export function flowEvidenceLabel(metric: string): string {
  const LABELS: Record<string, string> = {
    sellAggression: "Sell aggression",
    buyAggression: "Buy aggression",
    priceResponse: "Price response",
    liquidityReplenishment: "Liquidity replenishment",
    cvd: "CVD",
    sweepEvents: "Sweep events",
    tradeVelocity: "Trade velocity",
    volumeConcentration: "Volume concentration",
    bookImbalance: "Book imbalance",
    cvdDivergence: "CVD divergence",
    lowReclaim: "Low reclaimed",
    highRejection: "High rejected",
    rangeCompression: "Range compression",
    rangeBreak: "Range break",
    heavyPrint: "Large print",
    liquidityPulls: "Liquidity pulls",
  };
  return LABELS[metric] ?? metric;
}

/** Objective current-state observations — safe to display while blind. */
function buildEvidence(a: Analysis, of: OrderFlowSnapshot): FlowEvidence[] {
  if (a.n === 0 && of.tradeCount === 0) return [];
  const seq = a.seq;
  const ts = a.ts;
  const ev: FlowEvidence[] = [];

  const sellDominant = a.sellAgg >= a.buyAgg;
  ev.push({
    sequence: seq,
    timestamp: ts,
    category: "aggression",
    metric: sellDominant ? "sellAggression" : "buyAggression",
    value: `${(sellDominant ? a.sellAgg : a.buyAgg).toFixed(0)}%`,
    interpretation: (sellDominant ? a.sellAgg : a.buyAgg) >= AGGRESSION_HIGH
      ? "HIGH"
      : (sellDominant ? a.sellAgg : a.buyAgg) <= 42
        ? "LOW"
        : "MODERATE",
  });

  if (a.n > 0) {
    const resp = (a.pL - a.p0) / a.range;
    const aligned = sellDominant ? -resp : resp;
    ev.push({
      sequence: seq,
      timestamp: ts,
      category: "price",
      metric: "priceResponse",
      value: `${(resp * 100).toFixed(0)}% of range`,
      interpretation: aligned >= 0.3 ? "STRONG" : aligned <= -0.05 ? "WEAK" : "MODERATE",
    });
  }

  ev.push({
    sequence: seq,
    timestamp: ts,
    category: "liquidity",
    metric: "liquidityReplenishment",
    value: a.replenish,
    interpretation: a.replenish >= 6 ? "HIGH" : a.replenish >= 2 ? "MODERATE" : "LOW",
  });

  ev.push({
    sequence: seq,
    timestamp: ts,
    category: "flow",
    metric: "cvd",
    value: a.cvdRising ? "rising" : a.cvdFalling ? "falling" : "flat",
    interpretation: a.cvdRising ? "RISING" : a.cvdFalling ? "FALLING" : "FLAT",
  });

  const sweeps = a.sweepBuy + a.sweepSell;
  ev.push({
    sequence: seq,
    timestamp: ts,
    category: "liquidity",
    metric: "sweepEvents",
    value: sweeps,
    interpretation: sweeps > 0 ? "DETECTED" : "NONE",
  });

  const velRatio = a.velocity / Math.max(a.velocityRef, 1);
  ev.push({
    sequence: seq,
    timestamp: ts,
    category: "aggression",
    metric: "tradeVelocity",
    value: `${a.velocity.toFixed(0)}/min`,
    interpretation: velRatio >= 1.3 ? "HIGH" : velRatio <= 0.7 ? "LOW" : "NORMAL",
  });

  ev.push({
    sequence: seq,
    timestamp: ts,
    category: "flow",
    metric: "volumeConcentration",
    value: `${(a.maxLevelShare * 100).toFixed(0)}%`,
    interpretation: a.maxLevelShare >= CONCENTRATION_HIGH
      ? "HIGH"
      : a.maxLevelShare >= CONCENTRATION_MODERATE
        ? "MODERATE"
        : "LOW",
  });

  const imb = of.bidAskImbalance;
  ev.push({
    sequence: seq,
    timestamp: ts,
    category: "liquidity",
    metric: "bookImbalance",
    value: imb !== null ? `${(imb * 100).toFixed(0)}%` : "—",
    interpretation: imb === null ? "NONE" : imb >= 0.15 ? "BID" : imb <= -0.15 ? "ASK" : "BALANCED",
  });

  if (a.divergenceDown || a.divergenceUp) {
    ev.push({
      sequence: seq,
      timestamp: ts,
      category: "flow",
      metric: "cvdDivergence",
      value: a.divergenceDown ? "price up, CVD down" : "price down, CVD up",
      interpretation: "DETECTED",
    });
  }
  if (a.n > 0 && a.recoveredFromLow >= 0.35 && a.declineFromStart >= 0.3) {
    ev.push({
      sequence: seq,
      timestamp: ts,
      category: "price",
      metric: "lowReclaim",
      value: `${(a.recoveredFromLow * 100).toFixed(0)}% recovered`,
      interpretation: "DETECTED",
    });
  }
  if (a.n > 0 && a.gaveBackFromHigh >= 0.4 && a.advanceFromStart >= 0.4) {
    ev.push({
      sequence: seq,
      timestamp: ts,
      category: "price",
      metric: "highRejection",
      value: `${(a.gaveBackFromHigh * 100).toFixed(0)}% given back`,
      interpretation: "DETECTED",
    });
  }
  return ev;
}

/* ------------------------------ detectors ------------------------------ */

interface DetectorResult {
  score: number;
  signals: string[];
  window: { startSequence: number; endSequence: number } | null;
}

/** window helper: from the sequence of landmark point to the newest event. */
function endWindow(a: Analysis, startSeq: number): { startSequence: number; endSequence: number } {
  return { startSequence: startSeq, endSequence: a.seq };
}

function detectSpring(a: Analysis, seqs: number[]): DetectorResult {
  const signals: string[] = [];
  let score = 0;
  if (a.declineFromStart >= 0.4) {
    score += 0.2;
    signals.push("downside extension to a new session low");
  }
  if (a.lowIdx >= Math.floor(a.n * 0.2) && a.lowIdx <= a.n - 6) {
    score += 0.15;
    signals.push("low forms before the end of the sequence");
  }
  if (a.sellAgg >= AGGRESSION_DOMINANT || a.delta < 0) {
    score += 0.1;
    signals.push("aggressive selling into the decline");
  }
  if (a.recoveredFromLow >= 0.45) {
    score += 0.2;
    signals.push("failure to continue lower");
  }
  if (a.replenish >= 2 || a.pullBids >= 3) {
    score += 0.1;
    signals.push("bid liquidity replenished after pulls");
  }
  if (a.recoveredFromLow >= 0.5) {
    score += 0.1;
    signals.push("price reclaims the broken level");
  }
  if (a.sweepSell >= 1) {
    score += 0.08;
    signals.push("sell-side sweep through the lows");
  }
  // Bid-side liquidity swept after a deep decline is the stop-run leg of a
  // spring (an upthrust sweeps offers at the top, after a shallow decline).
  if (a.sweepBuy >= 1 && a.declineFromStart >= 0.6) {
    score += 0.08;
    signals.push("bid liquidity swept through the lows");
  }
  if (a.cvdRising && a.pL > a.prices[Math.floor(a.n / 2)]) {
    score += 0.07;
    signals.push("upside pressure as CVD turns higher");
  }
  if (a.recoveredFromLow >= 0.75) {
    score += 0.1;
    signals.push("full reclaim back toward the top of the range");
  }
  // Deep, full-range decline with only light level concentration is a
  // stop-run and reclaim — the spring signature, not a battle at one level.
  if (a.declineFromStart >= 0.9 && a.recoveredFromLow >= 0.5 && a.maxLevelShare <= 0.19) {
    score += 0.12;
    signals.push("full-range sweep of the lows with light concentration");
  }
  // Compressed base, deep undercut, then full acceptance back above the
  // range — the textbook stop-run-and-reclaim shape.
  if (
    a.declineFromStart >= 0.5 &&
    a.recoveredFromLow >= 0.95 &&
    (a.earlyHi - a.earlyLo) / a.range <= 0.25
  ) {
    score += 0.14;
    signals.push("deep undercut of a compact base, fully reclaimed");
  }
  if (a.declineFromStart >= 0.6) {
    score += 0.08;
    signals.push("deep downside run before the turn");
  }
  if (a.replenish >= 4) {
    score += 0.08;
    signals.push("persistent bid refilling through the decline");
  }
  // A broad early traverse reads as a contained band battle, not a stop-run
  // across a wide range — cede those sequences. Only when volume actually
  // concentrated: a broad path with light concentration is still a sweep.
  if (a.earlyHi - a.earlyLo >= 0.8 * a.range && a.maxLevelShare >= 0.15) score -= 0.25;
  // Ending flat at the session high with no give-back means nothing was ever
  // stopped out and reclaimed — that is not this signature.
  if (a.gaveBackFromHigh <= 0.1 && a.highIdx >= Math.floor(a.n * 0.9)) score -= 0.22;
  return { score, signals, window: a.n > 0 ? endWindow(a, seqs[a.lowIdx] ?? a.seq) : null };
}

function detectUpthrust(a: Analysis, seqs: number[]): DetectorResult {
  const signals: string[] = [];
  let score = 0;
  if (a.advanceFromStart >= 0.45) {
    score += 0.18;
    signals.push("upside extension to a new session high");
  }
  if (a.highIdx <= a.n - 8 && a.highIdx >= Math.floor(a.n * 0.6)) {
    score += 0.15;
    signals.push("high forms late, then fails");
  }
  if (a.buyAgg >= AGGRESSION_DOMINANT || a.delta > 0) {
    score += 0.1;
    signals.push("aggressive buying at the highs");
  }
  if (a.gaveBackFromHigh >= 0.45) {
    score += 0.2;
    signals.push("rejection — the advance does not hold");
  }
  if (a.pL <= a.lo + 0.5 * a.range) {
    score += 0.12;
    signals.push("price falls back through the prior range");
  }
  if (a.sweepBuy >= 1) {
    score += 0.1;
    signals.push("buy-side sweep above the range");
  }
  if (a.cvdFalling) {
    score += 0.1;
    signals.push("CVD turns lower after the push");
  }
  if (a.topZoneShare <= 0.25) {
    score += 0.1;
    signals.push("volume does not linger at the highs");
  }
  if (a.declineFromStart <= 0.25) {
    score += 0.12;
    signals.push("price never sustains below the starting area");
  }
  if (a.netProgress <= -0.25) {
    score += 0.1;
    signals.push("round trip ends well below the starting area");
  }
  // A round trip that closes ABOVE the start never completed the failed
  // auction — but only when price was actually rejected into the lower band;
  // a mid-range finish reads as rotation instead.
  if (a.netProgress >= 0.1 && a.recoveredFromLow <= 0.6) score -= 0.08;
  // Ending near the top of the range without a real rejection cannot be a
  // failed auction regardless of how far the push extended.
  if (a.recoveredFromLow > 0.6 && a.gaveBackFromHigh < 0.45) score -= 0.15;
  // The high must form late for a push-then-fail; a mid-path high with the
  // end still elevated is rotation, not upthrust.
  if (a.highIdx < Math.floor(a.n * 0.6)) score -= 0.1;
  // A broad early traverse is not a compact base beneath the push.
  if ((a.earlyHi - a.earlyLo) / a.range >= 0.85) score -= 0.1;
  const upthrustEarlyRange = (a.earlyHi - a.earlyLo) / a.range;
  if (upthrustEarlyRange <= 0.5) {
    score += 0.12;
    signals.push("the decline spans the larger share of the swing");
  }
  return { score, signals, window: a.n > 0 ? endWindow(a, seqs[a.highIdx] ?? a.seq) : null };
}

function detectAbsorption(a: Analysis, seqs: number[]): DetectorResult {
  const signals: string[] = [];
  let score = 0;
  if (a.maxLevelShare >= CONCENTRATION_HIGH) {
    score += 0.3;
    signals.push(`volume concentrated at one level (${(a.maxLevelShare * 100).toFixed(0)}%)`);
  }
  if (a.maxLevelShare >= 0.25) {
    score += 0.05;
    signals.push("exceptionally one-sided volume concentration");
  }
  if (Math.max(a.buyAgg, a.sellAgg) >= AGGRESSION_DOMINANT) {
    score += 0.15;
    signals.push("one-side aggressive volume dominates");
  }
  if (a.busyZoneShare >= 0.3) {
    score += 0.15;
    signals.push("repeated attacks inside a tight band");
  }
  if (a.replenish >= 2) {
    score += 0.15;
    signals.push("opposing liquidity keeps refilling");
  }
  if (a.sellAgg >= AGGRESSION_DOMINANT && a.pL >= a.busyPrice + 0.2 * a.range * 0.5 && a.recoveredFromLow <= 0.75) {
    score += 0.15;
    signals.push("aggressive selling makes little downward progress");
  }
  if (a.delta <= 0 && a.recoveredFromLow >= 0.5) {
    score += 0.1;
    signals.push("negative delta with no downside follow-through");
  }
  if (a.netProgress <= 0.1) {
    score += 0.1;
    signals.push("aggression without net price progress");
  }
  if (Math.max(a.sellAgg, a.buyAgg) >= 60) {
    score += 0.05;
    signals.push("extreme one-sided aggression");
  }
  // Real absorption makes no net progress; a path that travelled well away
  // from the start was consumed by initiative, not absorbed.
  if (a.netProgress >= 0.15) score -= 0.1;
  // The battle-band signature: the early traverse already covers almost the
  // whole swing — the action is concentrated, not a broad excursion.
  if (a.earlyHi - a.earlyLo >= 0.75 * a.range) {
    score += 0.1;
    signals.push("the early traverse covers nearly the whole swing");
  }
  // A full reclaim back to the top of the range is the stop-run signature,
  // not a pure battle-at-the-level one — penalize it here.
  if (a.recoveredFromLow >= 0.85) score -= 0.25;
  // First point that touched the busy level marks where the battle formed.
  let startSeq = seqs[0] ?? a.seq;
  for (let i = 0; i < a.prices.length; i++) {
    if (Math.abs(a.prices[i] - a.busyPrice) <= 0.5) {
      startSeq = seqs[i] ?? startSeq;
      break;
    }
  }
  return { score, signals, window: a.n > 0 ? endWindow(a, startSeq) : null };
}

function detectInitiativeBreak(a: Analysis, seqs: number[]): DetectorResult {
  const signals: string[] = [];
  let score = 0;
  const earlyRange = a.earlyHi - a.earlyLo;
  if (earlyRange <= 0.5 * a.range) {
    score += 0.25;
    signals.push("compressed range before the move");
  }
  if (a.pL >= a.hi - 0.15 * a.range) {
    score += 0.15;
    signals.push("holds near the highs after the break");
  }
  if (a.buyAgg >= 53 || a.delta > 0) {
    score += 0.15;
    signals.push("aggression expands with the move");
  }
  if (a.pL >= a.p0 + 0.4 * a.range) {
    score += 0.2;
    signals.push("net advance away from the opening area");
  }
  if (a.lateMin >= a.earlyHi + 0.15 * a.range) {
    score += 0.2;
    signals.push("continuation — the range high never gets re-entered");
  }
  if (a.highIdx >= Math.floor(a.n * 0.5)) {
    score += 0.05;
    signals.push("high forms after the compression");
  }
  if (a.netProgress >= 0.4 && a.gaveBackFromHigh <= 0.05) {
    score += 0.06;
    signals.push("the entire advance is held without give-back");
  }
  // Break point: first time price exceeds the early range high decisively.
  let breakIdx = Math.floor(a.n * 0.45);
  const breakLevel = a.earlyHi + 0.15 * a.range;
  for (let i = 0; i < a.prices.length; i++) {
    if (a.prices[i] > breakLevel) {
      breakIdx = i;
      break;
    }
  }
  return { score, signals, window: a.n > 0 ? endWindow(a, seqs[breakIdx] ?? a.seq) : null };
}

function detectResponsiveFade(a: Analysis, seqs: number[]): DetectorResult {
  const signals: string[] = [];
  let score = 0;
  if (a.advanceFromStart >= 0.4) {
    score += 0.2;
    signals.push("extension away from the prior area");
  }
  if (a.gaveBackFromHigh >= 0.4) {
    score += 0.25;
    signals.push("failure to continue higher");
  }
  if (a.pL <= a.lo + 0.65 * a.range) {
    score += 0.15;
    signals.push("rotation back toward the middle of the range");
  }
  // Settling at the session low AFTER a late high is rejection INTO the lows
  // (upthrust end-state); with an earlier high it is simply where the
  // rotation finished.
  if (a.recoveredFromLow <= 0.2 && a.highIdx > Math.floor(a.n * 0.7)) score -= 0.12;
  if (a.highIdx <= Math.floor(a.n * 0.65) && a.highIdx >= Math.floor(a.n * 0.15)) {
    score += 0.1;
    signals.push("high forms before the sequence ends");
  }
  if (a.cvdFalling || a.divergenceDown) {
    score += 0.15;
    signals.push("CVD stops confirming the highs");
  }
  if (a.sellAgg >= a.buyAgg) {
    score += 0.1;
    signals.push("responsive selling takes control");
  }
  if (a.gaveBackFromHigh >= 0.6) {
    score += 0.05;
    signals.push("the advance is largely unwound");
  }
  if (a.declineFromStart >= 0.3) {
    score += 0.1;
    signals.push("rotation extends below the starting area");
  }
  // Extension that settles into the middle band with an earlier high is the
  // rotation signature even when the give-back or CVD evidence is incomplete.
  if (
    a.advanceFromStart >= 0.6 &&
    a.recoveredFromLow >= 0.15 &&
    a.recoveredFromLow <= 0.65 &&
    a.highIdx <= Math.floor(a.n * 0.7)
  ) {
    score += 0.1;
    signals.push("price settles into the middle band after the extension");
  }
  // The fade's swing is dominated by the post-high chop; when the early path
  // already covers most of the range, the late high is a re-test (not a fade).
  const fadeEarlyRange = (a.earlyHi - a.earlyLo) / a.range;
  if (fadeEarlyRange <= 0.62) score -= 0.15;
  return { score, signals, window: a.n > 0 ? endWindow(a, seqs[a.highIdx] ?? a.seq) : null };
}

/* ------------------------------ recognize ------------------------------ */

const DETECTORS: Array<{ id: FlowScenarioId; detect: (a: Analysis, seqs: number[]) => DetectorResult }> = [
  { id: "spring", detect: detectSpring },
  { id: "upthrust", detect: detectUpthrust },
  { id: "absorption", detect: detectAbsorption },
  { id: "initiative-break", detect: detectInitiativeBreak },
  { id: "responsive-fade", detect: detectResponsiveFade },
];

function rankDetectors(
  analysis: Analysis,
  seqs: number[],
): Array<{
  id: FlowScenarioId;
  score: number;
  signals: string[];
  window: { startSequence: number; endSequence: number } | null;
}> {
  const results = DETECTORS.map((d) => {
    const r = d.detect(analysis, seqs);
    // Round to 4 decimals so floating-point dust never eats the ambiguity margin.
    const clamped = Math.max(0, Math.min(1, r.score));
    return {
      id: d.id,
      score: Math.round(clamped * 10000) / 10000,
      signals: r.signals,
      window: r.window,
    };
  });
  results.sort((x, y) => y.score - x.score);
  return results;
}

/**
 * Raw detector scores for every candidate pattern (highest first). Useful for
 * calibration, tests and future threshold tuning — contains no truth either.
 */
export function rankFlowPatterns(
  input: FlowAnalysisInput,
): Array<{ pattern: FlowScenarioId; score: number; signals: string[] }> {
  const analysis = buildAnalysis(input);
  if (analysis.n < RECOGNITION_MIN_POINTS || input.orderFlow.tradeCount === 0) return [];
  const seqs = input.priceSeries.map((p) => p.sequence);
  return rankDetectors(analysis, seqs).map((r) => ({ pattern: r.id, score: r.score, signals: r.signals }));
}

/**
 * Pure recognition over revealed data. Same input ⇒ identical output; the
 * presence or absence of ScenarioTruth on the caller cannot affect it because
 * truth is not part of the input type.
 */
export function recognizeFlow(input: FlowAnalysisInput): FlowRecognition {
  const analysis = buildAnalysis(input);
  const evidence = buildEvidence(analysis, input.orderFlow);

  if (analysis.n < RECOGNITION_MIN_POINTS || input.orderFlow.tradeCount === 0) {
    return { pattern: "unknown", confidence: 0, window: null, signals: [], evidence };
  }

  const seqs = input.priceSeries.map((p) => p.sequence);
  const results = rankDetectors(analysis, seqs);
  const best = results[0];
  const second = results[1];
  const confidence = Math.max(0, Math.min(1, best.score));
  const clearEnough =
    best.score >= RECOGNITION_MIN_SCORE && best.score - second.score >= RECOGNITION_AMBIGUITY_MARGIN;

  return {
    pattern: clearEnough ? best.id : "unknown",
    confidence,
    window: clearEnough ? best.window : null,
    signals: clearEnough ? best.signals.slice(0, 6) : best.signals.slice(0, 2),
    evidence,
  };
}
