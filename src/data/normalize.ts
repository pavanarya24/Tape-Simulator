/**
 * Normalization + data-quality validation.
 *
 * Takes raw parsed columns and produces (a) a compact column-oriented BarSeries
 * sorted by time with duplicates removed and invalid OHLC rows dropped, and
 * (b) a DataQualityReport describing everything that was wrong with the file.
 */

import type { BarSeries } from "../market/types";
import { emptyBarSeries } from "./types";
import type { DataQualityReport } from "./types";
import type { RawColumns } from "./csv";
import { isoDate, clockTime } from "./timezone";

export interface NormalizeResult {
  series: BarSeries;
  quality: DataQualityReport;
}

const MAX_EXAMPLES = 8;

function growableArrays(n: number) {
  return {
    t: new Float64Array(n),
    o: new Float64Array(n),
    h: new Float64Array(n),
    l: new Float64Array(n),
    c: new Float64Array(n),
    v: new Float64Array(n),
  };
}

export function normalizeColumns(cols: RawColumns, timezone: string): NormalizeResult {
  const n = cols.time.length;
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;

  // Stable-ish sort by timestamp so the series is chronological regardless of
  // the order the file happened to be in.
  const order = Array.from(idx).sort((a, b) => cols.time[a] - cols.time[b]);

  let nonMonotonic = 0;
  for (let i = 1; i < n; i++) {
    if (cols.time[i] < cols.time[i - 1]) nonMonotonic++;
  }

  const buf = growableArrays(n);
  let w = 0;
  let duplicates = 0;
  let invalidOhlc = 0;
  let zeroVolume = 0;
  const duplicateExamples: number[] = [];
  const invalidExamples: string[] = [];

  let lastT = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const t = cols.time[i];
    const o = cols.open[i];
    const h = cols.high[i];
    const l = cols.low[i];
    const c = cols.close[i];
    const v = cols.volume[i];

    if (t === lastT) {
      duplicates++;
      if (duplicateExamples.length < MAX_EXAMPLES) duplicateExamples.push(t);
      continue;
    }

    const eps = 1e-9;
    const valid =
      Number.isFinite(o) &&
      Number.isFinite(h) &&
      Number.isFinite(l) &&
      Number.isFinite(c) &&
      h + eps >= Math.max(o, c) &&
      l - eps <= Math.min(o, c) &&
      h + eps >= l &&
      v >= 0;

    if (!valid) {
      invalidOhlc++;
      if (invalidExamples.length < MAX_EXAMPLES) {
        invalidExamples.push(
          `${isoDate(t, timezone)} ${clockTime(t, timezone)} O:${o} H:${h} L:${l} C:${c}`,
        );
      }
      continue;
    }

    if (v === 0) zeroVolume++;

    buf.t[w] = t;
    buf.o[w] = o;
    buf.h[w] = h;
    buf.l[w] = l;
    buf.c[w] = c;
    buf.v[w] = v;
    w++;
    lastT = t;
  }

  // Detect timeframe from the distribution of consecutive deltas.
  const counts = new Map<number, number>();
  let missingBars = 0;
  const missingExamples: string[] = [];
  for (let i = 1; i < w; i++) {
    const d = buf.t[i] - buf.t[i - 1];
    // Overnight / weekend breaks are not part of the intraday timeframe, so
    // they must not skew detection or the consistency verdict.
    if (d > 0 && !isOvernightJump(d)) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let timeframeMs = 0;
  let timeframeCount = 0;
  for (const [delta, count] of counts) {
    if (count > timeframeCount || (count === timeframeCount && delta < timeframeMs)) {
      timeframeMs = delta;
      timeframeCount = count;
    }
  }
  if (timeframeMs === 0) timeframeMs = 5 * 60 * 1000;

  const timeframeCounts: Record<string, number> = {};
  for (const [delta, count] of counts) {
    const key = `${Math.round(delta / 60000)}m`;
    timeframeCounts[key] = (timeframeCounts[key] ?? 0) + count;
  }

  for (let i = 1; i < w; i++) {
    const d = buf.t[i] - buf.t[i - 1];
    // The CME maintenance window and weekends are legitimate breaks in an
    // intraday series, so they must not be reported as missing bars either.
    if (d > timeframeMs * 1.5 && !isOvernightJump(d)) {
      const gap = Math.max(0, Math.round(d / timeframeMs) - 1);
      missingBars += gap;
      if (missingExamples.length < MAX_EXAMPLES) {
        missingExamples.push(
          `${isoDate(buf.t[i - 1], timezone)} ${clockTime(buf.t[i - 1], timezone)} → missing ${gap}`,
        );
      }
    }
  }

  const consistent = Object.keys(timeframeCounts).length <= 1 || timeframeCount === w - 1;

  const series = emptyBarSeries();
  series.t = buf.t.slice(0, w);
  series.o = buf.o.slice(0, w);
  series.h = buf.h.slice(0, w);
  series.l = buf.l.slice(0, w);
  series.c = buf.c.slice(0, w);
  series.v = buf.v.slice(0, w);
  series.length = w;

  const quality: DataQualityReport = {
    rows: w,
    duplicateTimestamps: duplicates,
    duplicateExamples,
    missingBars,
    missingExamples,
    invalidOhlc,
    invalidExamples,
    zeroVolumeBars: zeroVolume,
    nonMonotonic,
    detectedTimeframeMs: timeframeMs,
    timeframeConsistent: consistent,
    timeframeCounts,
    firstBar: w > 0 ? series.t[0] : 0,
    lastBar: w > 0 ? series.t[w - 1] : 0,
    // A dataset cannot be reported as validated when rows were dropped on the
    // way in: parse rejects are data loss, exactly like duplicate or invalid
    // rows. (Benign blank/comment lines are counted separately as
    // `skippedLines` and are intentionally excluded.)
    passed:
      duplicates === 0 &&
      invalidOhlc === 0 &&
      nonMonotonic === 0 &&
      consistent &&
      w === n &&
      cols.unparseableRows === 0 &&
      cols.badTimestamps === 0,
  };

  return { series, quality };
}

function isOvernightJump(deltaMs: number): boolean {
  // The CME maintenance window (16:00–18:00 ET) plus weekends are legitimate
  // gaps in an intraday futures series, not "missing bars".
  return deltaMs >= 90 * 60 * 1000;
}
