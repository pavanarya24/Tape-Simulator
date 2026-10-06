/**
 * Phase 8B — professional trader workspace.
 *
 * Covers spec §12 TAPE / DOM / CHART / KEYBOARD:
 *  - Time & Sales stays synchronised with the event clock, preserves the
 *    feed's aggressorSide, and detects large / burst / sweep-like prints
 *  - filters only change the view, never the underlying data
 *  - DOM per-level change detection (new / added / pulled / removed) from
 *    consecutive revealed books, plus monotonic liquidity counters
 *  - chart marker mapping by TIMESTAMP (not array index), review trade-marker
 *    gating, and coarse BAR_CONTEXT aggregation
 *  - keyboard shortcut resolution with input-field protection
 */

import { describe, expect, test } from "bun:test";
import type { Aggressor, Level, TradeEvent } from "../src/flow/events";
import { buildTapeRows, summariseTape, TAPE_LARGE_MULTIPLE } from "../src/flow/tape";
import { BOOK_CHANGE_KEEP, countChanges, diffBook, type BookChange } from "../src/flow/domDiff";
import { drawFlowChart } from "../src/components/FlowChart";
import { FLOW_SHORTCUT_KEYS, FLOW_SHORTCUTS, isTypingTarget, resolveFlowShortcut } from "../src/flow/keyboard";
import { generateScenario, type FlowScenarioId } from "../src/flow/scenarios";
import { FlowTrainingSession } from "../src/flow/session";

/* ============================== helpers ============================== */

function print(sequence: number, timestamp: number, price: number, size: number, aggressorSide: Aggressor): TradeEvent {
  return { kind: "trade", timestamp, price, size, aggressorSide, sequence };
}

function level(price: number, size: number, orderCount = 1): Level {
  return { price, size, orderCount };
}

const BASE = 1_700_000_000_000;

function sessionFor(id: FlowScenarioId, seed: number) {
  const g = generateScenario(id, seed, { difficulty: "INTERMEDIATE" });
  return new FlowTrainingSession(g.feed, g.truth, { sessionId: "phase8-b", difficulty: "INTERMEDIATE" });
}

/* ========================== Time & Sales ========================== */

describe("8B.2 Time & Sales", () => {
  const tape: TradeEvent[] = [
    print(4, BASE + 4_000, 18451.25, 12, "BUY"),
    print(3, BASE + 3_000, 18451.0, 3, "SELL"),
    print(2, BASE + 2_200, 18450.75, 2, "BUY"),
    print(1, BASE + 1_000, 18450.5, 2, "SELL"),
  ];

  test("aggressor side is preserved exactly from the feed — never inferred", () => {
    const rows = buildTapeRows(tape, "ALL");
    for (const r of rows) {
      const src = tape.find((t) => t.sequence === r.sequence)!;
      expect(r.aggressorSide).toBe(src.aggressorSide);
      expect(r.price).toBe(src.price);
      expect(r.size).toBe(src.size);
      expect(r.timestamp).toBe(src.timestamp);
    }
    // A big BUY print on a falling tape is still reported as a BUY.
    const bigBuy = buildTapeRows(
      [
        print(1, BASE, 100, 1, "SELL"),
        print(2, BASE + 1_000, 99.75, 1, "SELL"),
        print(3, BASE + 2_000, 99.5, 1, "SELL"),
        print(4, BASE + 3_000, 99, 40, "BUY"),
      ],
      "LARGE",
    );
    expect(bigBuy.length).toBe(1);
    expect(bigBuy[0].aggressorSide).toBe("BUY");
    expect(bigBuy[0].large).toBe(true);
  });

  test("relative size is normalised to the largest print on the tape", () => {
    const rows = buildTapeRows(tape, "ALL");
    const max = Math.max(...rows.map((r) => r.relativeSize));
    expect(max).toBe(1);
    for (const r of rows) {
      expect(r.relativeSize).toBeGreaterThan(0);
      expect(r.relativeSize).toBeLessThanOrEqual(1);
    }
  });

  test("unusually large prints are detected against the tape median", () => {
    const rows = buildTapeRows(tape, "ALL");
    const big = rows.find((r) => r.sequence === 4)!;
    expect(big.large).toBe(true);
    expect(big.sweepLike).toBe(true);
    const small = rows.find((r) => r.sequence === 2)!;
    expect(small.large).toBe(false);
    expect(TAPE_LARGE_MULTIPLE).toBeGreaterThan(1);
  });

  test("bursts are detected from several prints inside the burst window", () => {
    const burst: TradeEvent[] = Array.from({ length: 5 }, (_, i) =>
      print(i + 1, BASE + i * 100, 18000 + i * 0.25, 2, "BUY"),
    );
    const rows = buildTapeRows(burst, "ALL");
    expect(rows.every((r) => r.burst)).toBe(true);
  });

  test("filters change the view only — never the underlying sequence", () => {
    const all = buildTapeRows(tape, "ALL");
    const buys = buildTapeRows(tape, "BUY");
    const sells = buildTapeRows(tape, "SELL");
    const large = buildTapeRows(tape, "LARGE");

    expect(all.length).toBe(4);
    expect(buys.map((r) => r.sequence)).toEqual([4, 2]);
    expect(sells.map((r) => r.sequence)).toEqual([3, 1]);
    expect(buys.length + sells.length).toBe(all.length); // every print has an aggressor here
    expect(large.map((r) => r.sequence)).toEqual([4]);
    for (const r of [...buys, ...sells, ...large]) {
      expect(all.find((a) => a.sequence === r.sequence)).toEqual(r);
    }
  });

  test("summary totals come from the rows on screen", () => {
    const rows = buildTapeRows(tape, "ALL");
    const s = summariseTape(rows);
    expect(s.prints).toBe(rows.length);
    expect(s.buyVolume).toBe(14);
    expect(s.sellVolume).toBe(5);
    expect(s.largePrints).toBe(1);
    expect(s.sweeps).toBe(1);
    expect(s.bursts).toBe(0);
    expect(buildTapeRows([], "ALL")).toEqual([]);
  });

  test("the tape is synchronised with the event clock (no future prints)", () => {
    const s = sessionFor("spring", 31);
    s.step(200);
    const snap = s.snapshot();
    expect(snap.orderFlow.tape.length).toBeGreaterThan(0);
    // buildTapeRows preserves input order; the panel reverses for newest-first.
    const rows = buildTapeRows([...snap.orderFlow.tape].reverse(), "ALL");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.sequence).toBeLessThanOrEqual(snap.sequence);
      expect(r.timestamp).toBeLessThanOrEqual(snap.timestamp!);
    }
    // Newest-first view: the head row is the highest revealed sequence.
    expect(rows[0].sequence).toBe(Math.max(...rows.map((r) => r.sequence)));
  });
});

