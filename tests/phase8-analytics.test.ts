/**
 * Phase 8C + 8D — training analytics and session review.
 *
 * Covers spec §12 ANALYTICS / REVIEW and the 8C sample-discipline rules:
 *  - pattern / difficulty / confidence breakdowns from real session data
 *  - "Insufficient sample" instead of a misleading rate
 *  - MFE capture, MAE, win rate, net P&L, profit factor, hold time
 *  - rule-based weakness observations gated by sample size
 *  - review bundles: entry/exit markers, evidence timeline, jump targets and
 *    the reveal gate that keeps them out of blind state
 */

import { describe, expect, test, beforeAll } from "bun:test";
import {
  ANALYTICS_THRESHOLDS,
  computeFlowAnalytics,
  INSUFFICIENT_SAMPLE_LABEL,
} from "../src/flow/analytics";
import { scoreFlowSession, type FlowSessionResults } from "../src/flow/scoring";
import { buildFlowReview, REVIEW_ENTRY_METRICS } from "../src/flow/review";
import { DEFAULT_FLOW_RISK } from "../src/flow/execution";
import { CONTRACTS } from "../src/market/instruments";
import { generateScenario, type FlowScenarioId } from "../src/flow/scenarios";
import { FlowTrainingSession } from "../src/flow/session";

/* ---------------------------- fixtures ---------------------------- */

function result(over: Partial<FlowSessionResults> = {}): FlowSessionResults {
  return {
    pattern: "Spring",
    patternId: "spring",
    direction: "bullish",
    bias: "LONG",
    prediction: "spring",
    predictionName: "Spring",
    confidence: 3,
    patternResult: "CORRECT",
    directionResult: "CORRECT",
    tradeResult: "PROFIT",
    confidenceVsResult: "3/5 confidence → CORRECT",
    trades: 1,
    wins: 1,
    losses: 0,
    grossPnL: 100,
    costs: 5,
    netPnL: 95,
    bestTrade: 95,
    worstTrade: 95,
    mfe: 120,
    mae: 40,
    rMultiple: null,
    entryTiming: "INSIDE",
    mfeCapturePct: 79.2,
    difficulty: "BEGINNER",
    avgHoldMs: 30_000,
    recognitionPattern: "spring",
    recognitionConfidence: 0.9,
    recognitionResult: "CORRECT",
    recognitionWindow: { startSequence: 1, endSequence: 10 },
    recognitionSignals: [],
    traderEngineAgreement: true,
    narrative: [],
    ...over,
  };
}

function sessionFor(id: FlowScenarioId, seed: number, difficulty: "BEGINNER" | "ADVANCED" = "BEGINNER") {
  const g = generateScenario(id, seed, { difficulty });
  return new FlowTrainingSession(g.feed, g.truth, { sessionId: "phase8-c", difficulty });
}

/** A session that produced exactly one completed trade and one reveal. */
function tradedSession(id: FlowScenarioId, seed: number, difficulty: "BEGINNER" | "ADVANCED" = "BEGINNER") {
  const s = sessionFor(id, seed, difficulty);
  s.warmup(60);
  s.step(140);
  const buy = s.buy();
  expect(buy.ok).toBe(true);
  s.step(60);
  s.flatten();
  s.step(s.totalEvents - s.eventIndex);
  s.markRevealed();
  return s;
}

/* ========================= 8C analytics ========================= */

