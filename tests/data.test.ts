/**
 * §2 Data — NQ/ES loading, 5-minute timestamps, America/New_York handling,
 * DST transitions, RTH boundaries, duplicates, gaps, invalid OHLC, timeframe.
 */

import { describe, expect, test } from "bun:test";
import { readCsvColumns, parseTimestamp, splitCsvLine } from "../src/data/csv";
import { normalizeColumns } from "../src/data/normalize";
import { buildSessionIndex, sessionsFor } from "../src/data/sessions";
import { DataRepository } from "../src/data/repository";
import { barSeriesFromBars } from "../src/data/types";
import type { Bar } from "../src/market/types";
import {
  DEFAULT_TIMEZONE,
  addDays,
  clockTime,
  isoDate,
  minutesOfDay,
  tzOffsetMs,
  wallClockToUtc,
} from "../src/data/timezone";
import { RTH_END_MINUTES, RTH_START_MINUTES } from "../src/data/types";

const TZ = DEFAULT_TIMEZONE;
const BAR_MS = 5 * 60 * 1000;

const HEADER = "Time, Open, High, Low, Close, Volume";

function csvBlob(lines: string[]): Blob {
  return new Blob([[HEADER, ...lines].join("\n")]);
}

function ts(local: string): number {
  const [d, t] = local.split(" ");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm, ss] = t.split(":").map(Number);
  return wallClockToUtc(y, m, day, hh, mm, ss ?? 0, TZ);
}

function barsFrom(locals: { at: string; o: number; h: number; l: number; c: number; v: number }[]) {
  const bars: Bar[] = locals.map((b) => ({ t: ts(b.at), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  return barSeriesFromBars(bars);
}

describe("CSV ingestion — required schema", () => {
  test("parses Time,Open,High,Low,Close,Volume", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:30:00,7700.00,7702.00,7698.00,7701.00,1200",
        "2019-08-05 09:35:00,7701.00,7705.00,7700.00,7704.00,1500",
      ]),
      { timeZone: TZ },
    );
    expect(cols.headerFound).toBe(true);
    expect(cols.time.length).toBe(2);
    expect(cols.open).toEqual([7700, 7701]);
    expect(cols.high).toEqual([7702, 7705]);
    expect(cols.low).toEqual([7698, 7700]);
    expect(cols.close).toEqual([7701, 7704]);
    expect(cols.volume).toEqual([1200, 1500]);
    expect(cols.unparseableRows).toBe(0);
    expect(cols.badTimestamps).toBe(0);
  });

  test("accepts split Date/Time columns and column aliases", async () => {
    const cols = await readCsvColumns(
      new Blob(["Date,Time,Open,High,Low,Close,Vol\n2019-08-05,09:30,100,101,99,100.5,10\n"]),
      { timeZone: TZ },
    );
    expect(cols.time.length).toBe(1);
    expect(cols.time[0]).toBe(ts("2019-08-05 09:30:00"));
    expect(cols.volume).toEqual([10]);
  });

  test("a file with no detectable OHLC header fails loudly", async () => {
    const html = "<!doctype html><html><body>not a csv</body></html>\n";
    await expect(readCsvColumns(new Blob([html]), { timeZone: TZ })).rejects.toThrow(/Could not detect OHLC/);
  });

  test("malformed rows are counted, not silently mis-parsed", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:30:00,7700,7702,7698,7701,1200",
        "2019-08-05 09:35:00,abc,7705,7700,7704,1500", // unparseable
        "2019-08-05 09:40:00,7704,7706,7702,7705", // short row
        "", // blank
        "2019-08-05 09:45:00,7705,7707,7703,7706,900",
      ]),
      { timeZone: TZ },
    );
    // The unparseable row is rejected outright; the short row still has valid
    // OHLC so it is kept, with its missing volume defaulted to 0 (which the
    // quality report surfaces as a zero-volume bar).
    expect(cols.time.length).toBe(3);
    expect(cols.unparseableRows).toBe(1);
    expect(cols.volume[1]).toBe(0);
  });

  test("quoted fields containing commas survive the splitter", () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
    expect(splitCsvLine('"he said ""hi""",x')).toEqual(['he said "hi"', "x"]);
  });

  test("timestamps: naive wall-clock, explicit offset, epoch seconds and ms", () => {
    expect(parseTimestamp("2019-08-05 09:30:00", TZ)).toBe(ts("2019-08-05 09:30:00"));
    expect(parseTimestamp("2019-08-05T13:30:00Z", TZ)).toBe(Date.UTC(2019, 7, 5, 13, 30));
    expect(parseTimestamp("1565011800", TZ)).toBe(1565011800 * 1000);
    expect(parseTimestamp("1565011800000", TZ)).toBe(1565011800000);
    expect(Number.isNaN(parseTimestamp("not-a-time", TZ))).toBe(true);
  });

  test("regression: a partially unparseable file is not reported as validated", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:30:00,100,101,99,100,10",
        "garbage,100,101,99,100,10", // bad timestamp → dropped
        "2019-08-05 09:40:00,100,101,99,100,10",
      ]),
      { timeZone: TZ },
    );
    expect(cols.badTimestamps).toBe(1);
    const { series, quality } = normalizeColumns(cols, TZ);
    expect(series.length).toBe(2);
    expect(quality.passed).toBe(false);
  });
});

