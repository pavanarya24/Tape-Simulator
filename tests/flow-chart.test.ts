/**
 * Flow Lab chart tests — verify the canvas chart actually renders what the
 * trader needs: OHLC candles, an X (time) axis and Y (price) axis with
 * labels, a visible CVD pane aligned to the tape, and a volume-at-price
 * profile that hugs the price scale in its own gutter.
 *
 * The drawing routine is a pure function over a canvas context, so these
 * tests render it against a recording stub and assert on what was painted.
 */
import { describe, expect, test } from "bun:test";
import { buildCandles, drawFlowChart, pickBucketMs } from "../src/components/FlowChart";
import type { VolumeAtPrice } from "../src/flow/orderFlow";

/* ----------------------------- stub canvas ----------------------------- */

interface StrokeOp {
  style: string;
  points: Array<{ x: number; y: number }>;
}

function stubCtx() {
  const texts: string[] = [];
  const rects: Array<{ x: number; y: number; w: number; h: number; fill: string }> = [];
  const strokes: StrokeOp[] = [];
  const fills: string[] = [];
  let path: Array<{ x: number; y: number }> = [];
  let arcs = 0;
  const state = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
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
    save() {},
    restore() {},
    clip() {},
    setLineDash() {},
    beginPath() { path = []; },
    moveTo(x: number, y: number) { path.push({ x, y }); },
    lineTo(x: number, y: number) { path.push({ x, y }); },
    closePath() {},
    stroke() { strokes.push({ style: state.strokeStyle, points: [...path] }); },
    fill() { fills.push(state.fillStyle); },
    arc() { arcs++; },
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, fill: state.fillStyle });
    },
    strokeRect() {},
    fillText(t: string) { texts.push(String(t)); },
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    texts,
    rects,
    strokes,
    fills,
    arcCount: () => arcs,
  };
}

/* ----------------------------- test fixtures ---------------------------- */

/** Deterministic NQ-like traded-price series (~17,800, 450 ms per print). */
function makeSeries(n: number): Array<{ t: number; price: number }> {
  const t0 = Date.UTC(2026, 0, 5, 14, 30, 0); // 09:30 New York
  const pts: Array<{ t: number; price: number }> = [];
  let p = 17800;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 7) * 2 + ((i % 5) - 2) * 0.25;
    pts.push({ t: t0 + i * 450, price: Math.round(p * 4) / 4 });
  }
  return pts;
}

function makeProfile(series: Array<{ price: number }>): VolumeAtPrice[] {
  const byPrice = new Map<number, VolumeAtPrice>();
  series.forEach((pt, i) => {
    const bucket = byPrice.get(pt.price) ?? { price: pt.price, buy: 0, sell: 0, total: 0 };
    const size = 2 + (i % 7);
    if (i % 3 === 0) bucket.sell += size;
    else bucket.buy += size;
    bucket.total = bucket.buy + bucket.sell;
    byPrice.set(pt.price, bucket);
  });
  return [...byPrice.values()].sort((a, b) => a.price - b.price);
}

const WIDTH = 900;
const HEIGHT = 440;
// Layout constants must mirror FlowChart: padLeft 10, axisW 64, gutter
// = clamp(900 * 0.14, 84, 140) = 126 → plotRight = 900 - 64 - 126 = 710.
const GUTTER_X = 774;

function baseInput() {
  const priceSeries = makeSeries(150);
  const cvdSeries = priceSeries.map((_, i) => i * 4 - 300);
  return {
    priceSeries,
    cvdSeries,
    tradeCount: 190, // truncated CVD (covers the last 150 of 190 trades)
    profile: makeProfile(priceSeries),
    showCvd: true,
    showProfile: true,
    vwap: 17800.5,
    annotations: [],
    showAnnotations: true,
  };
}

/* ------------------------------ pickBucketMs ---------------------------- */

