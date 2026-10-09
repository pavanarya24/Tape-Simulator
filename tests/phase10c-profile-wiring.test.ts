import { describe, expect, test } from "bun:test";
import {
  PROFILE_CME_NQ,
  PROFILE_CME_ES,
  PROFILE_BINANCE_BTCUSDT_SPOT,
  PROFILE_BINANCE_BTCUSDT_FUTURES,
  getMarketProfile,
} from "../src/market/registry";
import { buildTapeRows } from "../src/flow/tape";
import { recognizeFlow, rankFlowPatterns } from "../src/flow/recognition";
import { SyntheticMarketDataFeed } from "../src/flow/synthetic";
import { generateScenario } from "../src/flow/scenarios";
import { TrainingEngine, type FlowEngineCheckpoint } from "../src/flow/training";
import { FlowTrainingSession } from "../src/flow/session";
import type { MarketEvent, TradeEvent } from "../src/flow/events";
import { RealMarketDataFeed } from "../src/flow/ingest/feed";
import { OrderFlowEngine } from "../src/flow/orderFlow";
import { DOMEngine } from "../src/flow/dom";

describe("PHASE 10-C: MarketProfile Propagation & Market-Aware Replay", () => {
  /* ------------------------------------------------------------------ */
  /* 1. Profile Propagation                                              */
  /* ------------------------------------------------------------------ */
  describe("1. Profile Propagation", () => {
    test("MarketDataFeed / RealMarketDataFeed propagates injected MarketProfile", () => {
      const btcProfile = getMarketProfile("BINANCE:BTCUSDT-SPOT")!;
      expect(btcProfile).toBeDefined();

      const realFeed = new RealMarketDataFeed([], {
        profile: btcProfile,
        source: "Binance Spot Real Ingest",
      });

      expect(realFeed.profile).toBe(btcProfile);
      expect(realFeed.profile?.id).toBe("BINANCE:BTCUSDT-SPOT");
      expect(realFeed.profile?.pricing.tickSize).toBe(0.01);
    });

    test("TrainingEngine defaults to NQ when no profile is provided, or uses feed profile", () => {
      const syntheticNq = new SyntheticMarketDataFeed({ seed: 42 });
      const engineDefault = new TrainingEngine(syntheticNq);
      expect(engineDefault.profile.id).toBe("CME:NQ");

      const btcProfile = getMarketProfile("BINANCE:BTCUSDT-SPOT")!;
      const syntheticBtc = new SyntheticMarketDataFeed({ seed: 42, profile: btcProfile });
      const engineBtcFromFeed = new TrainingEngine(syntheticBtc);
      expect(engineBtcFromFeed.profile.id).toBe("BINANCE:BTCUSDT-SPOT");

      const esProfile = getMarketProfile("CME:ES")!;
      const engineExplicit = new TrainingEngine(syntheticNq, null, { profile: esProfile });
      expect(engineExplicit.profile.id).toBe("CME:ES");
    });

    test("FlowTrainingSession propagates profile to TrainingEngine and snapshot", () => {
      const btcProfile = getMarketProfile("BINANCE:BTCUSDT-FUTURES")!;
      const feed = new SyntheticMarketDataFeed({ seed: 123, profile: btcProfile });
      const session = new FlowTrainingSession(feed, null, { profile: btcProfile });

      expect(session.profile.id).toBe("BINANCE:BTCUSDT-FUTURES");
      expect(session.profile.pricing.tickSize).toBe(0.1);

      session.step(10);
      const snap = session.snapshot();
      expect(snap.eventIndex).toBe(10);
      expect(snap.evidence.length).toBeGreaterThan(0);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 2. Fractional Crypto Trade Sizes (tape.ts)                          */
  /* ------------------------------------------------------------------ */
  describe("2. Fractional Crypto Trade Sizes in Tape", () => {
    test("calculates accurate relative size for fractional BTC quantities without clamping to 1.0", () => {
      // Sub-unit BTC prints with fractional distribution around median = 0.05
      const events: TradeEvent[] = [
        { kind: "trade", sequence: 1, timestamp: 1000, price: 65000.5, size: 0.01, aggressorSide: "BUY" },
        { kind: "trade", sequence: 2, timestamp: 1010, price: 65000.5, size: 0.02, aggressorSide: "BUY" },
        { kind: "trade", sequence: 3, timestamp: 1020, price: 65001.0, size: 0.05, aggressorSide: "BUY" },
        { kind: "trade", sequence: 4, timestamp: 1030, price: 65001.0, size: 0.08, aggressorSide: "SELL" },
        { kind: "trade", sequence: 5, timestamp: 1040, price: 65000.5, size: 0.25, aggressorSide: "SELL" }, // large / sweepLike
      ];

      const rows = buildTapeRows(events);
      expect(rows.length).toBe(5);

      // Median of [0.01, 0.02, 0.05, 0.08, 0.25] is 0.05; max is 0.25.
      // Prior implementation clamped median to Math.max(1, 0.05) = 1.0, making relative sizes and large flags incorrect!
      // New implementation uses raw positive median 0.05.
      const medianRow = rows[2]; // size 0.05
      expect(medianRow.size).toBe(0.05);
      expect(medianRow.relativeSize).toBeCloseTo(0.2, 3); // 0.05 / 0.25
      expect(medianRow.large).toBe(false); // 0.05 < 0.05 * 2

      const smallRow = rows[0]; // size 0.01
      expect(smallRow.relativeSize).toBeCloseTo(0.04, 3); // 0.01 / 0.25
      expect(smallRow.large).toBe(false);

      const blockRow = rows[4]; // size 0.25
      expect(blockRow.relativeSize).toBeCloseTo(1.0, 3); // 0.25 / 0.25
      expect(blockRow.large).toBe(true); // 0.25 >= 0.05 * 2 = 0.10
      expect(blockRow.sweepLike).toBe(true); // 0.25 >= 0.05 * 3 = 0.15
    });

    test("preserves integer futures classification behavior for NQ/ES", () => {
      const events: TradeEvent[] = [
        { kind: "trade", sequence: 1, timestamp: 1000, price: 18000.25, size: 1, aggressorSide: "BUY" },
        { kind: "trade", sequence: 2, timestamp: 1010, price: 18000.25, size: 2, aggressorSide: "BUY" },
        { kind: "trade", sequence: 3, timestamp: 1020, price: 18000.50, size: 5, aggressorSide: "BUY" },
        { kind: "trade", sequence: 4, timestamp: 1030, price: 18000.50, size: 12, aggressorSide: "SELL" },
        { kind: "trade", sequence: 5, timestamp: 1040, price: 18000.25, size: 30, aggressorSide: "SELL" },
      ];

      const rows = buildTapeRows(events);
      expect(rows.length).toBe(5);

      // Median of [1, 2, 5, 12, 30] is 5; max is 30.
      const medianRow = rows[2]; // size 5
      expect(medianRow.relativeSize).toBeCloseTo(5 / 30, 3);
      expect(medianRow.large).toBe(false);

      const largeRow = rows[3]; // size 12 >= 5 * 2 = 10
      expect(largeRow.large).toBe(true);

      const blockRow = rows[4]; // size 30 => 30/30 = 1.0, >= 5 * 3 = 15
      expect(blockRow.relativeSize).toBeCloseTo(1.0, 3);
      expect(blockRow.large).toBe(true);
      expect(blockRow.sweepLike).toBe(true);
    });

    test("handles degenerate inputs, zero sizes, non-finite values, and empty arrays safely", () => {
      // Empty input
      expect(buildTapeRows([])).toEqual([]);

      // Degenerate zero/negative/NaN sizes
      const degenerateEvents: TradeEvent[] = [
        { kind: "trade", sequence: 1, timestamp: 1000, price: 100, size: 0, aggressorSide: "BUY" },
        { kind: "trade", sequence: 2, timestamp: 1010, price: 100, size: -5, aggressorSide: "BUY" },
        { kind: "trade", sequence: 3, timestamp: 1020, price: 100, size: NaN, aggressorSide: "SELL" },
      ];

      const rows = buildTapeRows(degenerateEvents);
      expect(rows.length).toBe(3);
      for (const r of rows) {
        expect(Number.isFinite(r.relativeSize)).toBe(true);
        expect(r.relativeSize).toBe(0);
        expect(r.large).toBe(false);
        expect(r.sweepLike).toBe(false);
      }

      // Single print
      const singleRow = buildTapeRows([
        { kind: "trade", sequence: 1, timestamp: 1000, price: 65000, size: 0.005, aggressorSide: "BUY" },
      ]);
      expect(singleRow.length).toBe(1);
      expect(singleRow[0].relativeSize).toBe(1);
      expect(singleRow[0].large).toBe(false);
    });

    test("preserves aggressor side semantics without modification", () => {
      const events: TradeEvent[] = [
        { kind: "trade", sequence: 1, timestamp: 1000, price: 100, size: 1, aggressorSide: "BUY" },
        { kind: "trade", sequence: 2, timestamp: 1010, price: 100, size: 1, aggressorSide: "SELL" },
        { kind: "trade", sequence: 3, timestamp: 1020, price: 100, size: 1, aggressorSide: "NONE" },
      ];
      const rows = buildTapeRows(events);
      expect(rows[0].aggressorSide).toBe("BUY");
      expect(rows[1].aggressorSide).toBe("SELL");
      expect(rows[2].aggressorSide).toBe("NONE");
    });
  });

  /* ------------------------------------------------------------------ */
  /* 3. Tick-Aware Flow Recognition (recognition.ts)                     */
  /* ------------------------------------------------------------------ */
  describe("3. Tick-Aware Flow Recognition", () => {
    test("scales busy zone tolerance and minimum range according to profile tickSize", () => {
      const nqProfile = getMarketProfile("CME:NQ")!; // tick = 0.25 => busyTol = 0.50
      const btcSpotProfile = getMarketProfile("BINANCE:BTCUSDT-SPOT")!; // tick = 0.01 => busyTol = 0.02
      const btcFutProfile = getMarketProfile("BINANCE:BTCUSDT-FUTURES")!; // tick = 0.10 => busyTol = 0.20

      // Create synthetic flat trades around 65000.00 with tight 0.01 spread
      const priceSeries = Array.from({ length: 100 }, (_, i) => ({
        t: 1000 + i * 100,
        price: 65000.00 + (i % 2 === 0 ? 0.01 : 0.00),
        sequence: i + 1,
      }));

      const ofEngine = new OrderFlowEngine();
      for (const p of priceSeries) {
        ofEngine.processEvent({
          kind: "trade",
          sequence: p.sequence,
          timestamp: p.t,
          price: p.price,
          size: 10,
          aggressorSide: "SELL",
        });
      }

      const input = {
        sequence: 100,
        timestamp: 11000,
        priceSeries,
        orderFlow: ofEngine.snapshot(),
        dom: new DOMEngine().snapshot(),
      };

      // Recognize with BTC Spot profile (tick = 0.01)
      const recBtc = recognizeFlow(input, btcSpotProfile);
      expect(recBtc).toBeDefined();
      expect(recBtc.evidence.length).toBeGreaterThan(0);

      // Recognize with NQ profile (tick = 0.25)
      const recNq = recognizeFlow(input, nqProfile);
      expect(recNq).toBeDefined();
      expect(recNq.evidence.length).toBeGreaterThan(0);
    });

    test("recognizes equivalent tick-relative patterns consistently across profiles", () => {
      // 1. Generate an absorption scenario for NQ
      const nqScenario = generateScenario("absorption", 12345, {
        profile: PROFILE_CME_NQ,
      });
      const nqEvents = nqScenario.feed.events();

      const ofNq = new OrderFlowEngine();
      const domNq = new DOMEngine();
      const priceSeriesNq: Array<{ t: number; price: number; sequence: number }> = [];
      for (const ev of nqEvents) {
        ofNq.processEvent(ev);
        domNq.processEvent(ev);
        if (ev.kind === "trade") {
          priceSeriesNq.push({ t: ev.timestamp, price: ev.price, sequence: ev.sequence });
        }
      }

      const recNq = recognizeFlow(
        {
          sequence: nqEvents.length,
          timestamp: nqEvents[nqEvents.length - 1]?.timestamp ?? 0,
          priceSeries: priceSeriesNq,
          orderFlow: ofNq.snapshot(),
          dom: domNq.snapshot(),
        },
        PROFILE_CME_NQ,
      );

      expect(recNq.pattern).toBe("absorption");
      expect(recNq.confidence).toBeGreaterThan(0.7);

      // 2. Generate an absorption scenario for BTC Spot
      const btcScenario = generateScenario("absorption", 12345, {
        profile: PROFILE_BINANCE_BTCUSDT_SPOT,
        startPrice: 65000,
      });
      const btcEvents = btcScenario.feed.events();

      const ofBtc = new OrderFlowEngine();
      const domBtc = new DOMEngine();
      const priceSeriesBtc: Array<{ t: number; price: number; sequence: number }> = [];
      for (const ev of btcEvents) {
        ofBtc.processEvent(ev);
        domBtc.processEvent(ev);
        if (ev.kind === "trade") {
          priceSeriesBtc.push({ t: ev.timestamp, price: ev.price, sequence: ev.sequence });
        }
      }

      const recBtc = recognizeFlow(
        {
          sequence: btcEvents.length,
          timestamp: btcEvents[btcEvents.length - 1]?.timestamp ?? 0,
          priceSeries: priceSeriesBtc,
          orderFlow: ofBtc.snapshot(),
          dom: domBtc.snapshot(),
        },
        PROFILE_BINANCE_BTCUSDT_SPOT,
      );

      expect(recBtc.pattern).toBe("absorption");
      expect(recBtc.confidence).toBeGreaterThan(0.7);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 4. Synthetic Scenario Generation                                    */
  /* ------------------------------------------------------------------ */
  describe("4. Synthetic Scenario Generation", () => {
    test("preserves byte-identical default NQ scenario generation when no profile is passed", () => {
      const defaultGen = generateScenario("spring", 9999);
      const explicitNqGen = generateScenario("spring", 9999, { profile: PROFILE_CME_NQ });

      const defaultEvents = defaultGen.feed.events();
      const explicitNqEvents = explicitNqGen.feed.events();

      expect(defaultEvents.length).toBe(explicitNqEvents.length);
      expect(defaultEvents).toEqual(explicitNqEvents);
      expect(defaultGen.truth).toEqual(explicitNqGen.truth);
    });

    test("generates profile-aligned synthetic data for BTCUSDT and ES", () => {
      // BTC Spot scenario
      const btcGen = generateScenario("initiative-break", 777, {
        profile: PROFILE_BINANCE_BTCUSDT_SPOT,
      });
      const btcTrades = btcGen.feed.events().filter((e): e is TradeEvent => e.kind === "trade");
      expect(btcTrades.length).toBeGreaterThan(50);
      for (const t of btcTrades) {
        expect(t.price).toBeGreaterThan(60000);
        expect(t.price).toBeLessThan(70000);
        // Step aligned to 0.01
        expect(Math.round(t.price * 100) / 100).toBe(t.price);
      }

      // ES scenario
      const esGen = generateScenario("responsive-fade", 777, {
        profile: PROFILE_CME_ES,
      });
      const esTrades = esGen.feed.events().filter((e): e is TradeEvent => e.kind === "trade");
      expect(esTrades.length).toBeGreaterThan(50);
      for (const t of esTrades) {
        expect(t.price).toBeGreaterThan(4500);
        expect(t.price).toBeLessThan(5500);
        // Step aligned to 0.25
        expect(Number.isInteger(t.price / 0.25)).toBe(true);
      }
    });

    test("guarantees deterministic reproducibility for seeded synthetic scenarios across runs", () => {
      const gen1 = generateScenario("upthrust", 54321, { profile: PROFILE_BINANCE_BTCUSDT_FUTURES });
      const gen2 = generateScenario("upthrust", 54321, { profile: PROFILE_BINANCE_BTCUSDT_FUTURES });

      expect(gen1.feed.events()).toEqual(gen2.feed.events());
      expect(gen1.truth).toEqual(gen2.truth);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 5. Checkpoint Safety & Profile Compatibility Guard                  */
  /* ------------------------------------------------------------------ */
  describe("5. Checkpoint Safety & Profile Compatibility Guard", () => {
    test("tags checkpoints with stable profileId", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 101, profile: PROFILE_BINANCE_BTCUSDT_SPOT });
      const engine = new TrainingEngine(feed, null, { profile: PROFILE_BINANCE_BTCUSDT_SPOT });

      const cp = engine.captureCheckpoint();
      expect(cp.profileId).toBe("BINANCE:BTCUSDT-SPOT");
    });

    test("same-profile checkpoint restore works cleanly", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 101, profile: PROFILE_BINANCE_BTCUSDT_SPOT });
      const engine = new TrainingEngine(feed, null, { profile: PROFILE_BINANCE_BTCUSDT_SPOT });

      engine.stepForward(50);
      const cp50 = engine.captureCheckpoint();
      expect(cp50.eventIndex).toBe(50);

      engine.stepForward(50);
      expect(engine.eventIndex).toBe(100);

      engine.restoreCheckpoint(cp50);
      expect(engine.eventIndex).toBe(50);
      expect(engine.snapshot().eventIndex).toBe(50);
    });

    test("cross-profile checkpoint restore fails deterministically and leaves engine state unchanged", () => {
      // Engine configured for NQ
      const nqFeed = new SyntheticMarketDataFeed({ seed: 101, profile: PROFILE_CME_NQ });
      const nqEngine = new TrainingEngine(nqFeed, null, { profile: PROFILE_CME_NQ });
      nqEngine.stepForward(30);

      const stateBefore = {
        eventIndex: nqEngine.eventIndex,
        snapshot: nqEngine.snapshot(),
      };

      // Create a foreign checkpoint from BTC Spot
      const btcFeed = new SyntheticMarketDataFeed({ seed: 101, profile: PROFILE_BINANCE_BTCUSDT_SPOT });
      const btcEngine = new TrainingEngine(btcFeed, null, { profile: PROFILE_BINANCE_BTCUSDT_SPOT });
      btcEngine.stepForward(60);
      const foreignCheckpoint = btcEngine.captureCheckpoint();
      expect(foreignCheckpoint.profileId).toBe("BINANCE:BTCUSDT-SPOT");

      // Attempt to restore foreign checkpoint into NQ engine
      expect(() => {
        nqEngine.restoreCheckpoint(foreignCheckpoint);
      }).toThrow(/Checkpoint profile mismatch/);

      // Verify engine state is completely untouched
      expect(nqEngine.eventIndex).toBe(stateBefore.eventIndex);
      expect(nqEngine.snapshot().eventIndex).toBe(stateBefore.snapshot.eventIndex);
      expect(nqEngine.snapshot().sequence).toBe(stateBefore.snapshot.sequence);
      expect(nqEngine.snapshot().timestamp).toBe(stateBefore.snapshot.timestamp);
    });

    test("legacy checkpoints with undefined profileId restore without error", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 101, profile: PROFILE_CME_NQ });
      const engine = new TrainingEngine(feed, null, { profile: PROFILE_CME_NQ });
      engine.stepForward(40);

      const cp = engine.captureCheckpoint();
      // Simulate a legacy checkpoint without profileId
      const legacyCp: FlowEngineCheckpoint = {
        eventIndex: cp.eventIndex,
        sequence: cp.sequence,
        timestamp: cp.timestamp,
        feedPosition: cp.feedPosition,
        orderFlow: cp.orderFlow,
        dom: cp.dom,
        priceSeries: cp.priceSeries,
      };

      expect(legacyCp.profileId).toBeUndefined();

      engine.stepForward(20);
      expect(engine.eventIndex).toBe(60);

      // Legacy restore should succeed
      expect(() => engine.restoreCheckpoint(legacyCp)).not.toThrow();
      expect(engine.eventIndex).toBe(40);
    });

    test("checkpoint seek and rewind determinism is preserved", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 202, profile: PROFILE_CME_NQ });
      const engine = new TrainingEngine(feed, null, { checkpointInterval: 20 });

      // Run forward to 100
      engine.seekTo(100);
      const snapAt100 = engine.snapshot();

      // Seek back to 40
      engine.seekTo(40);
      const snapAt40 = engine.snapshot();
      expect(snapAt40.eventIndex).toBe(40);

      // Seek back to 100
      engine.seekTo(100);
      const snapAt100Again = engine.snapshot();

      expect(snapAt100Again.eventIndex).toBe(100);
      expect(snapAt100Again.sequence).toBe(snapAt100.sequence);
      expect(snapAt100Again.timestamp).toBe(snapAt100.timestamp);
      expect(snapAt100Again.priceSeries).toEqual(snapAt100.priceSeries);
    });
  });
});
