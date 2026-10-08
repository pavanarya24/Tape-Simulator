import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BinanceAdapter,
  type BinanceRawMessage,
} from "../src/flow/ingest";
import { GenericMicrostructureAdapter } from "../src/flow/ingest/generic";
import { RealMarketDataFeed } from "../src/flow/ingest/feed";
import { TrainingEngine } from "../src/flow/training";

const snapshot = (lastUpdateId = 100, symbol = "BTCUSDT"): BinanceRawMessage => ({
  type: "snapshot",
  E: 1000,
  s: symbol,
  lastUpdateId,
  bids: [["60000.00", "2.5"], ["59999.00", "1.0"]],
  asks: [["60001.00", "3.0"], ["60002.00", "1.2"]],
});

describe("Phase 9-Crypto Binance normalization", () => {
  it("parses the checked-in representative BTCUSDT JSONL fixture", () => {
    const raw = readFileSync(resolve(import.meta.dir, "fixtures/binance_btcusdt_representative.jsonl"), "utf8");
    const { events, report } = new BinanceAdapter().normalize(raw, { symbol: "BTCUSDT" });
    expect(events.some((event) => event.kind === "trade")).toBe(true);
    expect(events.some((event) => event.kind === "depth-delta")).toBe(true);
    expect(report.sequenceGapCount).toBe(0);
    expect(report.isValid).toBe(true);
  });

  it("maps aggTrade/trade timestamps, symbol, and buyer-maker aggressor semantics without fabricating match IDs", () => {
    const adapter = new BinanceAdapter();
    const { events, report } = adapter.normalize([
      { e: "aggTrade", E: 1010, T: 1000, s: "btcusdt", a: 77, p: "60000.25", q: "0.5", m: false },
      { e: "trade", E: 1020, T: 1015, s: "BTCUSDT", t: 78, p: "60000.00", q: "1.25", m: true },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "trade", timestamp: 1000, symbol: "BTCUSDT", price: 60000.25, size: 0.5, aggressorSide: "BUY", sequence: 1 });
    expect(events[1]).toMatchObject({ kind: "trade", timestamp: 1015, symbol: "BTCUSDT", aggressorSide: "SELL", sequence: 2 });
    expect(events[0].kind === "trade" ? events[0].matchId : "unexpected").toBeUndefined();
    expect(report.capabilities).toMatchObject({ hasMBO: false, hasOrderCounts: false, hasNanosecondTimestamps: false, hasMatchIds: false, hasAggressor: true });
  });

  it("anchors a snapshot, emits truthful depth deltas, and accepts contiguous Spot updates", () => {
    const adapter = new BinanceAdapter();
    const { events, report } = adapter.normalize([
      snapshot(100),
      { e: "depthUpdate", E: 1100, s: "BTCUSDT", U: 101, u: 102, b: [["60000.00", "3.0"]], a: [["60001.00", "0"]] },
    ], { market: "spot", symbol: "BTCUSDT" });

    expect(events.filter((e) => e.kind === "book-reset")).toHaveLength(1);
    const depth = events.filter((e) => e.kind === "depth-delta");
    expect(depth).toHaveLength(6);
    expect(depth[0]).toMatchObject({ side: "bid", action: "add", price: 60000, size: 2.5, symbol: "BTCUSDT" });
    expect(depth[2]).toMatchObject({ side: "ask", action: "add", price: 60001, size: 3 });
    expect(depth[5]).toMatchObject({ side: "ask", action: "delete", price: 60001, size: 0 });
    expect(depth.every((event) => event.kind === "depth-delta" && event.orderCount === undefined)).toBe(true);
    expect(report.sequenceGapCount).toBe(0);
  });

  it("detects a gap, resets the local book, and requires a new snapshot before recovery", () => {
    const adapter = new BinanceAdapter();
    const { events, report } = adapter.normalize([
      snapshot(100),
      { e: "depthUpdate", E: 1100, s: "BTCUSDT", U: 105, u: 105, b: [["60000.00", "4"]], a: [] },
      { e: "depthUpdate", E: 1110, s: "BTCUSDT", U: 106, u: 106, b: [["60000.00", "5"]], a: [] },
      { type: "snapshot", E: 1200, s: "BTCUSDT", lastUpdateId: 200, bids: [["60100", "1"]], asks: [["60101", "1"]] },
      { e: "depthUpdate", E: 1210, s: "BTCUSDT", U: 201, u: 201, b: [["60100", "2"]], a: [] },
    ]);

    expect(report.sequenceGapCount).toBe(1);
    expect(events.filter((e) => e.kind === "book-reset")).toHaveLength(3);
    expect(events.filter((e) => e.kind === "depth-delta").some((e) => e.kind === "depth-delta" && e.price === 60000 && e.size === 4)).toBe(false);
    expect(events.some((e) => e.kind === "depth-delta" && e.price === 60100 && e.size === 2)).toBe(true);
  });

  it("uses the USDⓈ-M pu chain and emits reset on an explicit reconnect marker", () => {
    const adapter = new BinanceAdapter();
    const { events, report } = adapter.normalize([
      snapshot(500, "ETHUSDT"),
      { e: "depthUpdate", E: 2000, T: 1999, s: "ETHUSDT", U: 501, u: 502, pu: 500, b: [["3000", "1"]], a: [] },
      { type: "reset", E: 2010, s: "ETHUSDT", reason: "reconnect" },
      { e: "depthUpdate", E: 2020, T: 2020, s: "ETHUSDT", U: 503, u: 503, pu: 502, b: [["3000", "2"]], a: [] },
    ], { market: "usdm", symbol: "ETHUSDT" });

    expect(report.sequenceGapCount).toBe(0);
    expect(events.filter((e) => e.kind === "book-reset")).toHaveLength(2);
    expect(events.some((e) => e.kind === "depth-delta" && e.price === 3000 && e.size === 1)).toBe(true);
    expect(events.some((e) => e.kind === "depth-delta" && e.price === 3000 && e.size === 2)).toBe(false);
  });

  it("feeds the unchanged DOM/order-flow/checkpoint engines and remains deterministic", () => {
    const adapter = new BinanceAdapter();
    const raw: BinanceRawMessage[] = [
      snapshot(),
      { e: "aggTrade", E: 1005, T: 1005, s: "BTCUSDT", a: 1, p: "60001", q: "2", m: false },
      { e: "depthUpdate", E: 1100, s: "BTCUSDT", U: 101, u: 101, b: [["60000", "3"]], a: [["60001", "2"]] },
      { e: "aggTrade", E: 1110, T: 1110, s: "BTCUSDT", a: 2, p: "60000", q: "1", m: true },
    ];
    const feedA = adapter.createFeed(raw, { symbol: "BTCUSDT" });
    const feedB = adapter.createFeed(raw, { symbol: "BTCUSDT" });
    const engineA = new TrainingEngine(feedA, null, { checkpointInterval: 2 });
    const engineB = new TrainingEngine(feedB, null, { checkpointInterval: 2 });

    engineA.stepForward(feedA.totalEvents());
    engineB.stepForward(feedB.totalEvents());
    const finalA = engineA.snapshot();
    const finalB = engineB.snapshot();
    expect(finalA.orderFlow.totalVolume).toBe(3);
    expect(finalA.orderFlow.delta).toBe(1);
    expect(finalA.dom.bestBid).toBe(60000);
    expect(finalA.dom.bestAsk).toBe(60001);
    expect(finalB).toEqual(finalA);

    for (const target of [0, 1, 2, 4, feedA.totalEvents()]) {
      engineA.seekTo(target);
      const seek = engineA.snapshot();
      const freshFeed = adapter.createFeed(raw, { symbol: "BTCUSDT" });
      const sequential = new TrainingEngine(freshFeed, null);
      sequential.stepForward(target);
      expect(seek.orderFlow).toEqual(sequential.snapshot().orderFlow);
      expect(seek.dom).toEqual(sequential.snapshot().dom);
    }
  });

  it("normalizes alongside another adapter without changing the shared engine contract", () => {
    const binance = new BinanceAdapter();
    const generic = new GenericMicrostructureAdapter();
    const feedA = binance.createFeed([{ e: "aggTrade", E: 1000, T: 1000, s: "BTCUSDT", a: 1, p: "10", q: "2", m: false }]);
    const feedB = generic.createFeed([{ time: 1000, type: "trade", sym: "ES", px: 10, sz: 2, side: "buy" }]);
    const engineA = new TrainingEngine(feedA, null);
    const engineB = new TrainingEngine(feedB, null);
    engineA.stepForward(1);
    engineB.stepForward(1);
    expect(engineA.snapshot().orderFlow.totalVolume).toBe(engineB.snapshot().orderFlow.totalVolume);
    expect(engineA.snapshot().orderFlow.delta).toBe(engineB.snapshot().orderFlow.delta);
    expect(feedA).toBeInstanceOf(RealMarketDataFeed);
  });
});

