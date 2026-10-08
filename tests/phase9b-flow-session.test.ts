import { describe, expect, test } from "bun:test";
import { FlowTrainingSession, type FlowSessionSnapshot } from "../src/flow/session";
import { SyntheticMarketDataFeed, makeRng } from "../src/flow/synthetic";
import { generateScenario } from "../src/flow/scenarios";

/** Helper to compare observable session snapshots */
function assertSessionSnapshotsEqual(snapA: FlowSessionSnapshot, snapB: FlowSessionSnapshot, context = "") {
  // Event Clock & Feed
  expect(snapB.eventIndex).toBe(snapA.eventIndex);
  expect(snapB.totalEvents).toBe(snapA.totalEvents);
  expect(snapB.atStart).toBe(snapA.atStart);
  expect(snapB.atEnd).toBe(snapA.atEnd);
  expect(snapB.sequence).toBe(snapA.sequence);
  expect(snapB.timestamp).toBe(snapA.timestamp);

  // Core OrderFlow state
  expect(snapB.orderFlow.totalVolume).toBe(snapA.orderFlow.totalVolume);
  expect(snapB.orderFlow.delta).toBe(snapA.orderFlow.delta);
  expect(snapB.orderFlow.cumulativeDelta).toBe(snapA.orderFlow.cumulativeDelta);
  expect(snapB.orderFlow.vwap).toBe(snapA.orderFlow.vwap);
  expect(snapB.orderFlow.lastPrice).toBe(snapA.orderFlow.lastPrice);
  expect(snapB.orderFlow.cvdSeries).toEqual(snapA.orderFlow.cvdSeries);
  expect(snapB.orderFlow.tape).toEqual(snapA.orderFlow.tape);
  expect(snapB.orderFlow.volumeAtPrice).toEqual(snapA.orderFlow.volumeAtPrice);

  // Core DOM state
  expect(snapB.dom.hasBook).toBe(snapA.dom.hasBook);
  expect(snapB.dom.bestBid).toBe(snapA.dom.bestBid);
  expect(snapB.dom.bestAsk).toBe(snapA.dom.bestAsk);
  expect(snapB.dom.bids).toEqual(snapA.dom.bids);
  expect(snapB.dom.asks).toEqual(snapA.dom.asks);

  // Price Series
  expect(snapB.priceSeries).toEqual(snapA.priceSeries);

  // AMA State
  expect(snapB.ama).toBe(snapA.ama);
  expect(snapB.amaSeries).toEqual(snapA.amaSeries);

  // Evidence & Recognition State
  expect(snapB.evidence).toEqual(snapA.evidence);
  expect(snapB.recognition).toEqual(snapA.recognition);

  // Timeline & Annotations
  expect(snapB.timeline).toEqual(snapA.timeline);
  expect(snapB.annotations).toEqual(snapA.annotations);

  // Execution & Position
  expect(snapB.position).toEqual(snapA.position);
}

