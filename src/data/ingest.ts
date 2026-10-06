/**
 * Ingestion pipeline: CSV → parsed columns → normalized series → session index →
 * persisted dataset.
 */

import type { RootSymbol } from "../market/types";
import type { DatasetMeta, IngestProgressCallback } from "./types";
import { readCsvColumns } from "./csv";
import { normalizeColumns } from "./normalize";
import { buildSessionIndex } from "./sessions";
import { saveDataset, type StoredDataset } from "./db";

export interface IngestOptions {
  instrument: RootSymbol;
  file: File | Blob;
  fileName?: string;
  sourceTimeZone: string;
  displayTimeZone: string;
  onProgress?: IngestProgressCallback;
}

export async function ingestCsvFile(opts: IngestOptions): Promise<StoredDataset> {
  const { instrument, file, sourceTimeZone, displayTimeZone, onProgress } = opts;

  onProgress?.({
    phase: "reading",
    bytesRead: 0,
    totalBytes: file.size,
    rowsParsed: 0,
    message: "Streaming CSV…",
  });

  const cols = await readCsvColumns(file, {
    timeZone: sourceTimeZone,
    onProgress: (bytesRead, totalBytes, rows) =>
      onProgress?.({
        phase: "reading",
        bytesRead,
        totalBytes,
        rowsParsed: rows,
        message: `Parsing rows… ${rows.toLocaleString()}`,
      }),
  });

  onProgress?.({
    phase: "normalizing",
    bytesRead: file.size,
    totalBytes: file.size,
    rowsParsed: cols.time.length,
    message: "Validating OHLC, duplicates, gaps and timeframe…",
  });

  const { series, quality } = normalizeColumns(cols, sourceTimeZone);

  if (series.length === 0) {
    throw new Error("No valid bars were found in this file.");
  }

  onProgress?.({
    phase: "indexing",
    bytesRead: file.size,
    totalBytes: file.size,
    rowsParsed: series.length,
    message: "Building session index…",
  });

  const index = buildSessionIndex(series, instrument, sourceTimeZone);

  const meta: DatasetMeta = {
    instrument,
    source: "CSV_UPLOAD",
    label: opts.fileName ?? "Imported CSV",
    fileName: opts.fileName,
    timezone: { sourceTimeZone, displayTimeZone },
    barCount: series.length,
    firstBar: quality.firstBar,
    lastBar: quality.lastBar,
    detectedTimeframeMs: quality.detectedTimeframeMs,
    ingestedAt: Date.now(),
    quality,
    rthSessions: index.rth.length,
    ethSessions: index.eth.length,
  };

  const dataset: StoredDataset = {
    instrument,
    meta,
    series,
    index,
    indexedWithTimezone: sourceTimeZone,
  };

  onProgress?.({
    phase: "storing",
    bytesRead: file.size,
    totalBytes: file.size,
    rowsParsed: series.length,
    message: "Saving to local database…",
  });

  await saveDataset(dataset);

  onProgress?.({
    phase: "done",
    bytesRead: file.size,
    totalBytes: file.size,
    rowsParsed: series.length,
    message: `Stored ${series.length.toLocaleString()} bars across ${
      index.rth.length
    } RTH / ${index.eth.length} ETH sessions.`,
  });

  return dataset;
}
