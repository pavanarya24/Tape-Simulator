/**
 * Phase 6 — Synthetic order-flow engine validation.
 *
 * Covers: deterministic generation, timestamp ordering, trade sequencing,
 * aggressor-side preservation, delta, CVD, volume-at-price, L2 reconstruction,
 * bid/ask imbalance, stacking, pulling, replenishment, sweep detection, each of
 * the five scenario generators, blind-mode truth isolation, reveal behaviour
 * and reset/replay determinism.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { L2Event, MarketEvent, TradeEvent } from "../src/flow/events";
import { SyntheticMarketDataFeed, defaultPlan } from "../src/flow/synthetic";
import type { MarketDataFeed } from "../src/flow/feed";
import { OrderFlowEngine } from "../src/flow/orderFlow";
import { DOMEngine, STACK_MULT, PULL_DROP, SWEEP_MULT } from "../src/flow/dom";
import {
  FLOW_SCENARIOS,
  generateScenario,
  pickScenarioId,
  type FlowScenarioId,
} from "../src/flow/scenarios";
import { TrainingEngine } from "../src/flow/training";

/* ------------------------------ helpers ------------------------------ */

function mkL2(
  sequence: number,
  timestamp: number,
  bidTop: number,
  askTop: number,
  bidSizes: number[],
  askSizes: number[],
): L2Event {
  return {
    kind: "l2",
    timestamp,
    sequence,
    bids: bidSizes.map((size, i) => ({
      price: +(bidTop - i * 0.25).toFixed(2),
      size,
      orderCount: Math.max(1, Math.round(size / 40)),
    })),
    asks: askSizes.map((size, i) => ({
      price: +(askTop + i * 0.25).toFixed(2),
      size,
      orderCount: Math.max(1, Math.round(size / 40)),
    })),
  };
}

function mkTrade(
  sequence: number,
  timestamp: number,
  price: number,
  size: number,
  aggressorSide: TradeEvent["aggressorSide"],
): TradeEvent {
  return { kind: "trade", timestamp, price, size, aggressorSide, sequence };
}

function consume(feed: MarketDataFeed): MarketEvent[] {
  const out: MarketEvent[] = [];
  while (feed.hasNext()) {
    const ev = feed.nextEvent();
    if (!ev) break;
    out.push(ev);
  }
  return out;
}

const SEED_A = 1234567;
const SEED_B = 7654321;

/* --------------------- feed: determinism & shape --------------------- */