describe("8C analytics — aggregation", () => {
  test("win rate, net P&L, averages, best/worst and profit factor come from the data", () => {
    const results = [
      result({ netPnL: 100, trades: 2, wins: 2, losses: 0, bestTrade: 80, worstTrade: 20, mfe: 100, mae: 30, mfeCapturePct: 60 }),
      result({ netPnL: -40, trades: 2, wins: 0, losses: 2, bestTrade: -10, worstTrade: -30, mfe: 20, mae: 55, mfeCapturePct: 10 }),
    ];
    const a = computeFlowAnalytics(results);
    expect(a.sessions).toBe(2);
    expect(a.trades).toBe(4);
    expect(a.netPnL).toBe(60);
    expect(a.winRatePct).toBe(50);
    expect(a.avgTrade).toBe(15);
    expect(a.bestTrade).toBe(80);
    expect(a.worstTrade).toBe(-30);
    expect(a.avgMfe).toBe(60);
    expect(a.avgMae).toBe(42.5);
    expect(a.mfeCapturePct).toBe(35);
    expect(a.profitFactor).toBe(2.5); // 100 gross profit / 40 gross loss
    expect(a.tradesPerSession).toBe(2);
    expect(a.avgHoldMs).toBe(30_000);
    expect(a.avgConfidence).toBe(3);
    expect(a.earlyEntry).toEqual({ tradedSessions: 2, count: 0 });
  });

  test("an empty history reports no rates at all (never a fake zero)", () => {
    const a = computeFlowAnalytics([]);
    expect(a.sessions).toBe(0);
    expect(a.trades).toBe(0);
    expect(a.winRatePct).toBeNull();
    expect(a.avgTrade).toBeNull();
    expect(a.profitFactor).toBeNull();
    expect(a.mfeCapturePct).toBeNull();
    expect(a.avgHoldMs).toBeNull();
    expect(a.recognition.traderAccuracyPct).toBeNull();
    expect(a.recognition.sufficient).toBe(false);
    expect(a.weaknesses).toEqual([]);
  });

  test("profit factor is null when there are no losses to divide by", () => {
    const a = computeFlowAnalytics([result({ netPnL: 50 })]);
    expect(a.profitFactor).toBeNull();
  });
});

