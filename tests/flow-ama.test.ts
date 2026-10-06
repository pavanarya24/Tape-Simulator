/**
 * Adaptive Moving Average (AMA) — calculation, session integration,
 * chart rendering and state plumbing.
 *
 * The AMA is an objective, price-only indicator: pure in, pure out, computed
 * on the FlowTrainingSession's event clock and safe to show while blind.
 * These tests cover the math (efficiency ratio, smoothing, boundedness,
 * parameter behaviour), the session's event-clock caching and path
 * independence, the actual canvas rendering (stub context), and the value
 * reaching FlowState for the FlowPage readout.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import {
  AMA_DEFAULT_PARAMS,
  AMA_FAST,
  AMA_PERIOD,
  AMA_SLOW,
  computeAma,
  efficiencyRatio,
} from "../src/flow/indicators/ama";
import { generateScenario } from "../src/flow/scenarios";
import { FlowTrainingSession } from "../src/flow/session";
import { drawFlowChart } from "../src/components/FlowChart";

const AMA_COLOR = "#22d3ee";

/* ----------------------------- stub canvas ----------------------------- */

function stubCtx() {
  const texts: string[] = [];
  const strokes: Array<{ style: string; points: Array<{ x: number; y: number }> }> = [];
  let path: Array<{ x: number; y: number }> = [];
  const state = { strokeStyle: "#000000", fillStyle: "#000000" };
  const ctx = {
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v: string) { state.strokeStyle = v; },
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v: string) { state.fillStyle = v; },
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    clearRect() {},
    save() {},
    restore() {},
    clip() {},
    setLineDash() {},
    beginPath() { path = []; },
    moveTo(x: number, y: number) { path.push({ x, y }); },
    lineTo(x: number, y: number) { path.push({ x, y }); },
    closePath() {},
    stroke() { strokes.push({ style: state.strokeStyle, points: [...path] }); },
    fill() {},
    arc() {},
    fillRect() {},
    strokeRect() {},
    fillText(t: string) { texts.push(String(t)); },
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts, strokes };
}

/* --------------------------- deterministic data ------------------------- */

function walk(n: number): number[] {
  const out: number[] = [];
  let p = 17800;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 5) * 1.5 + ((i % 4) - 1.5) * 0.25;
    out.push(Math.round(p * 4) / 4);
  }
  return out;
}

function makeSession(seed = 4242, id: "spring" | "absorption" = "spring") {
  const g = generateScenario(id, seed);
  const s = new FlowTrainingSession(g.feed, g.truth);
  s.warmup(60);
  return s;
}

/* ------------------------- 1. AMA calculation --------------------------- */

