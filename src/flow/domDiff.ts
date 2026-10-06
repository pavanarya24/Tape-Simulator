/**
 * Phase 8B.3 — per-level DOM change detection.
 *
 * Pure diff of two revealed book snapshots, used to highlight which levels
 * gained or lost liquidity on the current event:
 *
 *   NEW      level appeared with size
 *   ADDED    existing level grew (replenished / stacked)
 *   PULLED   existing level shrank but still has size
 *   REMOVED  level emptied (all liquidity pulled or traded through)
 *
 * This is a *presentation* aid computed from consecutive revealed events; it
 * is deliberately not part of the session's deterministic market state (a
 * journal/seek rewrite never changes the book the engine builds).
 */

import type { Level } from "./events";

export type BookChangeKind = "NEW" | "ADDED" | "PULLED" | "REMOVED";

export interface BookChange {
  side: "bid" | "ask";
  price: number;
  kind: BookChangeKind;
  /** next size − previous size (negative when liquidity left). */
  delta: number;
  /** Size resting at the level after this event. */
  size: number;
}

export interface BookView {
  bids: readonly Level[];
  asks: readonly Level[];
}

/** How many per-level changes to surface (largest absolute moves first). */
export const BOOK_CHANGE_KEEP = 12;

export const BOOK_CHANGE_LABELS: Record<BookChangeKind, string> = {
  NEW: "NEW",
  ADDED: "ADDED",
  PULLED: "PULLED",
  REMOVED: "REMOVED",
};

function sizeByPrice(levels: readonly Level[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const l of levels) map.set(l.price, (map.get(l.price) ?? 0) + l.size);
  return map;
}

function classify(before: number, after: number): BookChangeKind {
  if (before === 0 && after > 0) return "NEW";
  if (after === 0) return "REMOVED";
  return after > before ? "ADDED" : "PULLED";
}

/** Diff two books (previous revealed event vs current). */
export function diffBook(prev: BookView | null, next: BookView | null): BookChange[] {
  if (!next) return [];
  const out: BookChange[] = [];

  const sides: Array<{ side: "bid" | "ask"; before: readonly Level[]; after: readonly Level[] }> = [
    { side: "bid", before: prev?.bids ?? [], after: next.bids },
    { side: "ask", before: prev?.asks ?? [], after: next.asks },
  ];

  for (const { side, before, after } of sides) {
    const beforeMap = sizeByPrice(before);
    const afterMap = sizeByPrice(after);
    const prices = new Set<number>([...beforeMap.keys(), ...afterMap.keys()]);
    for (const price of prices) {
      const beforeSize = beforeMap.get(price) ?? 0;
      const afterSize = afterMap.get(price) ?? 0;
      if (beforeSize === afterSize) continue;
      out.push({
        side,
        price,
        kind: classify(beforeSize, afterSize),
        delta: afterSize - beforeSize,
        size: afterSize,
      });
    }
  }

  out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.price - b.price);
  return out.slice(0, BOOK_CHANGE_KEEP);
}

/** Count changes of one kind (used by the DOM panel header). */
export function countChanges(changes: readonly BookChange[], kind: BookChangeKind): number {
  return changes.filter((c) => c.kind === kind).length;
}
