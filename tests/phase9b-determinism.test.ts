import { describe, expect, test } from "bun:test";
import { TrainingEngine, type FlowEngineCheckpoint, type TrainingSnapshot } from "../src/flow/training";
import { OrderFlowEngine, type OrderFlowState } from "../src/flow/orderFlow";
import { DOMEngine, type DOMState } from "../src/flow/dom";
import { SyntheticMarketDataFeed, makeRng } from "../src/flow/synthetic";
import { compareNormalizedEvents, type MarketEvent, type TradeEvent, type L2Event, type BookResetEvent } from "../src/flow/events";
import type { MarketDataFeed } from "../src/flow/feed";
import { generateScenario, type ScenarioTruth } from "../src/flow/scenarios";

/* -------------------------------------------------------------------------- */
/* Test Helpers & State Equivalence Verifiers                                  */
/* -------------------------------------------------------------------------- */

/**
 * Asserts complete deterministic observable & underlying state equivalence
 * between two TrainingEngine instances.
 */
function assertEngineStateEqual(
  engineA: TrainingEngine,
  engineB: TrainingEngine,
  contextMessage = "",
) {
  const snapA = engineA.snapshot();
  const snapB = engineB.snapshot();
  const cpA = engineA.captureCheckpoint();
  const cpB = engineB.captureCheckpoint();

  // 1. TrainingEngine Observable Snapshot
  expect(snapB.eventIndex).toBe(snapA.eventIndex);
  expect(snapB.totalEvents).toBe(snapA.totalEvents);
  expect(snapB.atStart).toBe(snapA.atStart);
  expect(snapB.atEnd).toBe(snapA.atEnd);
  expect(snapB.sequence).toBe(snapA.sequence);
  expect(snapB.timestamp).toBe(snapA.timestamp);
  expect(snapB.priceSeries).toEqual(snapA.priceSeries);

  // 2. TrainingEngine Checkpoint Invariants
  expect(cpB.eventIndex).toBe(cpA.eventIndex);
  expect(cpB.sequence).toBe(cpA.sequence);
  expect(cpB.timestamp).toBe(cpA.timestamp);
  expect(cpB.feedPosition).toBe(cpA.feedPosition);
  expect(cpB.priceSeries).toEqual(cpA.priceSeries);

  // 3. OrderFlowEngine State Equivalence
  const ofA: OrderFlowState = cpA.orderFlow;
  const ofB: OrderFlowState = cpB.orderFlow;

  try {
    expect(ofB.totalBuy).toBe(ofA.totalBuy);
    expect(ofB.totalSell).toBe(ofA.totalSell);
    expect(ofB.buyCount).toBe(ofA.buyCount);
    expect(ofB.sellCount).toBe(ofA.sellCount);
    expect(ofB.unknownCount).toBe(ofA.unknownCount);
    expect(ofB.cvd).toBe(ofA.cvd);
    expect(ofB.cvdSeries).toEqual(ofA.cvdSeries);
    expect(ofB.vwapNumerator).toBe(ofA.vwapNumerator);
    expect(ofB.vwapDenominator).toBe(ofA.vwapDenominator);
    expect(ofB.lastPrice).toBe(ofA.lastPrice);
    expect(ofB.lastSequence).toBe(ofA.lastSequence);
    expect(ofB.bestBid).toBe(ofA.bestBid);
    expect(ofB.bestAsk).toBe(ofA.bestAsk);
    expect(ofB.bidLiquidity).toBe(ofA.bidLiquidity);
    expect(ofB.askLiquidity).toBe(ofA.askLiquidity);
    expect(ofB.tradeTimestamps).toEqual(ofA.tradeTimestamps);
    expect(ofB.tape).toEqual(ofA.tape);
    expect(ofB.largest).toEqual(ofA.largest);
    expect(ofB.volumeByPrice).toEqual(ofA.volumeByPrice);
  } catch (err) {
    throw new Error(`OrderFlow state mismatch ${contextMessage}: ${(err as Error).message}`);
  }

  // 4. DOMEngine State Equivalence
  const domA: DOMState = cpA.dom;
  const domB: DOMState = cpB.dom;

  try {
    expect(domB.hasBook).toBe(domA.hasBook);
    expect(domB.sequence).toBe(domA.sequence);
    expect(domB.bids).toEqual(domA.bids);
    expect(domB.asks).toEqual(domA.asks);
    expect(domB.stackBidLevels).toBe(domA.stackBidLevels);
    expect(domB.stackAskLevels).toBe(domA.stackAskLevels);
    expect(domB.pullBidCount).toBe(domA.pullBidCount);
    expect(domB.pullAskCount).toBe(domA.pullAskCount);
    expect(domB.replenishCount).toBe(domA.replenishCount);
    expect(domB.depletedBid).toBe(domA.depletedBid);
    expect(domB.depletedAsk).toBe(domA.depletedAsk);
    expect(domB.sweepBuyCount).toBe(domA.sweepBuyCount);
    expect(domB.sweepSellCount).toBe(domA.sweepSellCount);
    expect(domB.topOfBookChanges).toBe(domA.topOfBookChanges);
    expect(domB.prevBestBid).toBe(domA.prevBestBid);
    expect(domB.prevBestAsk).toBe(domA.prevBestAsk);
    expect(domB.prevBidTopSize).toBe(domA.prevBidTopSize);
    expect(domB.prevAskTopSize).toBe(domA.prevAskTopSize);
    expect(domB.pullMarkers).toEqual(domA.pullMarkers);
    expect(domB.bidHistoryTotals).toEqual(domA.bidHistoryTotals);
    expect(domB.askHistoryTotals).toEqual(domA.askHistoryTotals);
    expect(domB.log).toEqual(domA.log);
  } catch (err) {
    throw new Error(`DOM state mismatch ${contextMessage}: ${(err as Error).message}`);
  }
}

