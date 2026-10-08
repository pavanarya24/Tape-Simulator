/**
 * DOMEngine — Level-2 / depth-of-market engine.
 *
 * Maintains the top-10 bid/ask book from L2Event snapshots and BookResetEvents,
 * and measures liquidity behaviour: total liquidity, imbalance, stacking,
 * pulling, replenishment, depletion, sweeps and top-of-book changes.
 *
 * Deliberately separate from OrderFlowEngine: this engine owns the BOOK. It
 * observes trades only to detect sweeps against the displayed book; it does not
 * compute tape statistics. Works on any MarketDataFeed via MarketEvent input.
 */

import type { Level, L2Event, MarketEvent, TradeEvent } from "./events";

// Re-exported so UI consumers get the book level shape from one place.
export type { Level } from "./events";

/* ------------------------- tunable definitions ------------------------- */

/** A level is "stacked" when its size ≥ STACK_MULT × the side's average level size. */
export const STACK_MULT = 2.5;
/** Top-level size must drop by this fraction between L2 updates to count as a pull. */
export const PULL_DROP = 0.5;
/** After a pull, size must recover to ≥ RECOVER_FRAC × pre-pull size within REPLENISH_WINDOW events. */
export const RECOVER_FRAC = 0.9;
export const REPLENISH_WINDOW = 12;
/** Total side liquidity declining by this fraction across DEPLETION_WINDOW updates = depletion. */
export const DEPLETION_DROP = 0.35;
export const DEPLETION_WINDOW = 20;
/** A trade ≥ SWEEP_MULT × the displayed size at the level it trades through is a sweep. */
export const SWEEP_MULT = 3;
/** Bounded log of notable DOM events for the UI. */
export const DOM_LOG_KEEP = 14;

export type DOMEventType = "pull" | "replenish" | "deplete" | "sweep-buy" | "sweep-sell";

export interface DOMEventLogEntry {
  type: DOMEventType;
  side: "bid" | "ask";
  sequence: number;
  detail: string;
}

export interface DOMSnapshot {
  hasBook: boolean;
  bids: Level[];
  asks: Level[];
  totalBidLiquidity: number;
  totalAskLiquidity: number;
  /** (bidLiq − askLiq) / (bidLiq + askLiq), −1..1. */
  imbalance: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  /** Levels currently counted as stacked (size ≥ STACK_MULT × side average). */
  stackBidLevels: number;
  stackAskLevels: number;
  pullBidCount: number;
  pullAskCount: number;
  replenishCount: number;
  depletedBid: boolean;
  depletedAsk: boolean;
  sweepBuyCount: number;
  sweepSellCount: number;
  topOfBookChanges: number;
  recentEvents: DOMEventLogEntry[];
  sequence: number;
}

export interface DOMPullMarker {
  side: "bid" | "ask";
  price: number;
  preSize: number;
  eventsLeft: number;
}

type PullMarker = DOMPullMarker;

export interface DOMState {
  bids: readonly Level[];
  asks: readonly Level[];
  hasBook: boolean;
  sequence: number;
  stackBidLevels: number;
  stackAskLevels: number;
  pullBidCount: number;
  pullAskCount: number;
  replenishCount: number;
  depletedBid: boolean;
  depletedAsk: boolean;
  sweepBuyCount: number;
  sweepSellCount: number;
  topOfBookChanges: number;
  prevBestBid: number | null;
  prevBestAsk: number | null;
  prevBidTopSize: number;
  prevAskTopSize: number;
  pullMarkers: readonly DOMPullMarker[];
  bidHistoryTotals: readonly number[];
  askHistoryTotals: readonly number[];
  log: readonly DOMEventLogEntry[];
}

interface LiquidityHistory {
  totals: number[]; // ring of last DEPLETION_WINDOW+1 totals
}

function clampLevels(levels: Level[]): Level[] {
  return levels.slice(0, 10).map((l) => ({ price: l.price, size: l.size, orderCount: l.orderCount }));
}

