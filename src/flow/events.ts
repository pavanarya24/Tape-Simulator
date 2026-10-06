/**
 * Vendor-neutral order-flow event contracts.
 *
 * These types describe the conceptual structure of a real market-data feed
 * (executed trades + Level-2 book snapshots + book resets + top-of-book
 * quotes), independent of any vendor. A real adapter (Databento, Rithmic, …)
 * maps its own wire format onto these types; the engines and UI below them
 * never learn which vendor produced the events.
 *
 * IMPORTANT: these events are NOT derived from OHLC candles. Nothing in Tape
 * Lab may fabricate Time & Sales or Level-2 data from OHLC bars — aggressor
 * side, book depth and liquidity behaviour only exist where a feed supplies
 * them (today: the deterministic synthetic generator; later: a real adapter).
 */

/** Aggressor side of an executed trade, as reported by the venue. */
export type Aggressor = "BUY" | "SELL" | "UNKNOWN";

/** One price level of a Level-2 book snapshot. */
export interface Level {
  price: number;
  /** Total resting size at this level. */
  size: number;
  /** Number of distinct resting orders at this level. */
  orderCount: number;
}

/** A single executed print (Time & Sales row). */
export interface TradeEvent {
  kind: "trade";
  /** Epoch milliseconds, UTC. */
  timestamp: number;
  price: number;
  size: number;
  /** Who initiated: never inferred from candles — the feed reports it. */
  aggressorSide: Aggressor;
  /** Strictly increasing per-feed event counter starting at 1. */
  sequence: number;
}

/** A full-depth snapshot of the top 10 bid and ask levels. */
export interface L2Event {
  kind: "l2";
  timestamp: number;
  sequence: number;
  /** Best bid first, descending price. Exactly 10 levels. */
  bids: Level[];
  /** Best ask first, ascending price. Exactly 10 levels. */
  asks: Level[];
}

/** Clears the maintained book (session start, feed reconnect, session break). */
export interface BookResetEvent {
  kind: "book-reset";
  timestamp: number;
  sequence: number;
}

/** Optional top-of-book quote (best bid/ask with sizes). */
export interface QuoteEvent {
  kind: "quote";
  timestamp: number;
  sequence: number;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
}

/** Every event a MarketDataFeed can emit. */
export type MarketEvent = TradeEvent | L2Event | BookResetEvent | QuoteEvent;

export function isTrade(ev: MarketEvent): ev is TradeEvent {
  return ev.kind === "trade";
}
export function isL2(ev: MarketEvent): ev is L2Event {
  return ev.kind === "l2";
}
export function isBookReset(ev: MarketEvent): ev is BookResetEvent {
  return ev.kind === "book-reset";
}
export function isQuote(ev: MarketEvent): ev is QuoteEvent {
  return ev.kind === "quote";
}

/** Human-readable label for a trade's aggressor. */
export function aggressorLabel(side: Aggressor): string {
  return side === "BUY" ? "BUY" : side === "SELL" ? "SELL" : "—";
}
