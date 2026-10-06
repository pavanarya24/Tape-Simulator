/**
 * Phase 8A — advanced replay engine / controls.
 *
 * Covers spec §12 REPLAY + TIMELINE: play progression policy, pause semantics,
 * speed independence, step forward/back, reset, deterministic seek/rebuild, no
 * future leakage, timeline progress, step units (EVENT/TRADE/TIME) and the
 * controller-level replay state (modes, speeds, review gating).
 *
 * The replay clock itself is the session's event clock — every advance in this
 * file goes through it, never through a second clock.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import {
  FLOW_REPLAY_MODES,
  FLOW_REPLAY_SPEEDS,
  FLOW_STEP_UNITS,
  DEFAULT_FLOW_SPEED,
  REPLAY_MIN_TICK_MS,
  TIME_STEP_MS,
  playbackBatch,
  replayPolicy,
  replayProgressPct,
  resolveReplayMode,
} from "../src/flow/replay";
import { generateScenario, type FlowScenarioId } from "../src/flow/scenarios";
import { FlowTrainingSession, type FlowSessionSnapshot } from "../src/flow/session";

const PATTERNS: FlowScenarioId[] = ["spring", "upthrust", "absorption", "initiative-break", "responsive-fade"];

/** Only the deterministic market state — never trader/session bookkeeping. */
function marketState(s: FlowSessionSnapshot) {
  return {
    eventIndex: s.eventIndex,
    sequence: s.sequence,
    timestamp: s.timestamp,
    orderFlow: s.orderFlow,
    dom: s.dom,
    book: s.book,
    priceSeries: s.priceSeries,
    amaSeries: s.amaSeries,
    ama: s.ama,
    evidence: s.evidence,
    annotations: s.annotations,
  };
}

function sessionFor(id: FlowScenarioId, seed: number, difficulty: "BEGINNER" | "ADVANCED" = "BEGINNER") {
  const g = generateScenario(id, seed, { difficulty });
  return new FlowTrainingSession(g.feed, g.truth, { sessionId: "phase8", difficulty });
}

/* =========================== 8A.1 policy =========================== */

describe("8A playback speeds and step units", () => {
  test("all eight speeds and all three step units are selectable", () => {
    expect([...FLOW_REPLAY_SPEEDS]).toEqual([0.25, 0.5, 1, 2, 5, 10, 25, 50]);
    expect([...FLOW_STEP_UNITS]).toEqual(["EVENT", "TRADE", "TIME"]);
    expect(DEFAULT_FLOW_SPEED).toBe(1);
  });

  test("speed changes the batch only — always whole events, never sub-event", () => {
    for (const speed of FLOW_REPLAY_SPEEDS) {
      const b = playbackBatch(speed);
      expect(Number.isInteger(b.eventsPerTick)).toBe(true);
      expect(b.eventsPerTick).toBeGreaterThanOrEqual(1);
      expect(b.intervalMs).toBeGreaterThanOrEqual(REPLAY_MIN_TICK_MS);
    }
    expect(playbackBatch(0.25).eventsPerTick).toBe(1);
    expect(playbackBatch(1).eventsPerTick).toBe(1);
    expect(playbackBatch(50).eventsPerTick).toBe(50);
    // Slow speeds keep one event per tick and stretch the interval.
    expect(playbackBatch(0.25).intervalMs).toBeGreaterThan(playbackBatch(1).intervalMs);
  });

  test("speed independence: the same event sequence results from any speed", () => {
    // Replaying N events in different batch sizes must land on identical state.
    const a = sessionFor("absorption", 808, "ADVANCED");
    a.step(200);

    const b = sessionFor("absorption", 808, "ADVANCED");
    // 50× batches of 50, then a 25× batch of 25 …
    for (const batch of [50, 50, 50, 25, 25]) b.step(batch);

    expect(b.eventIndex).toBe(a.eventIndex);
    expect(JSON.stringify(marketState(b.snapshot()))).toBe(JSON.stringify(marketState(a.snapshot())));
  });

  test("playback progression stops exactly at the end of the scenario", () => {
    const s = sessionFor("spring", 12);
    let tick = 0;
    while (s.step(10) > 0 && tick < 10_000) tick++;
    expect(s.snapshot().atEnd).toBe(true);
    expect(s.step(10)).toBe(0);
    expect(s.eventIndex).toBe(s.totalEvents);
  });

  test("pause semantics: no step is taken while paused (no advance is implicit)", () => {
    const s = sessionFor("upthrust", 12);
    s.step(80);
    const before = marketState(s.snapshot());
    // "Paused" = nobody calls step. Reading state must never move the clock.
    const a = s.snapshot();
    const b = s.snapshot();
    expect(a.eventIndex).toBe(b.eventIndex);
    expect(JSON.stringify(marketState(a))).toBe(JSON.stringify(marketState(b)));
    expect(s.eventIndex).toBe(80);
    expect(JSON.stringify(marketState(s.snapshot()))).toBe(JSON.stringify(before));
  });
});

