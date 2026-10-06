/**
 * Flow scenario engine — deterministic generators for classic tape-reading
 * patterns, each with a HIDDEN ScenarioTruth.
 *
 * Every generator composes SyntheticMarketDataFeed regime plans into a realistic
 * event sequence, then derives the truth by scanning the generated stream. The
 * truth object is owned by the training layer and must never enter blind-mode
 * UI state — "Reveal what it was" is the only sanctioned exposure path.
 *
 * Determinism: same scenario id + same seed ⇒ identical feed and identical
 * truth. Directions are fixed per pattern (the seed varies the path, not the
 * lesson); the "Any pattern" picker randomises the id, not the internals.
 */

import type { MarketEvent, TradeEvent } from "./events";
import { SyntheticMarketDataFeed, makeRng, type PhaseSpec } from "./synthetic";

/** Training difficulty — shapes scenario generation (never the recognition). */
export type FlowDifficulty = "BEGINNER" | "INTERMEDIATE" | "ADVANCED" | "EXPERT";

export const FLOW_DIFFICULTIES: readonly FlowDifficulty[] = [
  "BEGINNER",
  "INTERMEDIATE",
  "ADVANCED",
  "EXPERT",
];

export interface GenerateScenarioOptions {
  /** Defaults to BEGINNER: the canonical, cleanest-separation plan. */
  difficulty?: FlowDifficulty;
}

export type FlowScenarioId = "spring" | "upthrust" | "absorption" | "initiative-break" | "responsive-fade";

export type PatternDirection = "bullish" | "bearish";

export interface ScenarioTruth {
  pattern: FlowScenarioId;
  direction: PatternDirection;
  /** Sequence number of the trade where the pattern starts (session extreme / break). */
  startEvent: number;
  /** Sequence number of the trade where the pattern completes. */
  endEvent: number;
  characteristics: string[];
  /** Internal generator confidence (0..1). Hidden until reveal. */
  confidence: number;
}

export interface ScenarioMeta {
  id: FlowScenarioId;
  name: string;
  description: string;
}

export const FLOW_SCENARIOS: ScenarioMeta[] = [
  {
    id: "spring",
    name: "Spring",
    description: "Support breaks on a stop-run, sellers are absorbed, price springs back up.",
  },
  {
    id: "upthrust",
    name: "Upthrust",
    description: "Resistance breaks on a buying climax, buyers are trapped, price thrusts back down.",
  },
  {
    id: "absorption",
    name: "Absorption",
    description: "Heavy aggressive volume hits one price and fails to move it — passive liquidity wins.",
  },
  {
    id: "initiative-break",
    name: "Initiative Break",
    description: "Aggressive initiative buyers break the range and the move continues with delta behind it.",
  },
  {
    id: "responsive-fade",
    name: "Responsive Fade",
    description: "Price stretches from value with weakening delta, responsive activity fades it back.",
  },
];

export function scenarioName(id: FlowScenarioId): string {
  return FLOW_SCENARIOS.find((s) => s.id === id)?.name ?? id;
}

/* ------------------------------ helpers ------------------------------ */

function trades(events: readonly MarketEvent[]): TradeEvent[] {
  return events.filter((e): e is TradeEvent => e.kind === "trade");
}

/* -------------- difficulty shaping + anti-memorization -------------- */

/** Light, structurally-valid noise regimes (never destroys the lesson). */
const LIGHT_NOISE: PhaseSpec["kind"][] = ["meander", "rotation", "vol-contraction", "pull"];

function scaleTrades(n: number, lo: number, hi: number, rng: () => number): number {
  return Math.max(12, Math.round(n * (lo + rng() * (hi - lo))));
}

/**
 * Shape the canonical plan for a difficulty. Same seed ⇒ same shape.
 *
 * BEGINNER     canonical plan untouched — strongest signatures, cleanest
 *              separation, no conflicting phases.
 * INTERMEDIATE length jitter ±10% + one light noise phase.
 * ADVANCED     shorter signal phases, one counter-trend phase and one light
 *              noise phase, delayed confirmation (smaller final phase).
 * EXPERT       compressed signal phases, counter-trend + light + false-break
 *              phases interleaved, incomplete/late confirmation.
 *
 * The phase ORDER of the underlying lesson is preserved, so the scenario
 * stays structurally valid — difficulty degrades separation, not validity.
 */