describe("Phase 9.B-4 FlowTrainingSession Checkpoint Replay Integration", () => {
  /* -------------------------------------------------------------------------
     1. Accelerated Session Seek & Metrics Delegation
     ------------------------------------------------------------------------- */
  describe("Accelerated Session Seek Delegation", () => {
    test("seekTo delegates to TrainingEngine accelerated path and records SeekMetrics", () => {
      const feed = new SyntheticMarketDataFeed({
        seed: 42,
        plan: [{ kind: "meander", trades: 80_000 }],
      });
      const session = new FlowTrainingSession(feed, null, { checkpointInterval: 10_000 });

      // Forward seek to 50,000
      session.seekTo(50_000);
      expect(session.eventIndex).toBe(50_000);

      // Seek back to 21,000
      session.seekTo(21_000);
      expect(session.eventIndex).toBe(21_000);

      const metrics = session.lastSeekMetrics;
      expect(metrics).not.toBeNull();
      expect(metrics!.targetIndex).toBe(21_000);
      expect(metrics!.checkpointIndex).toBe(20_000);
      expect(metrics!.rolledEvents).toBe(1_000);
      expect(metrics!.rolledEvents).toBeLessThanOrEqual(9_999);
    });

    test("aliases stepForward() and seek() work identically", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 101 });
      const session = new FlowTrainingSession(feed, null, { checkpointInterval: 50 });

      session.stepForward(20);
      expect(session.eventIndex).toBe(20);

      session.seek(50);
      expect(session.eventIndex).toBe(50);
      expect(session.checkpointManager.has(50)).toBe(true);
    });
  });

  /* -------------------------------------------------------------------------
     2. Sequential vs Checkpoint Session Equivalence
     ------------------------------------------------------------------------- */
  describe("Sequential vs Checkpoint Session Equivalence", () => {
    test("matches sequential session state across key boundaries up to 100k", () => {
      const seed = 888;
      const K = 10_000;
      const feedA = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 75_000 }],
      });
      const feedB = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 75_000 }],
      });

      const sessionSeq = new FlowTrainingSession(feedA, null, { checkpointInterval: K });
      const sessionSeek = new FlowTrainingSession(feedB, null, { checkpointInterval: K });

      // Warm up sessionSeek to establish checkpoints
      sessionSeek.seekTo(100_000);

      const targets = [
        0,
        1,
        K - 1, // 9,999
        K, // 10,000
        K + 1, // 10,001
        2 * K - 1, // 19,999
        2 * K, // 20,000
        2 * K + 1, // 20,001
        50_000,
        100_000,
      ];

      for (const T of targets) {
        sessionSeq.reset();
        if (T > 0) sessionSeq.step(T);

        sessionSeek.reset();
        sessionSeek.seekTo(T);

        const snapSeq = sessionSeq.snapshot();
        const snapSeek = sessionSeek.snapshot();

        assertSessionSnapshotsEqual(snapSeq, snapSeek, `at target ${T}`);
      }
    });
  });

  /* -------------------------------------------------------------------------
     3. Randomized Session Targets
     ------------------------------------------------------------------------- */
  describe("Randomized Session Targets", () => {
    test("verifies 25 pseudo-random targets across 100k events", () => {
      const seed = 321;
      const rng = makeRng(777);
      const targets: number[] = [];
      for (let i = 0; i < 25; i++) {
        targets.push(Math.floor(rng() * 100_000));
      }

      for (const T of targets) {
        const feedRef = new SyntheticMarketDataFeed({
          seed,
          plan: [{ kind: "meander", trades: 75_000 }],
        });
        const feedSeek = new SyntheticMarketDataFeed({
          seed,
          plan: [{ kind: "meander", trades: 75_000 }],
        });
        const sessionRef = new FlowTrainingSession(feedRef, null, { checkpointInterval: 10_000 });
        const sessionSeek = new FlowTrainingSession(feedSeek, null, { checkpointInterval: 10_000 });
        if (T > 0) sessionRef.step(T);

        sessionSeek.seekTo(T);

        assertSessionSnapshotsEqual(sessionRef.snapshot(), sessionSeek.snapshot(), `at random target ${T}`);
      }
    }, 30_000);
  });

  /* -------------------------------------------------------------------------
     4. Nonlinear Repeated Seek Sequences
     ------------------------------------------------------------------------- */
  describe("Nonlinear Repeated Seek Sequence", () => {
    test("sequence 0 -> 50k -> 10k -> 99999 -> 20k -> 100001 -> 0 -> 75k matches fresh replays", () => {
      const seed = 444;
      const feed = new SyntheticMarketDataFeed({
        seed,
        plan: [{ kind: "meander", trades: 80_000 }],
      });
      const total = feed.totalEvents();
      expect(total).toBeGreaterThanOrEqual(100_002);

      const session = new FlowTrainingSession(feed, null, { checkpointInterval: 10_000 });
      session.seekTo(total);

      const sequence = [
        0,
        50_000,
        10_000,
        99_999,
        20_000,
        100_001,
        0,
        75_000,
      ];

      for (const T of sequence) {
        const feedRef = new SyntheticMarketDataFeed({
          seed,
          plan: [{ kind: "meander", trades: 80_000 }],
        });
        const sessionRef = new FlowTrainingSession(feedRef, null, { checkpointInterval: 10_000 });
        sessionRef.step(T);

        session.seekTo(T);
        assertSessionSnapshotsEqual(sessionRef.snapshot(), session.snapshot(), `at nonlinear step ${T}`);
      }
    }, 30_000);
  });

  /* -------------------------------------------------------------------------
     5. Step-Back Behavior
     ------------------------------------------------------------------------- */
  describe("Step-Back Behavior", () => {
    test("step-back at 10k, 50k, and 100k rolls exactly K-1 events from previous checkpoint", () => {
      const feed = new SyntheticMarketDataFeed({
        seed: 666,
        plan: [{ kind: "meander", trades: 75_000 }],
      });
      const session = new FlowTrainingSession(feed, null, { checkpointInterval: 10_000 });
      session.seekTo(100_000);

      const testPoints = [10_000, 50_000, 100_000];

      for (const pt of testPoints) {
        session.seekTo(pt);
        expect(session.eventIndex).toBe(pt);

        session.stepBack();
        expect(session.eventIndex).toBe(pt - 1);

        const metrics = session.lastSeekMetrics;
        expect(metrics).not.toBeNull();
        expect(metrics!.targetIndex).toBe(pt - 1);
        expect(metrics!.checkpointIndex).toBe(pt - 10_000);
        expect(metrics!.rolledEvents).toBe(9_999);
      }
    });
  });

  /* -------------------------------------------------------------------------
     6. Recognition Invalidation & No Future Leakage
     ------------------------------------------------------------------------- */
  describe("Recognition Invalidation Across Backward Seek", () => {
    test("seeking backward invalidates future recognition and rebuilds from restored state", () => {
      const scenario = generateScenario("spring", 42);
      const session = new FlowTrainingSession(scenario.feed, scenario.truth, { checkpointInterval: 100 });

      // Run forward to 300
      session.step(300);
      const snap300 = session.snapshot();
      expect(snap300.eventIndex).toBe(300);

      // Seek backward to 150
      session.seekTo(150);
      const snap150 = session.snapshot();
      expect(snap150.eventIndex).toBe(150);

      // Compare against fresh session stopped at 150
      const freshScenario = generateScenario("spring", 42);
      const freshSession = new FlowTrainingSession(freshScenario.feed, freshScenario.truth, { checkpointInterval: 100 });
      freshSession.step(150);
      const snapFresh150 = freshSession.snapshot();

      expect(snap150.evidence).toEqual(snapFresh150.evidence);

      // When revealed, recognition structure matches fresh run at 150 exactly
      session.markRevealed();
      freshSession.markRevealed();
      expect(session.snapshot().recognition).toEqual(freshSession.snapshot().recognition);
    });
  });

  /* -------------------------------------------------------------------------
     7. Timeline Truncation, Reconstruction & No Future Leakage
     ------------------------------------------------------------------------- */
  describe("Timeline Truncation & Lazy Reconstruction", () => {
    test("backward seek purges future timeline entries and annotations", () => {
      const scenario = generateScenario("absorption", 99);
      const session = new FlowTrainingSession(scenario.feed, scenario.truth, { checkpointInterval: 100 });
      session.markRevealed();

      // Step forward to 500 to accumulate timeline events
      session.step(500);
      const snap500 = session.snapshot();
      expect(snap500.timeline.length).toBeGreaterThan(0);

      // Seek backward to 200
      session.seekTo(200);
      const snap200 = session.snapshot();

      // Zero entries with index > 200
      for (const entry of snap200.timeline) {
        expect(entry.index).toBeLessThanOrEqual(200);
      }
      for (const annotation of snap200.annotations) {
        expect(annotation.seq).toBeLessThanOrEqual(snap200.sequence);
      }

      // Step forward by 10 events: advances cleanly without re-reading past 210
      session.step(10);
      expect(session.eventIndex).toBe(210);
      for (const entry of session.snapshot().timeline) {
        expect(entry.index).toBeLessThanOrEqual(210);
      }
    });
  });

  /* -------------------------------------------------------------------------
     8. AMA Invalidation & Reconstruction
     ------------------------------------------------------------------------- */
  describe("AMA Invalidation Across Backward Seek", () => {
    test("AMA state after backward seek matches fresh run at target exactly", () => {
      const feedA = new SyntheticMarketDataFeed({ seed: 555 });
      const feedB = new SyntheticMarketDataFeed({ seed: 555 });

      const session = new FlowTrainingSession(feedA, null, { checkpointInterval: 50 });
      const freshSession = new FlowTrainingSession(feedB, null, { checkpointInterval: 50 });

      session.step(300);
      session.seekTo(120);

      freshSession.step(120);

      const snapSeek = session.snapshot();
      const snapFresh = freshSession.snapshot();

      expect(snapSeek.ama).toBe(snapFresh.ama);
      expect(snapSeek.amaSeries).toEqual(snapFresh.amaSeries);
    });
  });

  /* -------------------------------------------------------------------------
     9. Execution State Safety
     ------------------------------------------------------------------------- */
  describe("Execution State Safety", () => {
    test("open position prevents replayFromStart() until flattened", () => {
      const scenario = generateScenario("spring", 77);
      const session = new FlowTrainingSession(scenario.feed, scenario.truth);
      session.warmup(50);
      session.step(20);

      // Open a position
      const buyRes = session.buy();
      expect(buyRes.ok).toBe(true);
      expect(session.snapshot().position.side).toBe("LONG");

      // replayFromStart refused while open
      expect(session.replayFromStart()).toBe(false);
      expect(session.snapshot().notice?.text).toContain("FLATTEN");

      // Flatten position
      session.flatten();
      expect(session.snapshot().position.side).toBe("FLAT");

      // Now replayFromStart succeeds
      expect(session.replayFromStart()).toBe(true);
      expect(session.eventIndex).toBe(0);
      expect(session.snapshot().trades.length).toBe(1); // Journal record kept
    });
  });

  /* -------------------------------------------------------------------------
     10. Blind-Mode Safety Invariants
     ------------------------------------------------------------------------- */
  describe("Blind-Mode Safety Invariants", () => {
    test("secrets remain unexposed across seek -> step -> seek back -> seek forward -> reset", () => {
      const scenario = generateScenario("upthrust", 123);
      const session = new FlowTrainingSession(scenario.feed, scenario.truth, { checkpointInterval: 50 });

      const lifecycle = [100, 150, 50, 200, 0, 80];

      for (const target of lifecycle) {
        if (target === 0) {
          session.reset();
        } else {
          session.seekTo(target);
        }

        const snap = session.snapshot();
        // Blind mode guarantees
        expect(snap.recognition).toBeNull();
        expect(snap.timeline).toEqual([]);
        expect(session.isRevealed).toBe(false);
        expect(session.results()).toBeNull();

        // Trades view does not disclose hidden pattern before reveal
        for (const t of snap.trades) {
          expect(t.hiddenPattern).toBeNull();
        }
      }

      // Only markRevealed unlocks results and pattern
      session.markRevealed();
      expect(session.isRevealed).toBe(true);
      expect(session.results()).not.toBeNull();
      expect(session.snapshot().recognition).not.toBeNull();
    });
  });

  /* -------------------------------------------------------------------------
     11. End-of-Feed Invariants
     ------------------------------------------------------------------------- */
  describe("End-of-Feed Invariants", () => {
    test("session handles event 0, totalEvents, and beyond cleanly", () => {
      const feed = new SyntheticMarketDataFeed({ seed: 202 });
      const total = feed.totalEvents();
      const session = new FlowTrainingSession(feed, null, { checkpointInterval: 50 });

      // Event 0
      session.seekTo(0);
      expect(session.eventIndex).toBe(0);
      expect(session.snapshot().atStart).toBe(true);
      expect(session.snapshot().atEnd).toBe(false);

      // Event totalEvents
      session.seekTo(total);
      expect(session.eventIndex).toBe(total);
      expect(session.snapshot().atStart).toBe(false);
      expect(session.snapshot().atEnd).toBe(true);

      // Beyond totalEvents
      session.seekTo(total + 500);
      expect(session.eventIndex).toBe(total);
      expect(session.snapshot().atEnd).toBe(true);
    });
  });
});
