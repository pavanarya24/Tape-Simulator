/**
 * Phase 7B — Flow Recognition & Training Intelligence.
 *
 * Covers spec §16: deterministic recognition, seed variation, no
 * ScenarioTruth access, blind-mode state, observable evidence, the five
 * pattern recognitions, unknown/ambiguous behaviour, confidence bounds,
 * seek/rebuild + restart consistency, evidence timeline, recognition
 * scoring, trader-vs-engine comparison, difficulty behaviour and
 * anti-memorization randomization — plus the existing suites.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { CONTRACTS } from "../src/market/instruments";
import {
  FLOW_DIFFICULTIES,
  FLOW_SCENARIOS,
  generateScenario,
  type FlowDifficulty,
  type FlowScenarioId,
} from "../src/flow/scenarios";
import { TrainingEngine } from "../src/flow/training";
import {
  flowEvidenceLabel,
  recognizeFlow,
  rankFlowPatterns,
  RECOGNITION_MIN_POINTS,
  RECOGNITION_MIN_SCORE,
  type FlowAnnotationType,
} from "../src/flow/recognition";
import { FlowTrainingSession } from "../src/flow/session";
import {
  computeFlowTrainingStats,
  scoreFlowSession,
  type FlowSessionResults,
} from "../src/flow/scoring";
import { DEFAULT_FLOW_DECISION, DEFAULT_FLOW_RISK } from "../src/flow/execution";

const PATTERN_IDS: FlowScenarioId[] = ["spring", "upthrust", "absorption", "initiative-break", "responsive-fade"];
const FORBIDDEN_WORDS = ["spring", "upthrust", "absorption", "initiative", "responsive", "confidence", "characteristics", "startEvent"];

function fullSnapshot(id: FlowScenarioId, seed: number, difficulty: FlowDifficulty = "BEGINNER") {
  const g = generateScenario(id, seed, { difficulty });
  const engine = new TrainingEngine(g.feed, g.truth);
  engine.stepForward(engine.totalEvents);
  return { g, engine, snap: engine.snapshot() };
}

/* --------------- 1. deterministic recognition --------------- */