describe("timezone normalization — America/New_York", () => {
  test("default source timezone is America/New_York", () => {
    expect(DEFAULT_TIMEZONE).toBe("America/New_York");
  });

  test("EDT (summer) 09:30 ET = 13:30Z", () => {
    expect(ts("2019-08-05 09:30:00")).toBe(Date.UTC(2019, 7, 5, 13, 30));
  });

  test("EST (winter) 09:30 ET = 14:30Z", () => {
    expect(ts("2020-01-06 09:30:00")).toBe(Date.UTC(2020, 0, 6, 14, 30));
  });

  test("UTC offset is −4h in summer and −5h in winter", () => {
    expect(tzOffsetMs(Date.UTC(2019, 6, 15, 12), TZ)).toBe(-4 * 3600_000);
    expect(tzOffsetMs(Date.UTC(2019, 0, 15, 12), TZ)).toBe(-5 * 3600_000);
  });

  test("DST spring-forward day (2019-03-10) and the week either side", () => {
    expect(ts("2019-03-08 09:30:00")).toBe(Date.UTC(2019, 2, 8, 14, 30)); // EST
    expect(ts("2019-03-10 09:30:00")).toBe(Date.UTC(2019, 2, 10, 13, 30)); // EDT
    expect(ts("2019-03-11 09:30:00")).toBe(Date.UTC(2019, 2, 11, 13, 30)); // EDT
  });

  test("DST fall-back day (2019-11-03) and the week either side", () => {
    expect(ts("2019-11-01 09:30:00")).toBe(Date.UTC(2019, 10, 1, 13, 30)); // EDT
    expect(ts("2019-11-03 09:30:00")).toBe(Date.UTC(2019, 10, 3, 14, 30)); // EST
    expect(ts("2019-11-04 09:30:00")).toBe(Date.UTC(2019, 10, 4, 14, 30)); // EST
  });

  test("round-trip: UTC → wall clock in New York is stable across DST", () => {
    for (const local of ["2019-03-10 09:30:00", "2019-11-03 09:30:00", "2021-07-01 18:00:00"]) {
      const ms = ts(local);
      expect(clockTime(ms, TZ)).toBe(local.slice(11, 16));
      expect(isoDate(ms, TZ)).toBe(local.slice(0, 10));
    }
  });

  test("no DST in UTC conversion", () => {
    expect(tzOffsetMs(Date.UTC(2019, 6, 15, 12), "UTC")).toBe(0);
    expect(tzOffsetMs(Date.UTC(2019, 0, 15, 12), "UTC")).toBe(0);
  });

  test("isoDate / addDays calendar arithmetic crosses month and year ends", () => {
    expect(addDays("2019-12-31", 1)).toBe("2020-01-01");
    expect(addDays("2020-02-28", 1)).toBe("2020-02-29");
    expect(addDays("2019-01-01", -1)).toBe("2018-12-31");
  });
});