describe("8C.1 breakdowns by pattern, difficulty and confidence", () => {
  const history: FlowSessionResults[] = [
    // spring: 3 correct, all long
    result({ patternId: "spring", confidence: 1, difficulty: "BEGINNER", netPnL: 50 }),
    result({ patternId: "spring", confidence: 1, difficulty: "BEGINNER", netPnL: 30 }),
    result({ patternId: "spring", confidence: 2, difficulty: "BEGINNER", netPnL: 20 }),
    // upthrust: 3 incorrect short calls
    result({ patternId: "upthrust", patternResult: "INCORRECT", bias: "SHORT", direction: "bearish", directionResult: "INCORRECT", tradeResult: "LOSS", confidence: 5, difficulty: "EXPERT", netPnL: -60, wins: 0, losses: 1 }),
    result({ patternId: "upthrust", patternResult: "INCORRECT", bias: "SHORT", direction: "bearish", directionResult: "INCORRECT", tradeResult: "LOSS", confidence: 4, difficulty: "EXPERT", netPnL: -40, wins: 0, losses: 1 }),
    result({ patternId: "upthrust", patternResult: "INCORRECT", bias: "SHORT", direction: "bearish", directionResult: "INCORRECT", tradeResult: "LOSS", confidence: 5, difficulty: "EXPERT", netPnL: -20, wins: 0, losses: 1 }),
    // absorption: only 2 predictions → insufficient
    result({ patternId: "absorption", patternResult: "CORRECT", difficulty: "ADVANCED" }),
    result({ patternId: "absorption", patternResult: "INCORRECT", difficulty: "ADVANCED" }),
  ];

  test("every pattern is broken out with its own accuracy and sample", () => {
    const a = computeFlowAnalytics(history);
    expect(a.byPattern.length).toBe(5);
    const spring = a.byPattern.find((p) => p.patternId === "spring")!;
    expect(spring.sessions).toBe(3);
    expect(spring.predictions).toBe(3);
    expect(spring.correct).toBe(3);
    expect(spring.accuracyPct).toBe(100);
    expect(spring.insufficient).toBe(false);

    const upthrust = a.byPattern.find((p) => p.patternId === "upthrust")!;
    expect(upthrust.accuracyPct).toBe(0);
    expect(upthrust.netPnL).toBe(-120);

    const fade = a.byPattern.find((p) => p.patternId === "responsive-fade")!;
    expect(fade.sessions).toBe(0);
    expect(fade.accuracyPct).toBeNull();
    expect(fade.insufficient).toBe(true);
  });

  test("difficulty breakdown carries win rate, recognition and sample flags", () => {
    const a = computeFlowAnalytics(history);
    expect(a.byDifficulty.length).toBe(4);
    const beginner = a.byDifficulty.find((d) => d.difficulty === "BEGINNER")!;
    expect(beginner.sessions).toBe(3);
    expect(beginner.insufficient).toBe(false);
    expect(beginner.winRatePct).toBe(100);
    expect(beginner.recognitionAccuracyPct).toBe(100);

    const expert = a.byDifficulty.find((d) => d.difficulty === "EXPERT")!;
    expect(expert.sessions).toBe(3);
    expect(expert.netPnL).toBe(-120);
    expect(expert.winRatePct).toBe(0);

    const advanced = a.byDifficulty.find((d) => d.difficulty === "ADVANCED")!;
    expect(advanced.sessions).toBe(2);
    expect(advanced.insufficient).toBe(true); // below minSample
  });

  test("confidence is bucketed 1..5 with sample-gated rates", () => {
    const a = computeFlowAnalytics(history);
    expect(a.byConfidence.map((b) => b.level)).toEqual([1, 2, 3, 4, 5]);
    const one = a.byConfidence.find((b) => b.level === 1)!;
    expect(one.sessions).toBe(2);
    expect(one.insufficient).toBe(true);
    expect(one.winRatePct).toBe(100); // rate is present, insufficiency is flagged

    const five = a.byConfidence.find((b) => b.level === 5)!;
    expect(five.sessions).toBe(2);
    expect(five.netPnL).toBe(-80);
    expect(five.avgNetPnL).toBe(-40);
    expect(a.byConfidence.find((b) => b.level === 3)!.sessions).toBe(2);
  });

  test("direction accuracy splits long vs short from the trader's own bias", () => {
    const a = computeFlowAnalytics(history);
    expect(a.direction.long.calls).toBe(5); // spring ×3 + absorption ×2
    expect(a.direction.short.calls).toBe(3); // upthrust ×3
    expect(a.direction.long.accuracyPct).toBe(100);
    expect(a.direction.short.accuracyPct).toBe(0);
    expect(a.direction.short.netPnL).toBe(-120);
  });

  test("recognition aggregates trader, engine and agreement separately", () => {
    const a = computeFlowAnalytics(history);
    expect(a.recognition.traderCalls).toBe(8);
    expect(a.recognition.traderCorrect).toBe(4);
    expect(a.recognition.traderAccuracyPct).toBe(50);
    expect(a.recognition.engineCalls).toBe(8);
    expect(a.recognition.engineAccuracyPct).toBe(100);
    expect(a.recognition.agreements).toBe(8);
    expect(a.recognition.agreementPct).toBe(100);
    expect(a.recognition.sufficient).toBe(true);
  });

  test("insufficient sample is explicitly labelled and thresholds are configurable", () => {
    expect(INSUFFICIENT_SAMPLE_LABEL).toBe("Insufficient sample");
    const two = [result({ patternId: "spring" }), result({ patternId: "spring" })];
    const strict = computeFlowAnalytics(two);
    expect(strict.byPattern[0].insufficient).toBe(true);
    expect(strict.byPattern[0].accuracyPct).toBeNull();
    expect(strict.thresholds.minSample).toBe(ANALYTICS_THRESHOLDS.minSample);

    const relaxed = computeFlowAnalytics(two, { minSample: 2 });
    expect(relaxed.byPattern[0].insufficient).toBe(false);
    expect(relaxed.byPattern[0].accuracyPct).toBe(100);
    expect(relaxed.recognition.traderAccuracyPct).toBe(100);
  });
});