export class DOMEngine {
  private bids: Level[] = [];
  private asks: Level[] = [];
  private hasBook = false;
  private sequence = 0;

  private stackBidLevels = 0;
  private stackAskLevels = 0;
  private pullBidCount = 0;
  private pullAskCount = 0;
  private replenishCount = 0;
  private depletedBid = false;
  private depletedAsk = false;
  private sweepBuyCount = 0;
  private sweepSellCount = 0;
  private topOfBookChanges = 0;

  private prevBestBid: number | null = null;
  private prevBestAsk: number | null = null;
  private prevBidTopSize = 0;
  private prevAskTopSize = 0;
  private pullMarkers: PullMarker[] = [];
  private bidHistory: LiquidityHistory = { totals: [] };
  private askHistory: LiquidityHistory = { totals: [] };
  private log: DOMEventLogEntry[] = [];

  reset(): void {
    this.bids = [];
    this.asks = [];
    this.hasBook = false;
    this.sequence = 0;
    this.stackBidLevels = 0;
    this.stackAskLevels = 0;
    this.pullBidCount = 0;
    this.pullAskCount = 0;
    this.replenishCount = 0;
    this.depletedBid = false;
    this.depletedAsk = false;
    this.sweepBuyCount = 0;
    this.sweepSellCount = 0;
    this.topOfBookChanges = 0;
    this.prevBestBid = null;
    this.prevBestAsk = null;
    this.prevBidTopSize = 0;
    this.prevAskTopSize = 0;
    this.pullMarkers = [];
    this.bidHistory = { totals: [] };
    this.askHistory = { totals: [] };
    this.log = [];
  }

  /**
   * Capture an immutable, detached checkpoint of internal DOM engine state.
   * Deep-clones bids, asks, pullMarkers (which mutate in place), and liquidity ring buffers.
   */
  captureState(): DOMState {
    return {
      bids: this.bids.map((l) => ({ price: l.price, size: l.size, orderCount: l.orderCount })),
      asks: this.asks.map((l) => ({ price: l.price, size: l.size, orderCount: l.orderCount })),
      hasBook: this.hasBook,
      sequence: this.sequence,
      stackBidLevels: this.stackBidLevels,
      stackAskLevels: this.stackAskLevels,
      pullBidCount: this.pullBidCount,
      pullAskCount: this.pullAskCount,
      replenishCount: this.replenishCount,
      depletedBid: this.depletedBid,
      depletedAsk: this.depletedAsk,
      sweepBuyCount: this.sweepBuyCount,
      sweepSellCount: this.sweepSellCount,
      topOfBookChanges: this.topOfBookChanges,
      prevBestBid: this.prevBestBid,
      prevBestAsk: this.prevBestAsk,
      prevBidTopSize: this.prevBidTopSize,
      prevAskTopSize: this.prevAskTopSize,
      pullMarkers: this.pullMarkers.map((m) => ({
        side: m.side,
        price: m.price,
        preSize: m.preSize,
        eventsLeft: m.eventsLeft,
      })),
      bidHistoryTotals: [...this.bidHistory.totals],
      askHistoryTotals: [...this.askHistory.totals],
      log: [...this.log],
    };
  }