/** In-memory array mock feed for custom event sequencing */
class MockArrayFeed implements MarketDataFeed {
  readonly source = "MockArrayFeed";
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

describe("Phase 9.B-3 Determinism & Checkpoint Regression Suite", () => {
  /* -------------------------------------------------------------------------
     1. Checkpoint Boundary Tests (K = 10,000)
     ------------------------------------------------------------------------- */
  describe("Checkpoint Boundary Determinism & Exact Roll Invariants", () => {
    test("verifies exact boundary, +1, -1, and surrounding targets", () => {
      const K = 10_000;
      const seed = 12345;
      const feedA = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 30_000 }],
      });
      const feedB = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 30_000 }],
      });

      const engineSeq = new TrainingEngine(feedA, null, { checkpointInterval: K });
      const engineSeek = new TrainingEngine(feedB, null, { checkpointInterval: K });

      // Warm up engineSeek to establish checkpoints up to 35k
      engineSeek.seekTo(35_000);

      const targets = [
        0,
        1,
        2,
        K - 2, // 9,998
        K - 1, // 9,999
        K, // 10,000
        K + 1, // 10,001
        K + 2, // 10,002
        2 * K - 1, // 19,999
        2 * K, // 20,000
        2 * K + 1, // 20,001
        3 * K - 1, // 29,999
        3 * K, // 30,000
        3 * K + 1, // 30,001
      ];

      for (const T of targets) {
        // Sequential Pipeline A
        engineSeq.reset();
        if (T > 0) {
          engineSeq.stepForward(T);
        }

        // Accelerated Pipeline B
        engineSeek.seekTo(T);

        // State equivalence verification
        assertEngineStateEqual(engineSeq, engineSeek, `at target ${T}`);

        // Roll event invariants
        const metrics = engineSeek.lastSeekMetrics!;
        expect(metrics.targetIndex).toBe(T);

        if (T === 0) {
          expect(metrics.checkpointIndex).toBe(0);
          expect(metrics.rolledEvents).toBe(0);
        } else if (T % K === 0) {
          // Exact boundary: rolledEvents === 0
          expect(metrics.checkpointIndex).toBe(T);
          expect(metrics.rolledEvents).toBe(0);
        } else if (T % K === 1) {
          // Boundary + 1: rolledEvents === 1
          expect(metrics.checkpointIndex).toBe(T - 1);
          expect(metrics.rolledEvents).toBe(1);
        } else if (T % K === K - 1) {
          // Boundary - 1: rolledEvents === K - 1
          expect(metrics.checkpointIndex).toBe(T - (K - 1));
          expect(metrics.rolledEvents).toBe(K - 1);
        }
      }
    });
  });

  /* -------------------------------------------------------------------------
     2. Randomized Determinism Testing (100 Targets on 1M Events)
     ------------------------------------------------------------------------- */
  describe("Randomized Determinism Testing on 1M Events", () => {
    test("verifies 100 pseudo-random target indices against sequential replay", () => {
      const seed = 999;
      const K = 10_000;
      const feed = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 750_000 }],
      });
      const totalEvents = feed.totalEvents();
      expect(totalEvents).toBeGreaterThanOrEqual(1_000_000);

      // Deterministic PRNG for targets
      const rng = makeRng(1337);

      const targetSet = new Set<number>();
      // 1. Mandatory boundaries & offsets
      targetSet.add(0);
      targetSet.add(1);
      targetSet.add(K - 1);
      targetSet.add(K);
      targetSet.add(K + 1);
      targetSet.add(totalEvents - 1); // Final event
      targetSet.add(totalEvents); // End of feed

      // 2. Early dataset (0 .. 50k)
      for (let i = 0; i < 20; i++) {
        targetSet.add(Math.floor(rng() * 50_000));
      }

      // 3. Middle dataset (400k .. 600k)
      for (let i = 0; i < 30; i++) {
        targetSet.add(400_000 + Math.floor(rng() * 200_000));
      }

      // 4. Late dataset (800k .. 1M)
      for (let i = 0; i < 30; i++) {
        targetSet.add(800_000 + Math.floor(rng() * (totalEvents - 800_000)));
      }

      // 5. Checkpoint multiples +/- offsets
      for (let cp = 10_000; cp <= 200_000; cp += 20_000) {
        targetSet.add(cp);
        targetSet.add(cp - 1);
        targetSet.add(cp + 1);
        targetSet.add(cp + Math.floor(rng() * 500));
      }

      const targets = [...targetSet].sort((a, b) => a - b);
      expect(targets.length).toBeGreaterThanOrEqual(100);

      // Pre-record reference sequential snapshots across 1 single forward pass
      const feedSeq = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 750_000 }],
      });
      const engineSeq = new TrainingEngine(feedSeq, null, { checkpointInterval: K });

      const referenceCheckpoints = new Map<number, FlowEngineCheckpoint>();
      let currentSeq = 0;
      for (const target of targets) {
        const delta = target - currentSeq;
        if (delta > 0) {
          engineSeq.stepForward(delta);
          currentSeq = target;
        }
        referenceCheckpoints.set(target, engineSeq.captureCheckpoint());
      }

      // Test engineSeek: warm up to end of dataset so all checkpoints exist
      const feedSeek = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 750_000 }],
      });
      const engineSeek = new TrainingEngine(feedSeek, null, { checkpointInterval: K });
      engineSeek.seekTo(totalEvents);

      // Shuffle target order using RNG so engineSeek visits targets non-linearly
      const shuffledTargets = [...targets];
      for (let i = shuffledTargets.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffledTargets[i], shuffledTargets[j]] = [shuffledTargets[j], shuffledTargets[i]];
      }

      // Execute non-linear seeks and compare against reference
      for (const target of shuffledTargets) {
        engineSeek.seekTo(target);
        const refCp = referenceCheckpoints.get(target)!;
        const actualCp = engineSeek.captureCheckpoint();

        try {
          expect(actualCp.eventIndex).toBe(refCp.eventIndex);
          expect(actualCp.sequence).toBe(refCp.sequence);
          expect(actualCp.timestamp).toBe(refCp.timestamp);
          expect(actualCp.feedPosition).toBe(refCp.feedPosition);
          expect(actualCp.orderFlow).toEqual(refCp.orderFlow);
          expect(actualCp.dom).toEqual(refCp.dom);
          expect(actualCp.priceSeries).toEqual(refCp.priceSeries);
        } catch (err) {
          const m = engineSeek.lastSeekMetrics!;
          console.error(
            `Mismatch at random target ${target}: selected CP ${m.checkpointIndex}, rolled ${m.rolledEvents}`,
          );
          throw err;
        }
      }
    }, 30_000);
  });

  /* -------------------------------------------------------------------------
     3. Repeated Seek Sequence
     ------------------------------------------------------------------------- */
  describe("Repeated Seek Sequences", () => {
    test("arbitrary jumping sequence 0 -> 50k -> 10k -> 99999 -> 20k -> 100001 -> 0 -> 75k -> end", () => {
      const seed = 555;
      const feedA = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 80_000 }],
      });
      const feedB = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 80_000 }],
      });

      const total = feedA.totalEvents();
      expect(total).toBeGreaterThanOrEqual(100_002);

      const engineSeq = new TrainingEngine(feedA, null, { checkpointInterval: 10_000 });
      const engineSeek = new TrainingEngine(feedB, null, { checkpointInterval: 10_000 });
      engineSeek.seekTo(total);

      const sequence = [
        0,
        50_000,
        10_000,
        99_999,
        20_000,
        100_001,
        0,
        75_000,
        total,
      ];

      for (const target of sequence) {
        engineSeq.reset();
        if (target > 0) {
          engineSeq.stepForward(target);
        }

        engineSeek.seekTo(target);
        assertEngineStateEqual(engineSeq, engineSeek, `at step ${target}`);
      }
    });
  });

  /* -------------------------------------------------------------------------
     4. Backward / Forward Seek Test Across Large Boundaries
     ------------------------------------------------------------------------- */
  describe("Large Scale Backward & Forward Jumps", () => {
    test("verifies large transitions 500k -> 499999 -> 500k -> 250k -> 750k -> 10k -> 900k", () => {
      const seed = 777;
      const feed = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 700_000 }],
      });
      const total = feed.totalEvents();
      expect(total).toBeGreaterThanOrEqual(900_000);

      const engineSeek = new TrainingEngine(feed, null, { checkpointInterval: 10_000 });
      engineSeek.seekTo(total);

      const jumps = [
        500_000,
        499_999,
        500_000,
        250_000,
        750_000,
        10_000,
        900_000,
      ];

      // Pre-record references across a single forward pass:
      const uniqueTargets = [...new Set(jumps)].sort((a, b) => a - b);
      const feedRef = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 700_000 }],
      });
      const engineRef = new TrainingEngine(feedRef, null, { checkpointInterval: 10_000 });
      const refCheckpoints = new Map<number, FlowEngineCheckpoint>();
      let cur = 0;
      for (const t of uniqueTargets) {
        if (t > cur) {
          engineRef.stepForward(t - cur);
          cur = t;
        }
        refCheckpoints.set(t, engineRef.captureCheckpoint());
      }

      for (const target of jumps) {
        engineSeek.seekTo(target);
        const refCp = refCheckpoints.get(target)!;
        const actualCp = engineSeek.captureCheckpoint();
        expect(actualCp.eventIndex).toBe(refCp.eventIndex);
        expect(actualCp.sequence).toBe(refCp.sequence);
        expect(actualCp.timestamp).toBe(refCp.timestamp);
        expect(actualCp.feedPosition).toBe(refCp.feedPosition);
        expect(actualCp.orderFlow).toEqual(refCp.orderFlow);
        expect(actualCp.dom).toEqual(refCp.dom);
        expect(actualCp.priceSeries).toEqual(refCp.priceSeries);
      }
    }, 30_000);
  });

  /* -------------------------------------------------------------------------
     5. Checkpoint Immutability Regression
     ------------------------------------------------------------------------- */
  describe("Checkpoint Immutability & Mutation Isolation", () => {
    test("checkpoint structure remains byte-for-byte identical after restoration and intense replay", () => {
      const feed = new SyntheticMarketDataFeed({
        seed: 333,
        plan: [{ kind: "meander", trades: 20_000 }],
      });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 10_000 });

      // Run to 10,000 to capture checkpoint 10,000
      engine.stepForward(10_000);
      const cp10k = engine.checkpointManager.get(10_000);
      expect(cp10k).toBeDefined();

      // Deep record structure as JSON string
      const jsonBefore = JSON.stringify(cp10k);

      // Restore checkpoint and mutate live engine
      engine.restoreCheckpoint(cp10k!);
      engine.stepForward(5_000);
      engine.seekTo(25_000);
      engine.stepForward(1_000);
      engine.seekTo(0);
      engine.stepForward(2_000);

      // Verify original checkpoint object was NOT mutated
      const jsonAfter = JSON.stringify(cp10k);
      expect(jsonAfter).toBe(jsonBefore);

      // Restore again and verify equality
      engine.restoreCheckpoint(cp10k!);
      expect(JSON.stringify(engine.captureCheckpoint())).toBe(jsonBefore);
    });
  });

  /* -------------------------------------------------------------------------
     6. Book Reset Regression
     ------------------------------------------------------------------------- */
  describe("Book Reset Handling", () => {
    test("seeks before, at, and after multiple book-reset events restore exact state", () => {
      const events: MarketEvent[] = [
        {
          kind: "l2",
          timestamp: 1000,
          sequence: 1,
          bids: [{ price: 100, size: 50, orderCount: 5 }],
          asks: [{ price: 100.25, size: 40, orderCount: 4 }],
        } as L2Event,
        {
          kind: "trade",
          timestamp: 1050,
          sequence: 2,
          price: 100.25,
          size: 10,
          aggressorSide: "BUY",
        } as TradeEvent,
        // Reset 1 at index 3
        {
          kind: "book-reset",
          timestamp: 1100,
          sequence: 3,
        } as BookResetEvent,
        {
          kind: "l2",
          timestamp: 1150,
          sequence: 4,
          bids: [{ price: 101, size: 20, orderCount: 2 }],
          asks: [{ price: 101.25, size: 30, orderCount: 3 }],
        } as L2Event,
        // Reset 2 at index 5
        {
          kind: "book-reset",
          timestamp: 1200,
          sequence: 5,
        } as BookResetEvent,
        {
          kind: "l2",
          timestamp: 1250,
          sequence: 6,
          bids: [{ price: 102, size: 10, orderCount: 1 }],
          asks: [{ price: 102.25, size: 15, orderCount: 2 }],
        } as L2Event,
      ];

      const feedA = new MockArrayFeed(events);
      const feedB = new MockArrayFeed(events);

      const engineSeq = new TrainingEngine(feedA, null, { checkpointInterval: 2 });
      const engineSeek = new TrainingEngine(feedB, null, { checkpointInterval: 2 });

      const seekOrder = [0, 2, 3, 4, 5, 6, 3, 2, 5, 1];

      for (const T of seekOrder) {
        engineSeq.reset();
        if (T > 0) engineSeq.stepForward(T);

        engineSeek.seekTo(T);
        assertEngineStateEqual(engineSeq, engineSeek, `at book-reset target ${T}`);
      }
    });
  });

  /* -------------------------------------------------------------------------
     7. Event Ordering Regression (Phase 9-A Contract)
     ------------------------------------------------------------------------- */
  describe("Event Ordering Contract & Stability", () => {
    test("preserves tsEventNanos -> sequence -> stable wire order without kind priority", () => {
      const e1: TradeEvent = {
        kind: "trade",
        timestamp: 1000,
        sequence: 1,
        tsEventNanos: 1000000000n,
        price: 100,
        size: 5,
        aggressorSide: "BUY",
      };
      const e2: L2Event = {
        kind: "l2",
        timestamp: 1000,
        sequence: 2,
        tsEventNanos: 1000000000n,
        bids: [],
        asks: [],
      };
      const e3: BookResetEvent = {
        kind: "book-reset",
        timestamp: 1000,
        sequence: 2,
        tsEventNanos: 1000000000n,
      };

      // Timestamp equal, sequence 1 vs 2: sequence governs
      expect(compareNormalizedEvents(e1, e2)).toBeLessThan(0);
      expect(compareNormalizedEvents(e2, e1)).toBeGreaterThan(0);

      // Exact collision (same timestamp & sequence): returns 0 (stable source ordering, no kind priority!)
      expect(compareNormalizedEvents(e2, e3)).toBe(0);
    });
  });

  /* -------------------------------------------------------------------------
     8. End-of-Feed & Boundary Range Invariants
     ------------------------------------------------------------------------- */
  describe("End-of-Feed Invariants", () => {
    test("cursor positions, hasNext(), atEnd, sequence, and eventIndex stay consistent", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 101 });
      const total = feed.totalEvents();
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 50 });

      // Target 0
      engine.seekTo(0);
      expect(engine.eventIndex).toBe(0);
      expect(engine.snapshot().atStart).toBe(true);
      expect(engine.snapshot().atEnd).toBe(false);
      expect(feed.position()).toBe(1);
      expect(feed.hasNext()).toBe(true);

      // Target 1
      engine.seekTo(1);
      expect(engine.eventIndex).toBe(1);
      expect(engine.snapshot().atStart).toBe(false);
      expect(feed.position()).toBe(2);

      // Final event (total - 1)
      engine.seekTo(total - 1);
      expect(engine.eventIndex).toBe(total - 1);
      expect(engine.snapshot().atEnd).toBe(false);
      expect(feed.position()).toBe(total);
      expect(feed.hasNext()).toBe(true);

      // Exact totalEvents
      engine.seekTo(total);
      expect(engine.eventIndex).toBe(total);
      expect(engine.snapshot().atEnd).toBe(true);
      expect(feed.position()).toBe(total + 1);
      expect(feed.hasNext()).toBe(false);

      // Beyond totalEvents clamps cleanly
      engine.seekTo(total + 1000);
      expect(engine.eventIndex).toBe(total);
      expect(engine.snapshot().atEnd).toBe(true);
      expect(feed.position()).toBe(total + 1);
      expect(feed.hasNext()).toBe(false);
    });
  });

  /* -------------------------------------------------------------------------
     9. Blind-Mode Safety Regression
     ------------------------------------------------------------------------- */
  describe("Blind-Mode Safety Invariants", () => {
    test("checkpoints strictly isolate ScenarioTruth and never leak secrets", () => {
      const scenario = generateScenario("spring", 42);
      const feed = new SyntheticMarketDataFeed({ seed: 42 });
      const engine = new TrainingEngine(feed, scenario.truth, { checkpointInterval: 100 });

      // Advance and capture checkpoint
      engine.stepForward(250);
      const cp = engine.captureCheckpoint();
      const snap = engine.snapshot();

      // Checkpoint must NOT contain secret fields
      const cpKeys = Object.keys(cp);
      expect(cpKeys).not.toContain("truth");
      expect(cpKeys).not.toContain("hiddenPattern");
      expect(cpKeys).not.toContain("pattern");
      expect(cpKeys).not.toContain("keyWindow");
      expect(cpKeys).not.toContain("generatorPhase");

      // Snapshot must be blind-safe
      const snapKeys = Object.keys(snap);
      expect(snapKeys).not.toContain("truth");
      expect(snapKeys).not.toContain("pattern");

      // Only reveal() yields truth
      expect(engine.reveal()).toBe(scenario.truth);
    });
  });

  /* -------------------------------------------------------------------------
     10. Checkpoint Count & Index Consistency Invariant
     ------------------------------------------------------------------------- */
  describe("Checkpoint Cadence & Consistency Invariant", () => {
    test("verifies checkpoints at exact K multiples with internal index consistency", () => {
      const K = 10_000;
      const feed = new SyntheticMarketDataFeed({
        seed: 888,
        plan: [{ kind: "meander", trades: 40_000 }],
      });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: K });
      engine.seekTo(50_000);

      const indices = engine.checkpointManager.indices();
      expect(indices).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000]);

      for (const idx of indices) {
        const cp = engine.checkpointManager.get(idx)!;
        expect(cp.eventIndex).toBe(idx);
        expect(cp.feedPosition).toBe(idx + 1);
        if (idx === 0) {
          expect(cp.sequence).toBe(0);
          expect(cp.timestamp).toBeNull();
        } else {
          expect(cp.sequence).toBe(idx);
          expect(cp.timestamp).not.toBeNull();
        }
      }
    });
  });

  /* -------------------------------------------------------------------------
     11. Performance Regression Guard
     ------------------------------------------------------------------------- */
  describe("Performance Regression Guard (rolledEvents Bounded)", () => {
    test("seek never rolls more than (K - 1) events on large datasets", () => {
      const K = 10_000;
      const feed = new SyntheticMarketDataFeed({
        seed: 777,
        plan: [{ kind: "meander", trades: 750_000 }],
      });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: K });
      engine.seekTo(1_000_000);

      // Worst case seek: 999,999
      engine.seekTo(999_999);
      const metrics999k = engine.lastSeekMetrics!;
      expect(metrics999k.checkpointIndex).toBe(990_000);
      expect(metrics999k.rolledEvents).toBe(9_999);
      expect(metrics999k.rolledEvents).toBeLessThanOrEqual(K - 1);

      // Step-back from 1M to 999,999
      engine.seekTo(1_000_000);
      engine.stepBack();
      const metricsStepBack = engine.lastSeekMetrics!;
      expect(metricsStepBack.checkpointIndex).toBe(990_000);
      expect(metricsStepBack.rolledEvents).toBe(9_999);
      expect(metricsStepBack.rolledEvents).toBeLessThanOrEqual(K - 1);
    });
  });
});
