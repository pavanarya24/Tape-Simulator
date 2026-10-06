/**
 * Phase 8B.2 — Time & Sales as a serious training component.
 *
 * Pure presentation over the *revealed* tape. The aggressor side always comes
 * from `TradeEvent.aggressorSide` (never inferred from price or candle
 * colour), and nothing here can invent a print the engine did not reveal.
 *
 * Highlighting rules (all thresholds exported and overridable):
 *  - large:      size ≥ largeMultiple × median size of the visible tape
 *  - sweepLike:  size ≥ sweepMultiple × median with a known aggressor
 *  - burst:      ≥ burstMinPrints prints within burstWindowMs of this print
 */

import type { Aggressor, TradeEvent } from "./events";

export type TapeFilter = "ALL" | "BUY" | "SELL" | "LARGE";
export const TAPE_FILTERS: readonly TapeFilter[] = ["ALL", "BUY", "SELL", "LARGE"];

export const TAPE_LARGE_MULTIPLE = 2;
export const TAPE_SWEEP_MULTIPLE = 3;
export const TAPE_BURST_WINDOW_MS = 500;
export const TAPE_BURST_MIN_PRINTS = 4;

export interface TapeOptions {
  largeMultiple?: number;
  sweepMultiple?: number;
  burstWindowMs?: number;
  burstMinPrints?: number;
}

export interface TapeRow {
  sequence: number;
  timestamp: number;
  price: number;
  size: number;
  /** Exactly as reported by the feed — never derived from price movement. */
  aggressorSide: Aggressor;
  /** size / largest size currently on the tape (0..1). */
  relativeSize: number;
  large: boolean;
  burst: boolean;
  sweepLike: boolean;
}

export interface TapeSummary {
  prints: number;
  buyVolume: number;
  sellVolume: number;
  largePrints: number;
  sweeps: number;
  bursts: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Build display rows from a revealed tape, preserving the input order.
 * `OrderFlowSnapshot.tape` is oldest-first — reverse it first for the
 * conventional newest-print-at-top Time & Sales view.
 */
export function buildTapeRows(
  tape: readonly TradeEvent[],
  filter: TapeFilter = "ALL",
  opts: TapeOptions = {},
): TapeRow[] {
  if (tape.length === 0) return [];
  const {
    largeMultiple = TAPE_LARGE_MULTIPLE,
    sweepMultiple = TAPE_SWEEP_MULTIPLE,
    burstWindowMs = TAPE_BURST_WINDOW_MS,
    burstMinPrints = TAPE_BURST_MIN_PRINTS,
  } = opts;

  const sizes = tape.map((t) => t.size);
  const med = Math.max(1, median(sizes));
  const maxSize = Math.max(1, ...sizes);

  const rows: TapeRow[] = tape.map((t) => {
    const large = t.size >= med * largeMultiple;
    const burst =
      tape.filter((o) => Math.abs(o.timestamp - t.timestamp) <= burstWindowMs).length >= burstMinPrints;
    return {
      sequence: t.sequence,
      timestamp: t.timestamp,
      price: t.price,
      size: t.size,
      aggressorSide: t.aggressorSide,
      relativeSize: Math.round((t.size / maxSize) * 10_000) / 10_000,
      large,
      burst,
      sweepLike: large && t.size >= med * sweepMultiple && t.aggressorSide !== "UNKNOWN",
    };
  });

  switch (filter) {
    case "BUY":
      return rows.filter((r) => r.aggressorSide === "BUY");
    case "SELL":
      return rows.filter((r) => r.aggressorSide === "SELL");
    case "LARGE":
      return rows.filter((r) => r.large || r.sweepLike);
    default:
      return rows;
  }
}

/** Header totals for the tape panel — computed from the rows on screen. */
export function summariseTape(rows: readonly TapeRow[]): TapeSummary {
  let buyVolume = 0;
  let sellVolume = 0;
  let largePrints = 0;
  let sweeps = 0;
  let bursts = 0;
  for (const r of rows) {
    if (r.aggressorSide === "BUY") buyVolume += r.size;
    else if (r.aggressorSide === "SELL") sellVolume += r.size;
    if (r.large) largePrints++;
    if (r.sweepLike) sweeps++;
    if (r.burst) bursts++;
  }
  return { prints: rows.length, buyVolume, sellVolume, largePrints, sweeps, bursts };
}