  /**
   * Restore DOM engine state from a captured checkpoint.
   * Clones collections so subsequent processing does not mutate the checkpoint.
   */
  restoreState(state: DOMState): void {
    this.bids = state.bids.map((l) => ({ price: l.price, size: l.size, orderCount: l.orderCount }));
    this.asks = state.asks.map((l) => ({ price: l.price, size: l.size, orderCount: l.orderCount }));
    this.hasBook = state.hasBook;
    this.sequence = state.sequence;
    this.stackBidLevels = state.stackBidLevels;
    this.stackAskLevels = state.stackAskLevels;
    this.pullBidCount = state.pullBidCount;
    this.pullAskCount = state.pullAskCount;
    this.replenishCount = state.replenishCount;
    this.depletedBid = state.depletedBid;
    this.depletedAsk = state.depletedAsk;
    this.sweepBuyCount = state.sweepBuyCount;
    this.sweepSellCount = state.sweepSellCount;
    this.topOfBookChanges = state.topOfBookChanges;
    this.prevBestBid = state.prevBestBid;
    this.prevBestAsk = state.prevBestAsk;
    this.prevBidTopSize = state.prevBidTopSize;
    this.prevAskTopSize = state.prevAskTopSize;
    this.pullMarkers = state.pullMarkers.map((m) => ({
      side: m.side,
      price: m.price,
      preSize: m.preSize,
      eventsLeft: m.eventsLeft,
    }));
    this.bidHistory = { totals: [...state.bidHistoryTotals] };
    this.askHistory = { totals: [...state.askHistoryTotals] };
    this.log = [...state.log];
  }

  /** Feed one event. L2 rebuilds the book; trades drive sweep detection. */
  processEvent(ev: MarketEvent): void {
    if (ev.kind === "l2") this.onL2(ev);
    else if (ev.kind === "book-reset") this.onReset(ev.sequence);
    else if (ev.kind === "trade") this.onTrade(ev);
  }

  private onReset(sequence: number): void {
    this.bids = [];
    this.asks = [];
    this.hasBook = false;
    this.prevBestBid = null;
    this.prevBestAsk = null;
    this.pullMarkers = [];
    this.bidHistory = { totals: [] };
    this.askHistory = { totals: [] };
    this.sequence = sequence;
  }

  private onL2(ev: L2Event): void {
    this.sequence = ev.sequence;
    const newBids = clampLevels(ev.bids);
    const newAsks = clampLevels(ev.asks);
    if (newBids.length === 0 || newAsks.length === 0) return;

    const bestBid = newBids[0];
    const bestAsk = newAsks[0];

    // Top-of-book price changes.
    if (this.hasBook) {
      if (this.prevBestBid !== null && bestBid.price !== this.prevBestBid) this.topOfBookChanges++;
      if (this.prevBestAsk !== null && bestAsk.price !== this.prevBestAsk) this.topOfBookChanges++;
    }
    this.prevBestBid = bestBid.price;
    this.prevBestAsk = bestAsk.price;

    // Pull / replenish analytics vs the previous top-of-book sizes.
    this.analyseSide("bid", this.prevBidTopSize, bestBid.price, bestBid.size);
    this.analyseSide("ask", this.prevAskTopSize, bestAsk.price, bestAsk.size);
    this.prevBidTopSize = bestBid.size;
    this.prevAskTopSize = bestAsk.size;

    this.bids = newBids;
    this.asks = newAsks;
    this.hasBook = true;

    // Stacking: levels ≥ STACK_MULT × the side's average level size.
    this.stackBidLevels = countStacked(newBids);
    this.stackAskLevels = countStacked(newAsks);

    // Depletion over the rolling window.
    this.depletedBid = this.trackDepletion(this.bidHistory, totalSize(newBids));
    this.depletedAsk = this.trackDepletion(this.askHistory, totalSize(newAsks));
  }

  private analyseSide(side: "bid" | "ask", prevSize: number, price: number, size: number): void {
    if (!this.hasBook || prevSize <= 0) return;

    const dropped = (prevSize - size) / prevSize;
    const pulled = dropped >= PULL_DROP;

    // Replenishment: an earlier pull at this price recovering now.
    const markerIdx = this.pullMarkers.findIndex((m) => m.side === side && m.price === price);
    if (markerIdx >= 0) {
      const marker = this.pullMarkers[markerIdx];
      if (size >= marker.preSize * RECOVER_FRAC) {
        this.replenishCount++;
        this.log.push({
          type: "replenish",
          side,
          sequence: this.sequence,
          detail: `${side === "bid" ? "Bid" : "Ask"} ${price} refilled to ${Math.round(size)}`,
        });
        this.pullMarkers.splice(markerIdx, 1);
      } else {
        marker.eventsLeft -= 1;
        if (marker.eventsLeft <= 0) this.pullMarkers.splice(markerIdx, 1);
      }
    } else if (pulled) {
      if (side === "bid") this.pullBidCount++;
      else this.pullAskCount++;
      this.log.push({
        type: "pull",
        side,
        sequence: this.sequence,
        detail: `${side === "bid" ? "Bid" : "Ask"} ${price} pulled ${Math.round(prevSize)}→${Math.round(size)}`,
      });
      this.pullMarkers.push({ side, price, preSize: prevSize, eventsLeft: REPLENISH_WINDOW });
      this.trimLog();
    }
  }