describe("8C.2 weakness detection is rule-based and sample-gated", () => {
  test("no statements are produced from too little data", () => {
    const a = computeFlowAnalytics([result()]);
    expect(a.weaknesses).toEqual([]);
  });

  test("a strong pattern is called out as the current strength", () => {
    const history = [
      result({ patternId: "spring", mfeCapturePct: 90 }),
      result({ patternId: "spring", mfeCapturePct: 90 }),
      result({ patternId: "spring", mfeCapturePct: 90 }),
      result({ patternId: "spring", mfeCapturePct: 90 }),
      result({ patternId: "upthrust", patternResult: "INCORRECT", mfeCapturePct: 90 }),
      result({ patternId: "upthrust", patternResult: "INCORRECT", mfeCapturePct: 90 }),
      result({ patternId: "upthrust", patternResult: "INCORRECT", mfeCapturePct: 90 }),
    ];
    const a = computeFlowAnalytics(history);
    const strength = a.weaknesses.find((w) => w.kind === "STRENGTH")!;
    expect(strength).toBeDefined();
    expect(strength.text).toContain("Spring");
    expect(strength.text).toContain("strongest");
    expect(strength.sample).toBeGreaterThanOrEqual(3);
    // and the lagging pattern is flagged relative to the session average
    const weak = a.weaknesses.find((w) => w.kind === "WEAK_PATTERN")!;
    expect(weak).toBeDefined();
    expect(weak.text).toContain("Upthrust");
    expect(weak.text).toContain("below your session average");
  });

  test("frequent early entries and low MFE capture produce observations", () => {
    const history = [
      result({ entryTiming: "EARLY", mfeCapturePct: 20 }),
      result({ entryTiming: "EARLY", mfeCapturePct: 20 }),
      result({ entryTiming: "EARLY", mfeCapturePct: 20 }),
      result({ entryTiming: "INSIDE", mfeCapturePct: 20 }),
    ];
    const a = computeFlowAnalytics(history);
    expect(a.earlyEntry.count).toBe(3);
    expect(a.earlyEntry.tradedSessions).toBe(4);
    const early = a.weaknesses.find((w) => w.kind === "EARLY_ENTRY")!;
    expect(early).toBeDefined();
    expect(early.text).toContain("before confirmation");
    expect(early.sample).toBe(4);
    const mfe = a.weaknesses.find((w) => w.kind === "MFE_CAPTURE")!;
    expect(mfe).toBeDefined();
    expect(mfe.text).toContain("MFE capture is low");
    expect(mfe.sample).toBe(4);
  });

  test("high confidence underperforming medium confidence is observed", () => {
    const winning = (netPnL: number, confidence: number) =>
      result({ confidence, netPnL, trades: 1, wins: 1, losses: 0 });
    const losing = (netPnL: number, confidence: number) =>
      result({ confidence, netPnL, trades: 1, wins: 0, losses: 1, tradeResult: "LOSS" });
    const history = [
      losing(-100, 5),
      losing(-80, 5),
      losing(-60, 5),
      winning(90, 2),
      winning(70, 2),
      winning(50, 2),
      winning(60, 3),
      winning(40, 3),
      winning(20, 3),
    ];
    const a = computeFlowAnalytics(history);
    const conf = a.weaknesses.find((w) => w.kind === "CONFIDENCE")!;
    expect(conf).toBeDefined();
    expect(conf.text).toContain("underperform");
    expect(conf.sample).toBe(9);
  });

  test("observations never read as psychological diagnoses", () => {
    const history = Array.from({ length: 4 }, () => result({ entryTiming: "EARLY", mfeCapturePct: 10 }));
    const a = computeFlowAnalytics(history);
    expect(a.weaknesses.length).toBeGreaterThan(0);
    const banned = ["you are", "anxious", "fear", "greed", "discipline problem", "psycholog"];
    for (const w of a.weaknesses) {
      const text = w.text.toLowerCase();
      for (const word of banned) expect(text).not.toContain(word);
      expect(w.sample).toBeGreaterThanOrEqual(1);
    }
  });
});

