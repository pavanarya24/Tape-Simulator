/**
 * §Journal persistence — the store is a trust boundary. It parses whatever sits in
 * localStorage, which an older build, a hand-edit or another script on the same
 * origin may have written. Every field the journal table, the CSV export and the
 * score read is checked, and a bad payload must never reach the UI.
 *
 * Bun has no localStorage, so the suite installs an in-memory stand-in. That the
 * store copes with localStorage being absent entirely is covered below.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadJournal, saveJournal } from "../src/state/journal-store";
import { EMPTY_NOTES, type ClosedTrade, type JournalNotes } from "../src/execution/types";

const KEY = "tl_journal_v1";
const original = (globalThis as { localStorage?: unknown }).localStorage;

class MemoryStorage {
  private map = new Map<string, string>();
  failWrites = false;
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  raw(k: string): string | null {
    return this.map.get(k) ?? null;
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = store;
});

afterEach(() => {
  if (original === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
  else (globalThis as { localStorage?: unknown }).localStorage = original;
});

function notes(over: Partial<JournalNotes> = {}): JournalNotes {
  return { ...EMPTY_NOTES, ...over };
}

function trade(over: Partial<ClosedTrade> = {}): ClosedTrade {
  return {
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
    notes: notes({ thesis: "breakout retest" }),
    ...over,
  };
}

function write(payload: unknown): void {
  store.setItem(KEY, typeof payload === "string" ? payload : JSON.stringify(payload));
}

describe("journal store — round trip", () => {
  test("a saved journal loads back with its trades and notes intact", () => {
    const j = {
      sessionId: "NQ:RTH:2024-01-02",
      trades: [trade(), trade({ id: "t2", direction: "short", netPnl: -120.5 })],
      notes: { "k1": notes({ lesson: "waited for confirmation" }) },
    };
    saveJournal(j);

    const loaded = loadJournal();
    expect(loaded.sessionId).toBe("NQ:RTH:2024-01-02");
    expect(loaded.trades).toHaveLength(2);
    expect(loaded.trades[0].notes.thesis).toBe("breakout retest");
    expect(loaded.trades[1].direction).toBe("short");
    expect(loaded.trades[1].netPnl).toBe(-120.5);
    expect(loaded.notes["k1"].lesson).toBe("waited for confirmation");
  });

  test("notes are kept even when their trade is not in the list", () => {
    // The notes map is keyed by trade key, not by the trade list, so it survives a
    // record being dropped — a written note is the one thing a reader cannot redo.
    saveJournal({
      sessionId: "s",
      trades: [],
      notes: { orphan: notes({ mistake: "chased it" }) },
    });
    expect(loadJournal().notes.orphan.mistake).toBe("chased it");
  });

  test("nothing is stored, and nothing crashes, without localStorage", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(loadJournal()).toEqual({ sessionId: null, trades: [], notes: {} });
    expect(() => saveJournal({ sessionId: "s", trades: [trade()], notes: {} })).not.toThrow();
  });

  test("a storage write failure is swallowed rather than breaking the session", () => {
    store.failWrites = true;
    expect(() => saveJournal({ sessionId: "s", trades: [trade()], notes: {} })).not.toThrow();
  });

  test("the stored list is capped, keeping the most recent trades", () => {
    const many = Array.from({ length: 2001 }, (_, i) => trade({ id: `t${i}` }));
    saveJournal({ sessionId: "s", trades: many, notes: {} });
    const loaded = loadJournal();
    expect(loaded.trades).toHaveLength(2000);
    // The newest end is what a reader is looking at, so that is the end kept.
    expect(loaded.trades[1999].id).toBe("t2000");
    expect(loaded.trades[0].id).toBe("t1");
  });
});

describe("journal store — hostile and stale payloads", () => {
  test("a payload that is not JSON at all is discarded, not partially applied", () => {
    write("{ this is not json");
    expect(loadJournal()).toEqual({ sessionId: null, trades: [], notes: {} });
  });

  test("a JSON payload of the wrong shape yields an empty journal", () => {
    for (const bad of ["null", "42", '"a string"', "[]", "{}"]) {
      write(bad);
      const loaded = loadJournal();
      expect(loaded.trades).toEqual([]);
      expect(loaded.sessionId).toBeNull();
    }
  });

  test("a trade with a non-finite price is dropped, not repaired", () => {
    // A repaired price would silently corrupt every statistic built from it.
    write({
      sessionId: "s",
      trades: [trade({ id: "good" }), trade({ id: "bad", entryPrice: null })],
      notes: {},
    });
    const loaded = loadJournal();
    expect(loaded.trades.map((t) => t.id)).toEqual(["good"]);
  });

  test("infinite and NaN numerics cannot enter the journal", () => {
    write({
      sessionId: "s",
      trades: [
        trade({ id: "inf", netPnl: 1e999 as unknown as number }),
        trade({ id: "nan", holdingMs: Number.NaN }),
        trade({ id: "ok" }),
      ],
      notes: {},
    });
    expect(loadJournal().trades.map((t) => t.id)).toEqual(["ok"]);
  });

  test("a record missing a field the journal renders is rejected", () => {
    const missing = trade();
    delete (missing as { exitPrice?: number }).exitPrice;
    write({ sessionId: "s", trades: [missing, trade({ id: "ok" })], notes: {} });
    expect(loadJournal().trades.map((t) => t.id)).toEqual(["ok"]);
  });

  test("a script-like or non-string note invalidates that record only", () => {
    write({
      sessionId: "s",
      trades: [
        trade({ id: "bad", notes: { ...notes(), thesis: { toString: "<script>" } } as never }),
        trade({ id: "ok" }),
      ],
      notes: {},
    });
    const loaded = loadJournal();
    expect(loaded.trades.map((t) => t.id)).toEqual(["ok"]);
    // Nothing from the rejected record survives anywhere in the result.
    expect(JSON.stringify(loaded)).not.toContain("<script>");
  });

  test("an unknown direction or exit reason is rejected", () => {
    write({
      sessionId: "s",
      trades: [
        trade({ id: "d", direction: "sideways" as never }),
        trade({ id: "e", exitReason: "bankruptcy" as never }),
        trade({ id: "ok" }),
      ],
      notes: {},
    });
    expect(loadJournal().trades.map((t) => t.id)).toEqual(["ok"]);
  });

  test("a note field absent from an older payload loads as empty, not as a rejection", () => {
    // Forward compatibility: a journal written before a field existed must survive.
    const legacy = trade();
    delete (legacy.notes as Partial<JournalNotes>).lesson;
    write({ sessionId: "s", trades: [legacy], notes: {} });
    const loaded = loadJournal();
    expect(loaded.trades).toHaveLength(1);
    expect(loaded.trades[0].notes).toEqual({ ...EMPTY_NOTES, thesis: "breakout retest" });
  });

  test("a notes entry of the wrong shape is dropped without losing the trades", () => {
    write({
      sessionId: "s",
      trades: [trade()],
      notes: { bad: "just a string", worse: 7, good: notes({ saw: "absorption" }) },
    });
    const loaded = loadJournal();
    expect(loaded.trades).toHaveLength(1);
    expect(Object.keys(loaded.notes)).toEqual(["good"]);
  });

  test("a non-string sessionId is discarded rather than restored", () => {
    write({ sessionId: 99, trades: [trade()], notes: {} });
    expect(loadJournal().sessionId).toBeNull();
  });
});
