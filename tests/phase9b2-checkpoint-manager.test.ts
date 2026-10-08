import { describe, expect, test } from "bun:test";
import {
  CheckpointManager,
  DEFAULT_CHECKPOINT_INTERVAL,
} from "../src/flow/checkpointManager";
import { TrainingEngine, type FlowEngineCheckpoint, type TrainingSnapshot } from "../src/flow/training";
import { SyntheticMarketDataFeed } from "../src/flow/synthetic";
import type { MarketDataFeed } from "../src/flow/feed";
import type { BookResetEvent, L2Event, MarketEvent, TradeEvent } from "../src/flow/events";

/** Deep comparison helper for TrainingSnapshot equivalence */
function assertSnapshotsEquivalent(snapA: TrainingSnapshot, snapB: TrainingSnapshot) {
  // Feed & Engine Clock
  expect(snapB.eventIndex).toBe(snapA.eventIndex);
  expect(snapB.totalEvents).toBe(snapA.totalEvents);
  expect(snapB.atStart).toBe(snapA.atStart);
  expect(snapB.atEnd).toBe(snapA.atEnd);
  expect(snapB.sequence).toBe(snapA.sequence);
  expect(snapB.timestamp).toBe(snapA.timestamp);

  // OrderFlow Snapshot
  expect(snapB.orderFlow.totalBuyVolume).toBe(snapA.orderFlow.totalBuyVolume);
  expect(snapB.orderFlow.totalSellVolume).toBe(snapA.orderFlow.totalSellVolume);
  expect(snapB.orderFlow.totalVolume).toBe(snapA.orderFlow.totalVolume);
  expect(snapB.orderFlow.delta).toBe(snapA.orderFlow.delta);
  expect(snapB.orderFlow.cumulativeDelta).toBe(snapA.orderFlow.cumulativeDelta);
  expect(snapB.orderFlow.vwap).toBe(snapA.orderFlow.vwap);
  expect(snapB.orderFlow.lastPrice).toBe(snapA.orderFlow.lastPrice);
  expect(snapB.orderFlow.sequence).toBe(snapA.orderFlow.sequence);
  expect(snapB.orderFlow.bestBid).toBe(snapA.orderFlow.bestBid);
  expect(snapB.orderFlow.bestAsk).toBe(snapA.orderFlow.bestAsk);
  expect(snapB.orderFlow.volumeAtPrice).toEqual(snapA.orderFlow.volumeAtPrice);
  expect(snapB.orderFlow.cvdSeries).toEqual(snapA.orderFlow.cvdSeries);
  expect(snapB.orderFlow.tape).toEqual(snapA.orderFlow.tape);

  // DOM Snapshot
  expect(snapB.dom.hasBook).toBe(snapA.dom.hasBook);
  expect(snapB.dom.bestBid).toBe(snapA.dom.bestBid);
  expect(snapB.dom.bestAsk).toBe(snapA.dom.bestAsk);
  expect(snapB.dom.bids).toEqual(snapA.dom.bids);
  expect(snapB.dom.asks).toEqual(snapA.dom.asks);
  expect(snapB.dom.pullMarkers).toEqual(snapA.dom.pullMarkers);
  expect(snapB.dom.liquidityHistory).toEqual(snapA.dom.liquidityHistory);
  expect(snapB.dom.domCounters).toEqual(snapA.dom.domCounters);

  // Book & Price Series
  expect(snapB.book).toEqual(snapA.book);
  expect(snapB.priceSeries).toEqual(snapA.priceSeries);
}

/** In-memory mock feed for deterministic edge-case sequences */
class ArrayMarketDataFeed implements MarketDataFeed {
  readonly source = "Array Mock Feed";
  readonly isRealData = false;
  private cursor = 0;

  constructor(private readonly events: MarketEvent[]) {}

  totalEvents(): number {
    return this.events.length;
  }

  position(): number {
    return this.cursor + 1;
  }

  hasNext(): boolean {
    return this.cursor < this.events.length;
  }

  nextEvent(): MarketEvent | null {
    if (!this.hasNext()) return null;
    const ev = this.events[this.cursor];
    this.cursor++;
    return ev;
  }

  reset(): void {
    this.cursor = 0;
  }

  seek(position: number): void {
    this.cursor = Math.max(0, Math.min(position - 1, this.events.length));
  }
}