/* ================== analytics on real session data ================== */

describe("8C analytics fed by real sessions", () => {
  test("difficulty and average hold time are captured on real results", () => {
    const s = tradedSession("absorption", 606, "ADVANCED");
    const r = s.results()!;
    expect(r.trades).toBe(1);
    expect(r.difficulty).toBe("ADVANCED");
    expect(r.avgHoldMs).toBeGreaterThan(0);
  });

  test("scoring defaults the difficulty when the caller does not supply one", () => {
    const g = generateScenario("spring", 11);
    const s = new FlowTrainingSession(g.feed, g.truth, {});
    s.warmup(60);
    s.step(120);
    s.markRevealed();
    const snap = s.snapshot();
    const r = scoreFlowSession({
      truth: g.truth,
      records: [],
      decision: { bias: "LONG", expected: "spring", level: 4, reason: "" },
      risk: DEFAULT_FLOW_RISK,
      contract: CONTRACTS.NQ,
      orderFlow: snap.orderFlow,
      dom: snap.dom,
    });
    expect(r.difficulty).toBe("INTERMEDIATE");
    expect(r.avgHoldMs).toBeNull();
    expect(r.trades).toBe(0);
  });

  test("history aggregates into a dashboard without hardcoded numbers", () => {
    const a1 = tradedSession("spring", 1).results()!;
    const a2 = tradedSession("upthrust", 2).results()!;
    const a = computeFlowAnalytics([a1, a2]);
    expect(a.sessions).toBe(2);
    expect(a.trades).toBe(2);
    expect(a.netPnL).toBe(Math.round((a1.netPnL + a2.netPnL) * 100) / 100);
    expect(a.byPattern.find((p) => p.patternId === "spring")!.sessions).toBe(1);
    expect(a.byPattern.find((p) => p.patternId === "upthrust")!.sessions).toBe(1);
    expect(a.avgHoldMs).toBeGreaterThan(0);
  });
});

/* =========================== 8D review =========================== */