describe("pickBucketMs", () => {
  test("picks a friendly step at or above the raw requirement", () => {
    expect(pickBucketMs(60_000, 60)).toBe(1_000);
    expect(pickBucketMs(10_000, 100)).toBe(100);
    expect(pickBucketMs(3_600_000, 60)).toBe(60_000);
    expect(pickBucketMs(10 * 3_600_000, 60)).toBe(600_000);
  });

  test("never returns a step smaller than span/target", () => {
    for (const span of [500, 5_000, 45_000, 171_000, 900_000, 7_200_000]) {
      for (const target of [30, 60, 90]) {
        const step = pickBucketMs(span, target);
        expect(step).toBeGreaterThanOrEqual(span / target);
      }
    }
  });

  test("degenerate span still yields a valid step", () => {
    expect(pickBucketMs(0, 60)).toBe(100);
  });
});

/* ------------------------------- buildCandles --------------------------- */

describe("buildCandles", () => {
  test("empty input → no candles", () => {
    expect(buildCandles([], 1_000)).toEqual([]);
  });

  test("aggregates OHLC per time bucket", () => {
    const t0 = 0;
    const points = [
      { t: t0 + 0, price: 100 },
      { t: t0 + 500, price: 101 },
      { t: t0 + 1_500, price: 99 },
      { t: t0 + 2_600, price: 103 },
    ];
    const candles = buildCandles(points, 1_000);
    expect(candles.length).toBe(3);
    expect(candles[0]).toEqual({ t: 0, o: 100, h: 101, l: 100, c: 101, n: 2 });
    expect(candles[1]).toEqual({ t: 1_000, o: 99, h: 99, l: 99, c: 99, n: 1 });
    expect(candles[2]).toEqual({ t: 2_000, o: 103, h: 103, l: 103, c: 103, n: 1 });
  });

  test("single print → one doji candle", () => {
    const candles = buildCandles([{ t: 42_000, price: 17_800.25 }], 2_000);
    expect(candles.length).toBe(1);
    expect(candles[0].o).toBe(17_800.25);
    expect(candles[0].h).toBe(17_800.25);
    expect(candles[0].l).toBe(17_800.25);
    expect(candles[0].c).toBe(17_800.25);
    expect(candles[0].n).toBe(1);
  });

  test("every print lands in exactly one candle, time-ordered", () => {
    const points = makeSeries(150);
    const candles = buildCandles(points, 2_000);
    const traded = candles.reduce((s, c) => s + c.n, 0);
    expect(traded).toBe(points.length);
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].t).toBeGreaterThan(candles[i - 1].t);
    }
    // OHLC invariants per candle
    for (const c of candles) {
      expect(c.h).toBeGreaterThanOrEqual(c.o);
      expect(c.h).toBeGreaterThanOrEqual(c.c);
      expect(c.l).toBeLessThanOrEqual(c.o);
      expect(c.l).toBeLessThanOrEqual(c.c);
    }
  });
});

/* ------------------------------ drawFlowChart --------------------------- */