/* =============================== DOM =============================== */

describe("8B.3 DOM level-change detection", () => {
  test("classifies new / added / pulled / removed levels", () => {
    const prev = { bids: [level(99.75, 10), level(99.5, 8), level(99.25, 5)], asks: [level(100, 4), level(100.25, 6)] };
    const next = {
      bids: [level(99.75, 14), level(99.25, 0), level(99, 7)], // added / removed / new
      asks: [level(100, 2), level(100.25, 6)], // pulled / unchanged
    };
    const changes = diffBook(prev, next);
    const byPrice = new Map(changes.map((c) => [`${c.side}:${c.price}`, c]));
    expect(byPrice.get("bid:99.75")!.kind).toBe("ADDED");
    expect(byPrice.get("bid:99.75")!.delta).toBe(4);
    expect(byPrice.get("bid:99.25")!.kind).toBe("REMOVED");
    expect(byPrice.get("bid:99")!.kind).toBe("NEW");
    expect(byPrice.get("ask:100")!.kind).toBe("PULLED");
    expect(byPrice.get("ask:100")!.delta).toBe(-2);
    expect(byPrice.has("ask:100.25")).toBe(false); // unchanged → no noise
  });

  test("the first revealed book reports every level as new", () => {
    const changes = diffBook(null, { bids: [level(50, 3)], asks: [level(50.25, 4)] });
    expect(changes.length).toBe(2);
    expect(changes.every((c) => c.kind === "NEW")).toBe(true);
  });

  test("no book yields no changes", () => {
    expect(diffBook({ bids: [level(1, 1)], asks: [] }, null)).toEqual([]);
    expect(diffBook(null, null)).toEqual([]);
  });

  test("changes are capped and sorted by absolute move", () => {
    const prev = { bids: [], asks: [] };
    const next = {
      bids: Array.from({ length: 40 }, (_, i) => level(100 - i * 0.25, i + 1)),
      asks: [],
    };
    const changes = diffBook(prev, next);
    expect(changes.length).toBe(BOOK_CHANGE_KEEP);
    for (let i = 1; i < changes.length; i++) {
      expect(Math.abs(changes[i - 1].delta)).toBeGreaterThanOrEqual(Math.abs(changes[i].delta));
    }
    expect(countChanges(changes, "NEW")).toBe(changes.length);
    expect(countChanges(changes, "PULLED")).toBe(0);
  });

  test("diffing two consecutive revealed events matches the real book history", () => {
    const a = sessionFor("initiative-break", 12);
    a.step(240);
    const bookA = a.snapshot().book;
    const b = sessionFor("initiative-break", 12);
    b.step(241);
    const bookB = b.snapshot().book;
    const changes: BookChange[] = diffBook(bookA, bookB);
    for (const c of changes) {
      expect(c.delta).not.toBe(0);
      expect(c.size).toBeGreaterThanOrEqual(0);
      const before = (c.side === "bid" ? bookA!.bids : bookA!.asks).find((l) => l.price === c.price)?.size ?? 0;
      const after = (c.side === "bid" ? bookB!.bids : bookB!.asks).find((l) => l.price === c.price)?.size ?? 0;
      expect(c.delta).toBe(after - before);
    }
  });

  test("liquidity counters only grow with the clock (current-event state only)", () => {
    const s = sessionFor("absorption", 5);
    let prev = 0;
    let guard = 0;
    while (!s.snapshot().atEnd && guard++ < 60) {
      s.step(25);
      const d = s.snapshot().dom;
      const total = d.pullBidCount + d.pullAskCount + d.replenishCount + d.sweepBuyCount + d.sweepSellCount;
      expect(total).toBeGreaterThanOrEqual(prev);
      prev = total;
    }
    expect(prev).toBeGreaterThanOrEqual(0);
  });

  test("sweep state is reported as counts of the current revealed book only", () => {
    const s = sessionFor("spring", 7);
    s.step(s.totalEvents);
    const d = s.snapshot().dom;
    expect(Number.isInteger(d.sweepBuyCount)).toBe(true);
    expect(Number.isInteger(d.sweepSellCount)).toBe(true);
    expect(d.sweepBuyCount).toBeGreaterThanOrEqual(0);
    expect(d.sweepSellCount).toBeGreaterThanOrEqual(0);
    expect(d.sequence).toBe(s.snapshot().sequence);
  });
});

