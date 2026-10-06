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
import { SyntheticMarketDataFeed, type PhaseSpec } from "./synthetic";

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

function spring(seed: number): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "trend-down", trades: 90 },
    { kind: "bid-absorption", trades: 70 },
    { kind: "failed-breakout-down", trades: 100 },
    { kind: "breakout-continuation-up", trades: 80 },
  ];
  const feed = new SyntheticMarketDataFeed({ seed, plan });
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

function upthrust(seed: number): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "trend-up", trades: 90 },
    { kind: "ask-absorption", trades: 70 },
    { kind: "failed-breakout-up", trades: 100 },
    { kind: "breakout-continuation-down", trades: 80 },
  ];
  const feed = new SyntheticMarketDataFeed({ seed, plan });
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

function absorption(seed: number): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "aggressive-sell", trades: 60 },
    { kind: "bid-absorption", trades: 110 },
    { kind: "trend-up", trades: 60 },
  ];
  const feed = new SyntheticMarketDataFeed({ seed, plan });
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

function initiativeBreak(seed: number): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "rotation", trades: 60 },
    { kind: "breakout-continuation-up", trades: 120 },
    { kind: "trend-up", trades: 60 },
  ];
  const feed = new SyntheticMarketDataFeed({ seed, plan });
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

function responsiveFade(seed: number): GeneratedScenario {
  const plan: PhaseSpec[] = [
    { kind: "meander", trades: 40 },
    { kind: "trend-up", trades: 90 },
    { kind: "delta-divergence", trades: 80 },
    { kind: "trend-down", trades: 80 },
  ];
  const feed = new SyntheticMarketDataFeed({ seed, plan });
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

const GENERATORS: Record<FlowScenarioId, (seed: number) => GeneratedScenario> = {
  spring,
  upthrust,
  absorption,
  "initiative-break": initiativeBreak,
  "responsive-fade": responsiveFade,
};

/** Generate a deterministic scenario feed + hidden truth. */
export function generateScenario(id: FlowScenarioId, seed: number): GeneratedScenario {
  return GENERATORS[id](seed >>> 0);
}

/** Deterministic random pick for the "Any pattern" option. */
export function pickScenarioId(seed: number): FlowScenarioId {
  return FLOW_SCENARIOS[(seed >>> 0) % FLOW_SCENARIOS.length].id;
}
