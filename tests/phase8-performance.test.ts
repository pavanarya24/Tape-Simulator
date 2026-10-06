/**
 * Phase 8 §10 — responsiveness of the replay/workspace paths.
 *
 * Two kinds of checks, deliberately:
 *
 *  1. STRUCTURAL (exact, never flaky): every UI-facing array the replay clock
 *     produces is bounded, so no panel can grow without limit as thousands of
 *     events are replayed. These already existed as engine bounds — this suite
 *     pins them at the FlowSessionSnapshot boundary the UI actually reads.
 *
 *  2. TIMED (generous guards): traversal, cached state reads and chart redraws
 *     are measured with wide margins. The margins are ~15–100× the measured
 *     cost on this host, so they catch pathological regressions (an accidental
 *     O(n²) rebuild, a cache that stopped caching) without becoming flaky.
 *
 * The event clock stays authoritative: every timed path below advances whole
 * events through FlowTrainingSession — none of them adds a second clock.
 */

import { describe, expect, test } from "bun:test";
import { CVD_SERIES_KEEP, LARGEST_KEEP, TAPE_KEEP } from "../src/flow/orderFlow";
import { DOM_LOG_KEEP } from "../src/flow/dom";
import { PRICE_SERIES_KEEP } from "../src/flow/training";
import { generateScenario, type FlowScenarioId } from "../src/flow/scenarios";
import { FlowTrainingSession } from "../src/flow/session";
import { drawFlowChart } from "../src/components/FlowChart";

const PATTERNS: FlowScenarioId[] = [
  "spring",
  "upthrust",
  "absorption",
  "initiative-break",
  "responsive-fade",
];

/** The largest EXPERT scenario available — the worst case the UI can face. */
function largestScenario() {
  let best = generateScenario("spring", 12345, { difficulty: "EXPERT" });
  for (const id of PATTERNS.slice(1)) {
    const g = generateScenario(id, 12345, { difficulty: "EXPERT" });
    if (g.feed.totalEvents() > best.feed.totalEvents()) best = g;
  }
  return best;
}

function stubCtx() {
  const state = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
  };
  const ctx = {
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v: string) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v: string) { state.strokeStyle = v; },
    get lineWidth() { return state.lineWidth; },
    set lineWidth(v: number) { state.lineWidth = v; },
    get font() { return state.font; },
    set font(v: string) { state.font = v; },
    get textAlign() { return state.textAlign; },
    set textAlign(v: string) { state.textAlign = v; },
    get textBaseline() { return state.textBaseline; },
    set textBaseline(v: string) { state.textBaseline = v; },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(v: number) { state.globalAlpha = v; },
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() {},
    fill() {},
    arc() {},
    setLineDash() {},
    save() {},
    restore() {},
    fillText() {},
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

describe("§10 UI-facing state stays bounded while replaying", () => {
  test("a full worst-case traversal exposes only bounded arrays", () => {
    const g = largestScenario();
    const s = new FlowTrainingSession(g.feed, g.truth, { sessionId: "perf", difficulty: "EXPERT" });
    while (!s.snapshot().atEnd) s.step(1);
    const snap = s.snapshot();

    expect(snap.atEnd).toBe(true);
    expect(snap.eventIndex).toBeGreaterThan(400);
    expect(snap.orderFlow.tape.length).toBeLessThanOrEqual(TAPE_KEEP);
    expect(snap.orderFlow.largestTrades.length).toBeLessThanOrEqual(LARGEST_KEEP);
    expect(snap.orderFlow.cvdSeries.length).toBeLessThanOrEqual(CVD_SERIES_KEEP);
    expect(snap.priceSeries.length).toBeLessThanOrEqual(PRICE_SERIES_KEEP);
    expect(snap.dom.recentEvents.length).toBeLessThanOrEqual(DOM_LOG_KEEP);
    if (snap.book) {
      expect(snap.book.bids.length).toBeLessThanOrEqual(10);
      expect(snap.book.asks.length).toBeLessThanOrEqual(10);
    }
    expect(snap.orderFlow.volumeAtPrice.length).toBeLessThanOrEqual(PRICE_SERIES_KEEP);
  });

  test("the timeline only grows and never exceeds the clock", () => {
    const g = largestScenario();
    const s = new FlowTrainingSession(g.feed, g.truth, { sessionId: "perf", difficulty: "EXPERT" });
    s.markRevealed();
    s.step(s.totalEvents);
    const full = s.snapshot().timeline;
    expect(full.length).toBeGreaterThan(0);
    for (const e of full) expect(e.index).toBeLessThanOrEqual(s.eventIndex);
    for (let i = 1; i < full.length; i++) expect(full[i].index).toBeGreaterThanOrEqual(full[i - 1].index);
  });
});

