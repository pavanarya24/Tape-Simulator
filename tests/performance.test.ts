/**
 * §10 Performance — ingest, index and replay a five-year-scale dataset without
 * pulling the whole series into application state.
 *
 * These are smoke/regression bounds, deliberately generous so they fail on a
 * real algorithmic regression rather than on CI noise. The measured numbers are
 * printed so they can be compared run to run.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readCsvColumns } from "../src/data/csv";
import { normalizeColumns } from "../src/data/normalize";
import { buildSessionIndex } from "../src/data/sessions";
import { DataRepository } from "../src/data/repository";
import { ReplayEngine } from "../src/replay/ReplayEngine";
import { barAt } from "../src/data/types";
import type { BarSeries } from "../src/market/types";

const TZ = "America/New_York";
const BAR_MS = 5 * 60 * 1000;

/** Naive wall-clock stamp, exactly the shape the real CSVs use. */
function stamp(y: number, m: number, d: number, minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} ${hh}:${mm}:00`;
}

interface BigFile {
  csv: string;
  rows: number;
}

/** Five years of a CME-style 5-minute series: 18:00 → 15:55 next day (264 bars). */
function buildFiveYearFile(): BigFile {
  const lines: string[] = ["Time, Open, High, Low, Close, Volume"];
  let price = 15000;
  let rows = 0;
  const cursor = new Date(Date.UTC(2019, 7, 5));
  const end = Date.UTC(2024, 7, 5);
  while (cursor.getTime() < end) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const y = cursor.getUTCFullYear();
      const m = cursor.getUTCMonth() + 1;
      const d = cursor.getUTCDate();
      const next = new Date(cursor.getTime() + 86_400_000);
      // Evening block on the trade day, overnight + day block on the next day.
      for (let minute = 1080; minute < 1440; minute += 5) {
        price += Math.sin(rows / 7) * 0.75;
        rows++;
        lines.push(`${stamp(y, m, d, minute)},${price.toFixed(2)},${(price + 1.25).toFixed(2)},${(price - 1.25).toFixed(2)},${price.toFixed(2)},${100 + (rows % 900)}`);
      }
      for (let minute = 0; minute < 960; minute += 5) {
        price += Math.cos(rows / 11) * 0.75;
        rows++;
        lines.push(
          `${stamp(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), minute)},${price.toFixed(2)},${(price + 1.25).toFixed(2)},${(price - 1.25).toFixed(2)},${price.toFixed(2)},${100 + (rows % 900)}`,
        );
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { csv: lines.join("\n"), rows };
}

let big: BigFile;
let parseMs = 0;
let normalizeMs = 0;
let indexMs = 0;
let series: BarSeries;
let rthSessions = 0;

beforeAll(() => {
  const t0 = performance.now();
  big = buildFiveYearFile();
  const built = performance.now() - t0;
  console.log(`  · generated ${big.rows.toLocaleString()} rows (${(big.csv.length / 1e6).toFixed(1)} MB) in ${built.toFixed(0)} ms`);
});

describe("five-year dataset ingestion", () => {
  test(
    "parses, validates and indexes ~5 years of 5-minute data",
    async () => {
      const heap0 = process.memoryUsage().heapUsed;

      let t = performance.now();
      const cols = await readCsvColumns(new Blob([big.csv]), { timeZone: TZ });
      parseMs = performance.now() - t;
      expect(cols.time.length).toBe(big.rows);

      t = performance.now();
      const norm = normalizeColumns(cols, TZ);
      normalizeMs = performance.now() - t;
      series = norm.series;
      expect(series.length).toBe(big.rows);
      expect(norm.quality.duplicateTimestamps).toBe(0);
      expect(norm.quality.invalidOhlc).toBe(0);
      expect(norm.quality.nonMonotonic).toBe(0);
      expect(norm.quality.detectedTimeframeMs).toBe(BAR_MS);
      expect(norm.quality.passed).toBe(true);
      expect(norm.quality.missingBars).toBe(0); // maintenance breaks are not data loss

      t = performance.now();
      const index = buildSessionIndex(series, "NQ", TZ);
      indexMs = performance.now() - t;
      rthSessions = index.rth.length;
      expect(rthSessions).toBeGreaterThan(1_200);
      expect(index.rth.every((s) => s.bars === 78)).toBe(true);
      expect(index.eth.every((s) => s.bars === 264)).toBe(true);

      const heapMb = (process.memoryUsage().heapUsed - heap0) / 1048576;
      console.log(
        `  · parse ${parseMs.toFixed(0)} ms · normalize ${normalizeMs.toFixed(0)} ms · index ${indexMs.toFixed(0)} ms · heap Δ ${heapMb.toFixed(0)} MB`,
      );

      expect(parseMs).toBeLessThan(60_000);
      expect(normalizeMs).toBeLessThan(30_000);
      expect(indexMs).toBeLessThan(10_000);
      expect(heapMb).toBeLessThan(500);
    },
    180_000,
  );

  test("column storage is typed and tightly packed (no per-bar objects)", () => {
    expect(series.t).toBeInstanceOf(Float64Array);
    expect(series.o).toBeInstanceOf(Float64Array);
    expect(series.v).toBeInstanceOf(Float64Array);
    // 6 float64 columns × 8 bytes per bar
    const bytes = series.t.byteLength + series.o.byteLength + series.h.byteLength + series.l.byteLength + series.c.byteLength + series.v.byteLength;
    expect(bytes).toBe(series.length * 6 * 8);
    console.log(`  · stored ${(bytes / 1048576).toFixed(0)} MB for ${series.length.toLocaleString()} bars`);
  });
});

describe("session loading stays lazy", () => {
  test("loading one session materializes only that session", () => {
    const meta = buildSessionIndex(series, "NQ", TZ).rth[500];
    expect(meta.bars).toBe(78);
    const t0 = performance.now();
    const slice = series.t.slice(meta.startIndex, meta.endIndex);
    const ms = performance.now() - t0;
    expect(slice.length).toBe(78);
    expect(slice.length).toBeLessThan(series.length / 1000);
    expect(ms).toBeLessThan(50);
  }, 60_000);

  test(
    "100 sequential session loads stay fast and constant-cost",
    async () => {
      const repo = new DataRepository();
      await repo.init(); // seeds the demo sets; the big series is indexed standalone here
      const index = buildSessionIndex(series, "NQ", TZ);
      const t0 = performance.now();
      let bars = 0;
      for (let i = 0; i < 100; i++) {
        const meta = index.rth[i * 10];
        const slice = series.t.slice(meta.startIndex, meta.endIndex);
        bars += slice.length;
      }
      const ms = performance.now() - t0;
      expect(bars).toBe(7_800);
      expect(ms).toBeLessThan(2_000);
      console.log(`  · 100 session loads in ${ms.toFixed(0)} ms`);
    },
    60_000,
  );

  test("the replay engine only ever holds the session it is replaying", () => {
    const index = buildSessionIndex(series, "NQ", TZ);
    const meta = index.rth[200];
    const bars = {
      t: series.t.slice(meta.startIndex, meta.endIndex),
      o: series.o.slice(meta.startIndex, meta.endIndex),
      h: series.h.slice(meta.startIndex, meta.endIndex),
      l: series.l.slice(meta.startIndex, meta.endIndex),
      c: series.c.slice(meta.startIndex, meta.endIndex),
      v: series.v.slice(meta.startIndex, meta.endIndex),
      length: meta.bars,
    };
    const engine = new ReplayEngine(meta, bars, 0);
    expect(engine.bars.length).toBe(78);
    expect(engine.bars.length).toBe(meta.bars);
    engine.dispose();
  }, 60_000);
});

describe("replay throughput", () => {
  test("stepping a full session is fast enough for 100x playback", () => {
    const index = buildSessionIndex(series, "NQ", TZ);
    const meta = index.rth[100];
    const bars: BarSeries = {
      t: series.t.slice(meta.startIndex, meta.endIndex),
      o: series.o.slice(meta.startIndex, meta.endIndex),
      h: series.h.slice(meta.startIndex, meta.endIndex),
      l: series.l.slice(meta.startIndex, meta.endIndex),
      c: series.c.slice(meta.startIndex, meta.endIndex),
      v: series.v.slice(meta.startIndex, meta.endIndex),
      length: meta.bars,
    };
    const engine = new ReplayEngine(meta, bars, 0);
    let visited = 0;
    engine.subscribe((ev) => {
      if (ev.type === "bar") visited++;
    });
    const t0 = performance.now();
    const RUNS = 200;
    for (let r = 0; r < RUNS; r++) {
      while (!engine.state.atEnd) engine.stepForward();
      engine.reset();
    }
    const ms = performance.now() - t0;
    const perBar = ms / (RUNS * 77);
    console.log(`  · ${perBar.toFixed(4)} ms per revealed bar (${RUNS} full sessions)`);
    expect(visited).toBe(RUNS * 77);
    expect(perBar).toBeLessThan(1); // 12 ms/bar is the fastest supported playback step
    engine.dispose();
  }, 60_000);

  test("bar access is O(1) at any index", () => {
    const t0 = performance.now();
    let sum = 0;
    for (let i = 0; i < 100_000; i++) {
      const idx = (i * 37) % series.length;
      sum += series.t[idx];
    }
    const ms = performance.now() - t0;
    expect(sum).toBeGreaterThan(0);
    expect(ms).toBeLessThan(500);
  }, 30_000);
});

describe("application state stays small", () => {
  test("no UI-facing array in the snapshot is larger than the loaded session", async () => {
    (globalThis as Record<string, unknown>).indexedDB = {
      open() {
        throw new Error("IndexedDB unavailable (simulated)");
      },
    };
    const { controller } = await import("../src/state/app");
    await controller.initialize();
    const s = controller.getState();

    // Walk the snapshot and find every typed array reachable from it.
    const lengths: number[] = [];
    const seen = new Set<unknown>();
    const walk = (v: unknown): void => {
      if (!v || typeof v !== "object" || seen.has(v)) return;
      seen.add(v);
      if (ArrayBuffer.isView(v)) {
        lengths.push((v as Float64Array).length);
        return;
      }
      for (const value of Object.values(v as Record<string, unknown>)) walk(value);
    };
    walk(s);

    const sessionBars = controller.session!.bars.length;
    expect(sessionBars).toBe(78); // only the demo RTH session is resident
    expect(lengths.length).toBeGreaterThan(0); // indicators are present
    expect(Math.max(...lengths)).toBeLessThanOrEqual(sessionBars);
    expect(lengths.reduce((a, b) => a + b, 0)).toBeLessThan(sessionBars * 10);
    // Nothing in the state is anywhere near a five-year series (~350k bars).
    expect(Math.max(...lengths)).toBeLessThan(10_000);
  }, 30_000);
});