function shapePlan(
  base: PhaseSpec[],
  difficulty: FlowDifficulty,
  bullish: boolean,
  rng: () => number,
): PhaseSpec[] {
  if (difficulty === "BEGINNER") return base.map((p) => ({ ...p }));

  const counterKind: PhaseSpec["kind"] = bullish ? "trend-down" : "trend-up";
  const falseBreakKind: PhaseSpec["kind"] = bullish ? "failed-breakout-up" : "failed-breakout-down";
  const lightNoise = (): PhaseSpec => ({
    kind: LIGHT_NOISE[Math.floor(rng() * LIGHT_NOISE.length)],
    trades: 20 + Math.floor(rng() * 21),
  });

  const [lo, hi] =
    difficulty === "INTERMEDIATE" ? [0.9, 1.1] : difficulty === "ADVANCED" ? [0.8, 1.0] : [0.7, 0.9];
  const plan: PhaseSpec[] = base.map((p) => ({ kind: p.kind, trades: scaleTrades(p.trades, lo, hi, rng) }));

  // Confirmation timing: the final phase carries the lesson's resolution.
  const confirmLo = difficulty === "INTERMEDIATE" ? 0.9 : difficulty === "ADVANCED" ? 0.7 : 0.5;
  const confirmHi = difficulty === "INTERMEDIATE" ? 1.1 : difficulty === "ADVANCED" ? 0.9 : 0.7;
  const last = plan[plan.length - 1];
  last.trades = scaleTrades(last.trades, confirmLo, confirmHi, rng);

  if (difficulty === "INTERMEDIATE") {
    plan.splice(Math.min(2, plan.length - 1), 0, lightNoise());
  } else if (difficulty === "ADVANCED") {
    plan.splice(1, 0, { kind: counterKind, trades: 25 + Math.floor(rng() * 21) });
    plan.splice(Math.min(3, plan.length), 0, lightNoise());
  } else {
    // EXPERT
    plan.splice(1, 0, { kind: counterKind, trades: 30 + Math.floor(rng() * 21) });
    plan.splice(2, 0, lightNoise());
    plan.splice(Math.min(4, plan.length), 0, { kind: falseBreakKind, trades: 25 + Math.floor(rng() * 16) });
  }
  return plan;
}

/**
 * Build the feed with anti-memorization randomization: every seed gets its
 * own starting price, event density (ms/print) and plan lengths — all
 * deterministic from the seed, so replaying the seed reproduces everything.
 */
function feedFor(
  seed: number,
  basePlan: PhaseSpec[],
  difficulty: FlowDifficulty,
  bullish: boolean,
): SyntheticMarketDataFeed {
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const plan = shapePlan(basePlan, difficulty, bullish, rng);
  const startPrice = Math.round((17700 + rng() * 600) / 0.25) * 0.25;
  const msPerTrade = Math.round(320 + rng() * 260);
  return new SyntheticMarketDataFeed({ seed, plan, startPrice, msPerTrade });
}

function extremeTrade(ts: TradeEvent[], mode: "min" | "max"): TradeEvent {
  let best = ts[0];
  for (const t of ts) {
    if (mode === "min" ? t.price < best.price : t.price > best.price) best = t;
  }
  return best;
}

function firstTradeAtOrAfter(ts: TradeEvent[], fromSequence: number, predicate: (t: TradeEvent) => boolean): TradeEvent | null {
  for (const t of ts) {
    if (t.sequence > fromSequence && predicate(t)) return t;
  }
  return null;
}

/** Busiest single price level, and the first trade that touched it. */
function busiestLevel(ts: TradeEvent[]): { price: number; first: TradeEvent; last: TradeEvent; volume: number } {
  const byPrice = new Map<number, { volume: number; first: TradeEvent; last: TradeEvent }>();
  for (const t of ts) {
    const entry = byPrice.get(t.price) ?? { volume: 0, first: t, last: t };
    entry.volume += t.size;
    entry.last = t;
    byPrice.set(t.price, entry);
  }
  let bestPrice = ts[0].price;
  let best = byPrice.get(bestPrice)!;
  for (const [price, entry] of byPrice) {
    if (entry.volume > best.volume) {
      bestPrice = price;
      best = entry;
    }
  }
  return { price: bestPrice, first: best.first, last: best.last, volume: best.volume };
}

/* --------------------------- the generators --------------------------- */

interface GeneratedScenario {
  feed: SyntheticMarketDataFeed;
  truth: ScenarioTruth;
}

function spring(seed: number, opts?: GenerateScenarioOptions): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "trend-down", trades: 90 },
    { kind: "bid-absorption", trades: 70 },
    { kind: "failed-breakout-down", trades: 100 },
    { kind: "breakout-continuation-up", trades: 80 },
  ];
  const feed = feedFor(seed, plan, opts?.difficulty ?? "BEGINNER", true);
  const ts = trades(feed.events());
  const low = extremeTrade(ts, "min");
  const reclaim = firstTradeAtOrAfter(ts, low.sequence, (t) => t.price >= low.price + 1.5) ?? ts[ts.length - 1];
  return {
    feed,
    truth: {
      pattern: "spring",
      direction: "bullish",
      startEvent: low.sequence,
      endEvent: reclaim.sequence,
      characteristics: [
        "Support gives way on a stop-run of sell stops",
        "Aggressive sellers absorbed by passive bids at the lows",
        "Price reclaims the broken level quickly",
        "Low-of-session prints fail to follow through",
      ],
      confidence: 0.9,
    },
  };
}