  private trackDepletion(history: LiquidityHistory, total: number): boolean {
    history.totals.push(total);
    if (history.totals.length > DEPLETION_WINDOW + 1) history.totals.shift();
    if (history.totals.length < DEPLETION_WINDOW + 1) return false;
    const then = history.totals[0];
    return then > 0 && total <= then * (1 - DEPLETION_DROP);
  }

  private onTrade(t: TradeEvent): void {
    if (!this.hasBook) return;
    const bestBid = this.bids[0];
    const bestAsk = this.asks[0];
    if (t.aggressorSide === "BUY" && t.price >= bestAsk.price && t.size >= bestAsk.size * SWEEP_MULT) {
      this.sweepBuyCount++;
      this.log.push({
        type: "sweep-buy",
        side: "ask",
        sequence: t.sequence,
        detail: `BUY ${t.size} @ ${t.price} swept offer ${bestAsk.size}`,
      });
      this.trimLog();
    } else if (t.aggressorSide === "SELL" && t.price <= bestBid.price && t.size >= bestBid.size * SWEEP_MULT) {
      this.sweepSellCount++;
      this.log.push({
        type: "sweep-sell",
        side: "bid",
        sequence: t.sequence,
        detail: `SELL ${t.size} @ ${t.price} swept bid ${bestBid.size}`,
      });
      this.trimLog();
    }
  }

  private trimLog(): void {
    if (this.log.length > DOM_LOG_KEEP) this.log.splice(0, this.log.length - DOM_LOG_KEEP);
  }

  snapshot(): DOMSnapshot {
    const bidLiq = totalSize(this.bids);
    const askLiq = totalSize(this.asks);
    const sum = bidLiq + askLiq;
    return {
      hasBook: this.hasBook,
      bids: this.bids.map((l) => ({ ...l })),
      asks: this.asks.map((l) => ({ ...l })),
      totalBidLiquidity: bidLiq,
      totalAskLiquidity: askLiq,
      imbalance: sum > 0 ? +((bidLiq - askLiq) / sum).toFixed(4) : null,
      bestBid: this.bids[0]?.price ?? null,
      bestAsk: this.asks[0]?.price ?? null,
      spread: this.hasBook ? +(this.asks[0].price - this.bids[0].price).toFixed(2) : null,
      stackBidLevels: this.stackBidLevels,
      stackAskLevels: this.stackAskLevels,
      pullBidCount: this.pullBidCount,
      pullAskCount: this.pullAskCount,
      replenishCount: this.replenishCount,
      depletedBid: this.depletedBid,
      depletedAsk: this.depletedAsk,
      sweepBuyCount: this.sweepBuyCount,
      sweepSellCount: this.sweepSellCount,
      topOfBookChanges: this.topOfBookChanges,
      recentEvents: [...this.log],
      sequence: this.sequence,
    };
  }
}

function totalSize(levels: Level[]): number {
  return levels.reduce((s, l) => s + l.size, 0);
}

function countStacked(levels: Level[]): number {
  if (levels.length === 0) return 0;
  const avg = totalSize(levels) / levels.length;
  return levels.filter((l) => l.size >= avg * STACK_MULT).length;
}
