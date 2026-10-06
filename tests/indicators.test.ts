/**
 * §5 Indicators — user-defined EMA lengths.
 *
 * The overlay panel lets a trader draw any EMA period they want, so the maths
 * has to hold for an arbitrary length (not just 21/50/200) and the sanitiser
 * must never let junk from the input field or from localStorage reach `ema()`.
 */

import { describe, expect, test } from "bun:test";
import { series, trend } from "./helpers";
import {
  DEFAULT_EMA_LENGTHS,
  MAX_EMA_LENGTH,
  MIN_EMA_LENGTH,
  computeIndicators,
  ema,
  normalizeEmaLengths,
} from "../src/indicators/indicators";

const TZ = "America/New_York";

describe("EMA length normalisation", () => {
  test("rounds, de-duplicates and sorts ascending", () => {
    expect(normalizeEmaLengths([50, 9.4, 21, 9.4, 200, 21])).toEqual([9, 21, 50, 200]);
  });

  test("drops non-finite, fractional-to-zero and out-of-range input", () => {
    expect(
      normalizeEmaLengths([NaN, Infinity, -Infinity, 0, -5, MIN_EMA_LENGTH - 1, MAX_EMA_LENGTH + 1, 12]),
    ).toEqual([12]);
  });

  test("keeps the documented bounds inclusive and tolerates an empty list", () => {
    expect(normalizeEmaLengths([MIN_EMA_LENGTH, MAX_EMA_LENGTH])).toEqual([MIN_EMA_LENGTH, MAX_EMA_LENGTH]);
    expect(normalizeEmaLengths([])).toEqual([]);
  });

  test("a 1-bar EMA is rejected (it has nothing to smooth)", () => {
    expect(normalizeEmaLengths([1])).toEqual([]);
  });
});

describe("custom EMA series", () => {
  const bars = trend(100, 30, 60_000, 1);

  test("any requested length is computed, and the stock periods still are", () => {
    const ind = computeIndicators(bars, 15, TZ, [5, 9]);
    expect(Object.keys(ind.emas).map(Number).sort((a, b) => a - b)).toEqual([5, 9, 21, 50, 200]);
    expect(ind.emas[9].length).toBe(bars.length);
  });

  test("the custom series is exactly the generic EMA of the closes", () => {
    const ind = computeIndicators(bars, 15, TZ, [5, 9]);
    for (const len of [5, 9, 21, 50, 200]) {
      const expected = ema(bars.c, len);
      expect(ind.emas[len].length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        // `toBe` uses Object.is, so the leading NaN warm-up window compares too.
        expect(ind.emas[len][i]).toBe(expected[i]);
      }
    }
  });

  test("a custom EMA stays NaN until it has enough history", () => {
    const ind = computeIndicators(bars, 15, TZ, [5, 25]);
    expect(Number.isNaN(ind.emas[5][3])).toBe(true);
    expect(Number.isFinite(ind.emas[5][4])).toBe(true);
    expect(Number.isNaN(ind.emas[25][23])).toBe(true);
    expect(Number.isFinite(ind.emas[25][24])).toBe(true);
    // 30 bars is not enough history for the stock 200 period.
    expect(Number.isFinite(ind.emas[200][bars.length - 1])).toBe(false);
  });

  test("a shorter custom EMA responds faster than a longer one on a trend", () => {
    const ind = computeIndicators(bars, 15, TZ, [3, 20]);
    const last = bars.length - 1;
    expect(ind.emas[3][last]).toBeGreaterThan(ind.emas[20][last]);
    expect(ind.emas[20][last]).toBeLessThan(bars.c[last]); // still lagging the rise
  });

  test("junk lengths are filtered instead of corrupting the series", () => {
    const ind = computeIndicators(bars, 15, TZ, [NaN, -3, 1, 7000, 10]);
    expect(Number.isFinite(ind.emas[10][bars.length - 1])).toBe(true);
    expect(Object.keys(ind.emas).map(Number)).not.toContain(-3);
    expect(Object.keys(ind.emas).map(Number)).not.toContain(7000);
  });

  test("omitting the argument keeps the historical 21/50/200 behaviour", () => {
    const ind = computeIndicators(bars, 15, TZ);
    for (const len of DEFAULT_EMA_LENGTHS) {
      expect(ind.emas[len]).toBeDefined();
    }
    const expected21 = ema(bars.c, 21);
    for (let i = 0; i < expected21.length; i++) expect(ind.ema21[i]).toBe(expected21[i]);
    expect(ind.ema50.length).toBe(bars.length);
    expect(ind.ema200.length).toBe(bars.length);
  });

  test("an empty custom list still exposes the stock periods for the legacy fields", () => {
    const ind = computeIndicators(bars, 15, TZ, []);
    expect(Number.isFinite(ind.ema21[bars.length - 1])).toBe(true);
    expect(ind.emas[21]).toBe(ind.ema21);
  });

  test("the indicator is line-agnostic: a flat session gives a flat EMA", () => {
    const flat = series(
      Array.from({ length: 12 }, (_, i) => [1_700_000_000_000 + i * 60_000, 50, 50.5, 49.5, 50, 100]),
    );
    const ind = computeIndicators(flat, 15, TZ, [8]);
    expect(ind.emas[8][11]).toBeCloseTo(50, 10);
  });
});
