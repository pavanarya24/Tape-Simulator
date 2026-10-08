import { describe, expect, test } from "bun:test";
import { OrderFlowEngine, type OrderFlowState } from "../src/flow/orderFlow";
import { DOMEngine, type DOMState } from "../src/flow/dom";
import { TrainingEngine, type FlowEngineCheckpoint } from "../src/flow/training";
import { SyntheticMarketDataFeed } from "../src/flow/synthetic";
import { generateScenario } from "../src/flow/scenarios";
import type { L2Event, TradeEvent, BookResetEvent } from "../src/flow/events";

describe("Phase 9.B-1 Core Checkpoint State", () => {
  /* -------------------------------------------------------------------------
     1. OrderFlowEngine State Capture, Restoration & Mutation Isolation
     ------------------------------------------------------------------------- */
  describe("OrderFlowEngine Checkpoint State", () => {
    test("captures and restores exact order-flow state", () => {
      const engine = new OrderFlowEngine();

      const t1: TradeEvent = {
        kind: "trade",
        timestamp: 1710514200000,
        sequence: 1,
        price: 18000.25,
        size: 10,
        aggressorSide: "BUY",
      };
      const t2: TradeEvent = {
        kind: "trade",
        timestamp: 1710514200500,
        sequence: 2,
        price: 18000.0,
        size: 6,
        aggressorSide: "SELL",
      };
      const l2: L2Event = {
        kind: "l2",
        timestamp: 1710514200600,
        sequence: 3,
        bids: [{ price: 18000.0, size: 25 }],
        asks: [{ price: 18000.25, size: 15 }],
      };

      engine.processEvent(t1);
      engine.processEvent(t2);
      engine.processEvent(l2);

      const snapBefore = engine.snapshot();
      const state = engine.captureState();

      // Process more events in engine to mutate live state
      const t3: TradeEvent = {
        kind: "trade",
        timestamp: 1710514201000,
        sequence: 4,
        price: 18000.5,
        size: 20,
        aggressorSide: "BUY",
      };
      engine.processEvent(t3);

      expect(engine.snapshot().totalVolume).toBe(36);
      expect(engine.snapshot().lastPrice).toBe(18000.5);

      // Restore captured state
      engine.restoreState(state);
      const snapAfter = engine.snapshot();

      expect(snapAfter.totalBuyVolume).toBe(snapBefore.totalBuyVolume);
      expect(snapAfter.totalSellVolume).toBe(snapBefore.totalSellVolume);
      expect(snapAfter.totalVolume).toBe(snapBefore.totalVolume);
      expect(snapAfter.delta).toBe(snapBefore.delta);
      expect(snapAfter.cumulativeDelta).toBe(snapBefore.cumulativeDelta);
      expect(snapAfter.vwap).toBe(snapBefore.vwap);
      expect(snapAfter.lastPrice).toBe(snapBefore.lastPrice);
      expect(snapAfter.sequence).toBe(snapBefore.sequence);
      expect(snapAfter.bestBid).toBe(snapBefore.bestBid);
      expect(snapAfter.bestAsk).toBe(snapBefore.bestAsk);
      expect(snapAfter.volumeAtPrice).toEqual(snapBefore.volumeAtPrice);
      expect(snapAfter.tape).toEqual(snapBefore.tape);
      expect(snapAfter.cvdSeries).toEqual(snapBefore.cvdSeries);
    });

    test("mutation isolation: volumeByPrice bucket objects are strictly decoupled", () => {
      const engine = new OrderFlowEngine();
      engine.processEvent({
        kind: "trade",
        timestamp: 1710514200000,
        sequence: 1,
        price: 18000.0,
        size: 10,
        aggressorSide: "BUY",
      });

      const checkpoint = engine.captureState();
      const bucketEntry = checkpoint.volumeByPrice.find(([p]) => p === 18000.0);
      expect(bucketEntry).toBeDefined();
      expect(bucketEntry![1].buy).toBe(10);
      expect(bucketEntry![1].sell).toBe(0);

      // Mutate live engine with another trade at the same price
      engine.processEvent({
        kind: "trade",
        timestamp: 1710514200100,
        sequence: 2,
        price: 18000.0,
        size: 50,
        aggressorSide: "BUY",
      });

      // The live engine has updated bucket buy volume to 60
      expect(engine.snapshot().volumeAtPrice.find((p) => p.price === 18000.0)?.buy).toBe(60);

      // The captured checkpoint's bucket must remain completely untouched (10)
      expect(bucketEntry![1].buy).toBe(10);

      // Mutate checkpoint directly to verify engine is also isolated from checkpoint
      bucketEntry![1].buy = 999;
      expect(engine.snapshot().volumeAtPrice.find((p) => p.price === 18000.0)?.buy).toBe(60);
    });

    test("mutation isolation: tape, largest, and cvdSeries arrays are cloned and detached", () => {
      const engine = new OrderFlowEngine();
      for (let i = 1; i <= 5; i++) {
        engine.processEvent({
          kind: "trade",
          timestamp: 1710514200000 + i * 100,
          sequence: i,
          price: 18000.0 + i * 0.25,
          size: i * 2,
          aggressorSide: "BUY",
        });
      }

      const checkpoint = engine.captureState();
      expect(checkpoint.tape.length).toBe(5);
      expect(checkpoint.cvdSeries.length).toBe(5);
      expect(checkpoint.largest.length).toBe(5);

      // Process 100 more trades to shift tape and mutate cvdSeries
      for (let i = 6; i <= 100; i++) {
        engine.processEvent({
          kind: "trade",
          timestamp: 1710514200000 + i * 100,
          sequence: i,
          price: 18000.0,
          size: 1,
          aggressorSide: "SELL",
        });
      }

      // Checkpoint arrays remain unchanged
      expect(checkpoint.tape.length).toBe(5);
      expect(checkpoint.cvdSeries.length).toBe(5);
      expect(checkpoint.largest.length).toBe(5);
      expect(checkpoint.tape[0].sequence).toBe(1);
    });
  });

  /* -------------------------------------------------------------------------
     2. DOMEngine State Capture, Restoration & Mutation Isolation
     ------------------------------------------------------------------------- */
  describe("DOMEngine Checkpoint State", () => {
    test("captures and restores exact DOM state and analytics", () => {
      const dom = new DOMEngine();

      dom.processEvent({
        kind: "l2",
        timestamp: 1710514200000,
        sequence: 1,
        bids: [
          { price: 18000.0, size: 50 },
          { price: 17999.75, size: 30 },
        ],
        asks: [
          { price: 18000.25, size: 40 },
          { price: 18000.5, size: 20 },
        ],
      });

      // Cause a top-of-book size drop (pull detection)
      dom.processEvent({
        kind: "l2",
        timestamp: 1710514200200,
        sequence: 2,
        bids: [
          { price: 18000.0, size: 10 }, // 50 -> 10 = 80% pull
          { price: 17999.75, size: 30 },
        ],
        asks: [
          { price: 18000.25, size: 40 },
          { price: 18000.5, size: 20 },
        ],
      });

      const snapBefore = dom.snapshot();
      expect(snapBefore.pullBidCount).toBeGreaterThan(0);
      const state = dom.captureState();

      // Mutate live DOM engine with subsequent events
      dom.processEvent({
        kind: "l2",
        timestamp: 1710514201000,
        sequence: 3,
        bids: [{ price: 18005.0, size: 100 }],
        asks: [{ price: 18005.25, size: 100 }],
      });

      expect(dom.snapshot().bestBid).toBe(18005.0);

      // Restore captured state
      dom.restoreState(state);
      const snapAfter = dom.snapshot();

      expect(snapAfter.hasBook).toBe(snapBefore.hasBook);
      expect(snapAfter.sequence).toBe(snapBefore.sequence);
      expect(snapAfter.bestBid).toBe(snapBefore.bestBid);
      expect(snapAfter.bestAsk).toBe(snapBefore.bestAsk);
      expect(snapAfter.bids).toEqual(snapBefore.bids);
      expect(snapAfter.asks).toEqual(snapBefore.asks);
      expect(snapAfter.pullBidCount).toBe(snapBefore.pullBidCount);
      expect(snapAfter.pullAskCount).toBe(snapBefore.pullAskCount);
      expect(snapAfter.replenishCount).toBe(snapBefore.replenishCount);
      expect(snapAfter.stackBidLevels).toBe(snapBefore.stackBidLevels);
      expect(snapAfter.topOfBookChanges).toBe(snapBefore.topOfBookChanges);
    });

    test("mutation isolation: pullMarkers and eventsLeft decrementing in place", () => {
      const dom = new DOMEngine();

      dom.processEvent({
        kind: "l2",
        timestamp: 1710514200000,
        sequence: 1,
        bids: [{ price: 18000.0, size: 100 }],
        asks: [{ price: 18000.25, size: 100 }],
      });

      // Trigger a pull marker on the bid side
      dom.processEvent({
        kind: "l2",
        timestamp: 1710514200100,
        sequence: 2,
        bids: [{ price: 18000.0, size: 20 }], // dropped 80%
        asks: [{ price: 18000.25, size: 100 }],
      });

      const checkpoint = dom.captureState();
      expect(checkpoint.pullMarkers.length).toBe(1);
      const initialEventsLeft = checkpoint.pullMarkers[0].eventsLeft;
      expect(initialEventsLeft).toBeGreaterThan(0);

      // Feed several subsequent events that tick and decrement eventsLeft in the live engine
      for (let i = 3; i <= 8; i++) {
        dom.processEvent({
          kind: "l2",
          timestamp: 1710514200000 + i * 100,
          sequence: i,
          bids: [{ price: 18000.0, size: 20 }],
          asks: [{ price: 18000.25, size: 100 }],
        });
      }

      // Checkpoint's pullMarker eventsLeft must remain at its captured initial value
      expect(checkpoint.pullMarkers[0].eventsLeft).toBe(initialEventsLeft);
    });

    test("mutation isolation: bids and asks Level objects are deeply cloned", () => {
      const dom = new DOMEngine();
      dom.processEvent({
        kind: "l2",
        timestamp: 1710514200000,
        sequence: 1,
        bids: [{ price: 18000.0, size: 25, orderCount: 3 }],
        asks: [{ price: 18000.25, size: 35, orderCount: 4 }],
      });

      const checkpoint = dom.captureState();
      expect(checkpoint.bids[0].size).toBe(25);

      // Mutate live DOM
      dom.processEvent({
        kind: "l2",
        timestamp: 1710514200100,
        sequence: 2,
        bids: [{ price: 18000.0, size: 999, orderCount: 10 }],
        asks: [{ price: 18000.25, size: 35, orderCount: 4 }],
      });

      expect(dom.snapshot().bids[0].size).toBe(999);
      expect(checkpoint.bids[0].size).toBe(25);
    });
  });

  /* -------------------------------------------------------------------------
     3. TrainingEngine Checkpoint Contract & Determinism Equivalence
     ------------------------------------------------------------------------- */
  describe("TrainingEngine FlowEngineCheckpoint Contract", () => {
    test("sequential replay (0 -> T) matches checkpoint restore + roll (0 -> C -> restore -> T)", () => {
      const seed = 98765;
      const feedA = new SyntheticMarketDataFeed({ seed });
      const feedB = new SyntheticMarketDataFeed({ seed });

      const engineA = new TrainingEngine(feedA);
      const engineB = new TrainingEngine(feedB);

      const targetEvents = 300;
      const checkpointAt = 120;

      // Engine A runs sequentially all the way to targetEvents
      engineA.stepForward(targetEvents);
      const snapA = engineA.snapshot();

      // Engine B runs to checkpointAt, captures checkpoint, advances further, then restores and rolls
      engineB.stepForward(checkpointAt);
      const checkpoint = engineB.captureCheckpoint();

      expect(checkpoint.eventIndex).toBe(checkpointAt);
      expect(checkpoint.priceSeries.length).toBeGreaterThan(0);

      // Simulate divergence / further playback in Engine B
      engineB.stepForward(50);
      expect(engineB.eventIndex).toBe(checkpointAt + 50);

      // Restore checkpoint back to checkpointAt
      engineB.restoreCheckpoint(checkpoint);
      expect(engineB.eventIndex).toBe(checkpointAt);

      // Step forward remaining events to reach targetEvents
      engineB.stepForward(targetEvents - checkpointAt);
      const snapB = engineB.snapshot();

      // Verify absolute equivalence
      expect(snapB.eventIndex).toBe(snapA.eventIndex);
      expect(snapB.sequence).toBe(snapA.sequence);
      expect(snapB.timestamp).toBe(snapA.timestamp);

      // OrderFlow snapshot equivalence
      expect(snapB.orderFlow.totalBuyVolume).toBe(snapA.orderFlow.totalBuyVolume);
      expect(snapB.orderFlow.totalSellVolume).toBe(snapA.orderFlow.totalSellVolume);
      expect(snapB.orderFlow.totalVolume).toBe(snapA.orderFlow.totalVolume);
      expect(snapB.orderFlow.delta).toBe(snapA.orderFlow.delta);
      expect(snapB.orderFlow.cumulativeDelta).toBe(snapA.orderFlow.cumulativeDelta);
      expect(snapB.orderFlow.vwap).toBe(snapA.orderFlow.vwap);
      expect(snapB.orderFlow.lastPrice).toBe(snapA.orderFlow.lastPrice);
      expect(snapB.orderFlow.volumeAtPrice).toEqual(snapA.orderFlow.volumeAtPrice);
      expect(snapB.orderFlow.cvdSeries).toEqual(snapA.orderFlow.cvdSeries);

      // DOM snapshot equivalence
      expect(snapB.dom.hasBook).toBe(snapA.dom.hasBook);
      expect(snapB.dom.bestBid).toBe(snapA.dom.bestBid);
      expect(snapB.dom.bestAsk).toBe(snapA.dom.bestAsk);
      expect(snapB.dom.bids).toEqual(snapA.dom.bids);
      expect(snapB.dom.asks).toEqual(snapA.dom.asks);
      expect(snapB.dom.pullBidCount).toBe(snapA.dom.pullBidCount);
      expect(snapB.dom.pullAskCount).toBe(snapA.dom.pullAskCount);
      expect(snapB.dom.replenishCount).toBe(snapA.dom.replenishCount);
      expect(snapB.dom.sweepBuyCount).toBe(snapA.dom.sweepBuyCount);

      // Traded price series equivalence
      expect(snapB.priceSeries).toEqual(snapA.priceSeries);
    });

    test("priceSeries mutation isolation: captured priceSeries remains detached", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 111 });
      const engine = new TrainingEngine(feed);
      engine.stepForward(50);

      const checkpoint = engine.captureCheckpoint();
      const originalLen = checkpoint.priceSeries.length;
      expect(originalLen).toBeGreaterThan(0);

      // Step forward 100 more events
      engine.stepForward(100);
      expect(engine.snapshot().priceSeries.length).toBeGreaterThan(originalLen);

      // Checkpoint priceSeries remains intact
      expect(checkpoint.priceSeries.length).toBe(originalLen);
    });
  });

  /* -------------------------------------------------------------------------
     4. Blind-Mode Safety Verification
     ------------------------------------------------------------------------- */
  describe("Blind-Mode Safety Verification", () => {
    test("checkpoint object contains ZERO ScenarioTruth, pattern names, or generator secrets", () => {
      const scenario = generateScenario("spring", 42);
      expect(scenario.truth).toBeDefined();
      expect(scenario.truth.pattern).toBe("spring");

      const engine = new TrainingEngine(scenario.feed, scenario.truth);
      engine.stepForward(75);

      const checkpoint = engine.captureCheckpoint();

      // Deep string inspection of JSON-serialized checkpoint
      const serialized = JSON.stringify(checkpoint);

      expect(serialized).not.toContain("spring");
      expect(serialized).not.toContain("upthrust");
      expect(serialized).not.toContain("absorption");
      expect(serialized).not.toContain("initiative-break");
      expect(serialized).not.toContain("responsive-fade");
      expect(serialized).not.toContain("keyWindow");
      expect(serialized).not.toContain("generator");
      expect(serialized).not.toContain("confidence");
      expect(serialized).not.toContain("ScenarioTruth");
      expect(serialized).not.toContain("pattern");

      // Direct property check on checkpoint root
      const cp = checkpoint as Record<string, unknown>;
      expect(cp.truth).toBeUndefined();
      expect(cp.pattern).toBeUndefined();
      expect(cp.scenarioId).toBeUndefined();
      expect(cp.confidence).toBeUndefined();
    });
  });

  /* -------------------------------------------------------------------------
     5. Edge Cases
     ------------------------------------------------------------------------- */
  describe("Checkpoint Edge Cases", () => {
    test("checkpoint at event 0 captures clean initial state and restores cleanly", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 123 });
      const engine = new TrainingEngine(feed);

      const cp0 = engine.captureCheckpoint();
      expect(cp0.eventIndex).toBe(0);
      expect(cp0.sequence).toBe(0);
      expect(cp0.timestamp).toBeNull();
      expect(cp0.priceSeries).toEqual([]);
      expect(cp0.orderFlow.totalBuy).toBe(0);
      expect(cp0.orderFlow.totalSell).toBe(0);
      expect(cp0.dom.hasBook).toBe(false);

      // Advance
      engine.stepForward(50);
      expect(engine.eventIndex).toBe(50);

      // Restore 0
      engine.restoreCheckpoint(cp0);
      expect(engine.eventIndex).toBe(0);
      expect(engine.snapshot().atStart).toBe(true);
      expect(engine.snapshot().priceSeries).toEqual([]);

      // Step forward again and compare with fresh feed
      const freshEngine = new TrainingEngine(new SyntheticMarketDataFeed({ seed: 123 }));
      engine.stepForward(20);
      freshEngine.stepForward(20);
      expect(engine.snapshot()).toEqual(freshEngine.snapshot());
    });

    test("checkpoint across book-reset event preserves reset state", () => {
      const engine = new TrainingEngine(new SyntheticMarketDataFeed({ seed: 456 }));
      // Advance to ensure book is populated
      engine.stepForward(30);
      expect(engine.snapshot().dom.hasBook).toBe(true);

      // Simulate a book-reset event
      const resetEv: BookResetEvent = {
        kind: "book-reset",
        timestamp: 1710514205000,
        sequence: 9999,
      };
      (engine as unknown as { apply: (ev: BookResetEvent) => void }).apply(resetEv);

      expect(engine.snapshot().dom.hasBook).toBe(false);
      const cpReset = engine.captureCheckpoint();
      expect(cpReset.dom.hasBook).toBe(false);

      // Populate again
      engine.stepForward(10);
      expect(engine.snapshot().dom.hasBook).toBe(true);

      // Restore reset checkpoint
      engine.restoreCheckpoint(cpReset);
      expect(engine.snapshot().dom.hasBook).toBe(false);
    });

    test("checkpoint at end of feed restores without out-of-bounds error", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 789 });
      const total = feed.totalEvents();
      const engine = new TrainingEngine(feed);

      engine.stepForward(total);
      expect(engine.eventIndex).toBe(total);
      expect(engine.snapshot().atEnd).toBe(true);

      const cpEnd = engine.captureCheckpoint();
      expect(cpEnd.eventIndex).toBe(total);

      // Rewind to 10
      engine.seekTo(10);
      expect(engine.eventIndex).toBe(10);

      // Restore end checkpoint
      engine.restoreCheckpoint(cpEnd);
      expect(engine.eventIndex).toBe(total);
      expect(engine.snapshot().atEnd).toBe(true);
    });
  });
});
