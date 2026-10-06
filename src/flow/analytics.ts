/**
 * Phase 8C — training analytics.
 *
 * Derives a session-overview view from the raw per-scenario results the
 * controller already keeps (`FlowSessionResults[]`). The existing raw training
 * statistics are untouched — everything here is additive and computed from
 * real session data, never hardcoded.
 *
 * SAMPLE DISCIPLINE: any bucket without enough observations is flagged
 * `insufficient` and the UI shows "Insufficient sample" instead of a
 * misleading percentage. Thresholds are exported and overridable.
 *
 * Weakness statements are rule-based observations about the record — never
 * psychological diagnoses.
 */

import {
  FLOW_DIFFICULTIES,
  FLOW_SCENARIOS,
  type FlowDifficulty,
  type FlowScenarioId,
} from "./scenarios";
import type { FlowSessionResults } from "./scoring";

export interface AnalyticsThresholds {
  /** Minimum observations before a bucket reports a rate at all. */
  minSample: number;
  /** MFE capture below this reads as "low relative to available movement". */
  lowMfeCapturePct: number;
  /** Share of traded sessions entered before confirmation that reads as "frequent". */
  earlyEntrySharePct: number;
  /** Pattern accuracy at or above this reads as a current strength. */
  strongAccuracyPct: number;
  /** How far below the session average a pattern must sit to be called out. */
  weakGapPct: number;
}

export const ANALYTICS_THRESHOLDS: AnalyticsThresholds = {
  minSample: 3,
  lowMfeCapturePct: 50,
  earlyEntrySharePct: 50,
  strongAccuracyPct: 60,
  weakGapPct: 5,
};

/** Shown wherever a bucket has too few observations to be meaningful. */
export const INSUFFICIENT_SAMPLE_LABEL = "Insufficient sample";

export interface PatternAnalytics {
  patternId: FlowScenarioId;
  pattern: string;
  sessions: number;
  predictions: number;
  correct: number;
  accuracyPct: number | null;
  trades: number;
  wins: number;
  losses: number;
  netPnL: number;
  avgNetPnL: number | null;
  insufficient: boolean;
}

export interface DifficultyAnalytics {
  difficulty: FlowDifficulty;
  sessions: number;
  trades: number;
  wins: number;
  losses: number;
  netPnL: number;
  winRatePct: number | null;
  recognitionCalls: number;
  recognitionCorrect: number;
  recognitionAccuracyPct: number | null;
  insufficient: boolean;
}

export interface ConfidenceAnalytics {
  level: number;
  sessions: number;
  trades: number;
  wins: number;
  losses: number;
  netPnL: number;
  avgNetPnL: number | null;
  winRatePct: number | null;
  insufficient: boolean;
}

export interface DirectionStats {
  calls: number;
  correct: number;
  accuracyPct: number | null;
  trades: number;
  netPnL: number;
  insufficient: boolean;
}

export interface RecognitionAnalytics {
  traderCalls: number;
  traderCorrect: number;
  traderAccuracyPct: number | null;
  engineCalls: number;
  engineCorrect: number;
  engineAccuracyPct: number | null;
  agreements: number;
  agreeCount: number;
  agreementPct: number | null;
  sufficient: boolean;
}

export type WeaknessKind = "STRENGTH" | "WEAK_PATTERN" | "CONFIDENCE" | "EARLY_ENTRY" | "MFE_CAPTURE";

export interface FlowWeakness {
  kind: WeaknessKind;
  /** Plain observation about the record — not a diagnosis. */
  text: string;
  /** Observations the statement is based on. */
  sample: number;
}

/** How often a traded session was entered before the confirmation window. */
export interface EarlyEntryStats {
  tradedSessions: number;
  count: number;
}

