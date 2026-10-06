/**
 * Local dataset repository.
 *
 * Implements `MarketDataSource` on top of IndexedDB. Datasets are cached in
 * memory as column arrays; sessions are always sliced on demand so the UI only
 * ever holds the bars for the session being replayed.
 */

import type { RootSymbol } from "../market/types";
import { OHLC_ONLY_CAPABILITIES, type DataCapabilities } from "../market/types";
import type { MarketDataSource } from "../market/feed";
import type { SessionBars, SessionMeta, SessionType } from "./types";
import { sliceBarSeries } from "./types";
import { buildSessionIndex } from "./sessions";
import {
  deleteDataset,
  listDatasets,
  loadDataset,
  saveDataset,
  type DatasetSummary,
  type StoredDataset,
} from "./db";
import { buildDemoDataset } from "./sample";
import { ingestCsvFile, type IngestOptions } from "./ingest";

export type RepositoryListener = () => void;

export class DataRepository implements MarketDataSource {
  readonly id = "local-indexeddb";
  readonly label = "Local dataset store (IndexedDB)";
  readonly capabilities: DataCapabilities = OHLC_ONLY_CAPABILITIES;

  private cache = new Map<RootSymbol, StoredDataset>();
  private listeners = new Set<RepositoryListener>();
  private memoryOnly = false;

  /** Load persisted datasets, seeding synthetic demo data on first run. */
  async init(): Promise<void> {
    try {
      const all = await listDatasets();
      for (const d of all) this.cache.set(d.instrument, d);
    } catch {
      this.memoryOnly = true;
    }

    for (const root of ["NQ", "ES"] as RootSymbol[]) {
      if (!this.cache.has(root)) {
        await this.seed(root);
      }
    }
    this.emit();
  }

  private async seed(root: RootSymbol): Promise<void> {
    const ds = buildDemoDataset(root);
    this.cache.set(root, ds);
    if (!this.memoryOnly) {
      try {
        await saveDataset(ds);
      } catch {
        this.memoryOnly = true;
      }
    }
  }

  subscribe(fn: RepositoryListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get(instrument: RootSymbol): StoredDataset | undefined {
    return this.cache.get(instrument);
  }

  has(instrument: RootSymbol): boolean {
    return this.cache.has(instrument);
  }

  listSessions(instrument: RootSymbol, type: SessionType): SessionMeta[] {
    const ds = this.cache.get(instrument);
    if (!ds) return [];
    return type === "RTH" ? ds.index.rth : ds.index.eth;
  }

  async loadSession(
    instrument: RootSymbol,
    type: SessionType,
    sessionId: string,
  ): Promise<SessionBars | null> {
    const ds = this.cache.get(instrument);
    if (!ds) return null;
    const list = type === "RTH" ? ds.index.rth : ds.index.eth;
    const meta = list.find((s) => s.id === sessionId);
    if (!meta) return null;
    return { meta, bars: sliceBarSeries(ds.series, meta.startIndex, meta.endIndex) };
  }

  summaries(): DatasetSummary[] {
    return Array.from(this.cache.values()).map((d) => ({
      instrument: d.instrument,
      meta: d.meta,
      rthSessions: d.index.rth,
      ethSessions: d.index.eth,
    }));
  }

  get isMemoryOnly(): boolean {
    return this.memoryOnly;
  }

  async importCsv(opts: IngestOptions): Promise<StoredDataset> {
    const ds = await ingestCsvFile(opts);
    this.cache.set(ds.instrument, ds);
    this.emit();
    return ds;
  }

  /** Rebuild the session index after a timezone change (series unchanged). */
  async reindex(instrument: RootSymbol, sourceTimeZone: string): Promise<void> {
    const ds = this.cache.get(instrument);
    if (!ds) return;
    const index = buildSessionIndex(ds.series, instrument, sourceTimeZone);
    const updated: StoredDataset = {
      ...ds,
      index,
      indexedWithTimezone: sourceTimeZone,
      meta: {
        ...ds.meta,
        timezone: { ...ds.meta.timezone, sourceTimeZone },
        rthSessions: index.rth.length,
        ethSessions: index.eth.length,
      },
    };
    this.cache.set(instrument, updated);
    if (!this.memoryOnly) {
      try {
        await saveDataset(updated);
      } catch {
        this.memoryOnly = true;
      }
    }
    this.emit();
  }

  async remove(instrument: RootSymbol): Promise<void> {
    this.cache.delete(instrument);
    if (!this.memoryOnly) {
      try {
        await deleteDataset(instrument);
      } catch {
        this.memoryOnly = true;
      }
    }
    this.emit();
  }

  /** Re-read a single dataset from disk (used after external changes). */
  async refresh(instrument: RootSymbol): Promise<void> {
    try {
      const ds = await loadDataset(instrument);
      if (ds) this.cache.set(instrument, ds);
    } catch {
      this.memoryOnly = true;
    }
    this.emit();
  }
}
