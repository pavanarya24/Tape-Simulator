import { memo, useEffect, useRef } from "react";
import { controller } from "../state/app";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from "lightweight-charts";
import {
  adaptAmaToLineData,
  adaptCvdToSeriesData,
  adaptFlowMarkers,
  adaptVolumeProfile,
  adaptVwapToLineData,
  getAmaSeriesOptions,
  getCandlestickSeriesOptions,
  getCvdSeriesOptions,
  getProfessionalChartOptions,
  getVwapSeriesOptions,
  toCandlestickData,
} from "../flow/chartAdapter";
import type { VolumeAtPrice } from "../flow/orderFlow";
import type { FlowAnnotation, FlowAnnotationType } from "../flow/recognition";
import { compact, price as fmtPrice } from "../util/format";

/** A completed trade drawn on the chart in REVIEW mode (spec §8D.2). */
export interface FlowChartTrade {
  tradeId: number;
  side: "LONG" | "SHORT";
  quantity: number;
  entryTimestamp: number;
  exitTimestamp: number;
  entryPrice: number;
  exitPrice: number;
  netPnL: number;
  mfe: number;
  mae: number;
}

interface FlowChartProps {
  priceSeries: Array<{ t: number; price: number }>;
  cvdSeries: number[];
  /** Revealed trade count — places a truncated CVD series on the time axis. */
  tradeCount?: number;
  profile: VolumeAtPrice[];
  showCvd: boolean;
  showProfile: boolean;
  vwap: number | null;
  /** When explicitly false, hides VWAP line overlay (defaults to true). */
  showVwap?: boolean;
  /** Adaptive Moving Average overlay — one value per revealed print. */
  ama?: Array<{ t: number; value: number }> | null;
  /** Observable event markers — mapped by timestamp, never array index. */
  annotations?: FlowAnnotation[];
  showAnnotations?: boolean;
  /** Review-only entry/exit markers — null while blind (policy gate). */
  trades?: FlowChartTrade[] | null;
  showTradeMarkers?: boolean;
  /** BAR_CONTEXT: coarser candle aggregation, still no future events. */
  coarseContext?: boolean;
}

/* -------------------------------------------------------------------------
   Canvas chart for the Flow Lab.

   Layout (left → right):  plot area · price axis labels · volume profile
   gutter.                  (top → bottom): price candles · CVD pane · time
   axis. Everything is drawn from the revealed synthetic tape — candles are
   time-bucketed OHLC aggregates of the traded-price series, never fed by a
   separate OHLC dataset.
   ------------------------------------------------------------------------- */

const C = {
  bg: "#0a0d10",
  pane: "#0b0f14",
  grid: "#161b21",
  axis: "#2a333d",
  line: "#e6a93c",
  vwap: "#4d8ff0",
  ama: "#22d3ee",
  cvd: "#a78bfa",
  cvdFill: "rgba(167,139,250,0.14)",
  up: "#2fbf71",
  down: "#e5484d",
  dim: "#55606b",
  text: "#7c8894",
};

const ANNOTATION_COLORS: Record<FlowAnnotationType, string> = {
  aggression: "#4d8ff0",
  concentration: "#a78bfa",
  sweep: "#e5484d",
  divergence: "#7dd3fc",
  breakout: "#2fbf71",
  rejection: "#e6a93c",
  replenishment: "#4dd0e1",
};