export interface FlowAnalytics {
  sessions: number;
  trades: number;
  netPnL: number;
  avgTrade: number | null;
  bestTrade: number;
  worstTrade: number;
  winRatePct: number | null;
  profitFactor: number | null;
  avgMfe: number | null;
  avgMae: number | null;
  mfeCapturePct: number | null;
  avgHoldMs: number | null;
  tradesPerSession: number | null;
  /** Mean trader conviction across revealed sessions (1..5). */
  avgConfidence: number | null;
  recognition: RecognitionAnalytics;
  direction: { long: DirectionStats; short: DirectionStats };
  byPattern: PatternAnalytics[];
  byDifficulty: DifficultyAnalytics[];
  byConfidence: ConfidenceAnalytics[];
  earlyEntry: EarlyEntryStats;
  weaknesses: FlowWeakness[];
  thresholds: AnalyticsThresholds;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((s, v) => s + v, 0) / values.length);
}

function ratePct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round1((numerator / denominator) * 100);
}

function sum(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

function money(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(round2(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ------------------------------ breakdowns ------------------------------ */

function patternBreakdown(
  results: readonly FlowSessionResults[],
  thresholds: AnalyticsThresholds,
): PatternAnalytics[] {
  return FLOW_SCENARIOS.map((meta) => {
    const rows = results.filter((r) => r.patternId === meta.id);
    const predictions = rows.filter((r) => r.patternResult !== "NO PREDICTION");
    const correct = predictions.filter((r) => r.patternResult === "CORRECT").length;
    const trades = sum(rows.map((r) => r.trades));
    const wins = sum(rows.map((r) => r.wins));
    const losses = sum(rows.map((r) => r.losses));
    const netPnL = round2(sum(rows.map((r) => r.netPnL)));
    return {
      patternId: meta.id,
      pattern: meta.name,
      sessions: rows.length,
      predictions: predictions.length,
      correct,
      accuracyPct: predictions.length >= thresholds.minSample ? ratePct(correct, predictions.length) : null,
      trades,
      wins,
      losses,
      netPnL,
      avgNetPnL: trades > 0 ? round2(netPnL / trades) : null,
      insufficient: predictions.length < thresholds.minSample,
    };
  });
}

function difficultyBreakdown(
  results: readonly FlowSessionResults[],
  thresholds: AnalyticsThresholds,
): DifficultyAnalytics[] {
  return FLOW_DIFFICULTIES.map((difficulty) => {
    const rows = results.filter((r) => (r.difficulty ?? "INTERMEDIATE") === difficulty);
    const trades = sum(rows.map((r) => r.trades));
    const wins = sum(rows.map((r) => r.wins));
    const losses = sum(rows.map((r) => r.losses));
    const calls = rows.filter((r) => r.recognitionResult !== "NO SIGNAL");
    const correct = calls.filter((r) => r.recognitionResult === "CORRECT").length;
    return {
      difficulty,
      sessions: rows.length,
      trades,
      wins,
      losses,
      netPnL: round2(sum(rows.map((r) => r.netPnL))),
      winRatePct: trades > 0 ? ratePct(wins, trades) : null,
      recognitionCalls: calls.length,
      recognitionCorrect: correct,
      recognitionAccuracyPct: calls.length >= thresholds.minSample ? ratePct(correct, calls.length) : null,
      insufficient: rows.length < thresholds.minSample,
    };
  });
}

function confidenceBreakdown(
  results: readonly FlowSessionResults[],
  thresholds: AnalyticsThresholds,
): ConfidenceAnalytics[] {
  const buckets: ConfidenceAnalytics[] = [];
  for (let level = 1; level <= 5; level++) {
    const rows = results.filter((r) => r.confidence === level);
    const trades = sum(rows.map((r) => r.trades));
    const wins = sum(rows.map((r) => r.wins));
    const losses = sum(rows.map((r) => r.losses));
    const netPnL = round2(sum(rows.map((r) => r.netPnL)));
    buckets.push({
      level,
      sessions: rows.length,
      trades,
      wins,
      losses,
      netPnL,
      avgNetPnL: trades > 0 ? round2(netPnL / trades) : null,
      winRatePct: trades > 0 ? ratePct(wins, trades) : null,
      insufficient: rows.length < thresholds.minSample,
    });
  }
  return buckets;
}

function directionStats(
  results: readonly FlowSessionResults[],
  bias: "LONG" | "SHORT",
  thresholds: AnalyticsThresholds,
): DirectionStats {
  const rows = results.filter((r) => r.bias === bias);
  const calls = rows.filter((r) => r.directionResult !== "NO TRADE");
  const correct = calls.filter((r) => r.directionResult === "CORRECT").length;
  const trades = sum(rows.map((r) => r.trades));
  return {
    calls: calls.length,
    correct,
    accuracyPct: calls.length >= thresholds.minSample ? ratePct(correct, calls.length) : null,
    trades,
    netPnL: round2(sum(rows.map((r) => r.netPnL))),
    insufficient: calls.length < thresholds.minSample,
  };
}

/* ------------------------------ weaknesses ------------------------------ */

function detectWeaknesses(
  analytics: Omit<FlowAnalytics, "weaknesses">,
  thresholds: AnalyticsThresholds,
): FlowWeakness[] {
  const out: FlowWeakness[] = [];
  const overall = analytics.recognition.traderAccuracyPct;
  const patterns = analytics.byPattern.filter((p) => !p.insufficient && p.accuracyPct !== null);

  const strongest = [...patterns].sort((a, b) => (b.accuracyPct ?? 0) - (a.accuracyPct ?? 0))[0];
  if (strongest && (strongest.accuracyPct ?? 0) >= thresholds.strongAccuracyPct) {
    out.push({
      kind: "STRENGTH",
      text: `${strongest.pattern} recognition is currently your strongest pattern (${strongest.accuracyPct}% over ${strongest.predictions} predictions).`,
      sample: strongest.predictions,
    });
  }

  if (overall !== null) {
    const weakest = [...patterns]
      .filter((p) => (p.accuracyPct ?? 0) < overall - thresholds.weakGapPct)
      .sort((a, b) => (a.accuracyPct ?? 0) - (b.accuracyPct ?? 0))[0];
    if (weakest) {
      out.push({
        kind: "WEAK_PATTERN",
        text: `${weakest.pattern} recognition is below your session average (${weakest.accuracyPct}% vs ${overall}%).`,
        sample: weakest.predictions,
      });
    }
  }

  const traded = analytics.byConfidence.filter((b) => !b.insufficient && b.trades > 0 && b.avgNetPnL !== null);
  const high = traded.filter((b) => b.level >= 4);
  const mid = traded.filter((b) => b.level === 2 || b.level === 3);
  const highTrades = sum(high.map((b) => b.trades));
  const midTrades = sum(mid.map((b) => b.trades));
  const highAvg = highTrades > 0 ? round2(sum(high.map((b) => b.netPnL)) / highTrades) : null;
  const midAvg = midTrades > 0 ? round2(sum(mid.map((b) => b.netPnL)) / midTrades) : null;
  if (highAvg !== null && midAvg !== null && highAvg < midAvg) {
    out.push({
      kind: "CONFIDENCE",
      text: `High-confidence trades currently underperform medium-confidence trades (avg ${money(highAvg)} vs ${money(midAvg)} per trade).`,
      sample: highTrades + midTrades,
    });
  }

  const tradedSessions = analytics.sessions > 0 ? analytics.tradesPerSession !== null : false;
  const earlySessions = analytics.earlyEntry.count;
  if (
    tradedSessions &&
    analytics.earlyEntry.tradedSessions >= thresholds.minSample &&
    earlySessions / analytics.earlyEntry.tradedSessions * 100 >= thresholds.earlyEntrySharePct
  ) {
    out.push({
      kind: "EARLY_ENTRY",
      text: `You frequently enter before confirmation (${earlySessions} of ${analytics.earlyEntry.tradedSessions} traded sessions entered before the pattern window).`,
      sample: analytics.earlyEntry.tradedSessions,
    });
  }

  if (
    analytics.mfeCapturePct !== null &&
    analytics.mfeCapturePct < thresholds.lowMfeCapturePct &&
    analytics.trades >= thresholds.minSample
  ) {
    out.push({
      kind: "MFE_CAPTURE",
      text: `Your average MFE capture is low relative to available movement (${analytics.mfeCapturePct}% of favourable excursion kept).`,
      sample: analytics.trades,
    });
  }

  return out;
}

/* ------------------------------- the report ------------------------------ */

/** Internal shape used while building the report (before weaknesses attach). */
type FlowAnalyticsCore = Omit<FlowAnalytics, "weaknesses">;

export function computeFlowAnalytics(
  results: readonly FlowSessionResults[],
  overrides: Partial<AnalyticsThresholds> = {},
): FlowAnalytics {
  const thresholds: AnalyticsThresholds = { ...ANALYTICS_THRESHOLDS, ...overrides };
  const trades = sum(results.map((r) => r.trades));
  const wins = sum(results.map((r) => r.wins));
  const netPnL = round2(sum(results.map((r) => r.netPnL)));
  const withTrades = results.filter((r) => r.trades > 0);
  const grossProfit = round2(sum(results.map((r) => (r.netPnL > 0 ? r.netPnL : 0))));
  const grossLoss = round2(Math.abs(sum(results.map((r) => (r.netPnL < 0 ? r.netPnL : 0)))));

  const traderCalls = results.filter((r) => r.patternResult !== "NO PREDICTION");
  const traderCorrect = traderCalls.filter((r) => r.patternResult === "CORRECT").length;
  const engineCalls = results.filter((r) => r.recognitionResult !== "NO SIGNAL");
  const engineCorrect = engineCalls.filter((r) => r.recognitionResult === "CORRECT").length;
  const agreements = results.filter((r) => r.traderEngineAgreement !== null);
  const agreeCount = agreements.filter((r) => r.traderEngineAgreement).length;

  const mfeCaptures = results
    .map((r) => r.mfeCapturePct)
    .filter((v): v is number => v !== null);
  const holdTimes = results
    .map((r) => r.avgHoldMs)
    .filter((v): v is number | null => v !== null && v > 0) as number[];

  const earlyEntry: EarlyEntryStats = {
    tradedSessions: withTrades.length,
    count: withTrades.filter((r) => r.entryTiming === "EARLY").length,
  };

  const core: FlowAnalyticsCore = {
    sessions: results.length,
    trades,
    netPnL,
    avgTrade: trades > 0 ? round2(netPnL / trades) : null,
    bestTrade: withTrades.length > 0 ? Math.max(...withTrades.map((r) => r.bestTrade)) : 0,
    worstTrade: withTrades.length > 0 ? Math.min(...withTrades.map((r) => r.worstTrade)) : 0,
    winRatePct: trades > 0 ? ratePct(wins, trades) : null,
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : null,
    avgMfe: mean(withTrades.map((r) => r.mfe)),
    avgMae: mean(withTrades.map((r) => r.mae)),
    mfeCapturePct: mean(mfeCaptures),
    avgHoldMs: mean(holdTimes),
    tradesPerSession: results.length > 0 ? round2(trades / results.length) : null,
    avgConfidence: mean(results.map((r) => r.confidence)),
    recognition: {
      traderCalls: traderCalls.length,
      traderCorrect,
      traderAccuracyPct: traderCalls.length >= thresholds.minSample ? ratePct(traderCorrect, traderCalls.length) : null,
      engineCalls: engineCalls.length,
      engineCorrect,
      engineAccuracyPct: engineCalls.length >= thresholds.minSample ? ratePct(engineCorrect, engineCalls.length) : null,
      agreements: agreements.length,
      agreeCount,
      agreementPct: agreements.length >= thresholds.minSample ? ratePct(agreeCount, agreements.length) : null,
      sufficient: traderCalls.length >= thresholds.minSample,
    },
    direction: {
      long: directionStats(results, "LONG", thresholds),
      short: directionStats(results, "SHORT", thresholds),
    },
    byPattern: patternBreakdown(results, thresholds),
    byDifficulty: difficultyBreakdown(results, thresholds),
    byConfidence: confidenceBreakdown(results, thresholds),
    earlyEntry,
    thresholds,
  };

  return { ...core, weaknesses: detectWeaknesses(core, thresholds) };
}