describe("RTH session boundaries", () => {
  test("RTH is 09:30–16:00 America/New_York", () => {
    expect(RTH_START_MINUTES).toBe(570);
    expect(RTH_END_MINUTES).toBe(960);
  });

  test("09:30 is inside RTH and 16:00 is outside", () => {
    expect(minutesOfDay(ts("2019-08-05 09:29:59"), TZ)).toBeLessThan(RTH_START_MINUTES);
    expect(minutesOfDay(ts("2019-08-05 09:30:00"), TZ)).toBe(RTH_START_MINUTES);
    expect(minutesOfDay(ts("2019-08-05 15:55:00"), TZ)).toBeLessThan(RTH_END_MINUTES);
    expect(minutesOfDay(ts("2019-08-05 16:00:00"), TZ)).toBe(RTH_END_MINUTES);
  });

  test("index excludes pre-open and post-close bars, keeps 09:30–15:55", () => {
    const bars = barsFrom(
      ["09:25", "09:30", "09:35", "15:55", "16:00", "16:05"].map((hm) => ({
        at: `2019-08-08 ${hm}:00`,
        o: 100,
        h: 101,
        l: 99,
        c: 100,
        v: 10,
      })),
    );
    const index = buildSessionIndex(bars, "NQ", TZ);
    expect(index.rth.length).toBe(1);
    const s = index.rth[0];
    expect(s.bars).toBe(3);
    expect(clockTime(s.firstTime, TZ)).toBe("09:30");
    expect(clockTime(s.lastTime, TZ)).toBe("15:55");
    expect(s.date).toBe("2019-08-08");
    expect(s.id).toBe("NQ:RTH:2019-08-08");
  });

  test("a full RTH day indexes exactly 78 five-minute bars", () => {
    const rows = [];
    for (let i = 0; i < 78; i++) {
      const total = RTH_START_MINUTES + i * 5;
      const hh = String(Math.floor(total / 60)).padStart(2, "0");
      const mm = String(total % 60).padStart(2, "0");
      rows.push({ at: `2019-08-08 ${hh}:${mm}:00`, o: 100, h: 101, l: 99, c: 100, v: 10 });
    }
    const bars = barsFrom(rows);
    const s = buildSessionIndex(bars, "NQ", TZ).rth[0];
    expect(s.bars).toBe(78);
    expect(clockTime(s.lastTime, TZ)).toBe("15:55");
  });

  test("consecutive days become consecutive sessions; 16:00–18:00 is its own ETH boundary", () => {
    const rows = [];
    for (const day of ["2019-08-08", "2019-08-09"]) {
      for (const hm of ["09:30", "09:35", "16:00", "17:55"]) {
        rows.push({ at: `${day} ${hm}:00`, o: 100, h: 101, l: 99, c: 100, v: 10 });
      }
    }
    const bars = barsFrom(rows);
    const index = buildSessionIndex(bars, "NQ", TZ);
    expect(index.rth.map((s) => s.date)).toEqual(["2019-08-08", "2019-08-09"]);
    expect(index.rth.every((s) => s.bars === 2)).toBe(true);
    expect(sessionsFor(index, "RTH")).toBe(index.rth);
    expect(sessionsFor(index, "ETH")).toBe(index.eth);
  });

  test("ETH rolls the trade day at 18:00 New York", () => {
    const bars = barsFrom([
      { at: "2019-08-07 18:05:00", o: 100, h: 101, l: 99, c: 100, v: 10 },
      { at: "2019-08-08 09:30:00", o: 100, h: 101, l: 99, c: 100, v: 10 },
      { at: "2019-08-08 17:55:00", o: 100, h: 101, l: 99, c: 100, v: 10 },
      { at: "2019-08-08 18:05:00", o: 100, h: 101, l: 99, c: 100, v: 10 },
    ]);
    const index = buildSessionIndex(bars, "NQ", TZ);
    expect(index.eth.map((s) => s.date)).toEqual(["2019-08-08", "2019-08-09"]);
    expect(index.eth[0].bars).toBe(3);
    expect(index.eth[1].bars).toBe(1);
  });
});