/* ========================= 8A.3 replay modes ========================= */

describe("8A.3 replay modes and gating policy", () => {
  test("all four modes exist and REVIEW degrades to BLIND before reveal", () => {
    expect([...FLOW_REPLAY_MODES]).toEqual(["LIVE", "BLIND", "BAR_CONTEXT", "REVIEW"]);
    for (const mode of FLOW_REPLAY_MODES) {
      expect(resolveReplayMode(mode, false)).not.toBe("REVIEW");
      expect(resolveReplayMode(mode, true)).toBe(mode);
    }
    expect(resolveReplayMode("REVIEW", false)).toBe("BLIND");
  });

  test("no mode ever permits reading future events", () => {
    for (const mode of FLOW_REPLAY_MODES) {
      for (const revealed of [false, true]) {
        expect(replayPolicy(mode, revealed).futureEvents).toBe(false);
      }
    }
  });

  test("trade markers, forward seek and review navigation unlock only in REVIEW", () => {
    for (const mode of FLOW_REPLAY_MODES) {
      const blind = replayPolicy(mode, false);
      expect(blind.tradeMarkers).toBe(false);
      expect(blind.forwardSeek).toBe(false);
      expect(blind.reviewNavigation).toBe(false);
    }
    const review = replayPolicy("REVIEW", true);
    expect(review.tradeMarkers).toBe(true);
    expect(review.forwardSeek).toBe(true);
    expect(review.reviewNavigation).toBe(true);
    // A requested REVIEW while blind still resolves blind.
    expect(replayPolicy(resolveReplayMode("REVIEW", false), false).tradeMarkers).toBe(false);
  });

  test("BAR_CONTEXT only coarsens the grain — it never unlocks future data", () => {
    const ctxPolicy = replayPolicy("BAR_CONTEXT", false);
    expect(ctxPolicy.coarseContext).toBe(true);
    expect(ctxPolicy.tradeMarkers).toBe(false);
    expect(ctxPolicy.forwardSeek).toBe(false);
    expect(replayPolicy("LIVE", false).coarseContext).toBe(false);
  });
});

/* ============================ timeline ============================ */

describe("8A.2 timeline progress", () => {
  test("progress is bounded, monotonic with the clock and 0 at the start", () => {
    expect(replayProgressPct(0, 500)).toBe(0);
    expect(replayProgressPct(250, 500)).toBe(50);
    expect(replayProgressPct(500, 500)).toBe(100);
    expect(replayProgressPct(999, 500)).toBe(100);
    expect(replayProgressPct(0, 0)).toBe(0);
    expect(replayProgressPct(10, 3)).toBe(100);
  });

  test("the timeline tracks the session clock: index, timestamp and percentage", () => {
    const s = sessionFor("responsive-fade", 303, "ADVANCED");
    s.step(150);
    const mid = s.snapshot();
    expect(mid.eventIndex).toBe(150);
    expect(replayProgressPct(mid.eventIndex, mid.totalEvents)).toBeGreaterThan(0);
    expect(replayProgressPct(mid.eventIndex, mid.totalEvents)).toBeLessThan(100);
    expect(mid.timestamp).not.toBeNull();

    s.step(s.totalEvents - s.eventIndex);
    const end = s.snapshot();
    expect(end.atEnd).toBe(true);
    expect(replayProgressPct(end.eventIndex, end.totalEvents)).toBe(100);
    expect(end.timestamp!).toBeGreaterThanOrEqual(mid.timestamp!);
  });
});

