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
