/**
 * Phase 9-C — Deterministic Snapshot-to-Delta Conversion
 *
 * Converts successive Level-2 book snapshots into canonical DepthDeltaEvent
 * records according to strict exchange matching rules:
 * - Unchanged levels produce NO delta.
 * - New level present in next snapshot but not in previous -> ADD.
 * - Level present in both but with size or orderCount changed -> MODIFY.
 * - Level present in previous snapshot but absent in next -> DELETE.
 *
 * Preserves deterministic sequence numbering and timestamps.
 */

import type { DepthDeltaEvent, Level } from "../events";

export interface SnapshotDeltaConverterOptions {
  symbol?: string;
  startSequence?: number;
}

export class SnapshotDeltaConverter {
  private prevBids: Map<number, Level> = new Map();
  private prevAsks: Map<number, Level> = new Map();
  private currentSeq: number;
  private readonly symbol?: string;

  constructor(opts: SnapshotDeltaConverterOptions = {}) {
    this.currentSeq = opts.startSequence ?? 1;
    this.symbol = opts.symbol;
  }

  /** Reset internal state (e.g. upon book reset or session start). */
  reset(startSequence = 1): void {
    this.prevBids.clear();
    this.prevAsks.clear();
    this.currentSeq = startSequence;
  }

  /**
   * Convert a new Level-2 snapshot into incremental DepthDeltaEvent updates.
   * Compares against previously seen book levels.
   */
  convert(
    timestamp: number,
    bids: Level[],
    asks: Level[],
    opts: { tsEventNanos?: bigint | string; tsRecvNanos?: bigint | string } = {},
  ): DepthDeltaEvent[] {
    const deltas: DepthDeltaEvent[] = [];

    // Process Bids
    const nextBids = new Map<number, Level>();
    for (const level of bids) {
      nextBids.set(level.price, level);
    }
    this.diffSide("bid", this.prevBids, nextBids, timestamp, deltas, opts);
    this.prevBids = nextBids;

    // Process Asks
    const nextAsks = new Map<number, Level>();
    for (const level of asks) {
      nextAsks.set(level.price, level);
    }
    this.diffSide("ask", this.prevAsks, nextAsks, timestamp, deltas, opts);
    this.prevAsks = nextAsks;

    return deltas;
  }

  private diffSide(
    side: "bid" | "ask",
    prev: Map<number, Level>,
    next: Map<number, Level>,
    timestamp: number,
    out: DepthDeltaEvent[],
    meta: { tsEventNanos?: bigint | string; tsRecvNanos?: bigint | string },
  ): void {
    // 1. Detect Adds and Modifies
    for (const [price, nextLevel] of next) {
      const prevLevel = prev.get(price);
      if (!prevLevel) {
        // New price level -> ADD
        out.push({
          kind: "depth-delta",
          timestamp,
          sequence: this.currentSeq++,
          symbol: this.symbol,
          side,
          action: "add",
          price,
          size: nextLevel.size,
          orderCount: nextLevel.orderCount,
          tsEventNanos: meta.tsEventNanos,
          tsRecvNanos: meta.tsRecvNanos,
        });
      } else if (prevLevel.size !== nextLevel.size || prevLevel.orderCount !== nextLevel.orderCount) {
        // Existing level changed -> MODIFY
        out.push({
          kind: "depth-delta",
          timestamp,
          sequence: this.currentSeq++,
          symbol: this.symbol,
          side,
          action: "modify",
          price,
          size: nextLevel.size,
          orderCount: nextLevel.orderCount,
          tsEventNanos: meta.tsEventNanos,
          tsRecvNanos: meta.tsRecvNanos,
        });
      }
      // If price, size, and orderCount are equal -> NO DELTA
    }

    // 2. Detect Deletes (present in prev but absent in next)
    for (const [price] of prev) {
      if (!next.has(price)) {
        out.push({
          kind: "depth-delta",
          timestamp,
          sequence: this.currentSeq++,
          symbol: this.symbol,
          side,
          action: "delete",
          price,
          size: 0,
          orderCount: 0,
          tsEventNanos: meta.tsEventNanos,
          tsRecvNanos: meta.tsRecvNanos,
        });
      }
    }
  }
}
