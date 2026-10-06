/**
 * IndexedDB persistence layer.
 *
 * Normalized bar arrays and the session index are stored per instrument. This is
 * the "efficient local database/cache" the app reads sessions from — the full
 * five-year series is never held in React state, only the requested session
 * slice.
 */

import type { BarSeries, RootSymbol } from "../market/types";
import type { DatasetMeta, SessionMeta } from "./types";
import type { SessionIndex } from "./sessions";

const DB_NAME = "tapelab";
const DB_VERSION = 1;
const STORE = "datasets";

export interface StoredDataset {
  instrument: RootSymbol;
  meta: DatasetMeta;
  series: BarSeries;
  index: SessionIndex;
  /** Session type the stored index was built with (for re-indexing). */
  indexedWithTimezone: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment."));
      return;
    }
    // Some sandboxed iframes never settle the open request; fall back to
    // memory-only mode instead of hanging the whole app on startup.
    const timeout = setTimeout(() => {
      reject(new Error("IndexedDB open timed out."));
    }, 4000);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "instrument" });
      }
    };
    req.onsuccess = () => {
      clearTimeout(timeout);
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timeout);
      reject(req.error ?? new Error("Failed to open IndexedDB"));
    };
    req.onblocked = () => {
      clearTimeout(timeout);
      reject(new Error("IndexedDB open blocked."));
    };
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("IndexedDB transaction timed out.")), 4000);
        try {
          const transaction = db.transaction(STORE, mode);
          const store = transaction.objectStore(STORE);
          const req = fn(store);
          req.onsuccess = () => {
            clearTimeout(timeout);
            resolve(req.result);
          };
          req.onerror = () => {
            clearTimeout(timeout);
            reject(req.error ?? new Error("IndexedDB request failed"));
          };
          transaction.oncomplete = () => db.close();
          transaction.onerror = () => {
            clearTimeout(timeout);
            reject(transaction.error ?? new Error("IndexedDB transaction failed"));
          };
          transaction.onabort = () => {
            clearTimeout(timeout);
            reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
          };
        } catch (err) {
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error("IndexedDB transaction failed"));
        }
      }),
  );
}

export async function saveDataset(ds: StoredDataset): Promise<void> {
  await tx("readwrite", (store) => store.put(ds));
}

export async function loadDataset(instrument: RootSymbol): Promise<StoredDataset | undefined> {
  return tx<StoredDataset | undefined>("readonly", (store) => store.get(instrument) as IDBRequest<StoredDataset | undefined>);
}

export async function deleteDataset(instrument: RootSymbol): Promise<void> {
  await tx("readwrite", (store) => store.delete(instrument));
}

export async function listDatasets(): Promise<StoredDataset[]> {
  return tx<StoredDataset[]>("readonly", (store) => store.getAll() as IDBRequest<StoredDataset[]>);
}

/** Metadata-only view, cheap enough to list in the Data Explorer. */
export interface DatasetSummary {
  instrument: RootSymbol;
  meta: DatasetMeta;
  rthSessions: SessionMeta[];
  ethSessions: SessionMeta[];
}

export async function listDatasetSummaries(): Promise<DatasetSummary[]> {
  const all = await listDatasets();
  return all.map((d) => ({
    instrument: d.instrument,
    meta: d.meta,
    rthSessions: d.index.rth,
    ethSessions: d.index.eth,
  }));
}