describe("Phase 9.B-2 CheckpointManager & Accelerated Seek", () => {
  /* -------------------------------------------------------------------------
     1. CheckpointManager Unit Contract & Indexing Strategy
     ------------------------------------------------------------------------- */
  describe("CheckpointManager Core & O(1) Indexing", () => {
    test("instantiates with default K = 10,000 or custom interval", () => {
      const defaultMgr = new CheckpointManager();
      expect(defaultMgr.interval).toBe(DEFAULT_CHECKPOINT_INTERVAL);
      expect(defaultMgr.interval).toBe(10_000);

      const customMgr = new CheckpointManager({ interval: 50 });
      expect(customMgr.interval).toBe(50);
    });

    test("shouldCapture() handles 0, interval multiples, and duplicate prevention", () => {
      const mgr = new CheckpointManager({ interval: 100 });

      // 0 must be captured initially
      expect(mgr.shouldCapture(0)).toBe(true);

      // Non-multiples should not be captured
      expect(mgr.shouldCapture(1)).toBe(false);
      expect(mgr.shouldCapture(99)).toBe(false);
      expect(mgr.shouldCapture(101)).toBe(false);
      expect(mgr.shouldCapture(-10)).toBe(false);

      // Multiple should be captured
      expect(mgr.shouldCapture(100)).toBe(true);
      expect(mgr.shouldCapture(200)).toBe(true);

      // Once saved, duplicate capture is false
      mgr.save({ eventIndex: 100 } as FlowEngineCheckpoint);
      expect(mgr.has(100)).toBe(true);
      expect(mgr.shouldCapture(100)).toBe(false);
    });

    test("findNearest() provides O(1) direct interval lookup", () => {
      const mgr = new CheckpointManager({ interval: 100 });
      const cp0 = { eventIndex: 0, sequence: 0 } as FlowEngineCheckpoint;
      const cp100 = { eventIndex: 100, sequence: 100 } as FlowEngineCheckpoint;
      const cp200 = { eventIndex: 200, sequence: 200 } as FlowEngineCheckpoint;

      mgr.save(cp0);
      mgr.save(cp100);
      mgr.save(cp200);

      expect(mgr.findNearest(0)).toBe(cp0);
      expect(mgr.findNearest(50)).toBe(cp0);
      expect(mgr.findNearest(99)).toBe(cp0);
      expect(mgr.findNearest(100)).toBe(cp100);
      expect(mgr.findNearest(150)).toBe(cp100);
      expect(mgr.findNearest(199)).toBe(cp100);
      expect(mgr.findNearest(200)).toBe(cp200);
      expect(mgr.findNearest(250)).toBe(cp200);
      expect(mgr.findNearest(-5)).toBeNull();
    });

    test("clear() and indices() inspection", () => {
      const mgr = new CheckpointManager({ interval: 10 });
      mgr.save({ eventIndex: 0 } as FlowEngineCheckpoint);
      mgr.save({ eventIndex: 20 } as FlowEngineCheckpoint);
      mgr.save({ eventIndex: 10 } as FlowEngineCheckpoint);

      expect(mgr.indices()).toEqual([0, 10, 20]);
      expect(mgr.size()).toBe(3);

      mgr.clear();
      expect(mgr.size()).toBe(0);
      expect(mgr.indices()).toEqual([]);
    });
  });

  /* -------------------------------------------------------------------------
     2. Integrated Checkpoint Creation in TrainingEngine
     ------------------------------------------------------------------------- */
  describe("TrainingEngine Checkpoint Creation", () => {
    test("automatically creates checkpoints at 0, K, 2K without live state corruption", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 12345 });
      const K = 50;
      const engine = new TrainingEngine(feed, null, { checkpointInterval: K });

      // Checkpoint 0 created at construction
      expect(engine.checkpointManager.has(0)).toBe(true);
      expect(engine.checkpointManager.size()).toBe(1);

      engine.stepForward(50);
      expect(engine.checkpointManager.has(50)).toBe(true);
      expect(engine.checkpointManager.size()).toBe(2);

      engine.stepForward(50);
      expect(engine.checkpointManager.has(100)).toBe(true);
      expect(engine.checkpointManager.size()).toBe(3);

      expect(engine.checkpointManager.indices()).toEqual([0, 50, 100]);
    });
  });

  /* -------------------------------------------------------------------------
     3. Critical Index Invariant: feedPosition = eventIndex + 1 = sequence + 1
     ------------------------------------------------------------------------- */
  describe("Critical Index Invariant", () => {
    test("preserves invariant across exact boundary targets 0, 1, K-1, K, K+1, 2K, 2K+1", () => {
      const K = 100;
      const feed = new SyntheticMarketDataFeed({ seed: 54321 });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: K });

      const targets = [0, 1, K - 1, K, K + 1, 2 * K, 2 * K + 1];

      for (const target of targets) {
        engine.seekTo(target);

        expect(engine.eventIndex).toBe(target);
        if (target === 0) {
          expect(feed.position()).toBe(1);
          expect(engine.snapshot().sequence).toBe(0);
          expect(engine.snapshot().atStart).toBe(true);
        } else {
          expect(feed.position()).toBe(target + 1);
          expect(engine.snapshot().sequence).toBe(target);
          expect(engine.snapshot().atStart).toBe(false);
        }
      }
    });

    test("end-of-feed and final event invariant", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 777 });
      const total = feed.totalEvents();
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 100 });

      // Seek to final event
      engine.seekTo(total - 1);
      expect(engine.eventIndex).toBe(total - 1);
      expect(engine.snapshot().atEnd).toBe(false);
      expect(feed.hasNext()).toBe(true);

      // Seek to end of feed (totalEvents)
      engine.seekTo(total);
      expect(engine.eventIndex).toBe(total);
      expect(engine.snapshot().atEnd).toBe(true);
      expect(feed.hasNext()).toBe(false);

      // Seek beyond range clamps to totalEvents
      engine.seekTo(total + 500);
      expect(engine.eventIndex).toBe(total);
      expect(engine.snapshot().atEnd).toBe(true);
      expect(feed.hasNext()).toBe(false);
    });
  });

  /* -------------------------------------------------------------------------
     4. Deterministic Equivalence: stepForward(T) vs seekTo(T)
     ------------------------------------------------------------------------- */
  describe("Deterministic Equivalence Across Checkpoint Boundaries", () => {
    test("matches sequential replay state at 0, 1, 9999, 10000, 10001, 19999, 20000, 20001, 50000, 100000", () => {
      const seed = 42;
      // Plan with 75,000 trades generates >100,000 events
      const feedA = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 75_000 }],
      });
      const feedB = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 75_000 }],
      });

      const total = feedA.totalEvents();
      expect(total).toBeGreaterThanOrEqual(100_000);

      const engineSeq = new TrainingEngine(feedA, null, { checkpointInterval: 10_000 });
      const engineSeek = new TrainingEngine(feedB, null, { checkpointInterval: 10_000 });

      const testTargets = [
        0,
        1,
        9_999,
        10_000,
        10_001,
        19_999,
        20_000,
        20_001,
        50_000,
        100_000,
      ];

      // Advance engineSeek to end of test range to populate checkpoints at 0, 10k, 20k, ..., 100k
      engineSeek.seekTo(100_000);
      expect(engineSeek.checkpointManager.indices()).toEqual([
        0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000,
      ]);

      for (const target of testTargets) {
        // Sequential advance
        engineSeq.reset();
        if (target > 0) {
          engineSeq.stepForward(target);
        }
        const snapSeq = engineSeq.snapshot();

        // Accelerated seek
        engineSeek.seekTo(target);
        const snapSeek = engineSeek.snapshot();

        assertSnapshotsEquivalent(snapSeq, snapSeek);

        // Verify seek metrics
        const metrics = engineSeek.lastSeekMetrics;
        expect(metrics).not.toBeNull();
        expect(metrics!.targetIndex).toBe(target);
        const expectedCheckpoint = Math.floor(target / 10_000) * 10_000;
        expect(metrics!.checkpointIndex).toBe(expectedCheckpoint);
        expect(metrics!.rolledEvents).toBe(target - expectedCheckpoint);
      }
    });
  });

  /* -------------------------------------------------------------------------
     5. Backward Seek & Bounded Forward Roll
     ------------------------------------------------------------------------- */
  describe("Backward Seek Acceleration", () => {
    test("current = 50,000 -> seekTo(21,000) replays only 1,000 events from checkpoint 20,000", () => {
      const feed = new SyntheticMarketDataFeed({
        seed: 888,
        plan: [{ kind: "meander", trades: 40_000 }],
      });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 10_000 });

      // First advance to 50,000
      engine.seekTo(50_000);
      expect(engine.eventIndex).toBe(50_000);

      // Now seek back to 21,000
      engine.seekTo(21_000);
      expect(engine.eventIndex).toBe(21_000);

      const metrics = engine.lastSeekMetrics;
      expect(metrics).not.toBeNull();
      expect(metrics!.targetIndex).toBe(21_000);
      expect(metrics!.checkpointIndex).toBe(20_000);
      expect(metrics!.rolledEvents).toBe(1_000); // Only rolled 1,000 events, NOT 21,000 or 50,000!
      expect(metrics!.forwardRollMs).toBeLessThan(100);
    });

    test("current = 100,000 -> seekTo(10,000) restores checkpoint 10,000 with 0 rolled events", () => {
      const feed = new SyntheticMarketDataFeed({
        seed: 999,
        plan: [{ kind: "meander", trades: 75_000 }],
      });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 10_000 });

      // Advance to 100,000
      engine.seekTo(100_000);
      expect(engine.eventIndex).toBe(100_000);

      // Seek back directly to checkpoint 10,000
      engine.seekTo(10_000);
      expect(engine.eventIndex).toBe(10_000);

      const metrics = engine.lastSeekMetrics;
      expect(metrics).not.toBeNull();
      expect(metrics!.targetIndex).toBe(10_000);
      expect(metrics!.checkpointIndex).toBe(10_000);
      expect(metrics!.rolledEvents).toBe(0); // 0 rolled events!
    });
  });

  /* -------------------------------------------------------------------------
     6. Checkpoint Isolation Across Repeated Seeks: seekTo(T) -> seekTo(C) -> seekTo(T)
     ------------------------------------------------------------------------- */
  describe("Checkpoint Isolation", () => {
    test("repeated seeks seekTo(T) -> seekTo(C) -> seekTo(T) produce identical states", () => {
      const feed = new SyntheticMarketDataFeed({
        seed: 321,
        plan: [{ kind: "meander", trades: 20_000 }],
      });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 10_000 });

      const T = 15_432;
      const C = 10_000;

      // 1. seekTo(T)
      engine.seekTo(T);
      const snapT1 = engine.snapshot();

      // 2. seekTo(C)
      engine.seekTo(C);
      const snapC = engine.snapshot();
      expect(snapC.eventIndex).toBe(C);

      // 3. seekTo(T) again
      engine.seekTo(T);
      const snapT2 = engine.snapshot();

      // States must be bit-for-bit equivalent
      assertSnapshotsEquivalent(snapT1, snapT2);

      // 4. seekTo(C) again
      engine.seekTo(C);
      const snapC2 = engine.snapshot();
      assertSnapshotsEquivalent(snapC, snapC2);
    });
  });

  /* -------------------------------------------------------------------------
     7. Book Reset Restoration
     ------------------------------------------------------------------------- */
  describe("Book Reset Handling Across Checkpoints", () => {
    test("checkpoints surrounding book-reset restore hasBook, bids, asks, pull markers and history", () => {
      const events: MarketEvent[] = [
        // Event 1: Initial book
        {
          kind: "l2",
          timestamp: 1000,
          sequence: 1,
          bids: [{ price: 100, size: 10, orderCount: 2 }],
          asks: [{ price: 100.25, size: 15, orderCount: 3 }],
        } as L2Event,
        // Event 2: Trade
        {
          kind: "trade",
          timestamp: 1050,
          sequence: 2,
          price: 100.25,
          size: 5,
          aggressorSide: "BUY",
        } as TradeEvent,
        // Event 3: Book Reset
        {
          kind: "book-reset",
          timestamp: 1100,
          sequence: 3,
        } as BookResetEvent,
        // Event 4: Re-seeded book after reset
        {
          kind: "l2",
          timestamp: 1150,
          sequence: 4,
          bids: [{ price: 101, size: 20, orderCount: 5 }],
          asks: [{ price: 101.25, size: 30, orderCount: 6 }],
        } as L2Event,
        // Event 5: Trade after reset
        {
          kind: "trade",
          timestamp: 1200,
          sequence: 5,
          price: 101,
          size: 8,
          aggressorSide: "SELL",
        } as TradeEvent,
      ];

      const feed = new ArrayMarketDataFeed(events);
      // Interval = 2 creates checkpoints at 0, 2, 4
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 2 });

      // Seek to 2 (before book reset)
      engine.seekTo(2);
      expect(engine.snapshot().dom.hasBook).toBe(true);
      expect(engine.snapshot().dom.bestBid).toBe(100);

      // Seek to 3 (exact book reset event)
      engine.seekTo(3);
      expect(engine.snapshot().dom.hasBook).toBe(false);
      expect(engine.snapshot().dom.bestBid).toBeNull();
      expect(engine.snapshot().dom.bestAsk).toBeNull();
      expect(engine.snapshot().book).toBeNull();

      // Seek to 5 (after re-seed)
      engine.seekTo(5);
      expect(engine.snapshot().dom.hasBook).toBe(true);
      expect(engine.snapshot().dom.bestBid).toBe(101);

      // Seek back to 3 (verifying restoration into reset book state)
      engine.seekTo(3);
      expect(engine.snapshot().dom.hasBook).toBe(false);
      expect(engine.snapshot().dom.bestBid).toBeNull();
      expect(engine.snapshot().book).toBeNull();

      // Seek back to 2 (verifying pre-reset book restored)
      engine.seekTo(2);
      expect(engine.snapshot().dom.hasBook).toBe(true);
      expect(engine.snapshot().dom.bestBid).toBe(100);
      expect(engine.snapshot().dom.bestAsk).toBe(100.25);
    });
  });

  /* -------------------------------------------------------------------------
     8. Performance Instrumentation & Latency Measurements
     ------------------------------------------------------------------------- */
  describe("Performance Instrumentation", () => {
    test("populates SeekMetrics on every seek", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 101 });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 50 });

      // First seek from cold engine (0) rolls to 125, establishing checkpoints at 50 and 100 along the way
      engine.seekTo(125);
      const firstMetrics = engine.lastSeekMetrics;

      expect(firstMetrics).not.toBeNull();
      expect(firstMetrics!.targetIndex).toBe(125);
      expect(firstMetrics!.checkpointIndex).toBe(0);
      expect(firstMetrics!.rolledEvents).toBe(125);

      // Now seeking to 140 utilizes the established checkpoint at 100
      engine.seekTo(140);
      const metrics = engine.lastSeekMetrics;

      expect(metrics).not.toBeNull();
      expect(metrics!.targetIndex).toBe(140);
      expect(metrics!.checkpointIndex).toBe(100);
      expect(metrics!.rolledEvents).toBe(40);
      expect(typeof metrics!.lookupMs).toBe("number");
      expect(typeof metrics!.restoreMs).toBe("number");
      expect(typeof metrics!.forwardRollMs).toBe("number");
      expect(typeof metrics!.totalSeekLatencyMs).toBe("number");
      expect(metrics!.totalSeekLatencyMs).toBeGreaterThanOrEqual(0);
    });

    test("measures seek latencies for 100k, stepBack, restore, and forward roll", () => {
      const feed = new SyntheticMarketDataFeed({
        seed: 202,
        plan: [{ kind: "meander", trades: 75_000 }],
      });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 10_000 });

      // Initial populate up to 100k
      engine.seekTo(100_000);

      // 1. Measure seek to 100k from 50k
      engine.seekTo(50_000);
      engine.seekTo(100_000);
      const seek100k = engine.lastSeekMetrics!;

      // 2. Measure step-back at 100k (seeks to 99,999 -> nearest 90,000 + 9,999 roll)
      engine.stepBack();
      const stepBackMetrics = engine.lastSeekMetrics!;

      // 3. Measure direct checkpoint restore at 50,000 (0 roll)
      engine.seekTo(50_000);
      const restoreMetrics = engine.lastSeekMetrics!;

      // 4. Measure forward roll of 1,000 events (seek to 51,000 from 50,000)
      engine.seekTo(51_000);
      const roll1kMetrics = engine.lastSeekMetrics!;

      console.log(`[Phase 9.B-2 Latency Measurements]
- Checkpoint lookup: ${seek100k.lookupMs.toFixed(4)} ms
- Checkpoint restore (50k): ${restoreMetrics.restoreMs.toFixed(4)} ms (total: ${restoreMetrics.totalSeekLatencyMs.toFixed(4)} ms)
- Forward roll 1,000 events: ${roll1kMetrics.forwardRollMs.toFixed(4)} ms (rolled: ${roll1kMetrics.rolledEvents})
- Step-back at 100k (restore 90k + roll 9,999): ${stepBackMetrics.totalSeekLatencyMs.toFixed(4)} ms
- 100k seek (restore 100k + roll 0): ${seek100k.totalSeekLatencyMs.toFixed(4)} ms`);

      expect(restoreMetrics.rolledEvents).toBe(0);
      expect(roll1kMetrics.rolledEvents).toBe(1_000);
      expect(stepBackMetrics.rolledEvents).toBe(9_999);
    });
  });
});