const MONO = "'IBM Plex Mono', monospace";
const AXIS_TZ = "America/New_York";
const fmtHMS = new Intl.DateTimeFormat("en-US", {
  hour12: false,
  timeZone: AXIS_TZ,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const fmtHM = new Intl.DateTimeFormat("en-US", {
  hour12: false,
  timeZone: AXIS_TZ,
  hour: "2-digit",
  minute: "2-digit",
});

/* ---------------------------- candle building ---------------------------- */

export interface FlowCandle {
  /** Bucket start timestamp. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Trades that printed inside the bucket. */
  n: number;
}

/** Human-friendly bucket widths (ms), smallest first. */
const NICE_STEPS_MS = [
  100, 200, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000,
  120_000, 300_000, 600_000,
];

/**
 * Smallest friendly bucket width that yields roughly `targetBuckets` candles
 * across `spanMs` — so the chart shows a readable number of candles on any
 * scenario length.
 */
export function pickBucketMs(spanMs: number, targetBuckets: number): number {
  const raw = spanMs / Math.max(1, targetBuckets);
  for (const step of NICE_STEPS_MS) if (step >= raw) return step;
  return NICE_STEPS_MS[NICE_STEPS_MS.length - 1];
}

/**
 * Aggregate the traded-price series into time-bucketed OHLC candles.
 * Points are consumed in series order; out-of-order timestamps are folded
 * into the previous bucket so the result is always time-ordered.
 */
export function buildCandles(
  points: Array<{ t: number; price: number }>,
  bucketMs: number,
): FlowCandle[] {
  if (points.length === 0) return [];
  const t0 = points[0].t;
  const step = Math.max(1, bucketMs);
  const candles: FlowCandle[] = [];
  let current: FlowCandle | null = null;
  let currentBucket = -1;
  for (const p of points) {
    const b = Math.max(currentBucket, Math.floor((p.t - t0) / step));
    if (b !== currentBucket || current === null) {
      current = { t: t0 + b * step, o: p.price, h: p.price, l: p.price, c: p.price, n: 1 };
      candles.push(current);
      currentBucket = b;
    } else {
      current.h = Math.max(current.h, p.price);
      current.l = Math.min(current.l, p.price);
      current.c = p.price;
      current.n++;
    }
  }
  return candles;
}

/* -------------------------------- drawing -------------------------------- */

export interface FlowChartDrawInput {
  priceSeries: Array<{ t: number; price: number }>;
  cvdSeries: number[];
  tradeCount?: number;
  profile: VolumeAtPrice[];
  showCvd: boolean;
  showProfile: boolean;
  vwap: number | null;
  /** Adaptive Moving Average overlay — one value per revealed print. */
  ama?: Array<{ t: number; value: number }> | null;
  annotations?: FlowAnnotation[];
  showAnnotations?: boolean;
  /** Review-only entry/exit markers — null while blind (policy gate). */
  trades?: FlowChartTrade[] | null;
  showTradeMarkers?: boolean;
  /** BAR_CONTEXT: coarser candle aggregation, still no future events. */
  coarseContext?: boolean;
}

/**
 * Pure draw routine (no DOM access beyond the context) so tests can render
 * the chart against a stub canvas and assert on what was painted.
 */
export function drawFlowChart(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  input: FlowChartDrawInput,
): void {
  const { priceSeries, cvdSeries, profile, showCvd, showProfile, vwap } = input;
  const annotations = input.annotations ?? [];
  const ama = input.ama ?? null;
  const tradeCount = input.tradeCount ?? 0;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);

  if (priceSeries.length === 0) {
    ctx.fillStyle = C.dim;
    ctx.font = `12px ${MONO}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("Generate a scenario, then step or play to reveal the tape.", 16, height / 2);
    return;
  }

  /* ---- layout ---- */
  const padLeft = 10;
  const padTop = 8;
  const padBottom = 22;
  const axisW = 64; // price-axis label column, right of the plot (terminal-style)
  const gutterW =
    showProfile && profile.length > 0 ? Math.min(140, Math.max(84, width * 0.14)) : 0;
  const plotW = Math.max(60, width - padLeft - axisW - gutterW);
  const plotX = padLeft;
  const plotRight = plotX + plotW;

  const cvdWanted = Math.max(56, Math.min(110, Math.round(height * 0.24)));
  let priceBottom = height - padBottom - cvdWanted - 10;
  const cvdVisible = showCvd && cvdSeries.length > 1 && priceBottom - padTop >= 110;
  if (!cvdVisible) priceBottom = height - padBottom;
  const cvdTop = priceBottom + 10;
  const cvdBottom = height - padBottom;

  /* ---- candles ---- */
  const t0 = priceSeries[0].t;
  const tEnd = priceSeries[priceSeries.length - 1].t;
  const span = Math.max(1, tEnd - t0);
  const target = Math.max(30, Math.min(90, Math.floor(plotW / 11)));
  // BAR_CONTEXT shows the surrounding price context at a coarser grain — it
  // changes aggregation only, never which events are revealed.
  const bucketMs = pickBucketMs(span, input.coarseContext ? Math.max(8, Math.round(target / 3)) : target);
  const candles = buildCandles(priceSeries, bucketMs);
  const axisT0 = t0;
  const axisT1 = candles[candles.length - 1].t + bucketMs;
  const timeSpan = Math.max(1, axisT1 - axisT0);
  const xOfTime = (t: number) => {
    const clamped = Math.min(axisT1, Math.max(axisT0, t));
    return plotX + (plotW * (clamped - axisT0)) / timeSpan;
  };

  /* ---- price scale ---- */
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of candles) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  if (vwap !== null) {
    hi = Math.max(hi, vwap);
    lo = Math.min(lo, vwap);
  }
  const pad = Math.max((hi - lo) * 0.08, 0.75);
  hi += pad;
  lo -= pad;
  const gridTop = padTop + 4;
  const gridBottom = priceBottom - 4;
  const yOf = (p: number) =>
    gridBottom - ((p - lo) / Math.max(1e-9, hi - lo)) * (gridBottom - gridTop);

  /* ---- CVD pane background (drawn first so the series sits on it) ---- */
  if (cvdVisible) {
    ctx.fillStyle = C.pane;
    ctx.fillRect(plotX, cvdTop, plotW, cvdBottom - cvdTop);
  }

  /* ---- gridlines + price-axis (Y) labels ---- */
  ctx.font = `10px ${MONO}`;
  ctx.textBaseline = "middle";
  const rows = 5;
  for (let g = 0; g <= rows; g++) {
    const y = gridTop + ((gridBottom - gridTop) * g) / rows;
    const val = hi - ((hi - lo) * g) / rows;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, Math.round(y) + 0.5);
    ctx.lineTo(plotRight, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = "left";
    ctx.fillText(fmtPrice(val), plotRight + 7, y);
  }

  /* ---- VWAP ---- */
  if (vwap !== null) {
    const vy = yOf(vwap);
    ctx.strokeStyle = C.vwap;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(plotX, vy);
    ctx.lineTo(plotRight, vy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.vwap;
    ctx.textAlign = "left";
    ctx.fillText("VWAP", plotX + 4, vy - 6);
  }

  /* ---- candles ---- */
  const slot = plotW / candles.length;
  const bodyW = Math.max(1, Math.min(14, slot * 0.62));
  for (const c of candles) {
    const cx = xOfTime(c.t + bucketMs / 2);
    const up = c.c >= c.o;
    const col = up ? C.up : C.down;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, yOf(c.h));
    ctx.lineTo(Math.round(cx) + 0.5, yOf(c.l));
    ctx.stroke();
    const yo = yOf(c.o);
    const yc = yOf(c.c);
    ctx.fillStyle = col;
    ctx.fillRect(cx - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
  }

  /* ---- Adaptive Moving Average ---- */
  if (ama && ama.length > 1) {
    let started = false;
    ctx.strokeStyle = C.ama;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    let first: { t: number; value: number } | null = null;
    for (const pt of ama) {
      if (pt.t < axisT0 || pt.t > axisT1) continue;
      const x = xOfTime(pt.t);
      const y = yOf(pt.value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
        first = pt;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    if (first) {
      ctx.fillStyle = C.ama;
      ctx.font = `10px ${MONO}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("AMA", plotX + 4, yOf(first.value) - 6);
    }
  }

  /* ---- observable event markers (time-interpolated onto the tape) ---- */
  if (input.showAnnotations !== false && annotations.length > 0 && priceSeries.length > 1) {
    const drawn = Math.min(annotations.length, 150);
    for (let k = 0; k < drawn; k++) {
      const a = annotations[k];
      if (a.t < axisT0 || a.t > axisT1) continue;
      let iLo = 0;
      let iHi = priceSeries.length - 1;
      while (iHi - iLo > 1) {
        const mid = (iLo + iHi) >> 1;
        if (priceSeries[mid].t <= a.t) iLo = mid;
        else iHi = mid;
      }
      const pa = priceSeries[iLo];
      const pb = priceSeries[iHi];
      const seg = pb.t - pa.t;
      const frac = seg > 0 ? Math.min(1, Math.max(0, (a.t - pa.t) / seg)) : 0;
      const price = pa.price + (pb.price - pa.price) * frac;
      const x = xOfTime(a.t);
      const y = yOf(price);
      ctx.globalAlpha = a.interpretive ? 0.95 : 0.7;
      ctx.fillStyle = ANNOTATION_COLORS[a.type] ?? C.text;
      ctx.beginPath();
      ctx.arc(x, y, a.interpretive ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (a.interpretive) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = C.bg;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.font = `9px ${MONO}`;
        ctx.fillStyle = ANNOTATION_COLORS[a.type] ?? C.text;
        ctx.textAlign = x > plotRight - 90 ? "right" : "left";
        ctx.fillText(a.label.toUpperCase(), x + (ctx.textAlign === "right" ? -6 : 6), y - 6);
        ctx.textAlign = "left";
        ctx.font = `10px ${MONO}`;
      }
      ctx.globalAlpha = 1;
    }
  }

  /* ---- review trade markers (REVIEW mode only — policy-gated upstream) ---- */
  const trades = input.trades ?? null;
  if (input.showTradeMarkers !== false && trades && trades.length > 0 && priceSeries.length > 1) {
    const drawn = Math.min(trades.length, 40);
    ctx.font = `9px ${MONO}`;
    for (let k = 0; k < drawn; k++) {
      const tr = trades[k];
      const ex = xOfTime(tr.entryTimestamp);
      const ey = yOf(tr.entryPrice);
      const xx = xOfTime(tr.exitTimestamp);
      const xy = yOf(tr.exitPrice);
      const long = tr.side === "LONG";
      const pnlCol = tr.netPnL >= 0 ? C.up : C.down;
      // entry → exit connector
      ctx.strokeStyle = C.dim;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(xx, xy);
      ctx.stroke();
      ctx.setLineDash([]);
      // entry marker: triangle pointing with the position
      ctx.fillStyle = long ? C.up : C.down;
      ctx.beginPath();
      if (long) {
        ctx.moveTo(ex, ey - 8);
        ctx.lineTo(ex - 5, ey + 3);
        ctx.lineTo(ex + 5, ey + 3);
      } else {
        ctx.moveTo(ex, ey + 8);
        ctx.lineTo(ex - 5, ey - 3);
        ctx.lineTo(ex + 5, ey - 3);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = long ? C.up : C.down;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(`${tr.side} ${tr.quantity}`, ex + 7, ey);
      // exit marker: ring coloured by the realised result
      ctx.strokeStyle = pnlCol;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(xx, xy, 4, 0, Math.PI * 2);
      ctx.stroke();
      const rightAlign = xx > plotRight - 96;
      ctx.textAlign = rightAlign ? "right" : "left";
      const dx = rightAlign ? -7 : 7;
      ctx.fillStyle = pnlCol;
      ctx.fillText(`${tr.netPnL >= 0 ? "+" : "-"}$${Math.abs(tr.netPnL).toFixed(2)}`, xx + dx, xy + 12);
      ctx.fillStyle = C.dim;
      ctx.fillText(`MFE ${Math.round(tr.mfe)} / MAE ${Math.round(tr.mae)}`, xx + dx, xy + 23);
      ctx.textAlign = "left";
    }
  }

  /* ---- last price line + tag ---- */
  const lastCandle = candles[candles.length - 1];
  const lastY = yOf(lastCandle.c);
  ctx.strokeStyle = C.line;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(plotX, lastY);
  ctx.lineTo(plotRight, lastY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.line;
  const tagW = 58;
  const tagX = plotRight - tagW - 2;
  const tagY = Math.min(Math.max(lastY - 7, gridTop), gridBottom - 14);
  ctx.fillRect(tagX, tagY, tagW, 14);
  ctx.fillStyle = C.bg;
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(fmtPrice(lastCandle.c), tagX + tagW / 2, tagY + 7);

  /* ---- CVD pane ---- */
  if (cvdVisible) {
    const cLoRaw = Math.min(0, ...cvdSeries);
    const cHiRaw = Math.max(0, ...cvdSeries);
    let cLo = cLoRaw;
    let cHi = cHiRaw;
    if (cHi - cLo < 1) {
      cHi += 1;
      cLo -= 1;
    }
    const cPad = (cHi - cLo) * 0.08;
    cHi += cPad;
    cLo -= cPad;
    const cy = (v: number) =>
      cvdBottom - 3 - ((v - cLo) / Math.max(1e-9, cHi - cLo)) * (cvdBottom - cvdTop - 6);
    // A truncated cvdSeries covers the LAST `cvdSeries.length` trades — map
    // through the true trade count so the curve lines up with the candles.
    const total = Math.max(tradeCount, cvdSeries.length, 1);
    const startIdx = Math.max(0, total - cvdSeries.length);
    const cxOf = (i: number) =>
      xOfTime(axisT0 + (timeSpan * (startIdx + i)) / Math.max(1, total - 1));

    // zero line
    ctx.strokeStyle = C.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, cy(0));
    ctx.lineTo(plotRight, cy(0));
    ctx.stroke();

    // filled area between the curve and zero
    ctx.beginPath();
    ctx.moveTo(cxOf(0), cy(0));
    for (let i = 0; i < cvdSeries.length; i++) ctx.lineTo(cxOf(i), cy(cvdSeries[i]));
    ctx.lineTo(cxOf(cvdSeries.length - 1), cy(0));
    ctx.closePath();
    ctx.fillStyle = C.cvdFill;
    ctx.fill();

    // curve
    ctx.strokeStyle = C.cvd;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < cvdSeries.length; i++) {
      const x = cxOf(i);
      const y = cy(cvdSeries[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // labels: name + current value (left), scale hi/lo (right)
    const lastCvd = cvdSeries[cvdSeries.length - 1];
    ctx.font = `10px ${MONO}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = C.cvd;
    ctx.fillText(`CVD ${lastCvd > 0 ? "+" : ""}${lastCvd}`, plotX + 5, cvdTop + 10);
    ctx.fillStyle = C.dim;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = "right";
    ctx.fillText(`${cHi > 0 ? "+" : ""}${Math.round(cHi)}`, plotRight - 4, cvdTop + 9);
    ctx.fillText(`${cLo > 0 ? "+" : ""}${Math.round(cLo)}`, plotRight - 4, cvdBottom - 8);
  }

  /* ---- volume profile gutter ---- */
  if (gutterW > 0) {
    const gx = plotRight + axisW;
    const innerX = gx + 6;
    const innerW = gutterW - 12;
    ctx.fillStyle = C.pane;
    ctx.fillRect(gx, padTop, gutterW, priceBottom - padTop);

    const maxTotal = Math.max(...profile.map((p) => p.total)) || 1;
    // Bar height follows the real spacing between adjacent price levels, so
    // the profile hugs the price scale instead of overlapping into slabs.
    let minGap = Infinity;
    for (let i = 1; i < profile.length; i++) {
      const g = profile[i].price - profile[i - 1].price;
      if (g > 0 && g < minGap) minGap = g;
    }
    if (!Number.isFinite(minGap)) minGap = 0.25;
    const pxPerPrice = (priceBottom - padTop - 8) / Math.max(1e-9, hi - lo);
    const barH = Math.max(2, Math.min(12, pxPerPrice * minGap * 0.8));

    for (const p of profile) {
      const mid = yOf(p.price);
      const top = Math.max(padTop, mid - barH / 2);
      const bottom = Math.min(priceBottom, mid + barH / 2);
      if (bottom <= top) continue;
      const w = ((p.total / maxTotal) * innerW);
      const total = p.total || 1;
      const sellW = (p.sell / total) * w;
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = C.down;
      ctx.fillRect(innerX, top, sellW, bottom - top);
      ctx.fillStyle = C.up;
      ctx.fillRect(innerX + sellW, top, w - sellW, bottom - top);
      ctx.globalAlpha = 1;
    }

    // gutter frame + captions
    ctx.strokeStyle = C.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(gx) + 0.5, padTop);
    ctx.lineTo(Math.round(gx) + 0.5, priceBottom);
    ctx.stroke();
    ctx.fillStyle = C.dim;
    ctx.font = `9px ${MONO}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("VOL PROFILE", innerX, padTop + 8);
    ctx.fillStyle = C.text;
    ctx.fillText(`max ${compact(maxTotal)}`, innerX, priceBottom - 8);
  }

  /* ---- axes: vertical price axis + horizontal time axis ---- */
  ctx.strokeStyle = C.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(plotRight) + 0.5, padTop);
  ctx.lineTo(Math.round(plotRight) + 0.5, cvdVisible ? cvdBottom : priceBottom);
  ctx.stroke();
  const axisY = Math.round(height - padBottom) + 0.5;
  ctx.beginPath();
  ctx.moveTo(plotX, axisY);
  ctx.lineTo(plotRight, axisY);
  ctx.stroke();

  /* ---- time (X) axis labels ---- */
  ctx.fillStyle = C.text;
  ctx.font = `10px ${MONO}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const useShort = bucketMs >= 60_000;
  const labelStep = Math.max(1, Math.ceil(candles.length / 8));
  for (let k = 0; k < candles.length; k += labelStep) {
    const x = xOfTime(candles[k].t + bucketMs / 2);
    const label = (useShort ? fmtHM : fmtHMS).format(new Date(candles[k].t));
    ctx.strokeStyle = C.axis;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, axisY - 4);
    ctx.lineTo(Math.round(x) + 0.5, axisY);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.fillText(label, x, axisY + 5);
  }
}

/* ------------------------------- component ------------------------------- */

/**
 * Chart-side Volume Profile gutter (spec §8B.1).
 * Displays buy/sell horizontal volume bars hugging price levels.
 */
export function VolumeProfileGutter({ profile }: { profile: VolumeAtPrice[] }) {
  const data = adaptVolumeProfile(profile);
  if (data.items.length === 0) return null;

  // Render highest price at the top, descending to match the price axis
  const sortedDesc = [...data.items].sort((a, b) => b.price - a.price);

  return (
    <aside
      className="flow-volume-profile-gutter"
      aria-label="Volume Profile"
      style={{
        width: "clamp(84px, 14%, 130px)",
        background: "#0b0f14",
        borderLeft: "1px solid #2a333d",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "6px 8px",
        boxSizing: "border-box",
        overflow: "hidden",
        userSelect: "none",
        fontFamily: "'IBM Plex Mono', monospace",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 9,
          color: "#55606b",
          marginBottom: 4,
          letterSpacing: "0.05em",
        }}
      >
        <span>VOL PROFILE</span>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-around",
          minHeight: 0,
          gap: 1,
        }}
      >
        {sortedDesc.map((item) => (
          <div
            key={item.price}
            title={`${item.formattedPrice}: ${item.total} (${item.buy} buy / ${item.sell} sell)`}
            style={{
              display: "flex",
              alignItems: "center",
              height: "max(2px, min(10px, 100% / " + Math.max(1, sortedDesc.length) + "))",
              width: "100%",
            }}
          >
            <div
              style={{
                display: "flex",
                width: `${item.widthPct}%`,
                height: "100%",
                borderRadius: 1,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${item.sellPct}%`,
                  height: "100%",
                  background: "#e5484d",
                }}
              />
              <div
                style={{
                  width: `${item.buyPct}%`,
                  height: "100%",
                  background: "#2fbf71",
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          fontSize: 9,
          color: "#7c8894",
          marginTop: 4,
          textAlign: "left",
        }}
      >
        max {data.formattedMax}
      </div>
    </aside>
  );
}

