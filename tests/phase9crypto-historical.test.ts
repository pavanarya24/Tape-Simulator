import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BinanceAdapter,
  type BinanceRawMessage,
  type BinanceRestAggTradeMessage,
  type BinanceRestTradeMessage,
} from "../src/flow/ingest";
import { DatabentoAdapter } from "../src/flow/ingest/databento";
import { GenericMicrostructureAdapter } from "../src/flow/ingest/generic";
import { RealMarketDataFeed } from "../src/flow/ingest/feed";
import { TrainingEngine } from "../src/flow/training";

describe("Phase 9-Crypto.2 Historical Microstructure Replay & Scale", () => {
  const spotCsvPath = resolve(import.meta.dir, "fixtures/binance_btcusdt_spot_historical_slice.csv");
  const futuresCsvPath = resolve(import.meta.dir, "fixtures/binance_btcusdt_futures_historical_slice.csv");

  it("normalizes genuine historical Spot aggTrades CSV from data.binance.vision", () => {
    const rawCsv = readFileSync(spotCsvPath, "utf8");
    const adapter = new BinanceAdapter();
    const { events, report } = adapter.normalize(rawCsv, {
      market: "spot",
      symbol: "BTCUSDT",
      strict: true,
    });

    expect(report.isValid).toBe(true);
    expect(report.sequenceGapCount).toBe(0);
    expect(report.rejectedRecords).toHaveLength(0);
    expect(events).toHaveLength(500);
    expect(report.tradeCount).toBe(500);

    const first = events[0] as any;
    expect(first.kind).toBe("trade");
    expect(first.symbol).toBe("BTCUSDT");
    expect(first.price).toBe(60672.01);
    expect(first.size).toBe(0.00147);
    expect(first.timestamp).toBe(1714521600000); // 2024-05-01 00:00:00 UTC
    expect(first.aggressorSide).toBe("BUY"); // is_buyer_maker = False -> BUY aggressor
    expect(first.matchId).toBeUndefined(); // never fabricate matchId from agg_trade_id
  });

  it("normalizes genuine historical USDⓈ-M Futures aggTrades CSV with header skipping", () => {
    const rawCsv = readFileSync(futuresCsvPath, "utf8");
    const adapter = new BinanceAdapter();
    const { events, report } = adapter.normalize(rawCsv, {
      market: "usdm",
      symbol: "BTCUSDT",
      strict: true,
    });

    expect(report.isValid).toBe(true);
    expect(report.sequenceGapCount).toBe(0);
    expect(report.rejectedRecords).toHaveLength(0);
    expect(events).toHaveLength(500);
    expect(report.tradeCount).toBe(500);

    const first = events[0] as any;
    expect(first.kind).toBe("trade");
    expect(first.symbol).toBe("BTCUSDT");
    expect(first.price).toBe(60651.2);
    expect(first.size).toBe(0.017);
    expect(first.timestamp).toBe(1714521600017);
    expect(first.aggressorSide).toBe("BUY");
    expect(first.matchId).toBeUndefined();
  });

  it("normalizes REST API aggTrades and trades JSON arrays without fabricating matchId", () => {
    const adapter = new BinanceAdapter();

    // 1. REST aggTrades array
    const restAgg: BinanceRestAggTradeMessage[] = [
      { a: 1001, p: "65000.50", q: "0.25", T: 1714521600100, m: false }, // BUY
      { a: 1002, p: "65000.25", q: "0.75", T: 1714521600200, m: true }, // SELL
    ];
    const { events: aggEvents, report: aggReport } = adapter.normalize(restAgg, { symbol: "BTCUSDT" });
    expect(aggReport.isValid).toBe(true);
    expect(aggEvents).toHaveLength(2);
    expect((aggEvents[0] as any).aggressorSide).toBe("BUY");
    expect((aggEvents[1] as any).aggressorSide).toBe("SELL");
    expect((aggEvents[0] as any).matchId).toBeUndefined();

    // 2. REST trades array
    const restTrades: BinanceRestTradeMessage[] = [
      { id: 2001, price: "65000.00", qty: "1.50", time: 1714521600300, isBuyerMaker: true }, // SELL
      { id: 2002, price: "65000.50", qty: "0.50", time: 1714521600400, isBuyerMaker: false }, // BUY
    ];
    const { events: tradeEvents, report: tradeReport } = adapter.normalize(restTrades, { symbol: "BTCUSDT" });
    expect(tradeReport.isValid).toBe(true);
    expect(tradeEvents).toHaveLength(2);
    expect((tradeEvents[0] as any).aggressorSide).toBe("SELL");
    expect((tradeEvents[1] as any).aggressorSide).toBe("BUY");
    expect((tradeEvents[0] as any).matchId).toBeUndefined();
  });

  it("handles duplicate detection on historical feeds", () => {
    const adapter = new BinanceAdapter();
    const rows = [
      "2991883277,60672.01000000,0.00147000,3580522188,3580522188,1714521600000,False,True",
      "2991883277,60672.01000000,0.00147000,3580522188,3580522188,1714521600000,False,True", // exact dupe
    ].join("\n");

    const { events, report } = adapter.normalize(rows, { symbol: "BTCUSDT" });
    expect(events).toHaveLength(2); // Sequence is assigned sequentially per record
    expect(report.isValid).toBe(true);
  });

  it("handles sequence gap and recovery with book-reset", () => {
    const adapter = new BinanceAdapter();
    const records: BinanceRawMessage[] = [
      { type: "snapshot", E: 1000, s: "BTCUSDT", lastUpdateId: 100, bids: [["60000", "1"]], asks: [["60001", "1"]] },
      // Contiguous update
      { e: "depthUpdate", E: 1100, s: "BTCUSDT", U: 101, u: 102, b: [["60000", "2"]], a: [] },
      // Gap: expects 103, but receives U=110, u=112
      { e: "depthUpdate", E: 1200, s: "BTCUSDT", U: 110, u: 112, b: [["60000", "3"]], a: [] },
      // Recovery snapshot
      { type: "snapshot", E: 1300, s: "BTCUSDT", lastUpdateId: 200, bids: [["60005", "1"]], asks: [["60006", "1"]] },
      { e: "depthUpdate", E: 1400, s: "BTCUSDT", U: 201, u: 201, b: [["60005", "4"]], a: [] },
    ];

    const { events, report } = adapter.normalize(records, { market: "spot", symbol: "BTCUSDT" });
    expect(report.sequenceGapCount).toBe(1);
    expect(events.filter((e) => e.kind === "book-reset")).toHaveLength(3); // init snap, gap reset, recovery snap
  });

  it("replays historical data through TrainingEngine with deterministic checkpoint seek equivalence", () => {
    const rawCsv = readFileSync(spotCsvPath, "utf8");
    const adapter = new BinanceAdapter();
    const feed = adapter.createFeed(rawCsv, { market: "spot", symbol: "BTCUSDT" });

    const engineA = new TrainingEngine(feed, null, { checkpointInterval: 50 });
    const engineB = new TrainingEngine(adapter.createFeed(rawCsv, { market: "spot", symbol: "BTCUSDT" }), null, { checkpointInterval: 50 });

    engineA.stepForward(feed.totalEvents());
    engineB.stepForward(feed.totalEvents());

    // Deterministic replay equivalence across runs
    expect(engineA.snapshot().orderFlow.totalVolume).toBe(engineB.snapshot().orderFlow.totalVolume);
    expect(engineA.snapshot().orderFlow.delta).toBe(engineB.snapshot().orderFlow.delta);
    expect(engineA.snapshot().orderFlow.tradeCount).toBe(500);

    // Accelerated seek equivalence against sequential execution
    const targets = [0, 1, 49, 50, 51, 149, 250, 399, 500];
    for (const target of targets) {
      engineA.seekTo(target);
      const seekSnap = engineA.snapshot();

      const freshEngine = new TrainingEngine(adapter.createFeed(rawCsv, { market: "spot", symbol: "BTCUSDT" }), null);
      freshEngine.stepForward(target);
      const seqSnap = freshEngine.snapshot();

      expect(seekSnap.orderFlow.totalVolume).toBe(seqSnap.orderFlow.totalVolume);
      expect(seekSnap.orderFlow.delta).toBe(seqSnap.orderFlow.delta);
      expect(seekSnap.orderFlow.tradeCount).toBe(seqSnap.orderFlow.tradeCount);
      expect(seekSnap.orderFlow.tape.length).toBe(seqSnap.orderFlow.tape.length);
    }
  });

  it("handles blind-mode replay on historical crypto data without leakage", () => {
    const rawCsv = readFileSync(spotCsvPath, "utf8");
    const adapter = new BinanceAdapter();
    const feed = adapter.createFeed(rawCsv, { market: "spot", symbol: "BTCUSDT" });

    // TrainingEngine with blind mode: truth remains private
    const engine = new TrainingEngine(feed, null);
    engine.stepForward(50);
    const snap = engine.snapshot();

    expect((snap as any).truth).toBeUndefined(); // snapshot is blind-safe
    expect(engine.reveal()).toBeNull();
    expect(snap.orderFlow.tradeCount).toBe(50);
    expect(snap.orderFlow.totalVolume).toBeGreaterThan(0);
  });

  it("rejects malformed records gracefully in non-strict mode and throws in strict mode", () => {
    const adapter = new BinanceAdapter();
    const malformedCsv = [
      "2991883277,60672.01,0.00147,3580522188,3580522188,1714521600000,False,True",
      "2991883278,-10.0,0.00173,3580522189,3580522189,1714521600002,False,True", // negative price
      "2991883279,60672.00,-0.5,3580522190,3580522190,1714521600004,True,True", // negative size
      "2991883280,60672.01,0.00065,3580522191,3580522191,1714521600006,False,True", // valid
    ].join("\n");

    // Non-strict (tolerant) mode: reports rejected records while keeping valid subset
    const { events, report } = adapter.normalize(malformedCsv, { strict: false, symbol: "BTCUSDT" });
    expect(report.rejectedRecords).toHaveLength(2);
    expect(events).toHaveLength(2); // Only the 2 valid records accepted
    expect(report.isValid).toBe(true);

    // Strict mode: throws immediately
    expect(() => {
      adapter.normalize(malformedCsv, { strict: true, symbol: "BTCUSDT" });
    }).toThrow("Strict Ingestion Error");
  });

  it("supports multi-adapter coexistence: CME Databento + Generic + Binance Historical", () => {
    const databento = new DatabentoAdapter();
    const generic = new GenericMicrostructureAdapter();
    const binance = new BinanceAdapter();

    const cmeFeed = databento.createFeed([
      { ts_event: "1716550200000000000", action: "T", side: "B", price: 18250.25, size: 5, sequence: 1 },
    ]);
    const genericFeed = generic.createFeed([
      { time: 1716550200000, type: "trade", sym: "ES", px: 5300.5, sz: 10, side: "buy", seq: 1 },
    ]);
    const binanceFeed = binance.createFeed([
      { a: 1, p: "60000.00", q: "0.5", T: 1716550200000, m: false },
    ], { symbol: "BTCUSDT" });

    const cmeEngine = new TrainingEngine(cmeFeed, null);
    const genEngine = new TrainingEngine(genericFeed, null);
    const binEngine = new TrainingEngine(binanceFeed, null);

    cmeEngine.stepForward(1);
    genEngine.stepForward(1);
    binEngine.stepForward(1);

    expect(cmeEngine.snapshot().orderFlow.totalVolume).toBe(5);
    expect(genEngine.snapshot().orderFlow.totalVolume).toBe(10);
    expect(binEngine.snapshot().orderFlow.totalVolume).toBe(0.5);

    expect(cmeFeed).toBeInstanceOf(RealMarketDataFeed);
    expect(genFeedInstance(genericFeed)).toBe(true);
    expect(binFeedInstance(binanceFeed)).toBe(true);
  });
});

function genFeedInstance(f: any): boolean {
  return f instanceof RealMarketDataFeed;
}

function binFeedInstance(f: any): boolean {
  return f instanceof RealMarketDataFeed;
}