/* ============================== chart ============================== */

interface RecordingCtx {
  strokes: Array<{ style: string; points: Array<{ x: number; y: number }> }>;
  arcs: Array<{ x: number; y: number; r: number }>;
  texts: string[];
}

function recordingCtx(): CanvasRenderingContext2D & RecordingCtx {
  const state = { fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "left", textBaseline: "alphabetic", globalAlpha: 1 };
  let path: Array<{ x: number; y: number }> = [];
  const rec: RecordingCtx = { strokes: [], arcs: [], texts: [] };
  const ctx = {
    ...rec,
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
    setLineDash() {},
    beginPath() { path = []; },
    moveTo(x: number, y: number) { path.push({ x, y }); },
    lineTo(x: number, y: number) { path.push({ x, y }); },
    closePath() {},
    stroke() { rec.strokes.push({ style: state.strokeStyle, points: [...path] }); },
    fill() {},
    arc(x: number, y: number, r: number) { rec.arcs.push({ x, y, r }); },
    fillRect() {},
    strokeRect() {},
    fillText(t: string) { rec.texts.push(String(t)); },
    measureText: (t: string) => ({ width: t.length * 6 }),
  };
  return ctx as unknown as CanvasRenderingContext2D & RecordingCtx;
}

const SERIES = Array.from({ length: 60 }, (_, i) => ({ t: BASE + i * 1_000, price: 18_000 + Math.sin(i / 5) * 4 }));

const TRADE = {
  tradeId: 1,
  side: "LONG" as const,
  quantity: 1,
  entryTimestamp: BASE + 20_000,
  exitTimestamp: BASE + 45_000,
  entryPrice: 18_001,
  exitPrice: 18_003.5,
  netPnL: 184,
  mfe: 120,
  mae: 40,
};

function draw(opts: {
  series?: Array<{ t: number; price: number }>;
  trades?: Array<typeof TRADE> | null;
  showTradeMarkers?: boolean;
  coarseContext?: boolean;
}) {
  const ctx = recordingCtx();
  drawFlowChart(ctx, 900, 440, {
    priceSeries: opts.series ?? SERIES,
    cvdSeries: [],
    tradeCount: 0,
    profile: [],
    showCvd: false,
    showProfile: false,
    vwap: null,
    ama: null,
    annotations: [],
    trades: opts.trades ?? null,
    showTradeMarkers: opts.showTradeMarkers,
    coarseContext: opts.coarseContext,
  });
  return ctx;
}

function candleStrokes(ctx: RecordingCtx & { strokes: Array<{ style: string }> }): number {
  return ctx.strokes.filter((s) => s.style === "#2fbf71" || s.style === "#e5484d").length;
}