function FlowChartInner(props: FlowChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const seriesMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const amaSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const cvdSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const prevPointsCountRef = useRef<number>(0);
  const prevBucketMsRef = useRef<number>(0);
  const prevCandlesCountRef = useRef<number>(0);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof window === "undefined") return;

    const width = wrap.clientWidth || 800;
    const height = wrap.clientHeight || 420;

    const chart = createChart(wrap, getProfessionalChartOptions(width, height));
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, getCandlestickSeriesOptions());
    candleSeriesRef.current = candleSeries;

    const markersPlugin = createSeriesMarkers(candleSeries);
    seriesMarkersRef.current = markersPlugin;

    const vwapSeries = chart.addSeries(LineSeries, getVwapSeriesOptions());
    vwapSeriesRef.current = vwapSeries;

    const amaSeries = chart.addSeries(LineSeries, getAmaSeriesOptions());
    amaSeriesRef.current = amaSeries;

    if (props.showCvd) {
      const cvdSeries = chart.addSeries(AreaSeries, getCvdSeriesOptions(), 1);
      cvdSeriesRef.current = cvdSeries;
    }

    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry || !chartRef.current) return;
            const { width: w, height: h } = entry.contentRect;
            if (w > 0 && h > 0) {
              chartRef.current.applyOptions({ width: Math.floor(w), height: Math.floor(h) });
            }
          })
        : null;

    ro?.observe(wrap);

    return () => {
      ro?.disconnect();
      seriesMarkersRef.current?.detach();
      seriesMarkersRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      vwapSeriesRef.current = null;
      amaSeriesRef.current = null;
      cvdSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const vwapSeries = vwapSeriesRef.current;
    const amaSeries = amaSeriesRef.current;
    const chart = chartRef.current;
    const wrap = wrapRef.current;
    if (!candleSeries || !vwapSeries || !amaSeries || !chart || !wrap) return;

    if (props.priceSeries.length === 0) {
      candleSeries.setData([]);
      vwapSeries.setData([]);
      amaSeries.setData([]);
      if (cvdSeriesRef.current) cvdSeriesRef.current.setData([]);
      seriesMarkersRef.current?.setMarkers([]);
      prevPointsCountRef.current = 0;
      prevCandlesCountRef.current = 0;
      prevBucketMsRef.current = 0;
      controller.flowSchedulerInstance?.recordChartUpdate(true);
      return;
    }

    const t0 = props.priceSeries[0].t;
    const tEnd = props.priceSeries[props.priceSeries.length - 1].t;
    const span = Math.max(1, tEnd - t0);
    const plotW = wrap.clientWidth || 800;
    const target = Math.max(30, Math.min(90, Math.floor(plotW / 11)));
    const effectiveTarget = props.coarseContext ? Math.max(8, Math.round(target / 3)) : target;
    const bucketMs = pickBucketMs(span, effectiveTarget);
    const rawCandles = buildCandles(props.priceSeries, bucketMs);
    const adaptedCandles = toCandlestickData(rawCandles);

    const canIncremental =
      bucketMs === prevBucketMsRef.current &&
      prevCandlesCountRef.current > 0 &&
      adaptedCandles.length === prevCandlesCountRef.current &&
      props.priceSeries.length >= prevPointsCountRef.current;

    if (canIncremental && adaptedCandles.length > 0) {
      const lastCandle = adaptedCandles[adaptedCandles.length - 1];
      candleSeries.update(lastCandle);

      const vwapData =
        props.showVwap === false ? [] : adaptVwapToLineData(props.vwap, adaptedCandles);
      if (vwapData.length > 0) vwapSeries.update(vwapData[vwapData.length - 1]);

      const amaData = adaptAmaToLineData(props.ama, adaptedCandles, bucketMs, rawCandles);
      if (amaData.length > 0) amaSeries.update(amaData[amaData.length - 1]);

      if (props.showCvd && cvdSeriesRef.current) {
        const cvdData = adaptCvdToSeriesData(props.cvdSeries, adaptedCandles, {
          tradeCount: props.tradeCount,
          rawCandles,
        });
        if (cvdData.length > 0) cvdSeriesRef.current.update(cvdData[cvdData.length - 1]);
      }

      controller.flowSchedulerInstance?.recordChartUpdate(false);
    } else {
      candleSeries.setData(adaptedCandles);
      const vwapData =
        props.showVwap === false ? [] : adaptVwapToLineData(props.vwap, adaptedCandles);
      vwapSeries.setData(vwapData);
      amaSeries.setData(adaptAmaToLineData(props.ama, adaptedCandles, bucketMs, rawCandles));

      if (props.showCvd) {
        if (!cvdSeriesRef.current) {
          cvdSeriesRef.current = chart.addSeries(AreaSeries, getCvdSeriesOptions(), 1);
        }
        cvdSeriesRef.current.setData(
          adaptCvdToSeriesData(props.cvdSeries, adaptedCandles, {
            tradeCount: props.tradeCount,
            rawCandles,
          }),
        );
      } else if (cvdSeriesRef.current) {
        chart.removeSeries(cvdSeriesRef.current);
        cvdSeriesRef.current = null;
      }

      controller.flowSchedulerInstance?.recordChartUpdate(true);
    }

    // Synchronize event and trade markers
    const adaptedMarkers = adaptFlowMarkers({
      annotations: props.annotations,
      showAnnotations: props.showAnnotations,
      trades: props.trades,
      showTradeMarkers: props.showTradeMarkers,
      priceSeries: props.priceSeries,
      candles: adaptedCandles,
      rawCandles,
      bucketMs,
      isBlind: props.trades === null,
    });
    seriesMarkersRef.current?.setMarkers(adaptedMarkers);

    if (prevPointsCountRef.current === 0 && adaptedCandles.length > 0) {
      chart.timeScale().fitContent();
    }
    prevPointsCountRef.current = props.priceSeries.length;
    prevCandlesCountRef.current = adaptedCandles.length;
    prevBucketMsRef.current = bucketMs;
  }, [
    props.priceSeries,
    props.coarseContext,
    props.vwap,
    props.showVwap,
    props.ama,
    props.showCvd,
    props.cvdSeries,
    props.tradeCount,
    props.annotations,
    props.showAnnotations,
    props.trades,
    props.showTradeMarkers,
  ]);

  return (
    <div
      className="flow-professional-chart-wrapper"
      style={{
        display: "flex",
        flexDirection: "row",
        width: "100%",
        height: "100%",
        minHeight: 320,
        background: "#0a0d10",
        position: "relative",
      }}
    >
      <div
        ref={wrapRef}
        className="flow-professional-chart"
        style={{
          flex: 1,
          minWidth: 0,
          height: "100%",
          position: "relative",
        }}
      >
        {props.priceSeries.length === 0 && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: 16,
              transform: "translateY(-50%)",
              color: "#55606b",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 12,
              pointerEvents: "none",
            }}
          >
            Generate a scenario, then step or play to reveal the tape.
          </div>
        )}
      </div>

      {props.showProfile && props.profile.length > 0 && (
        <VolumeProfileGutter profile={props.profile} />
      )}
    </div>
  );
}

export const FlowChart = memo(FlowChartInner);
