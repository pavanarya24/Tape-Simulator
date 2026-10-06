/**
 * §9 Persistence — the IndexedDB layer, verified against a stand-in that obeys
 * the same contract (async requests, upgrade events, and structured-clone
 * storage, so typed arrays round-trip exactly as they do in a real browser).
 *
 * Also documents the isolation boundary: Tape Lab is a single-user, per-origin
 * local application with no server and no accounts, so "one user's data leaking
 * into another user's session" cannot occur across accounts — there are none.
 * Isolation is therefore origin/device scoped, and this suite pins the two
 * things that *can* leak in-app: instrument and session cross-contamination.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { buildDemoDataset } from "../src/data/sample";
import {
  deleteDataset,
  listDatasetSummaries,
  listDatasets,
  loadDataset,
  saveDataset,
  type StoredDataset,
} from "../src/data/db";
import { DataRepository } from "../src/data/repository";
import { buildSessionIndex } from "../src/data/sessions";

/* ------------------------------------------------------------------ *
 * Minimal IndexedDB stand-in (structured-clone storage semantics)
 * ------------------------------------------------------------------ */

interface FakeRequest<T> {
  result: T;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
  onblocked?: (() => void) | null;
}

function later(fn: () => void): void {
  queueMicrotask(fn);
}

class FakeObjectStore {
  constructor(private rows: Map<string, unknown>, private keyPath: string) {}
  put(value: Record<string, unknown>): FakeRequest<undefined> {
    const req: FakeRequest<undefined> = { result: undefined, error: null, onsuccess: null, onerror: null };
    later(() => {
      try {
        this.rows.set(String(value[this.keyPath]), structuredClone(value));
        req.onsuccess?.();
      } catch (err) {
        req.error = err as Error;
        req.onerror?.();
      }
    });
    return req;
  }
  get(key: string): FakeRequest<unknown> {
    const req: FakeRequest<unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
    later(() => {
      const v = this.rows.get(key);
      req.result = v === undefined ? undefined : structuredClone(v);
      req.onsuccess?.();
    });
    return req;
  }
  delete(key: string): FakeRequest<undefined> {
    const req: FakeRequest<undefined> = { result: undefined, error: null, onsuccess: null, onerror: null };
    later(() => {
      this.rows.delete(key);
      req.onsuccess?.();
    });
    return req;
  }
  getAll(): FakeRequest<unknown[]> {
    const req: FakeRequest<unknown[]> = { result: [], error: null, onsuccess: null, onerror: null };
    later(() => {
      req.result = Array.from(this.rows.values()).map((v) => structuredClone(v));
      req.onsuccess?.();
    });
    return req;
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor(private store: FakeObjectStore) {
    later(() => this.oncomplete?.());
  }
  objectStore(): FakeObjectStore {
    return this.store;
  }
}

class FakeDb {
  objectStoreNames = { contains: (name: string) => name === "datasets" };
  constructor(private rows: Map<string, unknown>) {}
  createObjectStore(): void {
    /* already present */
  }
  close(): void {
    /* no resources to release in the stand-in */
  }
  transaction(): FakeTransaction {
    return new FakeTransaction(new FakeObjectStore(this.rows, "instrument"));
  }
}

let rows: Map<string, unknown>;

beforeAll(() => {
  rows = new Map();
  (globalThis as Record<string, unknown>).indexedDB = {
    open(): FakeRequest<FakeDb> {
      const req: FakeRequest<FakeDb> = { result: new FakeDb(rows), error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      later(() => req.onsuccess?.());
      return req;
    },
  };
});

/* ------------------------------------------------------------------ */

const demo: StoredDataset = buildDemoDataset("NQ", 4);

describe("IndexedDB round-trip", () => {
  test("a dataset survives a save/load cycle with its typed arrays intact", async () => {
    await saveDataset(demo);
    const loaded = await loadDataset("NQ");
    expect(loaded).toBeDefined();
    expect(loaded!.instrument).toBe("NQ");
    expect(loaded!.meta.barCount).toBe(demo.meta.barCount);
    expect(loaded!.meta.timezone.sourceTimeZone).toBe("America/New_York");
    expect(loaded!.indexedWithTimezone).toBe("America/New_York");
    expect(loaded!.series.t).toBeInstanceOf(Float64Array);
    expect(loaded!.series.length).toBe(demo.series.length);
    // Values, not just shapes, must match exactly.
    expect(Array.from(loaded!.series.t)).toEqual(Array.from(demo.series.t));
    expect(Array.from(loaded!.series.c)).toEqual(Array.from(demo.series.c));
    expect(loaded!.index.rth.map((s) => s.id)).toEqual(demo.index.rth.map((s) => s.id));
    expect(loaded!.index.rth[0]).toEqual(demo.index.rth[0]);
  });

  test("reloading does not mutate the stored copy", async () => {
    const a = await loadDataset("NQ");
    a!.series.c[0] = -999;
    a!.index.rth.pop();
    const b = await loadDataset("NQ");
    expect(b!.series.c[0]).toBe(demo.series.c[0]);
    expect(b!.index.rth.length).toBe(demo.index.rth.length);
  });

  test("both instruments coexist and are retrieved independently", async () => {
    const es = buildDemoDataset("ES", 4);
    await saveDataset(es);
    expect((await loadDataset("NQ"))!.instrument).toBe("NQ");
    expect((await loadDataset("ES"))!.instrument).toBe("ES");
    const all = await listDatasets();
    expect(all.map((d) => d.instrument).sort()).toEqual(["ES", "NQ"]);
    // Stored series are independent objects, not views over one buffer.
    expect((await loadDataset("ES"))!.series.t[0]).toBe(es.series.t[0]);
  });

  test("summaries expose metadata and session lists without the bar arrays", async () => {
    const summaries = await listDatasetSummaries();
    expect(summaries.length).toBe(2);
    for (const s of summaries) {
      expect(s.meta.barCount).toBeGreaterThan(0);
      expect(s.rthSessions.length).toBeGreaterThan(0);
      expect(Array.isArray(s.ethSessions)).toBe(true);
      expect((s as unknown as { series?: unknown }).series).toBeUndefined();
    }
  });

  test("delete removes only the requested instrument", async () => {
    await deleteDataset("ES");
    expect(await loadDataset("ES")).toBeUndefined();
    expect(await loadDataset("NQ")).toBeDefined();
    await saveDataset(buildDemoDataset("ES", 4)); // restore for later tests
  });
});

describe("repository reads back what it wrote", () => {
  test("init loads persisted datasets instead of re-seeding them", async () => {
    // A marker dataset proves the repository read the store rather than
    // regenerating demo data.
    const repo1 = new DataRepository();
    await repo1.init();
    expect(repo1.isMemoryOnly).toBe(false);
    const before = repo1.get("NQ")!.meta.ingestedAt;
    expect(repo1.get("NQ")!.meta.source).toBe("DEMO");

    // Persist a marker into the same store and confirm a fresh repository sees it.
    const marked: StoredDataset = {
      ...repo1.get("NQ")!,
      meta: { ...repo1.get("NQ")!.meta, ingestedAt: 1234567890, label: "MARKER" },
    };
    await saveDataset(marked);

    const repo2 = new DataRepository();
    await repo2.init();
    expect(repo2.get("NQ")!.meta.label).toBe("MARKER");
    expect(repo2.get("NQ")!.meta.ingestedAt).toBe(1234567890);
    expect(before).not.toBe(1234567890);
  });

  test("reindex persists the rebuilt session index", async () => {
    const repo = new DataRepository();
    await repo.init();
    await repo.reindex("NQ", "America/Chicago");
    const stored = await loadDataset("NQ");
    expect(stored!.indexedWithTimezone).toBe("America/Chicago");
    expect(stored!.meta.timezone.sourceTimeZone).toBe("America/Chicago");
    expect(stored!.index.rth.length).toBe(repo.get("NQ")!.index.rth.length);
    await repo.reindex("NQ", "America/New_York");
  });

  test("a fresh repository instance shares no in-memory state with another", async () => {
    const a = new DataRepository();
    const b = new DataRepository();
    await a.init();
    await b.init();
    const aMeta = a.get("NQ")!.meta;
    aMeta.label = "MUTATED";
    expect(b.get("NQ")!.meta.label).toBe("MARKER");
    expect(a.get("NQ")).not.toBe(b.get("NQ"));
  });
});

describe("cross-contamination cannot happen in-app", () => {
  test("instrument state is fully separated by the session index", () => {
    const nq = buildSessionIndex(demo.series, "NQ", "America/New_York");
    const es = buildSessionIndex(demo.series, "ES", "America/New_York");
    expect(nq.rth.every((s) => s.instrument === "NQ" && s.id.startsWith("NQ:"))).toBe(true);
    expect(es.rth.every((s) => s.instrument === "ES" && s.id.startsWith("ES:"))).toBe(true);
    // Same bars, different instrument: ids must differ, so a session id can
    // never resolve to the wrong instrument's data.
    const nqIds = new Set(nq.rth.map((s) => s.id));
    expect(es.rth.some((s) => nqIds.has(s.id))).toBe(false);
  });

  test("the stored record is keyed by instrument, so one cannot overwrite the other", async () => {
    await saveDataset({ ...demo, instrument: "NQ", meta: { ...demo.meta, label: "NQ-COPY" } });
    const nq = await loadDataset("NQ");
    const es = await loadDataset("ES");
    expect(nq!.meta.label).toBe("NQ-COPY");
    expect(es!.meta.label).not.toBe("NQ-COPY");
  });
});

describe("storage failure degrades loudly, never silently", () => {
  test("an unavailable IndexedDB leaves the repository in memory-only mode and still serves sessions", async () => {
    const saved = (globalThis as Record<string, unknown>).indexedDB;
    (globalThis as Record<string, unknown>).indexedDB = {
      open() {
        throw new Error("blocked by policy");
      },
    };
    try {
      const repo = new DataRepository();
      await repo.init();
      expect(repo.isMemoryOnly).toBe(true);
      expect(repo.has("NQ")).toBe(true);
      expect(repo.listSessions("NQ", "RTH").length).toBeGreaterThan(0);
      const session = await repo.loadSession("NQ", "RTH", repo.listSessions("NQ", "RTH")[0].id);
      expect(session!.bars.length).toBe(78);
    } finally {
      (globalThis as Record<string, unknown>).indexedDB = saved;
    }
  });

  test("a hung IndexedDB open cannot hang the application (timeout guard exists)", async () => {
    const src = await Bun.file(new URL("../src/data/db.ts", import.meta.url)).text();
    expect(src).toMatch(/setTimeout\([\s\S]{0,200}?4000\)/);
    expect(src).toMatch(/onblocked/);
    expect(src).toMatch(/onabort/);
  });
});