describe("SyntheticMarketDataFeed", () => {
  test("same seed produces byte-identical event streams", () => {
    const a = new SyntheticMarketDataFeed({ seed: SEED_A });
    const b = new SyntheticMarketDataFeed({ seed: SEED_A });
    expect(a.totalEvents()).toBe(b.totalEvents());
    expect(JSON.stringify(a.events())).toBe(JSON.stringify(b.events()));
  });

  test("different seeds produce different streams", () => {
    const a = new SyntheticMarketDataFeed({ seed: SEED_A });
    const b = new SyntheticMarketDataFeed({ seed: SEED_B });
    expect(JSON.stringify(a.events())).not.toBe(JSON.stringify(b.events()));
  });

  test("timestamps are non-decreasing and sequences are dense & strictly increasing", () => {
    const feed = new SyntheticMarketDataFeed({ seed: SEED_A });
    const events = feed.events();
    expect(events.length).toBeGreaterThan(500);
    let prevTs = -Infinity;
    events.forEach((ev, i) => {
      expect(ev.timestamp).toBeGreaterThanOrEqual(prevTs);
      expect(ev.sequence).toBe(i + 1);
      prevTs = ev.timestamp;
    });
  });

  test("the stream is a genuine mixed feed: book reset, trades and 10×10 L2 snapshots", () => {
    const feed = new SyntheticMarketDataFeed({ seed: SEED_A });
    const events = feed.events();
    expect(events[0].kind).toBe("book-reset");
    const trades = events.filter((e): e is TradeEvent => e.kind === "trade");
    const l2 = events.filter((e): e is L2Event => e.kind === "l2");
    expect(trades.length).toBeGreaterThan(300);
    expect(l2.length).toBeGreaterThan(80);
    for (const snap of l2) {
      expect(snap.bids.length).toBe(10);
      expect(snap.asks.length).toBe(10);
      expect(snap.bids[0].price).toBeGreaterThan(snap.bids[9].price);
      expect(snap.asks[0].price).toBeLessThan(snap.asks[9].price);
      expect(snap.bids[0].price).toBeLessThan(snap.asks[0].price);
    }
    // Trades always carry an explicit aggressor (never inferred downstream).
    expect(trades.every((t) => t.aggressorSide === "BUY" || t.aggressorSide === "SELL")).toBe(true);
    expect(trades.some((t) => t.aggressorSide === "BUY")).toBe(true);
    expect(trades.some((t) => t.aggressorSide === "SELL")).toBe(true);
  });

  test("interface: hasNext / nextEvent / currentTimestamp / seek / position / reset", () => {
    const feed = new SyntheticMarketDataFeed({ seed: SEED_B });
    expect(feed.source).toBe("Synthetic Training Data");
    expect(feed.isRealData).toBe(false);
    expect(feed.hasNext()).toBe(true);
    expect(feed.currentTimestamp()).toBe(feed.events()[0].timestamp);

    const first = feed.nextEvent();
    expect(first!.sequence).toBe(1);
    expect(feed.position()).toBe(2);

    expect(feed.seek(10)).toBe(true);
    expect(feed.position()).toBe(10);
    expect(feed.nextEvent()!.sequence).toBe(10);
    expect(feed.seek(0)).toBe(false);
    expect(feed.seek(feed.totalEvents() + 1)).toBe(false);

    feed.reset();
    expect(feed.position()).toBe(1);
    expect(feed.nextEvent()!.sequence).toBe(1);

    while (feed.hasNext()) feed.nextEvent();
    expect(feed.hasNext()).toBe(false);
    expect(feed.nextEvent()).toBeNull();
    expect(feed.currentTimestamp()).toBeNull();
  });

  test("the default plan exercises trending, rotation, volatility, aggression, liquidity and breakout regimes", () => {
    const kinds = new Set(defaultPlan().map((p) => p.kind));
    for (const required of [
      "trend-up", "trend-down", "rotation", "vol-expansion", "vol-contraction",
      "aggressive-buy", "aggressive-sell", "replenish", "pull",
      "bid-absorption", "ask-absorption", "sweep-buys", "sweep-sells",
      "delta-divergence", "failed-breakout-up", "failed-breakout-down",
      "breakout-continuation-up", "breakout-continuation-down",
    ] as const) {
      expect(kinds.has(required)).toBe(true);
    }
  });
});

/* ---------------------------- OrderFlowEngine ---------------------------- */