describe("AMA calculation", () => {
  test("empty tape → empty output; aligned lengths otherwise", () => {
    expect(computeAma([])).toEqual([]);
    const prices = walk(120);
    const ama = computeAma(prices);
    expect(ama.length).toBe(prices.length);
    expect(ama.every((v) => Number.isFinite(v))).toBe(true);
    expect(efficiencyRatio(prices).length).toBe(prices.length);
  });

  test("seeds at the first print", () => {
    const prices = walk(50);
    expect(computeAma(prices)[0]).toBe(prices[0]);
    expect(computeAma([17812.25])).toEqual([17812.25]);
  });

  test("defaults match Kaufman's constants", () => {
    expect(AMA_PERIOD).toBe(10);
    expect(AMA_FAST).toBeCloseTo(2 / 3, 12);
    expect(AMA_SLOW).toBeCloseTo(2 / 31, 12);
    expect(AMA_DEFAULT_PARAMS.period).toBe(AMA_PERIOD);
  });

  test("flat tape: efficiency ratio 0 and AMA stays exactly at the price", () => {
    const prices = new Array(40).fill(17800);
    const er = efficiencyRatio(prices);
    expect(er.every((v) => v === 0)).toBe(true);
    expect(computeAma(prices).every((v) => v === 17800)).toBe(true);
  });

  test("clean trend: efficiency ratio is 1 and AMA follows with lag, never overshooting", () => {
    const prices = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const er = efficiencyRatio(prices);
    for (let i = 1; i < er.length; i++) expect(er[i]).toBeCloseTo(1, 10);

    const ama = computeAma(prices);
    for (let i = 1; i < ama.length; i++) expect(ama[i]).toBeGreaterThan(ama[i - 1]);
    expect(ama[ama.length - 1]).toBeLessThan(prices[prices.length - 1]);
    expect(Math.min(...ama)).toBeGreaterThanOrEqual(Math.min(...prices));
    expect(Math.max(...ama)).toBeLessThanOrEqual(Math.max(...prices));
  });

  test("efficiency ratio always stays within [0, 1]", () => {
    for (const er of [efficiencyRatio(walk(150)), efficiencyRatio([1, 5, 2, 9, 2, 9, 2])]) {
      for (const v of er) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  test("AMA stays bounded inside the price range of a noisy walk", () => {
    const prices = walk(200);
    const ama = computeAma(prices);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    for (const v of ama) {
      expect(v).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(v).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  test("a single jump moves AMA partway — never instantly", () => {
    const prices = [...new Array(20).fill(100), 110];
    const ama = computeAma(prices);
    const last = ama[ama.length - 1];
    expect(last).toBeGreaterThan(100);
    expect(last).toBeLessThan(110);
  });

  test("parameter overrides: fast=slow=1 tracks price exactly, 0/0 never moves", () => {
    const prices = walk(60);
    const instant = computeAma(prices, { fast: 1, slow: 1 });
    for (let i = 0; i < prices.length; i++) expect(instant[i]).toBeCloseTo(prices[i], 6);
    const frozen = computeAma(prices, { fast: 0, slow: 0 });
    expect(frozen.every((v) => v === prices[0])).toBe(true);
  });

  test("pure and deterministic — identical input, identical output", () => {
    const prices = walk(180);
    expect(computeAma(prices)).toEqual(computeAma(prices));
    expect(efficiencyRatio(prices)).toEqual(efficiencyRatio(prices));
  });
});

/* --------------- 2. session integration on the event clock --------------- */

describe("AMA on the session event clock", () => {
  test("snapshot exposes an AMA series aligned with the price series", () => {
    const s = makeSession();
    s.step(120);
    const snap = s.snapshot();
    expect(snap.priceSeries.length).toBeGreaterThan(2);
    expect(snap.amaSeries.length).toBe(snap.priceSeries.length);
    expect(snap.amaSeries.every((p) => Number.isFinite(p.value))).toBe(true);
    expect(snap.ama).not.toBeNull();
    expect(snap.ama).toBeCloseTo(snap.amaSeries[snap.amaSeries.length - 1].value, 10);
    expect(snap.amaSeries.map((p) => p.t)).toEqual(snap.priceSeries.map((p) => p.t));
  });

  test("available while blind — no reveal required", () => {
    const s = makeSession(777);
    s.step(60);
    expect(s.isRevealed).toBe(false);
    const snap = s.snapshot();
    expect(snap.recognition).toBeNull();
    expect(snap.ama).not.toBeNull();
  });

  test("state reads reuse the cached series; the clock moving rebuilds it", () => {
    const s = makeSession();
    s.step(80);
    const a = s.snapshot();
    const b = s.snapshot();
    expect(a.amaSeries).toBe(b.amaSeries); // cached by event index
    s.step(1);
    const c = s.snapshot();
    expect(c.amaSeries).not.toBe(a.amaSeries); // clock moved → recomputed
    expect(c.eventIndex).toBe(b.eventIndex + 1);
  });

  test("path independence: step vs seek vs step-back produce identical AMA", () => {
    // A: warmup(60) + step(40) → index 100
    const a = makeSession(31337, "absorption");
    a.step(40);
    const snapA = a.snapshot();
    expect(snapA.eventIndex).toBe(100);

    // B: warmup(60) then straight seek to 100
    const b = makeSession(31337, "absorption");
    b.seekTo(100);
    const snapB = b.snapshot();

    // C: overshoot to 160, then step back to 100
    const c = makeSession(31337, "absorption");
    c.step(100);
    c.seekTo(100);
    const snapC = c.snapshot();

    for (const snap of [snapB, snapC]) {
      expect(snap.eventIndex).toBe(snapA.eventIndex);
      expect(snap.amaSeries).toEqual(snapA.amaSeries);
      expect(snap.ama).toBe(snapA.ama);
    }
  });

  test("the series grows as the tape reveals more prints", () => {
    const s = makeSession(99991);
    const early = s.snapshot();
    s.step(240);
    const later = s.snapshot();
    expect(later.priceSeries.length).toBeGreaterThan(early.priceSeries.length);
    expect(later.amaSeries.length).toBe(later.priceSeries.length);
    expect(later.ama).not.toBeNull();
  });

  test("restart reproduces the same AMA for the same clock position", () => {
    const s = makeSession(2026);
    s.step(150);
    const before = s.snapshot();
    s.restart(60); // back to the warmup point
    s.seekTo(before.eventIndex);
    const after = s.snapshot();
    expect(after.amaSeries).toEqual(before.amaSeries);
    expect(after.ama).toBe(before.ama);
  });
});

/* --------------------- 3. AMA rendering on the chart -------------------- */

describe("AMA rendering on FlowChart", () => {
  test("the AMA line is drawn with one point per series value and labelled", () => {
    const s = makeSession();
    s.step(120);
    const snap = s.snapshot();
    expect(snap.amaSeries.length).toBeGreaterThanOrEqual(2);

    const { ctx, texts, strokes } = stubCtx();
    drawFlowChart(ctx, 900, 440, {
      priceSeries: snap.priceSeries,
      cvdSeries: [],
      tradeCount: 0,
      profile: [],
      showCvd: false,
      showProfile: false,
      vwap: null,
      ama: snap.amaSeries,
      annotations: [],
      showAnnotations: true,
    });

    const amaStroke = strokes.find((st) => st.style === AMA_COLOR);
    expect(amaStroke).toBeTruthy();
    expect(amaStroke!.points.length).toBe(snap.amaSeries.length);
    // every point lands inside the plot area
    for (const p of amaStroke!.points) {
      expect(p.x).toBeGreaterThanOrEqual(10);
      expect(p.x).toBeLessThanOrEqual(900);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(440);
    }
    expect(texts).toContain("AMA");
  });

  test("no AMA stroke or label when the overlay is not passed", () => {
    const { ctx, texts, strokes } = stubCtx();
    drawFlowChart(ctx, 900, 440, {
      priceSeries: makeSession().snapshot().priceSeries,
      cvdSeries: [],
      tradeCount: 0,
      profile: [],
      showCvd: false,
      showProfile: false,
      vwap: null,
      annotations: [],
      showAnnotations: true,
    });
    expect(strokes.some((st) => st.style === AMA_COLOR)).toBe(false);
    expect(texts).not.toContain("AMA");
  });
});

/* --------------------- 4. AMA reaches FlowState (UI) --------------------- */

describe("AMA value reaches FlowState for the FlowPage readout", () => {
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

  test("flow.ama and flow.amaSeries mirror the session snapshot", () => {
    controller.generateFlowScenario("initiative-break");
    const flow = controller.getState().flow;
    expect(flow.amaSeries.length).toBe(flow.priceSeries.length);
    expect(flow.amaSeries.length).toBeGreaterThan(2);
    expect(typeof flow.ama).toBe("number");
    expect(Number.isFinite(flow.ama!)).toBe(true);
    expect(flow.ama).toBeCloseTo(flow.amaSeries[flow.amaSeries.length - 1].value, 10);
  });

  test("the value updates as the trader steps the tape", () => {
    controller.generateFlowScenario("responsive-fade");
    const before = controller.getState().flow;
    controller.stepFlow(150);
    const after = controller.getState().flow;
    expect(after.amaSeries.length).toBeGreaterThan(before.amaSeries.length);
    expect(after.amaSeries.length).toBe(after.priceSeries.length);
    expect(after.ama).toBeCloseTo(after.amaSeries[after.amaSeries.length - 1].value, 10);
  });
});