describe("8D session review", () => {
  test("entry/exit markers resolve to deterministic event indices", () => {
    const s = tradedSession("spring", 101);
    const snap = s.snapshot();
    expect(snap.trades.length).toBe(1);
    const trade = snap.trades[0];
    const review = buildFlowReview(snap.trades, snap.timeline);

    expect(review.trades.length).toBe(1);
    const r = review.trades[0];
    expect(r.tradeId).toBe(trade.tradeId);
    expect(r.entryIndex).toBe(trade.entrySequence - 1);
    expect(r.exitIndex).toBe(trade.exitSequence - 1);
    expect(r.exitIndex).toBeGreaterThan(r.entryIndex);
    expect(r.side).toBe(trade.side);
    expect(r.quantity).toBe(trade.quantity);
    expect(r.entryPrice).toBe(trade.entryPrice);
    expect(r.exitPrice).toBe(trade.exitPrice);
    expect(r.netPnL).toBe(trade.netPnL);
    expect(r.mfe).toBe(trade.maxFavorableExcursion);
    expect(r.mae).toBe(trade.maxAdverseExcursion);
    expect(r.exitReason.length).toBeGreaterThan(0);
    expect(r.outcome).toContain("$");
  });

  test("each trade carries the decision captured at entry", () => {
    const s = sessionFor("upthrust", 202);
    s.warmup(60);
    s.setDecision({ bias: "SHORT", expected: "upthrust", level: 5, reason: "failed breakout into offers" });
    s.step(140);
    s.buy(); // deliberately against the read — the journal records what was done
    s.step(60);
    s.flatten();
    s.markRevealed();
    const snap = s.snapshot();
    const review = buildFlowReview(snap.trades, snap.timeline);
    const r = review.trades[0];
    expect(r.bias).toBe("SHORT");
    expect(r.prediction).toBe("Upthrust");
    expect(r.confidence).toBe(5);
    expect(r.reason).toBe("failed breakout into offers");
    expect(Array.isArray(r.atEntry)).toBe(true);
  });

  test("jump targets cover start, entry, exit and major evidence in index order", () => {
    const s = tradedSession("absorption", 303);
    const snap = s.snapshot();
    const review = buildFlowReview(snap.trades, snap.timeline);

    expect(review.jumps[0].kind).toBe("START");
    expect(review.jumps[0].index).toBe(0);
    expect(review.jumps.some((j) => j.kind === "ENTRY")).toBe(true);
    expect(review.jumps.some((j) => j.kind === "EXIT")).toBe(true);
    for (const j of review.jumps) {
      expect(j.index).toBeGreaterThanOrEqual(0);
      expect(j.index).toBeLessThanOrEqual(s.totalEvents);
      expect(j.label.length).toBeGreaterThan(0);
    }
    const indices = review.jumps.map((j) => j.index);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    // evidence jumps are exactly the important observations
    const evidenceJumps = review.jumps.filter((j) => j.kind === "EVIDENCE").length;
    expect(evidenceJumps).toBe(review.majorEvidence.length);
  });

  test("the review exposes the observable evidence timeline, never the truth", () => {
    const s = tradedSession("responsive-fade", 404);
    const snap = s.snapshot();
    const review = buildFlowReview(snap.trades, snap.timeline);
    for (const e of review.evidence) {
      expect(e.index).toBeLessThanOrEqual(snap.eventIndex);
      expect(e.label.length).toBeGreaterThan(0);
    }
    for (const metric of REVIEW_ENTRY_METRICS) expect(typeof metric).toBe("string");
    const json = JSON.stringify(review).toLowerCase();
    for (const word of ["characteristics", "startevent", "hiddenpattern", "scenariotruth"]) {
      expect(json).not.toContain(word);
    }
  });

  test("an empty journal reviews cleanly with only the start jump", () => {
    const review = buildFlowReview([], []);
    expect(review.trades).toEqual([]);
    expect(review.jumps.length).toBe(1);
    expect(review.jumps[0].kind).toBe("START");
    expect(review.majorEvidence).toEqual([]);
  });
});

/* ============ review + analytics gating in the controller ============ */

describe("8D review and 8C analytics reach the controller behind the reveal gate", () => {
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

  test("blind state exposes neither review nor analytics nor trade markers", () => {
    controller.generateFlowScenario("spring");
    const flow = controller.getState().flow;
    expect(flow.review).toBeNull();
    expect(flow.analytics).toBeNull();
    expect(flow.policy.tradeMarkers).toBe(false);
    expect(flow.results).toBeNull();
  });

  test("post-reveal the review, analytics and markers appear", () => {
    controller.stepFlow(180);
    controller.revealFlow();
    const flow = controller.getState().flow;
    expect(flow.review).not.toBeNull();
    expect(flow.analytics).not.toBeNull();
    expect(flow.policy.tradeMarkers).toBe(true);
    expect(flow.analytics!.sessions).toBeGreaterThanOrEqual(1);
    expect(flow.analytics!.byPattern.length).toBe(5);
    expect(flow.analytics!.byDifficulty.length).toBe(4);
    expect(flow.review!.jumps[0].kind).toBe("START");
  });

  test("analytics accumulate across revealed scenarios", () => {
    const first = controller.getState().flow.analytics!.sessions;
    controller.generateFlowScenario("upthrust");
    controller.stepFlow(120);
    controller.revealFlow();
    const flow = controller.getState().flow;
    expect(flow.analytics!.sessions).toBe(first + 1);
    expect(flow.analytics!.trades).toBeGreaterThanOrEqual(0);
  });
});