describe("data quality validation", () => {
  test("duplicate timestamps are detected and de-duplicated", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:30:00,100,101,99,100,10",
        "2019-08-05 09:30:00,100,101,99,100,10",
        "2019-08-05 09:35:00,100,101,99,100,10",
      ]),
      { timeZone: TZ },
    );
    const { series, quality } = normalizeColumns(cols, TZ);
    expect(series.length).toBe(2);
    expect(quality.duplicateTimestamps).toBe(1);
    expect(quality.passed).toBe(false);
  });

  test("missing intervals are detected and counted", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:30:00,100,101,99,100,10",
        "2019-08-05 09:35:00,100,101,99,100,10",
        "2019-08-05 09:50:00,100,101,99,100,10", // 09:40 and 09:45 missing
      ]),
      { timeZone: TZ },
    );
    const { quality } = normalizeColumns(cols, TZ);
    expect(quality.detectedTimeframeMs).toBe(BAR_MS);
    expect(quality.missingBars).toBe(2);
    expect(quality.missingExamples.length).toBeGreaterThan(0);
  });

  test("overnight and weekend gaps are not counted as missing bars", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 15:55:00,100,101,99,100,10",
        "2019-08-05 18:00:00,100,101,99,100,10",
      ]),
      { timeZone: TZ },
    );
    const { quality } = normalizeColumns(cols, TZ);
    expect(quality.missingBars).toBe(0);
    expect(quality.missingExamples).toEqual([]);
  });

  test("regression: a complete session followed by the daily maintenance break reports zero missing bars", async () => {
    // Two full 78-bar RTH sessions back to back with the 16:00–18:00 CME break
    // in between: nothing is missing, so the quality report must say so.
    const lines: string[] = [];
    for (const day of ["2019-08-08", "2019-08-09"]) {
      for (let i = 0; i < 78; i++) {
        const total = RTH_START_MINUTES + i * 5;
        const hh = String(Math.floor(total / 60)).padStart(2, "0");
        const mm = String(total % 60).padStart(2, "0");
        lines.push(`${day} ${hh}:${mm}:00,100,101,99,100,10`);
      }
    }
    const cols = await readCsvColumns(csvBlob(lines), { timeZone: TZ });
    const { series, quality } = normalizeColumns(cols, TZ);
    expect(series.length).toBe(156);
    expect(quality.detectedTimeframeMs).toBe(BAR_MS);
    expect(quality.missingBars).toBe(0);
    expect(quality.missingExamples).toEqual([]);
    expect(quality.passed).toBe(true);
  });

  test("invalid OHLC rows are rejected", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:30:00,100,101,99,100,10",
        "2019-08-05 09:35:00,100,99,98,100,10", // high < open
        "2019-08-05 09:40:00,100,101,102,100,10", // low > close
        "2019-08-05 09:45:00,100,98,99,100,10", // high < low
        "2019-08-05 09:50:00,100,101,99,100,10",
      ]),
      { timeZone: TZ },
    );
    const { series, quality } = normalizeColumns(cols, TZ);
    expect(series.length).toBe(2);
    expect(quality.invalidOhlc).toBe(3);
    expect(quality.invalidExamples.length).toBe(3);
    expect(quality.passed).toBe(false);
  });

  test("zero-volume bars are flagged but accepted", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:30:00,100,101,99,100,0",
        "2019-08-05 09:35:00,100,101,99,100,10",
      ]),
      { timeZone: TZ },
    );
    const { series, quality } = normalizeColumns(cols, TZ);
    expect(series.length).toBe(2);
    expect(quality.zeroVolumeBars).toBe(1);
  });

  test("out-of-order rows are sorted and reported as non-monotonic", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:40:00,100,101,99,100,10",
        "2019-08-05 09:30:00,100,101,99,100,10",
        "2019-08-05 09:35:00,100,101,99,100,10",
      ]),
      { timeZone: TZ },
    );
    const { series, quality } = normalizeColumns(cols, TZ);
    expect(quality.nonMonotonic).toBe(1);
    expect(Array.from(series.t)).toEqual([...Array.from(series.t)].sort((a, b) => a - b));
    expect(quality.passed).toBe(false);
  });

  test("timeframe detection follows the data, not an assumption", async () => {
    const minuteCols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:30:00,100,101,99,100,10",
        "2019-08-05 09:31:00,100,101,99,100,10",
        "2019-08-05 09:32:00,100,101,99,100,10",
      ]),
      { timeZone: TZ },
    );
    expect(normalizeColumns(minuteCols, TZ).quality.detectedTimeframeMs).toBe(60_000);
  });

  test("a clean file reports passed: true with a green validation state", async () => {
    const cols = await readCsvColumns(
      csvBlob([
        "2019-08-05 09:30:00,100,101,99,100,10",
        "2019-08-05 09:35:00,100,101,99,100,10",
        "2019-08-05 09:40:00,100,101,99,100,10",
      ]),
      { timeZone: TZ },
    );
    const { quality } = normalizeColumns(cols, TZ);
    expect(quality.passed).toBe(true);
    expect(quality.rows).toBe(3);
    expect(quality.timeframeConsistent).toBe(true);
  });
});

