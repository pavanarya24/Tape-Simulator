/**
 * Streaming CSV ingestion.
 *
 * Expected schema: `Time, Open, High, Low, Close, Volume`
 * (column order is detected from the header; `Date` + `Time` split columns and
 * common aliases such as `Timestamp` / `Datetime` are also accepted).
 *
 * The reader streams the file in chunks so a ~350k-row / ~25MB dataset never has
 * to exist as one giant string, and it hands back column arrays rather than one
 * object per row.
 */

import { wallClockToUtc } from "./timezone";

export interface RawColumns {
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  /** Rows whose Open/High/Low/Close could not be parsed as numbers. */
  unparseableRows: number;
  /** Rows whose timestamp could not be parsed. */
  badTimestamps: number;
  /** Raw lines skipped (blank, comment, malformed column count). */
  skippedLines: number;
  headerFound: boolean;
  columns: Partial<Record<"time" | "open" | "high" | "low" | "close" | "volume", string>>;
}

const TIME_ALIASES = ["time", "timestamp", "datetime", "date_time", "dt", "bar_time"];
const DATE_ALIASES = ["date", "day", "trade_date", "tradedate"];
const OPEN_ALIASES = ["open", "o"];
const HIGH_ALIASES = ["high", "h"];
const LOW_ALIASES = ["low", "l"];
const CLOSE_ALIASES = ["close", "c", "last"];
const VOLUME_ALIASES = ["volume", "vol", "v", "totalvolume", "total_volume"];

function normalizeHeader(cell: string): string {
  return cell
    .replace(/^\ufeff/, "")
    .trim()
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/[\s-]+/g, "_");
}

function matchColumn(headers: string[], aliases: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    if (aliases.includes(headers[i])) return i;
  }
  return -1;
}

interface ColumnMap {
  time: number;
  date: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function detectColumns(headerCells: string[]): ColumnMap | null {
  const headers = headerCells.map(normalizeHeader);
  const open = matchColumn(headers, OPEN_ALIASES);
  const high = matchColumn(headers, HIGH_ALIASES);
  const low = matchColumn(headers, LOW_ALIASES);
  const close = matchColumn(headers, CLOSE_ALIASES);
  if (open < 0 || high < 0 || low < 0 || close < 0) return null;
  let time = matchColumn(headers, TIME_ALIASES);
  let date = matchColumn(headers, DATE_ALIASES);
  if (time < 0 && date < 0) {
    // No named time column: assume the first column is the timestamp.
    time = 0;
  }
  return {
    time,
    date: date === time ? -1 : date,
    open,
    high,
    low,
    close,
    volume: matchColumn(headers, VOLUME_ALIASES),
  };
}

/** Split one CSV line, honouring double-quoted fields. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Parse a timestamp cell into epoch ms.
 *
 * Naive timestamps (no offset) are interpreted as wall-clock time in
 * `timeZone`. Timestamps carrying an explicit offset (`Z`, `+HH:MM`) are parsed
 * as absolute instants.
 */
export function parseTimestamp(raw: string, timeZone: string): number {
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (!s) return NaN;

  // Pure integer: epoch seconds (10 digits) or milliseconds (13 digits).
  // Anything else numeric is NOT a timestamp — treating it as one would place
  // bars at absurd instants (e.g. "2019" -> 1970-01-01T00:00:02.019Z).
  if (/^\d+$/.test(s)) {
    if (s.length === 10) return Number(s) * 1000;
    if (s.length === 13) return Number(s);
    return NaN;
  }

  // Explicit offset / ISO with zone -> absolute parse.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /\d{4}-\d{2}-\d{2}/.test(s)) {
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) return parsed;
  }

  let year = NaN;
  let month = NaN;
  let day = NaN;
  let hour = 0;
  let minute = 0;
  let second = 0;

  const iso = s.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  const us = s.match(
    /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
    hour = iso[4] ? Number(iso[4]) : 0;
    minute = iso[5] ? Number(iso[5]) : 0;
    second = iso[6] ? Number(iso[6]) : 0;
  } else if (us) {
    month = Number(us[1]);
    day = Number(us[2]);
    year = Number(us[3]);
    hour = us[4] ? Number(us[4]) : 0;
    minute = us[5] ? Number(us[5]) : 0;
    second = us[6] ? Number(us[6]) : 0;
  } else {
    // Free-form text is only accepted when it actually carries a year.
    // `Date.parse` is lenient enough to turn arbitrary junk (e.g.
    // "<img src=x onerror=1>") into a valid 2001 instant, which would silently
    // inject bars into the series instead of being reported as bad rows.
    if (!/(?:19|20)\d{2}/.test(s)) return NaN;
    const parsed = Date.parse(s);
    return Number.isNaN(parsed) ? NaN : parsed;
  }

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;
  return wallClockToUtc(year, month, day, hour, minute, second, timeZone);
}