describe("Phase 9-Crypto Genuine Binance Public Market Data Certification", () => {
  const genuinePath = resolve(import.meta.dir, "fixtures/binance_btcusdt_genuine.jsonl");
  const metaPath = resolve(import.meta.dir, "fixtures/binance_btcusdt_genuine.meta.json");

  it("authenticates genuine capture metadata (source, market, record counts)", () => {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.source).toContain("Binance Spot Public REST & WebSocket APIs");
    expect(meta.market).toBe("spot");
    expect(meta.symbol).toBe("BTCUSDT");
    expect(meta.records.total).toBeGreaterThan(50);
    expect(meta.records.snapshot).toBe(1);
    expect(meta.records.depthUpdate).toBeGreaterThan(10);
    expect(meta.records.trade).toBeGreaterThan(10);
    expect(meta.gapsDetected).toBe(0);
  });

  it("normalizes genuine Binance Spot data with strict schema validation and 0 sequence gaps", () => {
    const raw = readFileSync(genuinePath, "utf8");
    const adapter = new BinanceAdapter();
    const { events, report } = adapter.normalize(raw, {
      market: "spot",
      symbol: "BTCUSDT",
      strict: true,
    });

    expect(report.isValid).toBe(true);
    expect(report.sequenceGapCount).toBe(0);
    expect(report.rejectedRecords).toHaveLength(0);
    expect(events.length).toBeGreaterThan(500);
    expect(report.tradeCount).toBeGreaterThan(10);
    expect(report.depthCount).toBeGreaterThan(100);
    expect(report.resetCount).toBe(1); // Anchoring snapshot emitted initial reset
  });

  it("verifies symbol propagation, millisecond timestamps, and buyer-maker aggressor mapping", () => {
    const raw = readFileSync(genuinePath, "utf8");
    const adapter = new BinanceAdapter();
    const { events } = adapter.normalize(raw, { market: "spot", symbol: "BTCUSDT", strict: true });

    // Symbol propagation
    expect(events.every((e) => e.symbol === "BTCUSDT")).toBe(true);

    // Millisecond timestamps
    for (const e of events) {
      expect(typeof e.timestamp).toBe("number");
      expect(e.timestamp).toBeGreaterThan(1_000_000_000_000);
      expect(e.timestamp).toBeLessThan(2_500_000_000_000);
    }

    // Buyer-maker aggressor mapping
    const trades = events.filter((e) => e.kind === "trade");
    const buyTrades = trades.filter((t) => (t as any).aggressorSide === "BUY");
    const sellTrades = trades.filter((t) => (t as any).aggressorSide === "SELL");
    expect(buyTrades.length).toBeGreaterThan(0);
    expect(sellTrades.length).toBeGreaterThan(0);
    expect(trades.every((t) => (t as any).aggressorSide === "BUY" || (t as any).aggressorSide === "SELL")).toBe(true);
  });

  it("verifies no fabricated matchId, no fabricated MBO/order counts, and truthful depth actions", () => {
    const raw = readFileSync(genuinePath, "utf8");
    const adapter = new BinanceAdapter();
    const { events } = adapter.normalize(raw, { market: "spot", symbol: "BTCUSDT", strict: true });

    // Match ID honesty: trades must have undefined matchId (never fabricated from t)
    const trades = events.filter((e) => e.kind === "trade");
    for (const trade of trades) {
      expect((trade as any).matchId).toBeUndefined();
    }

    // MBO honesty: depth deltas must never fabricate orderCount or queue positions
    const depthDeltas = events.filter((e) => e.kind === "depth-delta");
    for (const delta of depthDeltas) {
      expect((delta as any).orderCount).toBeUndefined();
    }

    // Depth actions: add, modify, delete all present based on size transitions
    const hasAdd = depthDeltas.some((d) => (d as any).action === "add");
    const hasModify = depthDeltas.some((d) => (d as any).action === "modify");
    const hasDelete = depthDeltas.some((d) => (d as any).action === "delete");
    expect(hasAdd).toBe(true);
    expect(hasModify).toBe(true);
    expect(hasDelete).toBe(true);
  });

  it("replays genuine Binance data through DOM and OrderFlow engines with valid book and tape totals", () => {
    const raw = readFileSync(genuinePath, "utf8");
    const adapter = new BinanceAdapter();
    const feed = adapter.createFeed(raw, { market: "spot", symbol: "BTCUSDT", strict: true });
    const engine = new TrainingEngine(feed, null, { checkpointInterval: 50 });

    engine.stepForward(feed.totalEvents());
    const snap = engine.snapshot();

    // DOM book validity
    expect(snap.dom.bestBid).toBeGreaterThan(0);
    expect(snap.dom.bestAsk).toBeGreaterThan(0);
    expect(snap.dom.bestBid).toBeLessThan(snap.dom.bestAsk);
    expect(snap.dom.spread).toBeCloseTo(0.01, 2);
    expect(snap.dom.bids.length).toBeGreaterThan(0);
    expect(snap.dom.asks.length).toBeGreaterThan(0);

    // Order flow totals
    expect(snap.orderFlow.totalVolume).toBeGreaterThan(0);
    expect(snap.orderFlow.totalBuyVolume).toBeGreaterThan(0);
    expect(snap.orderFlow.totalSellVolume).toBeGreaterThan(0);
    expect(snap.orderFlow.tape.length).toBeGreaterThan(0);
    expect(snap.orderFlow.totalVolume).toBeCloseTo(
      snap.orderFlow.totalBuyVolume + snap.orderFlow.totalSellVolume,
      6,
    );
  });

  it("guarantees 100% determinism and checkpoint seek equivalence on genuine Binance data", () => {
    const raw = readFileSync(genuinePath, "utf8");
    const adapter = new BinanceAdapter();
    const feedA = adapter.createFeed(raw, { market: "spot", symbol: "BTCUSDT", strict: true });
    const feedB = adapter.createFeed(raw, { market: "spot", symbol: "BTCUSDT", strict: true });

    const engineA = new TrainingEngine(feedA, null, { checkpointInterval: 50 });
    const engineB = new TrainingEngine(feedB, null, { checkpointInterval: 50 });

    engineA.stepForward(feedA.totalEvents());
    engineB.stepForward(feedB.totalEvents());

    // Deterministic replay
    expect(engineA.snapshot().dom).toEqual(engineB.snapshot().dom);
    expect(engineA.snapshot().orderFlow).toEqual(engineB.snapshot().orderFlow);

    // Checkpoint seek equivalence at multiple targets across checkpoints
    const targets = [0, 1, 10, 50, 100, 250, 500, 1000, feedA.totalEvents()];
    for (const target of targets) {
      engineA.seekTo(target);
      const seekSnap = engineA.snapshot();

      const freshEngine = new TrainingEngine(
        adapter.createFeed(raw, { market: "spot", symbol: "BTCUSDT", strict: true }),
        null,
      );
      freshEngine.stepForward(target);
      const seqSnap = freshEngine.snapshot();

      expect(seekSnap.orderFlow).toEqual(seqSnap.orderFlow);
      expect(seekSnap.dom).toEqual(seqSnap.dom);
    }
  });
});