describe("drawFlowChart", () => {
  test("draws a Y (price) axis with formatted price labels", () => {
    const { ctx, texts } = stubCtx();
    drawFlowChart(ctx, WIDTH, HEIGHT, baseInput());
    const priceLabels = texts.filter((t) => /^\d{1,3}(,\d{3})*\.\d{2}$/.test(t));
    // five gridline rows + the last-price tag
    expect(priceLabels.length).toBeGreaterThanOrEqual(5);
    expect(texts).toContain("VWAP");
  });

  test("draws an X (time) axis with clock labels below the plot", () => {
    const { ctx, texts, strokes } = stubCtx();
    drawFlowChart(ctx, WIDTH, HEIGHT, baseInput());
    const timeLabels = texts.filter((t) => /^\d{2}:\d{2}:\d{2}$/.test(t));
    expect(timeLabels.length).toBeGreaterThanOrEqual(4);
    // axis lines + tick marks are stroked in the axis colour
    const axisStrokes = strokes.filter((s) => s.style === "#2a333d");
    expect(axisStrokes.length).toBeGreaterThanOrEqual(3);
    // horizontal time axis spans the plot and sits above the labels
    const hAxis = axisStrokes.find((s) => s.points.length === 2 && s.points[0].y === s.points[1].y);
    expect(hAxis).toBeTruthy();
    expect(hAxis!.points[0].x).toBe(10);
  });

  test("draws OHLC candles as up/down bodies across the plot", () => {
    const { ctx, rects } = stubCtx();
    const input = baseInput();
    drawFlowChart(ctx, WIDTH, HEIGHT, input);
    const candles = buildCandles(
      input.priceSeries,
      pickBucketMs(
        input.priceSeries[input.priceSeries.length - 1].t - input.priceSeries[0].t,
        Math.max(30, Math.min(90, Math.floor((WIDTH - 10 - 64 - 126) / 11))),
      ),
    );
    const candleRects = rects.filter(
      (r) => (r.fill === "#2fbf71" || r.fill === "#e5484d") && r.x < GUTTER_X - 64,
    );
    expect(candles.length).toBeGreaterThanOrEqual(20);
    expect(candleRects.length).toBe(candles.length);
  });

  test("CVD pane is labelled and aligned to the true trade clock", () => {
    const { ctx, texts, strokes } = stubCtx();
    const input = baseInput();
    drawFlowChart(ctx, WIDTH, HEIGHT, input);
    expect(texts.some((t) => t.startsWith("CVD "))).toBe(true);

    const cvdStroke = strokes.find(
      (s) => s.style === "#a78bfa" && s.points.length === input.cvdSeries.length,
    );
    expect(cvdStroke).toBeTruthy();
    // tradeCount (190) > cvdSeries.length (150): the curve must start ~21%
    // into the plot, not at the left edge.
    expect(cvdStroke!.points[0].x).toBeGreaterThan(10 + 100);
    expect(cvdStroke!.points[0].x).toBeLessThan(710);
  });

  test("CVD pane hidden when toggled off", () => {
    const { ctx, texts } = stubCtx();
    drawFlowChart(ctx, WIDTH, HEIGHT, { ...baseInput(), showCvd: false });
    expect(texts.some((t) => t.startsWith("CVD "))).toBe(false);
  });

  test("volume profile draws aligned bars in the right-hand gutter", () => {
    const { ctx, texts, rects } = stubCtx();
    const input = baseInput();
    drawFlowChart(ctx, WIDTH, HEIGHT, input);
    expect(texts).toContain("VOL PROFILE");
    const gutterBars = rects.filter(
      (r) => (r.fill === "#2fbf71" || r.fill === "#e5484d") && r.x >= GUTTER_X,
    );
    expect(gutterBars.length).toBeGreaterThanOrEqual(input.profile.length);
    // bars hug the price scale: every bar sits inside the price pane
    for (const r of gutterBars) {
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.y + r.h).toBeLessThanOrEqual(HEIGHT - 22);
      expect(r.h).toBeLessThanOrEqual(12);
    }
  });

  test("profile hidden when toggled off", () => {
    const { ctx, texts, rects } = stubCtx();
    drawFlowChart(ctx, WIDTH, HEIGHT, { ...baseInput(), showProfile: false });
    expect(texts.includes("VOL PROFILE")).toBe(false);
    // no gutter background panel (the CVD pane shares its colour but stays left)
    expect(rects.some((r) => r.fill === "#0b0f14" && r.x >= 700)).toBe(false);
  });

  test("event markers are drawn for annotations", () => {
    const { ctx, texts, arcCount } = stubCtx();
    const input = baseInput();
    const mid = input.priceSeries[75];
    drawFlowChart(ctx, WIDTH, HEIGHT, {
      ...input,
      annotations: [
        { t: mid.t, seq: mid.t, type: "aggression", label: "Buy aggression", interpretive: true },
      ],
    });
    expect(arcCount()).toBe(1);
    expect(texts).toContain("BUY AGGRESSION");
  });

  test("empty state shows the guidance message and nothing else", () => {
    const { ctx, texts, rects } = stubCtx();
    drawFlowChart(ctx, 800, 400, {
      priceSeries: [],
      cvdSeries: [],
      profile: [],
      showCvd: true,
      showProfile: true,
      vwap: null,
    });
    expect(texts).toContain("Generate a scenario, then step or play to reveal the tape.");
    expect(rects.filter((r) => r.w < 700 && r.h < 50).length).toBe(0);
  });
});
