/**
 * §11 Security — API surface, input validation, file-upload handling, CSV
 * parsing, authentication boundaries and client-exposed secrets.
 *
 * Tape Lab is a fully client-side replay simulator: there is no server, no
 * network call and no authentication. These tests lock that property in, so a
 * future change cannot quietly start shipping secrets or exfiltrating data.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCsvColumns, parseTimestamp } from "../src/data/csv";
import { normalizeColumns } from "../src/data/normalize";
import { tradesToCsv } from "../src/journal/journal";
import type { ClosedTrade } from "../src/execution/types";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "_generated" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(SRC).filter((f) => /\.(ts|tsx|css|html)$/.test(f));
const sources = files.map((f) => ({ path: f.slice(SRC.length + 1).replace(/\\/g, "/"), text: readFileSync(f, "utf8") }));

describe("no server surface, no network calls", () => {
  test("the client never performs a network request", () => {
    const offenders: string[] = [];
    for (const { path, text } of sources) {
      if (/\bfetch\s*\(/.test(text)) offenders.push(`${path}: fetch(`);
      if (/XMLHttpRequest/.test(text)) offenders.push(`${path}: XMLHttpRequest`);
      if (/new\s+WebSocket/.test(text)) offenders.push(`${path}: WebSocket`);
      if (/axios/.test(text)) offenders.push(`${path}: axios`);
      if (/EventSource/.test(text)) offenders.push(`${path}: EventSource`);
      if (/navigator\.sendBeacon/.test(text)) offenders.push(`${path}: sendBeacon`);
    }
    expect(offenders).toEqual([]);
  });

  test("no API endpoints, URLs or hardcoded hosts exist in the application code", () => {
    const offenders: string[] = [];
    for (const { path, text } of sources) {
      for (const m of text.matchAll(/https?:\/\/[^\s"'`)]+/g)) offenders.push(`${path}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  test("no secrets or credentials are read into, or shipped to, the client", () => {
    const offenders: string[] = [];
    for (const { path, text } of sources) {
      if (/process\.env/.test(text)) offenders.push(`${path}: process.env`);
      if (/import\.meta\.env/.test(text)) offenders.push(`${path}: import.meta.env`);
      if (/\b(api[_-]?key|secret|password|access[_-]?token|private[_-]?key)\b/i.test(text.replace(/\/\*[\s\S]*?\*\//g, ""))) {
        offenders.push(`${path}: secret-like identifier`);
      }
      // Long high-entropy literals would indicate a pasted key.
      if (/["'][A-Za-z0-9_\-]{32,}["']/.test(text)) offenders.push(`${path}: long literal`);
    }
    expect(offenders).toEqual([]);
  });

  test("there is no authentication layer to subvert — and no auth token handling", () => {
    const offenders: string[] = [];
    for (const { path, text } of sources) {
      if (/\b(jwt|bearer|oauth|session_token|Authorization)\b/i.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

describe("no dangerous DOM sinks", () => {
  test("nothing writes raw HTML or evaluates strings", () => {
    const offenders: string[] = [];
    for (const { path, text } of sources) {
      if (/dangerouslySetInnerHTML/.test(text)) offenders.push(`${path}: dangerouslySetInnerHTML`);
      if (/\.innerHTML\s*=/.test(text)) offenders.push(`${path}: innerHTML`);
      if (/\beval\s*\(/.test(text)) offenders.push(`${path}: eval`);
      if (/new\s+Function\s*\(/.test(text)) offenders.push(`${path}: new Function`);
      if (/document\.write/.test(text)) offenders.push(`${path}: document.write`);
      if (/javascript:/.test(text)) offenders.push(`${path}: javascript URL`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("CSV parsing is hostile-input safe", () => {
  test("script-like content in a numeric field is rejected, never executed or stored", async () => {
    const cols = await readCsvColumns(
      new Blob([
        "Time,Open,High,Low,Close,Volume\n" +
          "2019-08-05 09:30:00,<script>alert(1)</script>,101,99,100,10\n" +
          "2019-08-05 09:35:00,100,101,99,100,10\n",
      ]),
      { timeZone: "America/New_York" },
    );
    expect(cols.unparseableRows).toBe(1);
    expect(cols.time.length).toBe(1);
    expect(cols.open).toEqual([100]);
  });

  test("non-finite numbers cannot enter the dataset", async () => {
    const cols = await readCsvColumns(
      new Blob([
        "Time,Open,High,Low,Close,Volume\n" +
          "2019-08-05 09:30:00,1e999,1e999,1e999,1e999,1e999\n" +
          "2019-08-05 09:35:00,100,101,99,100,10\n",
      ]),
      { timeZone: "America/New_York" },
    );
    const { series } = normalizeColumns(cols, "America/New_York");
    expect(series.length).toBe(1);
    for (const v of series.o) expect(Number.isFinite(v)).toBe(true);
    for (const v of series.v) expect(Number.isFinite(v)).toBe(true);
  });

  test("deeply malformed rows, control characters and a huge field do not crash the parser", async () => {
    const huge = "9".repeat(500_000);
    const cols = await readCsvColumns(
      new Blob([
        `Time,Open,High,Low,Close,Volume\n\u0000\u0001\u0002\n${huge},101,99,100,10,7\n2019-08-05 09:35:00,100,101,99,100,10\n`,
      ]),
      { timeZone: "America/New_York" },
    );
    // The 500k-digit timestamp is not a valid time, the control-character line
    // is skipped, and only the good row survives.
    expect(cols.time.length).toBe(1);
    expect(cols.badTimestamps).toBe(1);
    expect(cols.skippedLines).toBe(1);
  });

  test("a row with far too many columns is read by position and cannot shift the schema", async () => {
    const cols = await readCsvColumns(
      new Blob([
        "Time,Open,High,Low,Close,Volume\n" +
          "2019-08-05 09:30:00,100,101,99,100,10,extra,extra,extra,extra,extra,extra\n",
      ]),
      { timeZone: "America/New_York" },
    );
    expect(cols.open).toEqual([100]);
    expect(cols.volume).toEqual([10]);
  });

  test("garbage timestamps are rejected instead of being coerced to a bogus instant", () => {
    for (const bad of [
      "../../etc/passwd",
      "<img src=x onerror=1>",
      "onerror=1",
      "",
      "hello",
      "2019", // a bare 4-digit number is NOT an epoch value
      "1",
      "99999999999999999",
      "=",
    ]) {
      expect(Number.isNaN(parseTimestamp(bad, "America/New_York"))).toBe(true);
    }
    // The two documented epoch forms still work.
    expect(parseTimestamp("1565011800", "America/New_York")).toBe(1565011800 * 1000);
    expect(parseTimestamp("1565011800000", "America/New_York")).toBe(1565011800000);
    // And genuine free-form dates still parse.
    expect(parseTimestamp("Aug 5, 2019 09:30:00", "America/New_York")).toBe(Date.parse("Aug 5, 2019 09:30:00"));
  });

  test("an uploaded file's name is only used as a label, never as a path", () => {
    const ingest = sources.find((s) => s.path === "data/ingest.ts")!;
    // fileName appears only in the dataset label/metadata.
    const uses = [...ingest.text.matchAll(/fileName/g)].map((m) => {
      const line = ingest.text.slice(0, m.index).split("\n").length;
      return ingest.text.split("\n")[line - 1].trim();
    });
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/fileName/);
    expect(ingest.text).not.toMatch(/\b(require|import)\s*\(\s*(opts\.)?fileName/);
    expect(ingest.text).not.toMatch(/readFile|writeFile|unlink|createReadStream/);
  });
});

describe("journal export stays well-formed", () => {
  const trade = {
    id: "t1",
    instrument: "NQ",
    contract: "NQ",
    sessionId: "NQ:RTH:2024-01-02",
    sessionDate: "2024-01-02",
    sessionType: "RTH",
    direction: "long",
    contracts: 1,
    entryTime: 1_700_000_000_000,
    entryIndex: 0,
    entryPrice: 15000,
    exitTime: 1_700_000_300_000,
    exitIndex: 1,
    exitPrice: 15010,
    grossPnl: 200,
    commission: 4.5,
    netPnl: 195.5,
    rMultiple: 2,
    holdingMs: 300_000,
    exitReason: "target",
    notes: {
      thesis: 'multi\nline, with "quotes"',
      saw: "breakout",
      whyEntered: "trigger",
      whyExited: "target",
      mistake: "",
      lesson: "",
    },
  } as unknown as ClosedTrade;

  test("quotes, commas and newlines are escaped so rows cannot be split", () => {
    const csv = tradesToCsv([trade], "America/New_York");
    const lines = csv.split("\n");
    // A raw newline inside a note would create a phantom row; the quoted field
    // keeps the record on one logical line.
    expect(csv).toContain('"multi\nline, with ""quotes"""');
    expect(lines.length).toBe(3); // header + 2 physical lines inside the quoted field
    const header = lines[0].split(",");
    expect(header.length).toBe(24);
    expect(header[0]).toBe("Instrument");
  });

  test("the exported columns match the documented journal schema", () => {
    const header = tradesToCsv([], "America/New_York").split("\n")[0].split(",");
    expect(header).toEqual([
      "Instrument",
      "Contract",
      "Session Date",
      "Session",
      "Direction",
      "Contracts",
      "Entry Time",
      "Entry Price",
      "Exit Time",
      "Exit Price",
      "Stop",
      "Target",
      "Gross P&L",
      "Commission",
      "Net P&L",
      "R Multiple",
      "Holding Time",
      "Exit Reason",
      "Thesis",
      "What I Saw",
      "Why I Entered",
      "Why I Exited",
      "Mistake",
      "Lesson",
    ]);
  });
});

describe("in-memory-only degradation is explicit", () => {
  test("storage failures are reported rather than hidden", async () => {
    const db = sources.find((s) => s.path === "data/db.ts")!;
    expect(db.text).toContain("IndexedDB is not available");
    expect(db.text).toMatch(/timed out/);
    const repo = sources.find((s) => s.path === "data/repository.ts")!;
    expect(repo.text).toMatch(/memoryOnly/);
    expect(repo.text).toMatch(/catch/);
  });
});