describe("deterministic recognition", () => {
  test("the same seed and difficulty produce byte-identical recognition", () => {
    for (const id of PATTERN_IDS) {
      const a = fullSnapshot(id, 11);
      const b = fullSnapshot(id, 11);
      expect(JSON.stringify(recognizeFlow(a.snap))).toBe(JSON.stringify(recognizeFlow(b.snap)));
      expect(a.snap.sequence).toBe(b.snap.sequence);
      expect(a.snap.priceSeries).toEqual(b.snap.priceSeries);
    }
  });

  test("recognition is a pure function of the snapshot (repeat calls agree)", () => {
    const { snap } = fullSnapshot("absorption", 505, "INTERMEDIATE");
    const first = recognizeFlow(snap);
    const second = recognizeFlow(snap);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

/* --------------- 2. different seeds produce different paths --------------- */

describe("different seeds produce materially different paths", () => {
  test("for every pattern, seeds 11 / 505 / 99991 diverge", () => {
    for (const id of PATTERN_IDS) {
      const paths = [11, 505, 99991].map((seed) => {
        const { snap } = fullSnapshot(id, seed, "INTERMEDIATE");
        return {
          total: snap.totalEvents,
          start: snap.priceSeries[0]?.price,
          tail: snap.priceSeries.slice(-3).map((p) => p.price),
          sum: snap.priceSeries.reduce((s, p) => s + p.price, 0),
        };
      });
      // Same metric across three seeds must not be identical three times.
      const distinct = new Set(paths.map((p) => `${p.total}|${p.start}|${p.sum.toFixed(2)}`));
      expect(distinct.size).toBeGreaterThan(1);
    }
  });
});

/* --------------- 3. recognition does not access ScenarioTruth --------------- */

describe("recognition never touches ScenarioTruth", () => {
  test("the recognition module source never imports or reads ScenarioTruth", async () => {
    const src = await Bun.file(new URL("../src/flow/recognition.ts", import.meta.url)).text();
    // No import (value or type) may bring ScenarioTruth into the recogniser…
    expect(src).not.toMatch(/import[^;]*ScenarioTruth/);
    // …and no truth object may ever be read.
    expect(src).not.toContain(".truth");
  });

  test("a snapshot from a truth-blind engine recognises identically", () => {
    for (const id of PATTERN_IDS) {
      // Two independent generations of the same seed are byte-identical feeds.
      const g1 = generateScenario(id, 4242, { difficulty: "ADVANCED" });
      const g2 = generateScenario(id, 4242, { difficulty: "ADVANCED" });
      const withTruth = new TrainingEngine(g1.feed, g1.truth);
      withTruth.stepForward(withTruth.totalEvents);
      const blind = new TrainingEngine(g2.feed, null);
      blind.stepForward(blind.totalEvents);
      expect(blind.snapshot().priceSeries).toEqual(withTruth.snapshot().priceSeries);
      expect(JSON.stringify(recognizeFlow(withTruth.snapshot()))).toBe(
        JSON.stringify(recognizeFlow(blind.snapshot())),
      );
    }
  });

  test("the evidence structure carries no pattern vocabulary", () => {
    const { snap } = fullSnapshot("spring", 11);
    const json = JSON.stringify(recognizeFlow(snap).evidence).toLowerCase();
    for (const word of FORBIDDEN_WORDS) expect(json).not.toContain(word);
  });
});

/* --------------- 5. evidence is derived from observable data --------------- */

describe("evidence is measurable and observable", () => {
  const ALLOWED_CATEGORIES = new Set(["aggression", "price", "liquidity", "flow", "structure"]);

  test("every evidence item has sequence, timestamp, category, metric, value, interpretation", () => {
    const { snap } = fullSnapshot("upthrust", 11);
    const evidence = recognizeFlow(snap).evidence;
    expect(evidence.length).toBeGreaterThan(0);
    for (const ev of evidence) {
      expect(Number.isFinite(ev.sequence)).toBe(true);
      expect(ev.sequence).toBeGreaterThan(0);
      expect(Number.isFinite(ev.timestamp)).toBe(true);
      expect(ALLOWED_CATEGORIES.has(ev.category)).toBe(true);
      expect(typeof ev.metric).toBe("string");
      expect(ev.value === null || ev.value !== undefined).toBe(true);
      expect(typeof ev.interpretation).toBe("string");
      expect(ev.interpretation.length).toBeGreaterThan(0);
      // Observations come from the revealed tape, never past the clock.
      expect(ev.sequence).toBeLessThanOrEqual(snap.sequence);
      // Labels are human metric names, not pattern names.
      const label = flowEvidenceLabel(ev.metric).toLowerCase();
      for (const word of FORBIDDEN_WORDS) expect(label).not.toContain(word);
    }
  });

  test("annotations map by timestamp/sequence and are objective before reveal", () => {
    const g = generateScenario("initiative-break", 33, { difficulty: "INTERMEDIATE" });
    const session = new FlowTrainingSession(g.feed, g.truth, {});
    session.warmup(60);
    session.step(session.totalEvents - session.eventIndex);
    const snap = session.snapshot();
    expect(snap.recognition).toBeNull(); // still blind
    expect(snap.timeline).toEqual([]);
    const t0 = snap.priceSeries[0].t;
    const tN = snap.priceSeries[snap.priceSeries.length - 1].t;
    const validTypes = new Set<FlowAnnotationType>([
      "aggression", "concentration", "sweep", "divergence", "breakout", "rejection", "replenishment",
    ]);
    for (const a of snap.annotations) {
      expect(a.t).toBeGreaterThanOrEqual(t0);
      expect(a.t).toBeLessThanOrEqual(tN);
      expect(a.seq).toBeGreaterThan(0);
      expect(validTypes.has(a.type)).toBe(true);
      expect(a.interpretive).toBe(false); // no interpretation labels while blind
      const json = JSON.stringify(a).toLowerCase();
      for (const word of FORBIDDEN_WORDS) expect(json).not.toContain(word);
    }
  });
});

/* --------------- 6–10. the five pattern recognitions --------------- */

describe("all five patterns are recognised from observable data", () => {
  test.each(
    PATTERN_IDS.flatMap((id) =>
      (["BEGINNER", "INTERMEDIATE", "ADVANCED", "EXPERT"] as FlowDifficulty[]).map((d) => [id, d] as const),
    ),
  )("%s @ %s (seed 11)", (id, difficulty) => {
    const { snap } = fullSnapshot(id, 11, difficulty);
    const rec = recognizeFlow(snap);
    expect(rec.pattern).toBe(id);
    expect(rec.confidence).toBeGreaterThanOrEqual(RECOGNITION_MIN_SCORE);
    expect(rec.window).not.toBeNull();
    expect(rec.window!.startSequence).toBeLessThanOrEqual(rec.window!.endSequence);
    expect(rec.signals.length).toBeGreaterThan(0);
    expect(rec.evidence.length).toBeGreaterThan(0);
  });

  test("held-out seed 505 recognises every pattern at every difficulty", () => {
    for (const id of PATTERN_IDS) {
      for (const difficulty of FLOW_DIFFICULTIES) {
        const { snap } = fullSnapshot(id, 505, difficulty);
        expect(recognizeFlow(snap).pattern).toBe(id);
      }
    }
  });

  test("rankFlowPatterns orders candidates without exposing truth", () => {
    const { snap } = fullSnapshot("responsive-fade", 11);
    const ranks = rankFlowPatterns(snap);
    expect(ranks.length).toBe(PATTERN_IDS.length);
    for (let i = 1; i < ranks.length; i++) expect(ranks[i - 1].score).toBeGreaterThanOrEqual(ranks[i].score);
    const json = JSON.stringify(ranks).toLowerCase();
    expect(json).not.toContain("characteristics");
    expect(json).not.toContain("startEvent");
  });
});

/* --------------- 4. blind-mode state contains no hidden pattern --------------- */

describe("blind-mode controller state leaks nothing", () => {
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

  test("pre-reveal state exposes evidence but no engine answer, timeline or stats", () => {
    controller.setFlowDifficulty("ADVANCED");
    controller.generateFlowScenario("absorption");
    const flow = controller.getState().flow;
    expect(flow.active).toBe(true);
    expect(flow.difficulty).toBe("ADVANCED");
    // objective evidence is available while blind
    expect(flow.evidence.length).toBeGreaterThan(0);
    // the engine's answer is not
    expect(flow.revealed).toBeNull();
    expect(flow.recognition).toBeNull();
    expect(flow.timeline).toEqual([]);
    expect(flow.trainingStats).toBeNull();
    expect(flow.results).toBeNull();
    for (const a of flow.annotations) expect(a.interpretive).toBe(false);

    const json = JSON.stringify(flow).toLowerCase();
    for (const word of FORBIDDEN_WORDS) expect(json).not.toContain(word);
  });

  test("after reveal the engine answer, timeline and training stats appear", () => {
    controller.generateFlowScenario("spring");
    controller.stepFlow(120);
    controller.revealFlow();
    const flow = controller.getState().flow;
    expect(flow.revealed).not.toBeNull();
    expect(flow.recognition).not.toBeNull();
    expect(flow.timeline.length).toBeGreaterThan(0);
    expect(flow.trainingStats).not.toBeNull();
    expect(flow.trainingStats!.scenarios).toBeGreaterThanOrEqual(1);
    expect(flow.results).not.toBeNull();
    expect(flow.results!.recognitionResult).toMatch(/CORRECT|INCORRECT|NO SIGNAL/);
  });
});

/* --------------- 11. unknown / ambiguous behaviour --------------- */

describe("unknown and ambiguous behaviour", () => {
  test("early sessions stay unknown — no premature classification", () => {
    for (const id of PATTERN_IDS) {
      const g = generateScenario(id, 7, { difficulty: "INTERMEDIATE" });
      const engine = new TrainingEngine(g.feed, g.truth);
      engine.stepForward(60);
      const rec = recognizeFlow(engine.snapshot());
      expect(rec.pattern).toBe("unknown");
      expect(rec.window).toBeNull();
    }
  });

  test("an empty tape is unknown with zero confidence", () => {
    const g = generateScenario("spring", 11);
    const engine = new TrainingEngine(g.feed, g.truth); // event 0: nothing revealed
    const rec = recognizeFlow(engine.snapshot());
    expect(rec.pattern).toBe("unknown");
    expect(rec.confidence).toBe(0);
    expect(rec.window).toBeNull();
    expect(rec.signals).toEqual([]);
  });

  test("below the minimum point count no classification is attempted", () => {
    const g = generateScenario("upthrust", 11);
    const engine = new TrainingEngine(g.feed, g.truth);
    engine.stepForward(RECOGNITION_MIN_POINTS - 10);
    expect(engine.snapshot().priceSeries.length).toBeLessThan(RECOGNITION_MIN_POINTS);
    expect(recognizeFlow(engine.snapshot()).pattern).toBe("unknown");
  });
});

/* --------------- 12. confidence bounds --------------- */

describe("confidence is bounded and evidence-derived", () => {
  test("confidence stays within 0..1 for every pattern and difficulty", () => {
    for (const id of PATTERN_IDS) {
      for (const difficulty of FLOW_DIFFICULTIES) {
        const { snap } = fullSnapshot(id, 44, difficulty);
        const rec = recognizeFlow(snap);
        expect(rec.confidence).toBeGreaterThanOrEqual(0);
        expect(rec.confidence).toBeLessThanOrEqual(1);
        if (rec.pattern !== "unknown") {
          expect(rec.confidence).toBeGreaterThanOrEqual(RECOGNITION_MIN_SCORE);
        }
      }
    }
  });

  test("confidence equals the top detector score and tracks the data", () => {
    const { snap } = fullSnapshot("initiative-break", 44);
    const rec = recognizeFlow(snap);
    const ranks = rankFlowPatterns(snap);
    expect(ranks.length).toBeGreaterThan(0);
    expect(rec.confidence).toBe(ranks[0].score);

    // Same scenario mid-stream: less evidence, materially lower confidence —
    // confidence tracks observations, it is neither constant nor random.
    const g = generateScenario("initiative-break", 44, { difficulty: "BEGINNER" });
    const engine = new TrainingEngine(g.feed, g.truth);
    engine.stepForward(RECOGNITION_MIN_POINTS);
    const early = recognizeFlow(engine.snapshot());
    expect(early.confidence).toBeLessThan(rec.confidence);
  });
});

/* --------------- 13. seek / rebuild consistency --------------- */

describe("seek and rebuild reproduce identical recognition", () => {
  test("stepwise vs seeked snapshots recognise identically", () => {
    const g = generateScenario("absorption", 202, { difficulty: "ADVANCED" });

    const stepwise = new TrainingEngine(g.feed, g.truth);
    stepwise.stepForward(300);
    const viaSteps = recognizeFlow(stepwise.snapshot());

    const seeked = new TrainingEngine(g.feed, g.truth);
    seeked.stepForward(seeked.totalEvents);
    seeked.seekTo(300);
    const viaSeek = recognizeFlow(seeked.snapshot());

    expect(JSON.stringify(viaSeek)).toBe(JSON.stringify(viaSteps));
  });

  test("rewind and replay land on the same recognition", () => {
    const g = generateScenario("initiative-break", 909, { difficulty: "INTERMEDIATE" });
    const engine = new TrainingEngine(g.feed, g.truth);
    engine.stepForward(400);
    const first = recognizeFlow(engine.snapshot());
    engine.seekTo(0);
    engine.stepForward(400);
    const second = recognizeFlow(engine.snapshot());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

/* --------------- 14. restart consistency --------------- */

describe("restart reproduces identical recognition", () => {
  test("RESTART SCENARIO lands on the same recognition and evidence at the same index", () => {
    const g = generateScenario("spring", 55, { difficulty: "ADVANCED" });
    const session = new FlowTrainingSession(g.feed, g.truth, { sessionId: "flow-test" });
    session.markRevealed();
    session.warmup(60);
    session.step(240); // index 300
    const before = session.snapshot();
    expect(before.eventIndex).toBe(300);
    const recBefore = before.recognition;
    expect(recBefore).not.toBeNull();

    session.restart(60);
    expect(session.eventIndex).toBe(60);
    session.step(240); // back to index 300
    const after = session.snapshot();
    expect(after.eventIndex).toBe(300);
    expect(JSON.stringify(after.recognition)).toBe(JSON.stringify(recBefore));
    expect(after.sequence).toBe(before.sequence);
  });
});

/* --------------- 15. evidence timeline consistency --------------- */

describe("evidence timeline consistency", () => {
  function buildSession(id: FlowScenarioId, seed: number) {
    const g = generateScenario(id, seed, { difficulty: "INTERMEDIATE" });
    const session = new FlowTrainingSession(g.feed, g.truth, { sessionId: "flow-timeline" });
    session.markRevealed();
    session.warmup(60);
    return session;
  }

  test("any navigation path yields the same timeline at the same index", () => {
    const a = buildSession("responsive-fade", 1010);
    a.step(a.totalEvents - a.eventIndex);
    const direct = a.snapshot();

    const b = buildSession("responsive-fade", 1010);
    b.step(150);
    b.seekTo(0);
    b.step(b.totalEvents - b.eventIndex);
    const wandering = b.snapshot();

    expect(direct.eventIndex).toBe(wandering.eventIndex);
    expect(wandering.timeline).toEqual(direct.timeline);
    expect(wandering.annotations).toEqual(direct.annotations);
    expect(JSON.stringify(wandering.recognition)).toBe(JSON.stringify(direct.recognition));
  });

  test("the timeline is ordered, capped at the clock and free of pattern names", () => {
    const s = buildSession("upthrust", 505);
    s.step(s.totalEvents - s.eventIndex);
    const { timeline, eventIndex } = s.snapshot();
    expect(timeline.length).toBeGreaterThan(0);
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].index).toBeGreaterThanOrEqual(timeline[i - 1].index);
      expect(timeline[i].sequence).toBeGreaterThanOrEqual(timeline[i - 1].sequence);
    }
    for (const e of timeline) {
      expect(e.index).toBeLessThanOrEqual(eventIndex);
      expect(e.sequence).toBeGreaterThan(0);
      expect(e.timestamp).toBeGreaterThan(0);
      expect(e.label.length).toBeGreaterThan(0);
      expect(typeof e.important).toBe("boolean");
      const json = JSON.stringify(e).toLowerCase();
      for (const word of FORBIDDEN_WORDS) expect(json).not.toContain(word);
    }
  });

  test("seeking back truncates the visible timeline, extending restores it", () => {
    const s = buildSession("absorption", 606);
    s.step(s.totalEvents - s.eventIndex);
    const full = s.snapshot().timeline;
    s.seekTo(100);
    const partial = s.snapshot().timeline;
    expect(partial.length).toBeLessThanOrEqual(full.length);
    expect(partial.every((e) => e.index <= 100)).toBe(true);
    s.step(s.totalEvents - s.eventIndex);
    expect(s.snapshot().timeline).toEqual(full);
  });

  test("pre-reveal the timeline is never exposed", () => {
    const g = generateScenario("spring", 31337, { difficulty: "EXPERT" });
    const session = new FlowTrainingSession(g.feed, g.truth, {});
    session.warmup(60);
    session.step(200);
    const snap = session.snapshot();
    expect(snap.timeline).toEqual([]);
    expect(snap.recognition).toBeNull();
    expect(snap.evidence.length).toBeGreaterThan(0);
  });
});

/* --------------- 16 + 17. recognition scoring & trader vs engine --------------- */

describe("recognition scoring and trader vs engine", () => {
  function score(opts: {
    expected?: FlowScenarioId | "unknown";
    recognitionPattern?: FlowScenarioId | "unknown";
  }): FlowSessionResults {
    const g = generateScenario("spring", 11, { difficulty: "BEGINNER" });
    const engine = new TrainingEngine(g.feed, g.truth);
    engine.stepForward(engine.totalEvents);
    const snap = engine.snapshot();
    return scoreFlowSession({
      truth: g.truth,
      records: [],
      decision: { ...DEFAULT_FLOW_DECISION, bias: "LONG", expected: opts.expected ?? "unknown", level: 4 },
      risk: DEFAULT_FLOW_RISK,
      contract: CONTRACTS.NQ,
      orderFlow: snap.orderFlow,
      dom: snap.dom,
      recognition: {
        pattern: opts.recognitionPattern ?? "spring",
        confidence: 0.87,
        window: { startSequence: 10, endSequence: 500 },
        signals: ["downside extension to a new session low"],
        evidence: [],
      },
    });
  }

  test("engine recognition matching truth scores CORRECT with window and signals", () => {
    const r = score({ recognitionPattern: "spring" });
    expect(r.recognitionPattern).toBe("spring");
    expect(r.recognitionConfidence).toBe(0.87);
    expect(r.recognitionResult).toBe("CORRECT");
    expect(r.recognitionWindow).toEqual({ startSequence: 10, endSequence: 500 });
    expect(r.recognitionSignals.length).toBe(1);
  });

  test("engine recognition disagreeing with truth scores INCORRECT", () => {
    expect(score({ recognitionPattern: "upthrust" }).recognitionResult).toBe("INCORRECT");
  });

  test("an unknown engine call is NO SIGNAL — never a correctness claim", () => {
    const r = score({ recognitionPattern: "unknown" });
    expect(r.recognitionResult).toBe("NO SIGNAL");
    expect(r.traderEngineAgreement).toBeNull();
  });

  test("trader vs engine agreement is computed only when both made a call", () => {
    expect(score({ expected: "spring", recognitionPattern: "spring" }).traderEngineAgreement).toBe(true);
    expect(score({ expected: "spring", recognitionPattern: "upthrust" }).traderEngineAgreement).toBe(false);
    expect(score({ expected: "unknown", recognitionPattern: "spring" }).traderEngineAgreement).toBeNull();
    expect(score({ expected: "spring", recognitionPattern: "unknown" }).traderEngineAgreement).toBeNull();
  });

  test("session results carry the live recognition end-to-end", () => {
    const g = generateScenario("upthrust", 11, { difficulty: "BEGINNER" });
    const session = new FlowTrainingSession(g.feed, g.truth, {});
    expect(session.results()).toBeNull(); // blind
    session.warmup(60);
    session.step(session.totalEvents - session.eventIndex);
    session.markRevealed();
    const r = session.results();
    expect(r).not.toBeNull();
    expect(r!.patternId).toBe("upthrust");
    expect(r!.recognitionPattern).toBe("upthrust");
    expect(r!.recognitionResult).toBe("CORRECT");
    expect(r!.recognitionConfidence).not.toBeNull();
    expect(r!.recognitionWindow).not.toBeNull();
  });

  test("training statistics aggregate raw metrics across scenarios", () => {
    const g = generateScenario("absorption", 11);
    const engine = new TrainingEngine(g.feed, g.truth);
    engine.stepForward(engine.totalEvents);
    const snap = engine.snapshot();
    const base = scoreFlowSession({
      truth: g.truth,
      records: [],
      decision: { ...DEFAULT_FLOW_DECISION, expected: "absorption", level: 5 },
      risk: DEFAULT_FLOW_RISK,
      contract: CONTRACTS.NQ,
      orderFlow: snap.orderFlow,
      dom: snap.dom,
      recognition: recognizeFlow(snap),
    });
    const stats = computeFlowTrainingStats([base, base]);
    expect(stats.scenarios).toBe(2);
    expect(stats.traderPredictions).toBe(2);
    expect(stats.traderCorrect).toBe(2);
    expect(stats.engineCalls).toBe(2);
    expect(stats.engineCorrect).toBeGreaterThanOrEqual(0);
    expect(stats.agreements).toBe(2);
    expect(stats.agreeCount).toBe(2);
    expect(stats.avgConfidence).toBe(5);
    expect(stats.avgConfidenceCorrect).toBe(5);
    expect(stats.netPnL).toBe(0);
    expect(stats.trades).toBe(0);
    expect(stats.winRatePct).toBe(0);
    // no opaque composite score exists on the stats object
    expect(Object.keys(stats)).not.toContain("score");
    expect(Object.keys(stats)).not.toContain("grade");
  });
});

/* --------------- 18. difficulty behaviour --------------- */

describe("difficulty shapes generation structurally", () => {
  test("the same seed at different difficulties produces different paths", () => {
    for (const id of PATTERN_IDS) {
      const beginner = fullSnapshot(id, 99, "BEGINNER");
      const expert = fullSnapshot(id, 99, "EXPERT");
      const different =
        beginner.snap.totalEvents !== expert.snap.totalEvents ||
        beginner.snap.priceSeries[0]?.price !== expert.snap.priceSeries[0]?.price ||
        JSON.stringify(beginner.snap.priceSeries.slice(0, 40)) !== JSON.stringify(expert.snap.priceSeries.slice(0, 40));
      expect(different).toBe(true);
    }
  });

  test("difficulty is not random noise: BEGINNER and EXPERT both stay recognisable", () => {
    for (const id of PATTERN_IDS) {
      expect(recognizeFlow(fullSnapshot(id, 11, "BEGINNER").snap).pattern).toBe(id);
      expect(recognizeFlow(fullSnapshot(id, 11, "EXPERT").snap).pattern).toBe(id);
    }
  });

  test("the controller passes the selected difficulty to the generator", () => {
    // covered via controller state in the blind-state suite; here we verify
    // the generator API itself honours the option deterministically.
    const a = generateScenario("spring", 123, { difficulty: "EXPERT" });
    const b = generateScenario("spring", 123, { difficulty: "EXPERT" });
    const c = generateScenario("spring", 123, { difficulty: "BEGINNER" });
    expect(a.feed.totalEvents()).toBe(b.feed.totalEvents());
    expect(a.truth.pattern).toBe(b.truth.pattern);
    const expert = new TrainingEngine(a.feed, a.truth);
    const beginner = new TrainingEngine(c.feed, c.truth);
    expert.stepForward(expert.totalEvents);
    beginner.stepForward(beginner.totalEvents);
    expect(JSON.stringify(expert.snapshot().priceSeries)).not.toBe(
      JSON.stringify(beginner.snapshot().priceSeries),
    );
  });
});

/* --------------- 11b / 19. anti-memorization randomization --------------- */

describe("anti-memorization randomization", () => {
  test("same seed remains fully deterministic across generations", () => {
    for (const id of PATTERN_IDS) {
      const a = fullSnapshot(id, 777, "ADVANCED");
      const b = fullSnapshot(id, 777, "ADVANCED");
      expect(a.snap.totalEvents).toBe(b.snap.totalEvents);
      expect(a.snap.priceSeries).toEqual(b.snap.priceSeries);
      expect(a.snap.orderFlow.cumulativeDelta).toBe(b.snap.orderFlow.cumulativeDelta);
      expect(a.snap.dom.totalBidLiquidity).toBe(b.snap.dom.totalBidLiquidity);
    }
  });

  test("start price, length and liquidity vary across seeds", () => {
    for (const id of PATTERN_IDS) {
      const seeds = [11, 101, 505, 12345, 99991];
      const starts = new Set<number>();
      const lengths = new Set<number>();
      for (const seed of seeds) {
        const { snap } = fullSnapshot(id, seed, "INTERMEDIATE");
        starts.add(snap.priceSeries[0]?.price ?? 0);
        lengths.add(snap.totalEvents);
      }
      expect(starts.size).toBeGreaterThan(1);
      expect(lengths.size).toBeGreaterThan(1);
    }
  });

  test("the recogniser still resolves the intended pattern after randomization", () => {
    for (const id of PATTERN_IDS) {
      for (const seed of [11, 44, 505, 99991]) {
        expect(recognizeFlow(fullSnapshot(id, seed, "BEGINNER").snap).pattern).toBe(id);
      }
    }
  });
});