/* ======================= deterministic seek ======================= */

describe("8A.2 seeking rebuilds deterministically (spec §8A.2)", () => {
  test("seek to N is byte-equivalent to reset → replay events 0..N", () => {
    for (const id of PATTERNS) {
      const direct = sessionFor(id, 4242, "ADVANCED");
      direct.step(300);
      const wandered = sessionFor(id, 4242, "ADVANCED");
      wandered.step(700);
      wandered.stepBack();
      wandered.stepBack();
      wandered.seekTo(300);
      expect(JSON.stringify(marketState(wandered.snapshot()))).toBe(
        JSON.stringify(marketState(direct.snapshot())),
      );
    }
  });

  test("seeking backward from the end matches a fresh forward run", () => {
    const s = sessionFor("initiative-break", 777, "INTERMEDIATE");
    s.step(s.totalEvents);
    s.seekTo(120);
    const rewind = s.snapshot();
    const fresh = sessionFor("initiative-break", 777, "INTERMEDIATE");
    fresh.step(120);
    expect(JSON.stringify(marketState(rewind))).toBe(JSON.stringify(marketState(fresh.snapshot())));
  });

  test("step-back is a deterministic rebuild, not a mutation", () => {
    const s = sessionFor("responsive-fade", 909, "INTERMEDIATE");
    s.step(200);
    const at200 = s.snapshot();
    s.step(25);
    s.stepBack();
    expect(s.eventIndex).toBe(224);
    s.seekTo(200);
    expect(JSON.stringify(marketState(s.snapshot()))).toBe(JSON.stringify(marketState(at200)));
  });

  test("reset clears the clock and every piece of market state", () => {
    const s = sessionFor("absorption", 55);
    s.step(400);
    s.reset();
    const snap = s.snapshot();
    expect(snap.eventIndex).toBe(0);
    expect(snap.sequence).toBe(0);
    expect(snap.timestamp).toBeNull();
    expect(snap.priceSeries).toEqual([]);
    expect(snap.orderFlow.tape).toEqual([]);
    expect(snap.book).toBeNull();
    expect(snap.ama).toBeNull();
  });

  test("seeking past the end clamps to the total event count", () => {
    const s = sessionFor("upthrust", 88);
    s.seekTo(999_999);
    expect(s.eventIndex).toBe(s.totalEvents);
    expect(s.snapshot().atEnd).toBe(true);
  });
});

/* ========================== step units ========================== */