describe("8B.1 chart", () => {
  test("review trade markers draw entry side, exit, P&L and MFE/MAE", () => {
    const ctx = draw({ trades: [TRADE] });
    expect(ctx.arcs.length).toBe(1); // exit marker ring
    expect(ctx.texts).toContain("LONG 1");
    expect(ctx.texts).toContain("+$184.00");
    expect(ctx.texts.some((t) => t.startsWith("MFE 120 / MAE 40"))).toBe(true);
    expect(ctx.arcs[0].x).toBeGreaterThan(0);
    expect(ctx.arcs[0].x).toBeLessThan(900);
    expect(ctx.arcs[0].y).toBeGreaterThan(0);
    expect(ctx.arcs[0].y).toBeLessThan(440);
  });

  test("trade markers are gated off while blind (no trades passed) and by the flag", () => {
    expect(draw({ trades: null }).arcs.length).toBe(0);
    const gated = draw({ trades: [TRADE], showTradeMarkers: false });
    expect(gated.arcs.length).toBe(0);
    expect(gated.texts.some((t) => t.includes("LONG"))).toBe(false);
  });

  test("markers map by timestamp, not by array index", () => {
    const full = draw({ trades: [TRADE] });
    // Same first/last timestamps, interior points removed: array indices shift
    // but the trade's timestamp is unchanged, so the marker must not move.
    const decimated = SERIES.filter((_, i) => i === 0 || i === SERIES.length - 1 || i < 10 || i > 29);
    const sparse = draw({ series: decimated, trades: [TRADE] });
    expect(decimated.length).toBeLessThan(SERIES.length);
    expect(sparse.arcs.length).toBe(1);
    // x depends only on the timestamp — never on the point's array index.
    expect(sparse.arcs[0].x).toBeCloseTo(full.arcs[0].x, 6);
    expect(Number.isFinite(sparse.arcs[0].y)).toBe(true);
  });

  test("later trades draw further right (time-ordered mapping)", () => {
    const later = { ...TRADE, tradeId: 2, entryTimestamp: BASE + 40_000, exitTimestamp: BASE + 55_000 };
    const ctx = draw({ trades: [TRADE, later] });
    expect(ctx.arcs.length).toBe(2);
    expect(ctx.arcs[1].x).toBeGreaterThan(ctx.arcs[0].x);
  });

  test("BAR_CONTEXT coarsens the candle grain without dropping the series", () => {
    const normal = draw({});
    const coarse = draw({ coarseContext: true });
    expect(candleStrokes(normal)).toBeGreaterThan(candleStrokes(coarse));
    expect(candleStrokes(coarse)).toBeGreaterThan(0);
    // the price axis is still labelled from the same revealed series
    expect(coarse.texts.length).toBeGreaterThan(0);
  });

  test("an empty series still renders the guidance state", () => {
    const ctx = draw({ series: [], trades: [TRADE] });
    expect(ctx.arcs.length).toBe(0);
  });
});

/* ============================ keyboard ============================ */

describe("8B/§11 keyboard shortcuts", () => {
  test("every documented shortcut resolves", () => {
    expect(resolveFlowShortcut(" ", false)).toBe("PLAY_PAUSE");
    expect(resolveFlowShortcut("ArrowRight", false)).toBe("STEP_FORWARD");
    expect(resolveFlowShortcut("ArrowLeft", false)).toBe("STEP_BACK");
    expect(resolveFlowShortcut("r", false)).toBe("RESET");
    expect(resolveFlowShortcut("R", false)).toBe("RESET");
    expect(resolveFlowShortcut("b", false)).toBe("BUY");
    expect(resolveFlowShortcut("s", false)).toBe("SELL");
    expect(resolveFlowShortcut("f", false)).toBe("FLATTEN");
  });

  test("all seven actions are represented with a key hint", () => {
    expect(FLOW_SHORTCUTS.length).toBe(7);
    for (const s of FLOW_SHORTCUTS) expect(FLOW_SHORTCUT_KEYS[s].length).toBeGreaterThan(0);
  });

  test("unrelated keys are ignored", () => {
    for (const key of ["q", "Enter", "Escape", "Tab", "1", "ArrowUp", "x"]) {
      expect(resolveFlowShortcut(key, false)).toBeNull();
    }
  });

  test("input-field protection: typing never triggers a shortcut", () => {
    for (const key of [" ", "ArrowRight", "ArrowLeft", "r", "b", "s", "f"]) {
      expect(resolveFlowShortcut(key, true)).toBeNull();
    }
    expect(isTypingTarget("INPUT")).toBe(true);
    expect(isTypingTarget("input")).toBe(true);
    expect(isTypingTarget("TEXTAREA")).toBe(true);
    expect(isTypingTarget("SELECT")).toBe(true);
    expect(isTypingTarget("DIV", true)).toBe(true); // contenteditable
    expect(isTypingTarget("DIV", false)).toBe(false);
    expect(isTypingTarget("BUTTON", false)).toBe(false);
  });
});