describe("§10 replay and redraw cost (generous guards)", () => {
  test("a full worst-case traversal in single-event steps finishes well inside budget", () => {
    const g = largestScenario();
    const s = new FlowTrainingSession(g.feed, g.truth, { sessionId: "perf", difficulty: "EXPERT" });
    const started = performance.now();
    let snapshots = 0;
    while (!s.snapshot().atEnd) {
      s.step(1);
      if (s.eventIndex % 25 === 0) {
        s.snapshot(); // worst case: the timeline walk runs mid-traversal too
        snapshots++;
      }
    }
    const elapsed = performance.now() - started;
    expect(snapshots).toBeGreaterThan(10);
    // Measured ≈0.4s on this host — the 5s guard is ~13× headroom.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("state reads at a fixed event are cached, not recomputed", () => {
    const g = largestScenario();
    const s = new FlowTrainingSession(g.feed, g.truth, { sessionId: "perf", difficulty: "EXPERT" });
    s.markRevealed();
    s.step(400);

    // Reference identity: the recogniser and the AMA series are reused, so no
    // panel can force a recalculation just by reading state.
    const a = s.snapshot();
    const b = s.snapshot();
    expect(b.recognition).toBe(a.recognition);
    expect(b.amaSeries).toBe(a.amaSeries);
    expect(b.evidence).toBe(a.evidence);
    expect(s.eventIndex).toBe(400); // reading state never moves the clock

    const started = performance.now();
    for (let i = 0; i < 2_000; i++) s.snapshot();
    const elapsed = performance.now() - started;
    // Measured ≈10ms on this host — the 1s guard is ~100× headroom.
    expect(elapsed).toBeLessThan(1_000);
  });

  test("chart redraw at full width stays inside budget with every overlay on", () => {
    const g = largestScenario();
    const s = new FlowTrainingSession(g.feed, g.truth, { sessionId: "perf", difficulty: "EXPERT" });
    s.markRevealed();
    s.step(s.totalEvents);
    const snap = s.snapshot();
    const ctx = stubCtx();
    const input = {
      priceSeries: snap.priceSeries,
      cvdSeries: snap.orderFlow.cvdSeries,
      tradeCount: snap.orderFlow.tradeCount,
      profile: snap.orderFlow.volumeAtPrice,
      showCvd: true,
      showProfile: true,
      vwap: snap.orderFlow.vwap,
      ama: snap.amaSeries,
      annotations: snap.annotations,
      showAnnotations: true,
    };
    expect(snap.priceSeries.length).toBeGreaterThan(200);

    const started = performance.now();
    for (let i = 0; i < 200; i++) drawFlowChart(ctx, 1200, 460, input);
    const elapsed = performance.now() - started;
    // Measured ≈95ms for 200 draws on this host — the 3s guard is ~30× headroom.
    expect(elapsed).toBeLessThan(3_000);
  });

  test("deterministic rebuild cost stays proportional to the seek target", () => {
    const g = largestScenario();
    const s = new FlowTrainingSession(g.feed, g.truth, { sessionId: "perf", difficulty: "EXPERT" });
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      s.seekTo(s.totalEvents);
      s.seekTo(0);
    }
    const elapsed = performance.now() - started;
    expect(s.eventIndex).toBe(0);
    // 40 full rebuilds of the longest scenario — measured well under 2s.
    expect(elapsed).toBeLessThan(5_000);
  });
});
