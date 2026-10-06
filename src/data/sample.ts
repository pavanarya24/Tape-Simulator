/**
 * Synthetic demo dataset.
 *
 * Tape Lab ships with a small, clearly-labelled SYNTHETIC dataset so the replay
 * terminal is usable before real NQ/ES CSVs are uploaded. It is generated from a
 * seeded random walk — it is NOT market history and is labelled as demo data
 * everywhere it appears (top bar badge, Data Explorer, dataset meta).
 *
 * Real datasets are imported through Data → Import CSV and replace the demo
 * series for that instrument.
 */

import type { BarSeries, RootSymbol } from "../market/types";
import { barSeriesFromBars } from "./types";
import type { DatasetMeta, DataQualityReport } from "./types";
import { buildSessionIndex } from "./sessions";
import type { StoredDataset } from "./db";
import { addDays, wallClockToUtc } from "./timezone";

type Regime = "trendUp" | "trendDown" | "range" | "breakout" | "reversal";

const REGIMES: Regime[] = ["trendUp", "trendDown", "range", "breakout", "reversal"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface InstrumentProfile {
  basePrice: number;
  pointVol: number;
  tick: number;
}

const PROFILES: Record<RootSymbol, InstrumentProfile> = {
  NQ: { basePrice: 15250, pointVol: 5.5, tick: 0.25 },
  ES: { basePrice: 4380, pointVol: 1.6, tick: 0.25 },
};

/** Last `count` weekdays ending on (and including) `endDate`. */
function businessDaysBack(endDate: string, count: number): string[] {
  const out: string[] = [];
  let cursor = endDate;
  while (out.length < count) {
    const [y, m, d] = cursor.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(cursor);
    cursor = addDays(cursor, -1);
  }
  return out;
}

function buildSessionBars(
  instrument: RootSymbol,
  tradeDate: string,
  openPrice: number,
  regime: Regime,
  rng: () => number,
): { bars: number[][] } {
  const profile = PROFILES[instrument];
  const tz = "America/New_York"; // demo bars are NY-anchored, like the real CSVs
  void tz;

  // Session opens 18:00 the prior calendar day and runs to 17:00 on trade day.
  const [y, m, d] = addDays(tradeDate, -1).split("-").map(Number);
  const startMs = wallClockToUtc(y, m, d, 18, 0, 0, tz);

  const BARS = 275; // 18:00 → 16:55 next day, 5-minute bars
  const step = 5 * 60 * 1000;

  let price = openPrice;
  const bars: number[][] = [];

  const driftMag = profile.pointVol * 0.22;
  let drift = 0;
  let direction = 1;

  switch (regime) {
    case "trendUp":
      drift = driftMag;
      direction = 1;
      break;
    case "trendDown":
      drift = -driftMag;
      direction = -1;
      break;
    case "range":
      drift = 0;
      break;
    case "breakout":
      drift = 0;
      break;
    case "reversal":
      drift = -driftMag;
      direction = -1;
      break;
  }

  // 18:00 previous day → 09:30 trade day is 15.5 hours = 186 five-minute bars.
  const rthStartIndex = 186;

  for (let i = 0; i < BARS; i++) {
    const o = price;

    let localDrift = drift;
    if (regime === "range") {
      localDrift = Math.sin((i / BARS) * Math.PI * 6) * profile.pointVol * 0.12;
    } else if (regime === "breakout") {
      localDrift = i < rthStartIndex ? 0 : i < rthStartIndex + 10 ? driftMag * 4 * direction : driftMag * 0.6 * direction;
    } else if (regime === "reversal") {
      localDrift = i < rthStartIndex + 8 ? -driftMag * 1.6 : driftMag * 1.8;
    } else if (i > rthStartIndex + 60) {
      localDrift *= 0.55; // afternoon fade
    }

    const shock = (rng() - 0.5) * profile.pointVol * 2.2;
    const c = Math.max(1, o + localDrift + shock);
    const wickUp = Math.abs((rng() - 0.35) * profile.pointVol * 1.4);
    const wickDown = Math.abs((rng() - 0.35) * profile.pointVol * 1.4);
    const h = Math.max(o, c) + wickUp;
    const l = Math.min(o, c) - wickDown;

    const activity = i >= rthStartIndex && i < rthStartIndex + 42 ? 1.9 : 0.8;
    const v = Math.round((2500 + rng() * 4200) * activity);

    const round = (x: number) => Math.round(x / profile.tick) * profile.tick;
    bars.push([
      startMs + i * step,
      round(o),
      round(h),
      round(l),
      round(c),
      v,
    ]);
    price = c;
  }

  return { bars };
}

/** Build a complete synthetic dataset for one instrument. */
export function buildDemoDataset(instrument: RootSymbol, sessionCount = 60): StoredDataset {
  const tz = "America/New_York";
  const rng = mulberry32(instrument === "NQ" ? 0x51ab1e : 0xba5ed1);
  const dates = businessDaysBack("2024-08-30", sessionCount);
  const profile = PROFILES[instrument];

  let price = profile.basePrice;
  const all: number[][] = [];

  for (let s = 0; s < dates.length; s++) {
    const regime = REGIMES[Math.floor(rng() * REGIMES.length)];
    const { bars } = buildSessionBars(instrument, dates[s], price, regime, rng);
    all.push(...bars);
    price = bars[bars.length - 1][4];
  }

  const series: BarSeries = barSeriesFromBars(
    all.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })),
  );

  const index = buildSessionIndex(series, instrument, tz);

  const quality: DataQualityReport = {
    rows: series.length,
    duplicateTimestamps: 0,
    duplicateExamples: [],
    missingBars: 0,
    missingExamples: [],
    invalidOhlc: 0,
    invalidExamples: [],
    zeroVolumeBars: 0,
    nonMonotonic: 0,
    detectedTimeframeMs: 5 * 60 * 1000,
    timeframeConsistent: true,
    timeframeCounts: { "5m": Math.max(0, series.length - 1) },
    firstBar: series.length ? series.t[0] : 0,
    lastBar: series.length ? series.t[series.length - 1] : 0,
    passed: true,
  };

  const meta: DatasetMeta = {
    instrument,
    source: "DEMO",
    label: `${instrument} — synthetic demo data`,
    timezone: { sourceTimeZone: tz, displayTimeZone: tz },
    barCount: series.length,
    firstBar: quality.firstBar,
    lastBar: quality.lastBar,
    detectedTimeframeMs: 5 * 60 * 1000,
    ingestedAt: Date.now(),
    quality,
    rthSessions: index.rth.length,
    ethSessions: index.eth.length,
  };

  return { instrument, meta, series, index, indexedWithTimezone: tz };
}

/** A compact single-session demo used when only a quick sample is needed. */
export function demoInstruments(): RootSymbol[] {
  return ["NQ", "ES"];
}
