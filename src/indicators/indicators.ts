/**
 * Indicators. Pure functions over a session's bar arrays — no UI, no state.
 * Values before an indicator has enough history are `NaN`.
 */

import type { BarSeries } from "../market/types";
import { minutesOfDay } from "../data/timezone";
import { RTH_START_MINUTES } from "../data/types";

export function ema(values: ArrayLike<number>, period: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  if (n === 0 || period <= 0) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  let count = 0;
  let prev = NaN;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (count < period) {
      seed += v;
      count++;
      if (count === period) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Session-anchored VWAP using the typical price (H+L+C)/3. */
export function vwap(bars: BarSeries): Float64Array {
  const n = bars.length;
  const out = new Float64Array(n).fill(NaN);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < n; i++) {
    const typical = (bars.h[i] + bars.l[i] + bars.c[i]) / 3;
    pv += typical * bars.v[i];
    vol += bars.v[i];
    out[i] = vol > 0 ? pv / vol : NaN;
  }
  return out;
}

export interface OpeningRange {
  /** Minutes configured (5 / 15 / 30). */
  minutes: number;
  startIndex: number;
  endIndex: number;
  high: number;
  low: number;
  ready: boolean;
}

/**
 * Opening range measured from the 09:30 America/New_York cash open, regardless
 * of whether the replay session is RTH or the full ETH day.
 */
export function openingRange(
  bars: BarSeries,
  minutes: number,
  timeZone: string,
): OpeningRange {
  let startIndex = -1;
  for (let i = 0; i < bars.length; i++) {
    if (minutesOfDay(bars.t[i], timeZone) >= RTH_START_MINUTES) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) {
    return { minutes, startIndex: -1, endIndex: -1, high: NaN, low: NaN, ready: false };
  }

  const startMinute = minutesOfDay(bars.t[startIndex], timeZone);
  let endIndex = startIndex - 1;
  let high = -Infinity;
  let low = Infinity;
  for (let i = startIndex; i < bars.length; i++) {
    const m = minutesOfDay(bars.t[i], timeZone);
    if (m - startMinute >= minutes) break;
    high = Math.max(high, bars.h[i]);
    low = Math.min(low, bars.l[i]);
    endIndex = i;
  }
  return {
    minutes,
    startIndex,
    endIndex,
    high: Number.isFinite(high) ? high : NaN,
    low: Number.isFinite(low) ? low : NaN,
    ready: endIndex >= startIndex && Number.isFinite(high),
  };
}

/** EMA periods that are always available, so the legacy fields stay valid. */
export const DEFAULT_EMA_LENGTHS: readonly number[] = [21, 50, 200];

/** A custom EMA must fit between these lengths (inclusive). */
export const MIN_EMA_LENGTH = 2;
export const MAX_EMA_LENGTH = 1000;

/** Most EMAs drawn at once — keeps the chart readable and the panels compact. */
export const MAX_EMA_COUNT = 6;

/**
 * Sanitize a user-supplied EMA length list: round, drop anything outside
 * `MIN_EMA_LENGTH..MAX_EMA_LENGTH`, de-duplicate and sort ascending. Invalid
 * or junk input yields an empty array (the caller decides on a fallback).
 */
export function normalizeEmaLengths(lengths: readonly number[]): number[] {
  const out = new Set<number>();
  for (const raw of lengths) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < MIN_EMA_LENGTH || n > MAX_EMA_LENGTH) continue;
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

export interface IndicatorSeries {
  vwap: Float64Array;
  /** Every requested EMA keyed by period — this is what the chart draws. */
  emas: Record<number, Float64Array>;
  ema21: Float64Array;
  ema50: Float64Array;
  ema200: Float64Array;
  openingRange: OpeningRange;
}

/**
 * Compute every overlay once per session (cheap: one pass each).
 *
 * `emaLengths` are the user's custom periods; the three legacy periods are
 * always computed too so `ema21/50/200` never regress.
 */
export function computeIndicators(
  bars: BarSeries,
  openingRangeMinutes: number,
  timeZone: string,
  emaLengths: readonly number[] = DEFAULT_EMA_LENGTHS,
): IndicatorSeries {
  const emas: Record<number, Float64Array> = {};
  for (const len of normalizeEmaLengths([...emaLengths, ...DEFAULT_EMA_LENGTHS])) {
    emas[len] = ema(bars.c, len);
  }
  return {
    vwap: vwap(bars),
    emas,
    ema21: emas[21],
    ema50: emas[50],
    ema200: emas[200],
    openingRange: openingRange(bars, openingRangeMinutes, timeZone),
  };
}