describe("repository — NQ and ES load independently", () => {
  test("both instruments seed, index and slice their own sessions", async () => {
    const repo = new DataRepository();
    await repo.init();
    expect(repo.isMemoryOnly).toBe(true); // no IndexedDB in the test runtime
    expect(repo.has("NQ")).toBe(true);
    expect(repo.has("ES")).toBe(true);

    const nqRth = repo.listSessions("NQ", "RTH");
    const esRth = repo.listSessions("ES", "RTH");
    expect(nqRth.length).toBeGreaterThan(0);
    expect(esRth.length).toBeGreaterThan(0);
    expect(nqRth.every((s) => s.instrument === "NQ" && s.id.startsWith("NQ:RTH:"))).toBe(true);
    expect(esRth.every((s) => s.instrument === "ES" && s.id.startsWith("ES:RTH:"))).toBe(true);

    const nq = await repo.loadSession("NQ", "RTH", nqRth[0].id);
    const es = await repo.loadSession("ES", "RTH", esRth[0].id);
    expect(nq!.meta.instrument).toBe("NQ");
    expect(es!.meta.instrument).toBe("ES");
    // Sessions are sliced, never the full multi-year series.
    expect(nq!.bars.length).toBe(nqRth[0].bars);
    expect(es!.bars.length).toBe(esRth[0].bars);
    expect(nq!.bars.length).toBeLessThan(repo.get("NQ")!.series.length);
    // Independent buffers: mutating one session cannot touch the other.
    nq!.bars.c[0] = 12345;
    expect(es!.bars.c[0]).not.toBe(12345);
    expect(repo.get("NQ")!.series.c[nqRth[0].startIndex]).not.toBe(12345);
  });

  test("unknown sessions and instruments resolve to null, not to a wrong session", async () => {
    const repo = new DataRepository();
    await repo.init();
    expect(await repo.loadSession("NQ", "RTH", "NQ:RTH:1999-01-01")).toBeNull();
    expect(await repo.loadSession("ES", "ETH", "NQ:ETH:anything")).toBeNull();
    expect(repo.listSessions("NQ", "RTH").length).toBeGreaterThan(0);
  });

  test("re-timezoning rebuilds the session index without touching the bars", async () => {
    const repo = new DataRepository();
    await repo.init();
    const before = repo.get("NQ")!.series;
    const firstT = before.t[0];
    await repo.reindex("NQ", "America/Chicago");
    expect(repo.get("NQ")!.series.t[0]).toBe(firstT);
    expect(repo.get("NQ")!.indexedWithTimezone).toBe("America/Chicago");
    expect(repo.get("NQ")!.index.rth.length).toBeGreaterThan(0);
  });

  test("the repository declares OHLC-only capabilities (no fabricated L2)", async () => {
    const repo = new DataRepository();
    await repo.init();
    expect(repo.capabilities.ohlc).toBe(true);
    expect(repo.capabilities.tick).toBe(false);
    expect(repo.capabilities.level2).toBe(false);
    expect(repo.capabilities.orderFlow).toBe(false);
  });
});