describe("8A.1 EVENT / TRADE / TIME step units", () => {
  test("EVENT advances exactly N events", () => {
    const s = sessionFor("spring", 21);
    const taken = s.stepByUnit("EVENT", 5);
    expect(taken).toBe(5);
    expect(s.eventIndex).toBe(5); // exactly the events asked for
  });

  test("TRADE advances until the next print lands on the tape", () => {
    const s = sessionFor("spring", 21);
    const before = s.snapshot().orderFlow.tradeCount;
    const taken = s.stepByUnit("TRADE", 1);
    expect(taken).toBeGreaterThanOrEqual(1);
    expect(s.snapshot().orderFlow.tradeCount).toBeGreaterThan(before);
  });

  test("TRADE can cross several prints when asked", () => {
    const s = sessionFor("absorption", 33, "INTERMEDIATE");
    const before = s.snapshot().orderFlow.tradeCount;
    s.stepByUnit("TRADE", 5);
    expect(s.snapshot().orderFlow.tradeCount - before).toBeGreaterThanOrEqual(5);
  });

  test("TIME advances the tape clock by at least one TIME step", () => {
    const s = sessionFor("responsive-fade", 44, "INTERMEDIATE");
    const before = s.snapshot().timestamp!;
    s.stepByUnit("TIME", 1);
    const after = s.snapshot();
    expect(after.timestamp! - before).toBeGreaterThanOrEqual(TIME_STEP_MS);
    expect(after.eventIndex).toBeGreaterThan(0);
  });

  test("a step unit never advances past the end of the scenario", () => {
    for (const unit of FLOW_STEP_UNITS) {
      const s = sessionFor("initiative-break", 66);
      s.seekTo(s.totalEvents);
      expect(s.stepByUnit(unit, 3)).toBe(0);
      expect(s.eventIndex).toBe(s.totalEvents);
    }
  });

  test("unit stepping equals the same number of single-event steps", () => {
    const a = sessionFor("upthrust", 71, "INTERMEDIATE");
    const taken = a.stepByUnit("TRADE", 4);

    const b = sessionFor("upthrust", 71, "INTERMEDIATE");
    for (let i = 0; i < taken; i++) b.step(1);

    expect(b.eventIndex).toBe(a.eventIndex);
    expect(JSON.stringify(marketState(b.snapshot()))).toBe(JSON.stringify(marketState(a.snapshot())));
  });
});

/* ====================== no future leakage ====================== */

describe("8A no future events ever leak (spec §8A/§13)", () => {
  test("every revealed datum is at or before the clock's sequence", () => {
    for (const id of PATTERNS) {
      const s = sessionFor(id, 1234, "BEGINNER");
      s.step(220);
      const snap = s.snapshot();
      expect(snap.eventIndex).toBe(220);
      expect(snap.sequence).toBeLessThanOrEqual(220); // sequences are dense, 1-based
      for (const t of snap.orderFlow.tape) expect(t.sequence).toBeLessThanOrEqual(snap.sequence);
      for (const p of snap.priceSeries) expect(p.sequence).toBeLessThanOrEqual(snap.sequence);
      for (const e of snap.evidence) expect(e.sequence).toBeLessThanOrEqual(snap.sequence);
      for (const a of snap.annotations) expect(a.seq).toBeLessThanOrEqual(snap.sequence);
      if (snap.book) {
        for (const l of [...snap.book.bids, ...snap.book.asks]) {
          expect(Number.isFinite(l.price)).toBe(true);
        }
      }
    }
  });

  test("a shorter clock always produces the prefix of a longer run", () => {
    const short = sessionFor("absorption", 2, "BEGINNER");
    short.step(140);
    const long = sessionFor("absorption", 2, "BEGINNER");
    long.step(200);
    const shortSeries = short.snapshot().priceSeries;
    const longSeries = long.snapshot().priceSeries;
    expect(shortSeries.length).toBeLessThanOrEqual(longSeries.length);
    expect(shortSeries).toEqual(longSeries.slice(0, shortSeries.length));
  });

  test("blind state exposes no engine answer; revealed state does", () => {
    const s = sessionFor("spring", 9);
    s.step(300);
    const blind = s.snapshot();
    expect(blind.recognition).toBeNull();
    expect(blind.timeline).toEqual([]);
    s.markRevealed();
    const shown = s.snapshot();
    expect(shown.recognition).not.toBeNull();
    expect(shown.timeline.length).toBeGreaterThan(0);
    expect(shown.eventIndex).toBe(blind.eventIndex); // reveal never moves the clock
    expect(shown.sequence).toBe(blind.sequence);
  });
});

/* ==================== controller replay wiring ==================== */

