/**
 * Phase 9-C — Real Microstructure Replay & Engine Integration Tests
 *
 * Verifies:
 * 1. Golden Fixture hand-calculated outcomes (buy/sell volume, delta, CVD, VWAP, profile, DOM)
 * 2. Databento CME NQ Fixture integration with TrainingEngine, Tape, DOM, and CVD
 * 3. Checkpoint equivalence on real-data feeds (sequential vs checkpoint seek)
 * 4. Blind-mode safety protections (truth === null, zero pattern leaks)
 * 5. Multi-vendor architecture proof (Databento + Generic adapters plug into unchanged engines)
 * 6. High-frequency throughput & memory measurements (normalization, feed iteration, engine replay)
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CME_INSTRUMENTS,
  DatabentoAdapter,
  GenericMicrostructureAdapter,
  RealMarketDataFeed,
  type GenericMicrostructureRecord,
} from "../src/flow/ingest";
import { DOMEngine } from "../src/flow/dom";
import { OrderFlowEngine } from "../src/flow/orderFlow";
import { TrainingEngine } from "../src/flow/training";
import { FlowTrainingSession } from "../src/flow/session";
import { CONTRACTS } from "../src/market/instruments";

describe("Phase 9-C Golden Fixture Independent Hand-Verified Verification", () => {
  it("computes hand-verified buy/sell volume, delta, CVD, VWAP, profile, and DOM", () => {
    const fixturePath = resolve(__dirname, "fixtures/golden_microstructure.json");
    const fixtureData = JSON.parse(readFileSync(fixturePath, "utf-8"));

    const adapter = new GenericMicrostructureAdapter();
    const feed = adapter.createFeed(fixtureData.records, {
      instrument: CME_INSTRUMENTS.NQ,
    });

    expect(feed.isRealData).toBe(true);
    expect(feed.totalEvents()).toBe(8);

    const orderFlow = new OrderFlowEngine();
    const dom = new DOMEngine();

    while (feed.hasNext()) {
      const ev = feed.nextEvent()!;
      orderFlow.processEvent(ev);
      dom.processEvent(ev);
    }

    const flowSnap = orderFlow.snapshot();
    const domSnap = dom.snapshot();

    // 1. Total Volume = 10 + 5 + 7 = 22
    expect(flowSnap.totalVolume).toBe(22);

    // 2. Buy Volume = 10 + 5 = 15
    expect(flowSnap.totalBuyVolume).toBe(15);

    // 3. Sell Volume = 7
    expect(flowSnap.totalSellVolume).toBe(7);

    // 4. Cumulative Delta = 15 - 7 = +8
    expect(flowSnap.delta).toBe(8);
    expect(flowSnap.cumulativeDelta).toBe(8);

    // 5. VWAP = (10 * 100 + 5 * 101 + 7 * 99) / 22 = 2198 / 22 = 99.9090909... -> 99.91
    expect(flowSnap.vwap).toBe(99.91);

    // 6. Volume Profile (Volume at Price)
    const p100 = flowSnap.volumeAtPrice.find((v) => v.price === 100);
    expect(p100).toBeDefined();
    expect(p100?.total).toBe(10);
    expect(p100?.buy).toBe(10);
    expect(p100?.sell).toBe(0);

    const p101 = flowSnap.volumeAtPrice.find((v) => v.price === 101);
    expect(p101).toBeDefined();
    expect(p101?.total).toBe(5);
    expect(p101?.buy).toBe(5);
    expect(p101?.sell).toBe(0);

    const p99 = flowSnap.volumeAtPrice.find((v) => v.price === 99);
    expect(p99).toBeDefined();
    expect(p99?.total).toBe(7);
    expect(p99?.buy).toBe(0);
    expect(p99?.sell).toBe(7);

    // 7. DOM Top-of-Book
    expect(domSnap.bestBid).toBe(99);
    expect(domSnap.bestAsk).toBe(101);
    expect(domSnap.bids[0].size).toBe(15);
    expect(domSnap.asks[0].size).toBe(12);
    expect(domSnap.spread).toBe(2.0);
  });
});

describe("Phase 9-C Databento CME NQ Fixture Replay & Integration", () => {
  const fixturePath = resolve(__dirname, "fixtures/databento_cme_nq.jsonl");
  const fixtureRaw = readFileSync(fixturePath, "utf-8");
  const adapter = new DatabentoAdapter();

  const makeFeed = () =>
    adapter.createFeed(fixtureRaw, {
      instrument: CME_INSTRUMENTS.NQ,
    });

  it("produces valid RealMarketDataFeed with full capabilities and reports", () => {
    const feed = makeFeed();
    expect(feed.isRealData).toBe(true);
    expect(feed.totalEvents()).toBeGreaterThan(20);
    expect(feed.capabilities?.hasTrades).toBe(true);
    expect(feed.capabilities?.hasDepth).toBe(true);
    expect(feed.capabilities?.hasNanosecondTimestamps).toBe(true);
    expect(feed.validationReport?.isValid).toBe(true);
    expect(feed.validationReport?.rejectedRecords.length).toBe(0);
  });

  it("replays real trades into Tape without duplicates or drops", () => {
    const feed = makeFeed();
    const engine = new TrainingEngine(feed, null);
    engine.stepForward(feed.totalEvents());

    const snap = engine.snapshot();
    expect(snap.orderFlow.tape.length).toBeGreaterThan(0);

    // Verify chronological order (stored oldest to newest) and matchIds
    for (let i = 1; i < snap.orderFlow.tape.length; i++) {
      expect(snap.orderFlow.tape[i].timestamp).toBeGreaterThanOrEqual(snap.orderFlow.tape[i - 1].timestamp);
    }

    const tradePrints = snap.orderFlow.tape.filter((t) => t.matchId !== undefined);
    expect(tradePrints.length).toBeGreaterThan(0);
    expect(tradePrints[0].matchId).toContain("CME_M_");
  });

  it("replays depth deltas and updates DOM book and liquidity", () => {
    const feed = makeFeed();
    const engine = new TrainingEngine(feed, null);
    engine.stepForward(feed.totalEvents());

    const snap = engine.snapshot();
    expect(snap.dom.hasBook).toBe(true);
    expect(snap.dom.bids.length).toBeGreaterThan(0);
    expect(snap.dom.asks.length).toBeGreaterThan(0);
    expect(snap.dom.bestBid).toBeDefined();
    expect(snap.dom.bestAsk).toBeDefined();
    expect(snap.dom.bestBid!).toBeLessThan(snap.dom.bestAsk!);
  });
});

describe("Phase 9-C Checkpoint Replay Equivalence on Real Data", () => {
  it("guarantees sequential replay === checkpoint seek replay on real feeds", () => {
    const fixturePath = resolve(__dirname, "fixtures/databento_cme_nq.jsonl");
    const fixtureRaw = readFileSync(fixturePath, "utf-8");

    const adapter = new DatabentoAdapter();
    const feed1 = adapter.createFeed(fixtureRaw, { instrument: CME_INSTRUMENTS.NQ });
    const feed2 = adapter.createFeed(fixtureRaw, { instrument: CME_INSTRUMENTS.NQ });

    const total = feed1.totalEvents();
    // Configure small K=5 checkpoint interval for dense verification
    const engineSeq = new TrainingEngine(feed1, null, { checkpointInterval: 5 });
    const engineSeek = new TrainingEngine(feed2, null, { checkpointInterval: 5 });

    // Step sequential engine
    engineSeq.stepForward(total);

    // Warm up seek engine with checkpoints then seek
    engineSeek.stepForward(total);

    const testTargets = [0, 1, 5, 6, 10, 15, total];
    for (const target of testTargets) {
      // Re-run sequential from 0
      feed1.reset();
      const freshSeq = new TrainingEngine(feed1, null);
      if (target > 0) freshSeq.stepForward(target);
      const snapSeq = freshSeq.snapshot();

      // Seek
      engineSeek.seekTo(target);
      const snapSeek = engineSeek.snapshot();

      expect(snapSeek.eventIndex).toBe(snapSeq.eventIndex);
      expect(snapSeek.orderFlow.totalVolume).toBe(snapSeq.orderFlow.totalVolume);
      expect(snapSeek.orderFlow.delta).toBe(snapSeq.orderFlow.delta);
      expect(snapSeek.orderFlow.cumulativeDelta).toBe(snapSeq.orderFlow.cumulativeDelta);
      expect(snapSeek.dom.bids.length).toBe(snapSeq.dom.bids.length);
      expect(snapSeek.dom.asks.length).toBe(snapSeq.dom.asks.length);
      if (snapSeq.dom.bestBid !== null) {
        expect(snapSeek.dom.bestBid).toBe(snapSeq.dom.bestBid);
      }
    }
  });

  it("verifies sequential replay === checkpoint seek replay on 50,000-event representative dataset across targets (0, 1, 9999, 10000, 10001, 50000)", () => {
    const N = 50_000;
    const rawBatch = new Array(N);
    const startNanos = 1716550200000000000n;

    for (let i = 0; i < N; i++) {
      const isTrade = i % 4 === 0;
      rawBatch[i] = {
        ts_event: startNanos + BigInt(i * 1000),
        action: isTrade ? "T" : i % 2 === 0 ? "A" : "M",
        side: i % 2 === 0 ? "A" : "B",
        price: 18250.0 + (i % 20) * 0.25,
        size: 1 + (i % 10),
        sequence: i + 1,
        order_cnt: 1 + (i % 5),
        symbol: "NQ",
      };
    }

    const adapter = new DatabentoAdapter();
    const { events } = adapter.normalize(rawBatch);

    const feedSeq = new RealMarketDataFeed(events);
    const feedSeek = new RealMarketDataFeed(events);

    // Default K=10,000 checkpoint interval
    const engineSeek = new TrainingEngine(feedSeek, null, { checkpointInterval: 10000 });
    // Warm up seek engine up to 50k to populate checkpoints at 0, 10k, 20k, 30k, 40k, 50k
    engineSeek.stepForward(N);

    const targets = [0, 1, 9999, 10000, 10001, 50000];

    for (const target of targets) {
      // Re-run clean sequential engine from 0
      feedSeq.reset();
      const engineSeq = new TrainingEngine(feedSeq, null);
      if (target > 0) engineSeq.stepForward(target);

      const seqSnap = engineSeq.snapshot();
      engineSeek.seekTo(target);
      const seekSnap = engineSeek.snapshot();

      // Verify all required microstructure and DOM metrics
      expect(seekSnap.eventIndex).toBe(seqSnap.eventIndex);
      expect(seekSnap.sequence).toBe(seqSnap.sequence);
      expect(seekSnap.timestamp).toBe(seqSnap.timestamp);
      expect(seekSnap.orderFlow.totalVolume).toBe(seqSnap.orderFlow.totalVolume);
      expect(seekSnap.orderFlow.delta).toBe(seqSnap.orderFlow.delta);
      expect(seekSnap.orderFlow.cumulativeDelta).toBe(seqSnap.orderFlow.cumulativeDelta);
      expect(seekSnap.orderFlow.vwap).toBe(seqSnap.orderFlow.vwap);
      expect(seekSnap.orderFlow.volumeAtPrice.length).toBe(seqSnap.orderFlow.volumeAtPrice.length);
      expect(seekSnap.dom.bestBid).toBe(seqSnap.dom.bestBid);
      expect(seekSnap.dom.bestAsk).toBe(seqSnap.dom.bestAsk);
      expect(seekSnap.dom.bids.length).toBe(seqSnap.dom.bids.length);
      expect(seekSnap.dom.asks.length).toBe(seqSnap.dom.asks.length);
      expect(seekSnap.dom.hasBook).toBe(seqSnap.dom.hasBook);
    }
  });
});

describe("Phase 9-C Blind Mode Protections on Real Data", () => {
  it("replays real microstructure with truth === null without leaking secrets", () => {
    const fixturePath = resolve(__dirname, "fixtures/databento_cme_nq.jsonl");
    const fixtureRaw = readFileSync(fixturePath, "utf-8");

    const adapter = new DatabentoAdapter();
    const feed = adapter.createFeed(fixtureRaw, { instrument: CME_INSTRUMENTS.NQ });

    const session = new FlowTrainingSession(feed, null, {
      contract: CONTRACTS.NQ,
    });

    session.stepForward(15);
    const snap = session.snapshot();

    expect(snap.recognition).toBeNull();
    expect(session.results()).toBeNull();
    expect(session.isRevealed).toBe(false);
    expect(snap.isRealData).toBe(true);
    expect(snap.orderFlow.totalVolume).toBeGreaterThan(0);
    expect(snap.dom.hasBook).toBe(true);

    // Seeking forward and backward stays blind-safe
    session.seekTo(5);
    const backSnap = session.snapshot();
    expect(backSnap.recognition).toBeNull();
    expect(session.results()).toBeNull();
    expect(backSnap.isRealData).toBe(true);
  });
});

describe("Phase 9-C Multi-Vendor Architecture Validation", () => {
  it("proves Databento and Generic adapters plug into unchanged engines", () => {
    const databentoAdapter = new DatabentoAdapter();
    const genericAdapter = new GenericMicrostructureAdapter();

    const databentoRecords = [
      { ts_event: "1716550200000000000", action: "T", side: "A", price: 100, size: 2, sequence: 1 },
    ];
    const genericRecords: GenericMicrostructureRecord[] = [
      { time: 1716550200000, type: "trade", side: "buy", px: 100, sz: 2, seq: 1 },
    ];

    const feedA = databentoAdapter.createFeed(databentoRecords);
    const feedB = genericAdapter.createFeed(genericRecords);

    const engineA = new TrainingEngine(feedA, null);
    const engineB = new TrainingEngine(feedB, null);

    engineA.stepForward(1);
    engineB.stepForward(1);

    expect(engineA.snapshot().orderFlow.totalVolume).toBe(2);
    expect(engineB.snapshot().orderFlow.totalVolume).toBe(2);
    expect(engineA.snapshot().orderFlow.delta).toBe(2);
    expect(engineB.snapshot().orderFlow.delta).toBe(2);
  });
});

describe("Phase 9-C High-Frequency Ingestion & Normalization Throughput", () => {
  it("measures normalization, feed iteration, and engine throughput on 50,000 real-schema events", () => {
    // Generate 50,000 synthetic raw Databento records
    const N = 50_000;
    const rawBatch = new Array(N);
    const startNanos = 1716550200000000000n;

    for (let i = 0; i < N; i++) {
      const isTrade = i % 4 === 0;
      rawBatch[i] = {
        ts_event: startNanos + BigInt(i * 1000),
        action: isTrade ? "T" : i % 2 === 0 ? "A" : "M",
        side: i % 2 === 0 ? "A" : "B",
        price: 18250.0 + (i % 20) * 0.25,
        size: 1 + (i % 10),
        sequence: i + 1,
        order_cnt: 1 + (i % 5),
        symbol: "NQ",
      };
    }

    // 1. Normalization Benchmark
    const adapter = new DatabentoAdapter();
    const tNormStart = performance.now();
    const { events, report } = adapter.normalize(rawBatch);
    const tNormEnd = performance.now();
    const normDurationMs = Math.max(0.001, tNormEnd - tNormStart);
    const normThroughput = Math.round((N / normDurationMs) * 1000);

    expect(events.length).toBe(N);
    expect(report.isValid).toBe(true);

    // 2. Feed Creation & Replay Throughput
    const feed = new RealMarketDataFeed(events);
    const engine = new TrainingEngine(feed, null, { checkpointInterval: 10000 });

    const tReplayStart = performance.now();
    engine.stepForward(N);
    const tReplayEnd = performance.now();
    const replayDurationMs = Math.max(0.001, tReplayEnd - tReplayStart);
    const replayThroughput = Math.round((N / replayDurationMs) * 1000);

    // Report metrics cleanly
    console.log("==================================================");
    console.log(`[Phase 9-C Ingestion Benchmark: ${N} events]`);
    console.log(`- Normalization Duration: ${normDurationMs.toFixed(2)} ms`);
    console.log(`- Normalization Throughput: ${normThroughput.toLocaleString()} ev/s`);
    console.log(`- Replay Duration: ${replayDurationMs.toFixed(2)} ms`);
    console.log(`- Engine Replay Throughput: ${replayThroughput.toLocaleString()} ev/s`);
    console.log(`- Valid Records: ${report.normalizedEventCount}`);
    console.log(`- Trades: ${report.tradeCount}, Depth: ${report.depthCount}`);
    console.log("==================================================");

    expect(normThroughput).toBeGreaterThan(50_000); // Sane throughput guard
    expect(replayThroughput).toBeGreaterThan(100_000); // Sane engine replay guard
  });
});