function upthrust(seed: number, opts?: GenerateScenarioOptions): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "trend-up", trades: 90 },
    { kind: "ask-absorption", trades: 70 },
    { kind: "failed-breakout-up", trades: 100 },
    { kind: "breakout-continuation-down", trades: 80 },
  ];
  const feed = feedFor(seed, plan, opts?.difficulty ?? "BEGINNER", false);
  const ts = trades(feed.events());
  const high = extremeTrade(ts, "max");
  const failure = firstTradeAtOrAfter(ts, high.sequence, (t) => t.price <= high.price - 1.5) ?? ts[ts.length - 1];
  return {
    feed,
    truth: {
      pattern: "upthrust",
      direction: "bearish",
      startEvent: high.sequence,
      endEvent: failure.sequence,
      characteristics: [
        "Resistance breaks on a buying climax into resting offers",
        "Aggressive buyers absorbed at the highs",
        "Price falls straight back below the broken level",
        "High-of-session prints fail to hold",
      ],
      confidence: 0.9,
    },
  };
}

function absorption(seed: number, opts?: GenerateScenarioOptions): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "aggressive-sell", trades: 60 },
    { kind: "bid-absorption", trades: 110 },
    { kind: "trend-up", trades: 60 },
  ];
  const feed = feedFor(seed, plan, opts?.difficulty ?? "BEGINNER", true);
  const ts = trades(feed.events());
  const level = busiestLevel(ts.slice(40));
  return {
    feed,
    truth: {
      pattern: "absorption",
      direction: "bullish",
      startEvent: level.first.sequence,
      endEvent: level.last.sequence,
      characteristics: [
        `Heaviest volume of the session prints at ${level.price.toFixed(2)}`,
        "Aggressive selling makes almost no downward progress",
        "Passive bids keep refilling the level",
        "Price lifts away once sellers are exhausted",
      ],
      confidence: 0.88,
    },
  };
}

function initiativeBreak(seed: number, opts?: GenerateScenarioOptions): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "rotation", trades: 60 },
    { kind: "breakout-continuation-up", trades: 120 },
    { kind: "trend-up", trades: 60 },
  ];
  const feed = feedFor(seed, plan, opts?.difficulty ?? "BEGINNER", true);
  const ts = trades(feed.events());
  // Range = the balanced warm-up before the break (first 100 trades).
  const range = ts.slice(0, 100);
  const rangeHigh = extremeTrade(range, "max").price;
  const breakTrade = firstTradeAtOrAfter(ts, range[range.length - 1].sequence, (t) => t.price > rangeHigh + 0.5) ?? ts[ts.length - 1];
  return {
    feed,
    truth: {
      pattern: "initiative-break",
      direction: "bullish",
      startEvent: breakTrade.sequence,
      endEvent: ts[ts.length - 1].sequence,
      characteristics: [
        `Range high at ${rangeHigh.toFixed(2)} breaks on initiative buying`,
        "Aggressive buyers lift offers faster than they refill",
        "Cumulative delta expands with the move",
        "Pullbacks are shallow and bought",
      ],
      confidence: 0.92,
    },
  };
}

function responsiveFade(seed: number, opts?: GenerateScenarioOptions): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "trend-up", trades: 90 },
    { kind: "delta-divergence", trades: 80 },
    { kind: "trend-down", trades: 80 },
  ];
  const feed = feedFor(seed, plan, opts?.difficulty ?? "BEGINNER", false);
  const ts = trades(feed.events());
  const high = extremeTrade(ts, "max");
  const fade = firstTradeAtOrAfter(ts, high.sequence, (t) => t.price <= high.price - 1.5) ?? ts[ts.length - 1];
  return {
    feed,
    truth: {
      pattern: "responsive-fade",
      direction: "bearish",
      startEvent: high.sequence,
      endEvent: fade.sequence,
      characteristics: [
        "Price stretches from value while delta stops confirming",
        "New highs print on diminishing aggressor size",
        "Responsive sellers defend the extension",
        "The move folds back toward the session mean",
      ],
      confidence: 0.87,
    },
  };
}

const GENERATORS: Record<FlowScenarioId, (seed: number, opts?: GenerateScenarioOptions) => GeneratedScenario> = {
  spring,
  upthrust,
  absorption,
  "initiative-break": initiativeBreak,
  "responsive-fade": responsiveFade,
};

/** Generate a deterministic scenario feed + hidden truth. */
export function generateScenario(
  id: FlowScenarioId,
  seed: number,
  opts?: GenerateScenarioOptions,
): GeneratedScenario {
  return GENERATORS[id](seed >>> 0, opts);
}

/** Deterministic random pick for the "Any pattern" option. */
export function pickScenarioId(seed: number): FlowScenarioId {
  return FLOW_SCENARIOS[(seed >>> 0) % FLOW_SCENARIOS.length].id;
}