export interface StreamCsvOptions {
  timeZone: string;
  onProgress?: (bytesRead: number, totalBytes: number, rows: number) => void;
}

/** Stream a File/Blob into parsed OHLCV columns without holding the whole file as text. */
export async function readCsvColumns(
  file: Blob,
  opts: StreamCsvOptions,
): Promise<RawColumns> {
  const cols: RawColumns = {
    time: [],
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
    unparseableRows: 0,
    badTimestamps: 0,
    skippedLines: 0,
    headerFound: false,
    columns: {},
  };

  const decoder = new TextDecoder("utf-8");
  let map: ColumnMap | null = null;
  let pending = "";
  let rows = 0;
  const CHUNK = 4 * 1024 * 1024;
  const total = file.size;
  let read = 0;

  const handleLine = (line: string) => {
    if (!line) return;
    const first = line.charCodeAt(0);
    if (first === 35 /* # */ || first === 59 /* ; */) return;

    if (!map) {
      const cells = splitCsvLine(line);
      const detected = detectColumns(cells);
      if (detected) {
        map = detected;
        cols.headerFound = true;
        cols.columns = {
          time: cells[detected.time] ?? (detected.date >= 0 ? cells[detected.date] : undefined),
          open: cells[detected.open],
          high: cells[detected.high],
          low: cells[detected.low],
          close: cells[detected.close],
          volume: detected.volume >= 0 ? cells[detected.volume] : undefined,
        };
      } else {
        cols.skippedLines++;
      }
      return;
    }

    const cells = splitCsvLine(line);
    if (cells.length <= map.close) {
      cols.skippedLines++;
      return;
    }

    let tsRaw = map.time >= 0 ? cells[map.time] : "";
    if (map.date >= 0 && map.date !== map.time) {
      const d = cells[map.date] ?? "";
      tsRaw = tsRaw ? `${d} ${tsRaw}` : d;
    }

    const o = Number(cells[map.open]);
    const h = Number(cells[map.high]);
    const l = Number(cells[map.low]);
    const c = Number(cells[map.close]);
    const v = map.volume >= 0 ? Number(cells[map.volume]) : 0;

    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
      cols.unparseableRows++;
      return;
    }
    const t = parseTimestamp(tsRaw, opts.timeZone);
    if (!Number.isFinite(t)) {
      cols.badTimestamps++;
      return;
    }

    cols.time.push(t);
    cols.open.push(o);
    cols.high.push(h);
    cols.low.push(l);
    cols.close.push(c);
    cols.volume.push(Number.isFinite(v) ? v : 0);
    rows++;
  };

  while (read < total) {
    const slice = file.slice(read, Math.min(read + CHUNK, total));
    const buf = new Uint8Array(await slice.arrayBuffer());
    read += buf.byteLength;
    const text = pending + decoder.decode(buf, { stream: true });
    const lines = text.split(/\r\n|\n|\r/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) {
        if (line.length > 0) cols.skippedLines++;
        continue;
      }
      handleLine(line);
    }
    opts.onProgress?.(read, total, rows);
  }

  pending += decoder.decode();
  if (pending.trim().length > 0) handleLine(pending);

  if (!map) {
    throw new Error(
      "Could not detect OHLC columns. Expected a header row containing at least Open, High, Low, Close (and Time).",
    );
  }

  return cols;
}