describe("OrderFlowEngine", () => {
  function run(events: readonly MarketEvent[]): OrderFlowEngine {
    const engine = new OrderFlowEngine();
    for (const ev of events) engine.processEvent(ev);
    return engine;
  }

  test("delta and CVD derive strictly from aggressor sides", () => {
    const engine = run([
      mkTrade(1, 1000, 18000.0, 10, "BUY"),
      mkTrade(2, 2000, 18000.25, 4, "SELL"),
      mkTrade(3, 3000, 18000.0, 6, "BUY"),
      mkTrade(4, 4000, 17999.75, 3, "SELL"),
    ]);
    const s = engine.snapshot();
    expect(s.totalBuyVolume).toBe(16);
    expect(s.totalSellVolume).toBe(7);
    expect(s.delta).toBe(9);
    expect(s.cumulativeDelta).toBe(9);
    expect(s.cvdSeries).toEqual([10, 6, 12, 9]);
    expect(s.tradeCount).toBe(4);
    expect(s.buyAggressionPct + s.sellAggressionPct).toBeCloseTo(100, 6);
  });

  test("aggressor sides are preserved exactly — never inferred from price direction", () => {
    // Price RISES on a sell, falls on a buy, and one print is UNKNOWN:
    // sides must pass through untouched.
    const engine = run([
      mkTrade(1, 1000, 18000.0, 5, "SELL"),
      mkTrade(2, 2000, 18001.0, 7, "BUY"),
      mkTrade(3, 3000, 17999.0, 3, "UNKNOWN"),
      mkTrade(4, 4000, 17998.0, 9, "BUY"),
    ]);
    const s = engine.snapshot();
    expect(s.sellCount).toBe(1);
    expect(s.buyCount).toBe(2);
    expect(s.unknownCount).toBe(1);
    expect(s.totalBuyVolume).toBe(16);
    expect(s.totalSellVolume).toBe(5);
    expect(s.delta).toBe(11); // UNKNOWN adds nothing — no side is invented
  });

  test("volume at price buckets per side and sums to total volume", () => {
    const engine = run([
      mkTrade(1, 1000, 18000.0, 10, "BUY"),
      mkTrade(2, 2000, 18000.0, 5, "SELL"),
      mkTrade(3, 3000, 18000.25, 8, "BUY"),
      mkTrade(4, 4000, 17999.75, 4, "SELL"),
    ]);
    const s = engine.snapshot();
    const sum = s.volumeAtPrice.reduce((acc, b) => acc + b.total, 0);
    expect(sum).toBe(s.totalVolume);
    const atZero = s.volumeAtPrice.find((b) => b.price === 18000.0);
    expect(atZero).toEqual({ price: 18000.0, buy: 10, sell: 5, total: 15 });
    const prices = s.volumeAtPrice.map((b) => b.price);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  test("spread, microprice and imbalance come from the latest book", () => {
    const engine = run([
      mkL2(1, 1000, 18000.0, 18000.25, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100], [300, 300, 300, 300, 300, 300, 300, 300, 300, 300]),
    ]);
    const s = engine.snapshot();
    expect(s.spread).toBe(0.25);
    expect(s.bidAskImbalance).toBe(-0.5); // 1000 vs 3000 liquidity
    expect(s.microprice).toBeCloseTo(18000.0 * 0.25 + 18000.25 * 0.75, 1);
  });

  test("realistic feed: delta matches a manual recomputation over all trades", () => {
    const feed = new SyntheticMarketDataFeed({ seed: SEED_A });
    const engine = run(feed.events());
    let buy = 0;
    let sell = 0;
    for (const ev of feed.events()) {
      if (ev.kind !== "trade") continue;
      if (ev.aggressorSide === "BUY") buy += ev.size;
      else if (ev.aggressorSide === "SELL") sell += ev.size;
    }
    const s = engine.snapshot();
    expect(s.totalBuyVolume).toBe(buy);
    expect(s.totalSellVolume).toBe(sell);
    expect(s.delta).toBe(buy - sell);
    expect(s.cumulativeDelta).toBe(buy - sell);
    expect(s.volumeAtPrice.reduce((a, b) => a + b.total, 0)).toBe(buy + sell);
    expect(s.largestTrades.length).toBeGreaterThan(0);
    const sizes = s.largestTrades.map((t) => t.size);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(s.velocityPerMin).toBeGreaterThanOrEqual(0);
    expect(s.tape.length).toBeGreaterThan(0);
  });
});

/* ------------------------------ DOMEngine ------------------------------ */

describe("DOMEngine", () => {
  const uniform = (v: number) => Array.from({ length: 10 }, () => v);

  test("L2 reconstruction: the maintained book equals the last snapshot exactly", () => {
    const engine = new DOMEngine();
    engine.processEvent(mkL2(1, 1000, 18000.0, 18000.25, uniform(120), uniform(90)));
    engine.processEvent(mkL2(2, 2000, 17999.75, 18000.0, uniform(140), uniform(110)));
    const s = engine.snapshot();
    expect(s.hasBook).toBe(true);
    expect(s.bestBid).toBe(17999.75);
    expect(s.bestAsk).toBe(18000.0);
    expect(s.bids.length).toBe(10);
    expect(s.asks.length).toBe(10);
    expect(s.bids[0]).toEqual({ price: 17999.75, size: 140, orderCount: 4 });
    expect(s.asks[9].price).toBe(18000.0 + 9 * 0.25);
    expect(s.topOfBookChanges).toBe(2); // both best prices moved
  });

  test("BookResetEvent clears the maintained book", () => {
    const engine = new DOMEngine();
    engine.processEvent(mkL2(1, 1000, 18000.0, 18000.25, uniform(120), uniform(90)));
    engine.processEvent({ kind: "book-reset", timestamp: 1500, sequence: 2 });
    const s = engine.snapshot();
    expect(s.hasBook).toBe(false);
    expect(s.bids).toEqual([]);
    expect(s.asks).toEqual([]);
    expect(s.imbalance).toBeNull();
  });

  test("bid/ask imbalance uses total side liquidity", () => {
    const engine = new DOMEngine();
    engine.processEvent(mkL2(1, 1000, 18000.0, 18000.25, uniform(100), uniform(300)));
    const s = engine.snapshot();
    expect(s.totalBidLiquidity).toBe(1000);
    expect(s.totalAskLiquidity).toBe(3000);
    expect(s.imbalance).toBe(-0.5);
  });

  test("stacking: oversized levels are counted per side", () => {
    const engine = new DOMEngine();
    // bid top 900 vs side average 190 → ≥ STACK_MULT × avg → 1 stacked level.
    const bids = [900, 100, 100, 100, 100, 100, 100, 100, 100, 100];
    engine.processEvent(mkL2(1, 1000, 18000.0, 18000.25, bids, uniform(100)));
    const s = engine.snapshot();
    expect(s.stackBidLevels).toBe(1);
    expect(s.stackAskLevels).toBe(0);
    expect(900).toBeGreaterThanOrEqual(190 * STACK_MULT);
  });

  test("pulling: a top-of-book size collapse is counted; refill is replenishment", () => {
    const engine = new DOMEngine();
    engine.processEvent(mkL2(1, 1000, 18000.0, 18000.25, [400, 100, 100, 100, 100, 100, 100, 100, 100, 100], uniform(100)));
    // 400 → 150 is a 62.5% drop ≥ PULL_DROP.
    engine.processEvent(mkL2(2, 2000, 18000.0, 18000.25, [150, 100, 100, 100, 100, 100, 100, 100, 100, 100], uniform(100)));
    let s = engine.snapshot();
    expect(s.pullBidCount).toBe(1);
    expect(s.pullAskCount).toBe(0);
    expect(1 - 150 / 400).toBeGreaterThanOrEqual(PULL_DROP);
    expect(s.replenishCount).toBe(0);
    // Refill back to the pre-pull size → replenishment.
    engine.processEvent(mkL2(3, 3000, 18000.0, 18000.25, [420, 100, 100, 100, 100, 100, 100, 100, 100, 100], uniform(100)));
    s = engine.snapshot();
    expect(s.replenishCount).toBe(1);
    expect(s.pullBidCount).toBe(1);
  });

  test("sweeps: only trades that clear the displayed size at the level count", () => {
    const engine = new DOMEngine();
    engine.processEvent(mkL2(1, 1000, 18000.0, 18000.25, uniform(8), uniform(10)));
    // Too-small lift, and a large sell that never reaches the bid: no sweeps.
    engine.processEvent(mkTrade(2, 1100, 18000.25, 5, "BUY"));
    engine.processEvent(mkTrade(3, 1200, 18000.5, 50, "SELL"));
    let s = engine.snapshot();
    expect(s.sweepBuyCount).toBe(0);
    expect(s.sweepSellCount).toBe(0);
    // BUY lifting an offer ≥ SWEEP_MULT × displayed ask size (3 × 10 = 30).
    engine.processEvent(mkTrade(4, 1300, 18000.25, 30, "BUY"));
    // SELL hitting a bid of size 8 (3 × 8 = 24).
    engine.processEvent(mkTrade(5, 1400, 18000.0, 24, "SELL"));
    s = engine.snapshot();
    expect(s.sweepBuyCount).toBe(1);
    expect(s.sweepSellCount).toBe(1);
    expect(30).toBeGreaterThanOrEqual(10 * SWEEP_MULT);
    expect(s.recentEvents.some((e) => e.type === "sweep-buy")).toBe(true);
  });

  test("the realistic synthetic stream produces book activity (pulls, replenishments, sweeps)", () => {
    const feed = new SyntheticMarketDataFeed({ seed: SEED_A });
    const engine = new DOMEngine();
    for (const ev of feed.events()) engine.processEvent(ev);
    const s = engine.snapshot();
    expect(s.hasBook).toBe(true);
    expect(s.pullBidCount + s.pullAskCount).toBeGreaterThan(0);
    expect(s.replenishCount).toBeGreaterThan(0);
    expect(s.sweepBuyCount + s.sweepSellCount).toBeGreaterThan(0);
    expect(s.imbalance).not.toBeNull();
  });
});

/* ------------------------- scenario generators ------------------------- */

describe("scenario generators", () => {
  const EXPECTED: Record<FlowScenarioId, "bullish" | "bearish"> = {
    spring: "bullish",
    upthrust: "bearish",
    absorption: "bullish",
    "initiative-break": "bullish",
    "responsive-fade": "bearish",
  };

  for (const meta of FLOW_SCENARIOS) {
    test(`${meta.name}: deterministic truth with an ordered key window`, () => {
      const one = generateScenario(meta.id, 42);
      const two = generateScenario(meta.id, 42);
      expect(one.truth).toEqual(two.truth);
      expect(JSON.stringify(one.feed.events())).toBe(JSON.stringify(two.feed.events()));

      const t = one.truth;
      expect(t.pattern).toBe(meta.id);
      expect(t.direction).toBe(EXPECTED[meta.id]);
      expect(t.startEvent).toBeGreaterThanOrEqual(1);
      expect(t.endEvent).toBeGreaterThanOrEqual(t.startEvent);
      expect(t.endEvent).toBeLessThanOrEqual(one.feed.totalEvents());
      expect(t.characteristics.length).toBeGreaterThanOrEqual(3);
      expect(t.confidence).toBeGreaterThan(0);
      expect(t.confidence).toBeLessThanOrEqual(1);
      // The pattern name is the generator's business — events never encode it.
      expect(JSON.stringify(one.feed.events())).not.toContain(meta.id);
    });

    test(`${meta.name}: feeds through the pipeline into working analytics`, () => {
      const { feed } = generateScenario(meta.id, 99);
      const of = new OrderFlowEngine();
      const dom = new DOMEngine();
      for (const ev of feed.events()) {
        of.processEvent(ev);
        dom.processEvent(ev);
      }
      const s = of.snapshot();
      // Smallest plan (absorption) has 270 trades; every scenario is substantial.
      expect(s.tradeCount).toBeGreaterThan(200);
      expect(s.totalVolume).toBeGreaterThan(0);
      expect(s.delta).toBe(s.totalBuyVolume - s.totalSellVolume);
      expect(dom.snapshot().hasBook).toBe(true);
    });
  }

  test("different seeds give different paths for the same pattern", () => {
    const a = generateScenario("spring", 1);
    const b = generateScenario("spring", 2);
    expect(JSON.stringify(a.feed.events())).not.toBe(JSON.stringify(b.feed.events()));
  });

  test("Any-pattern picker is deterministic per seed", () => {
    expect(pickScenarioId(7)).toBe(pickScenarioId(7));
    const picks = new Set(Array.from({ length: 50 }, (_, i) => pickScenarioId(i)));
    expect(picks.size).toBeGreaterThan(1);
    for (const p of picks) expect(FLOW_SCENARIOS.some((m) => m.id === p)).toBe(true);
  });
});

/* -------------------- TrainingEngine: blindness & replay -------------------- */

describe("TrainingEngine", () => {
  const PATTERN_WORDS = [
    "spring",
    "upthrust",
    "absorption",
    "initiative",
    "responsive",
    "confidence",
    "characteristics",
    "startEvent",
    "endEvent",
    "truth",
  ];

  test("blind snapshot contains price/tape/CVD/profile/DOM but NO truth", () => {
    const { feed, truth } = generateScenario("spring", 5);
    const engine = new TrainingEngine(feed, truth);
    engine.stepForward(150);
    const snap = engine.snapshot();

    // What the trader IS allowed to see:
    expect(snap.source).toBe("Synthetic Training Data");
    expect(snap.isRealData).toBe(false);
    expect(snap.eventIndex).toBe(150);
    expect(snap.priceSeries.length).toBeGreaterThan(0);
    expect(snap.orderFlow.tape.length).toBeGreaterThan(0);
    expect(snap.orderFlow.cvdSeries.length).toBeGreaterThan(0);
    expect(snap.orderFlow.volumeAtPrice.length).toBeGreaterThan(0);
    expect(snap.dom.hasBook).toBe(true);

    // What the trader must NEVER see before reveal:
    const json = JSON.stringify(snap);
    for (const word of PATTERN_WORDS) expect(json.toLowerCase()).not.toContain(word);
    expect("pattern" in snap).toBe(false);
    expect("revealed" in snap).toBe(false);
  });

  test("reveal() is the only path to the truth and returns exactly the generator's truth", () => {
    const { feed, truth } = generateScenario("upthrust", 11);
    const engine = new TrainingEngine(feed, truth);
    engine.stepForward(50);
    expect(JSON.stringify(engine.snapshot())).not.toContain("upthrust");
    expect(engine.reveal()).toEqual(truth);
    expect(engine.reveal()!.pattern).toBe("upthrust");
  });

  test("reveal(null) stays null for engine instances without a scenario", () => {
    const feed = new SyntheticMarketDataFeed({ seed: 5 });
    const engine = new TrainingEngine(feed);
    expect(engine.reveal()).toBeNull();
  });

  test("reset / replay determinism: identical positions give identical snapshots", () => {
    const first = generateScenario("absorption", 31);
    const engine = new TrainingEngine(first.feed, first.truth);
    engine.stepForward(120);
    const before = JSON.stringify(engine.snapshot());

    engine.reset();
    const empty = engine.snapshot();
    expect(empty.eventIndex).toBe(0);
    expect(empty.orderFlow.tape).toEqual([]);
    expect(empty.orderFlow.delta).toBe(0);
    expect(empty.dom.hasBook).toBe(false);

    engine.stepForward(120);
    expect(JSON.stringify(engine.snapshot())).toBe(before);

    // Seek (stepBack path) rebuilds to exactly the same state.
    engine.seekTo(60);
    engine.stepForward(60);
    expect(JSON.stringify(engine.snapshot())).toBe(before);
  });

  test("stepForward stops at the end of the feed", () => {
    const { feed, truth } = generateScenario("responsive-fade", 3);
    const engine = new TrainingEngine(feed, truth);
    const taken = engine.stepForward(feed.totalEvents() + 100);
    expect(taken).toBe(feed.totalEvents());
    const snap = engine.snapshot();
    expect(snap.atEnd).toBe(true);
    expect(snap.eventIndex).toBe(snap.totalEvents);
  });
});

/* --------------- controller-level blind isolation & reveal --------------- */

describe("controller flow session", () => {
  let controller: import("../src/state/app").TapeLabController;

  beforeAll(async () => {
    // Same browser-global stubs as controller.test.ts (idempotent if loaded).
    (globalThis as Record<string, unknown>).indexedDB = {
      open() {
        throw new Error("IndexedDB unavailable (simulated)");
      },
    };
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
    const mod = await import("../src/state/app");
    controller = mod.controller;
    await controller.initialize(); // idempotent — cached promise if already run
  });

  test("a fresh session hides the truth in UI state; reveal exposes it", () => {
    controller.generateFlowScenario("spring");
    let flow = controller.getState().flow;
    expect(flow.active).toBe(true);
    expect(flow.revealed).toBeNull();
    expect(flow.source).toBe("Synthetic Training Data");
    expect(flow.isRealData).toBe(false);

    const json = JSON.stringify(flow).toLowerCase();
    for (const word of ["spring", "upthrust", "absorption", "initiative", "responsive", "confidence", "characteristics", "startEvent"]) {
      expect(json).not.toContain(word);
    }

    controller.revealFlow();
    flow = controller.getState().flow;
    expect(flow.revealed).not.toBeNull();
    expect(flow.revealed!.pattern).toBe("spring");
    expect(flow.revealed!.direction).toBe("bullish");
  });

  test("stepFlow advances the event cursor and resetFlow rewinds it", () => {
    controller.generateFlowScenario("upthrust");
    const start = controller.getState().flow.eventIndex;
    expect(start).toBeGreaterThan(0); // warm-up reveals initial context
    expect(controller.stepFlow(25)).toBe(true);
    expect(controller.getState().flow.eventIndex).toBe(start + 25);
    controller.resetFlow();
    expect(controller.getState().flow.eventIndex).toBe(0);
    expect(controller.getState().flow.revealed).toBeNull();
  });

  test("the Any-pattern option also generates a blind-safe session", () => {
    controller.generateFlowScenario("any");
    const flow = controller.getState().flow;
    expect(flow.active).toBe(true);
    expect(flow.revealed).toBeNull();
    expect(JSON.stringify(flow)).not.toContain("\"pattern\"");
  });
});