describe("8A controller replay state", () => {
  let controller: import("../src/state/app").TapeLabController;

  beforeAll(async () => {
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
    await controller.initialize();
  });

  test("mode, speed and step unit reach FlowState and default sensibly", () => {
    controller.generateFlowScenario("spring");
    let flow = controller.getState().flow;
    expect(flow.replayMode).toBe("LIVE");
    expect(flow.effectiveReplayMode).toBe("LIVE");
    expect(flow.speed).toBe(DEFAULT_FLOW_SPEED);
    expect(flow.stepUnit).toBe("EVENT");
    expect(flow.policy.tradeMarkers).toBe(false);

    controller.setFlowSpeed(25);
    controller.setFlowStepUnit("TRADE");
    controller.setFlowReplayMode("BAR_CONTEXT");
    flow = controller.getState().flow;
    expect(flow.speed).toBe(25);
    expect(flow.stepUnit).toBe("TRADE");
    expect(flow.policy.coarseContext).toBe(true);
    expect(flow.policy.forwardSeek).toBe(false);
  });

  test("while blind, seeking forward is refused and seeking back is deterministic", () => {
    controller.setFlowReplayMode("LIVE");
    controller.generateFlowScenario("absorption");
    const start = controller.getState().flow.eventIndex;
    expect(start).toBe(60);
    controller.stepFlow(120);
    expect(controller.getState().flow.eventIndex).toBe(180);

    // forward peek while blind → refused
    expect(controller.seekFlow(400)).toBe(false);
    expect(controller.getState().flow.eventIndex).toBe(180);

    // backward seek → allowed, and re-walking lands on the identical state
    expect(controller.seekFlow(120)).toBe(true);
    const rewound = controller.getState().flow;
    expect(rewound.eventIndex).toBe(120);
    controller.stepFlow(60);
    const again = controller.getState().flow;
    expect(again.eventIndex).toBe(180);
    expect(again.progressPct).toBe(replayProgressPct(again.eventIndex, again.totalEvents));
  });

  test("progress percentage and current timestamp track the clock", () => {
    const flow = controller.getState().flow;
    expect(flow.progressPct).toBeGreaterThan(0);
    expect(flow.timestamp).not.toBeNull();
    expect(replayProgressPct(flow.eventIndex, flow.totalEvents)).toBe(flow.progressPct);
  });

  test("REVIEW unlocks only after reveal, and forward seek then works", () => {
    controller.setFlowReplayMode("REVIEW");
    let flow = controller.getState().flow;
    expect(flow.effectiveReplayMode).not.toBe("REVIEW");
    expect(flow.policy.forwardSeek).toBe(false);

    controller.stepFlow(60);
    controller.revealFlow();
    flow = controller.getState().flow;
    expect(flow.replayMode).toBe("REVIEW");
    expect(flow.effectiveReplayMode).toBe("REVIEW");
    expect(flow.policy.forwardSeek).toBe(true);
    expect(flow.policy.tradeMarkers).toBe(true);

    const total = flow.totalEvents;
    expect(controller.seekFlow(total)).toBe(true);
    expect(controller.getState().flow.eventIndex).toBe(total);
    expect(controller.getState().flow.progressPct).toBe(100);

    // REVIEW navigation is deterministic: jumping around reproduces the state.
    controller.seekFlow(100);
    const a = controller.getState().flow;
    controller.seekFlow(total);
    controller.seekFlow(100);
    const b = controller.getState().flow;
    expect(JSON.stringify(a.orderFlow)).toBe(JSON.stringify(b.orderFlow));
    expect(JSON.stringify(a.book)).toBe(JSON.stringify(b.book));
  });

  test("a fresh scenario never inherits REVIEW", () => {
    controller.generateFlowScenario("upthrust");
    const flow = controller.getState().flow;
    expect(flow.replayMode).toBe("LIVE");
    expect(flow.effectiveReplayMode).toBe("LIVE");
    expect(flow.policy.tradeMarkers).toBe(false);
  });

  test("play progression advances the clock until the scenario ends", () => {
    controller.generateFlowScenario("spring");
    const batch = playbackBatch(50);
    let guard = 0;
    while (controller.stepFlow(batch.eventsPerTick) && guard < 200) guard++;
    const flow = controller.getState().flow;
    expect(flow.atEnd).toBe(true);
    expect(controller.stepFlow(1)).toBe(false);
  });
});
