import type { Bar, BarSeries, RootSymbol } from "../market/types";

export type SessionType = "RTH" | "ETH";

/** RTH is 09:30–16:00 America/New_York; ETH is the full 23-hour futures day. */
export const RTH_START_MINUTES = 9 * 60 + 30; // 09:30
export const RTH_END_MINUTES = 16 * 60; // 16:00
export const ETH_DAY_START_MINUTES = 18 * 60; // 18:00 prior day opens the CME day

/** Which timezone the dataset's naive timestamps are interpreted in. */
export interface TimezoneConfig {
  sourceTimeZone: string;
  displayTimeZone: string;
}

export interface SessionMeta {
  /** Stable id: `${instrument}:${type}:${date}`. */
  id: string;
  instrument: RootSymbol;
  type: SessionType;
  /** Trade date, `YYYY-MM-DD` (CME day for ETH, calendar day for RTH). */
  date: string;
  /** Inclusive start / exclusive end indices into the dataset's bar arrays. */
  startIndex: number;
  endIndex: number;
  bars: number;
  firstTime: number;
  lastTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DataQualityReport {
  rows: number;
  duplicateTimestamps: number;
  duplicateExamples: number[];
  missingBars: number;
  missingExamples: string[];
  invalidOhlc: number;
  invalidExamples: string[];
  zeroVolumeBars: number;
  nonMonotonic: number;
  detectedTimeframeMs: number;
  timeframeConsistent: boolean;
  timeframeCounts: Record<string, number>;
  firstBar: number;
  lastBar: number;
  passed: boolean;
}

export interface DatasetMeta {
  instrument: RootSymbol;
  source: "CSV_UPLOAD" | "DEMO";
  label: string;
  fileName?: string;
  timezone: TimezoneConfig;
  barCount: number;
  firstBar: number;
  lastBar: number;
  detectedTimeframeMs: number;
  ingestedAt: number;
  quality: DataQualityReport;
  rthSessions: number;
  ethSessions: number;
}

/** A loaded, chart-ready slice of one session. */
export interface SessionBars {
  meta: SessionMeta;
  bars: BarSeries;
}

export interface IngestProgress {
  phase: "reading" | "normalizing" | "indexing" | "storing" | "done" | "error";
  bytesRead: number;
  totalBytes: number;
  rowsParsed: number;
  message: string;
}

export type IngestProgressCallback = (p: IngestProgress) => void;

/* --------------------------- helpers --------------------------- */

export function emptyBarSeries(): BarSeries {
  return {
    t: new Float64Array(0),
    o: new Float64Array(0),
    h: new Float64Array(0),
    l: new Float64Array(0),
    c: new Float64Array(0),
    v: new Float64Array(0),
    length: 0,
  };
}

export function barSeriesFromBars(bars: Bar[]): BarSeries {
  const s = emptyBarSeries();
  s.t = new Float64Array(bars.length);
  s.o = new Float64Array(bars.length);
  s.h = new Float64Array(bars.length);
  s.l = new Float64Array(bars.length);
  s.c = new Float64Array(bars.length);
  s.v = new Float64Array(bars.length);
  s.length = bars.length;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    s.t[i] = b.t;
    s.o[i] = b.o;
    s.h[i] = b.h;
    s.l[i] = b.l;
    s.c[i] = b.c;
    s.v[i] = b.v;
  }
  return s;
}

export function sliceBarSeries(series: BarSeries, start: number, end: number): BarSeries {
  const n = Math.max(0, end - start);
  const out = emptyBarSeries();
  out.t = series.t.slice(start, end);
  out.o = series.o.slice(start, end);
  out.h = series.h.slice(start, end);
  out.l = series.l.slice(start, end);
  out.c = series.c.slice(start, end);
  out.v = series.v.slice(start, end);
  out.length = n;
  return out;
}

export function barAt(series: BarSeries, i: number): Bar {
  return {
    t: series.t[i],
    o: series.o[i],
    h: series.h[i],
    l: series.l[i],
    c: series.c[i],
    v: series.v[i],
  };
}
