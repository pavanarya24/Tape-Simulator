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

/** Action performed by an incremental depth update. */
export type DepthAction = "add" | "modify" | "delete";

/** Order book side for depth updates and quotes. */
export type BookSide = "bid" | "ask";

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
  /** Instrument or contract identifier (e.g. "NQ", "ES", "NQM4"). */
  symbol?: string;
  /** High-resolution exchange matching engine timestamp in nanoseconds. */
  tsEventNanos?: bigint | string;
  /** High-resolution packet receive / capture timestamp in nanoseconds. */
  tsRecvNanos?: bigint | string;
  /** Unique match / execution ID linking split fills from one aggressor sweep. */
  matchId?: string;
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
  symbol?: string;
  tsEventNanos?: bigint | string;
  tsRecvNanos?: bigint | string;
}

/** Clears the maintained book (session start, feed reconnect, session break). */
export interface BookResetEvent {
  kind: "book-reset";
  timestamp: number;
  sequence: number;
  symbol?: string;
  tsEventNanos?: bigint | string;
  tsRecvNanos?: bigint | string;
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
  symbol?: string;
  tsEventNanos?: bigint | string;
  tsRecvNanos?: bigint | string;
}

/** Incremental Level-2 order book depth change (CME MDP 3.0 / MBP / MBO delta). */
export interface DepthDeltaEvent {
  kind: "depth-delta";
  /** Epoch milliseconds, UTC. */
  timestamp: number;
  sequence: number;
  symbol?: string;
  side: BookSide;
  action: DepthAction;
  price: number;
  size: number;
  orderCount?: number;
  tsEventNanos?: bigint | string;
  tsRecvNanos?: bigint | string;
}

/**
 * Vendor-neutral normalized market event contract.
 * Represents all supported microstructure events: executed trades, incremental
 * depth changes, Level-2 book snapshots, top-of-book quotes, and book resets.
 */
export type NormalizedMarketEvent =
  | TradeEvent
  | L2Event
  | BookResetEvent
  | QuoteEvent
  | DepthDeltaEvent;

/** Every event a MarketDataFeed can emit. Fully compatible with NormalizedMarketEvent. */
export type MarketEvent = NormalizedMarketEvent;

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
export function isDepthDelta(ev: MarketEvent): ev is DepthDeltaEvent {
  return ev.kind === "depth-delta";
}

/** Human-readable label for a trade's aggressor. */
export function aggressorLabel(side: Aggressor): string {
  return side === "BUY" ? "BUY" : side === "SELL" ? "SELL" : "—";
}

/**
 * Extract or compute nanoseconds timestamp as a safe `bigint`.
 * Prefers `tsEventNanos` when available; falls back to `timestamp * 1_000_000n`.
 */
export function toEventNanos(ev: { timestamp: number; tsEventNanos?: bigint | string }): bigint {
  if (ev.tsEventNanos !== undefined) {
    if (typeof ev.tsEventNanos === "bigint") return ev.tsEventNanos;
    const trimmed = String(ev.tsEventNanos).trim();
    if (/^-?\d+$/.test(trimmed)) {
      try {
        return BigInt(trimmed);
      } catch {
        // Fall through to timestamp calculation on syntax anomaly
      }
    }
  }
  return BigInt(Math.floor(ev.timestamp)) * 1_000_000n;
}

/**
 * Deterministic total ordering comparator for normalized market events:
 * 1. Nanosecond event timestamp (exchange/matching engine time)
 * 2. Event sequence number
 * 3. Tie-breaker by event kind priority (book-reset -> depth-delta -> l2 -> quote -> trade)
 */
export function compareNormalizedEvents(
  a: NormalizedMarketEvent,
  b: NormalizedMarketEvent,
): number {
  const aNanos = toEventNanos(a);
  const bNanos = toEventNanos(b);
  if (aNanos < bNanos) return -1;
  if (aNanos > bNanos) return 1;

  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }

  const priority = (kind: NormalizedMarketEvent["kind"]): number => {
    switch (kind) {
      case "book-reset": return 0;
      case "depth-delta": return 1;
      case "l2": return 2;
      case "quote": return 3;
      case "trade": return 4;
    }
  };
  return priority(a.kind) - priority(b.kind);
}

/**
 * Validates a normalized market event payload for structural and numerical validity.
 */
export function validateNormalizedEvent(ev: unknown): { valid: boolean; error?: string } {
  if (!ev || typeof ev !== "object") {
    return { valid: false, error: "Event must be a non-null object" };
  }
  const e = ev as Partial<NormalizedMarketEvent>;
  if (!e.kind || typeof e.kind !== "string") {
    return { valid: false, error: "Missing or invalid 'kind' discriminator" };
  }
  if (typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp) || e.timestamp < 0) {
    return { valid: false, error: "Timestamp must be a non-negative finite number" };
  }
  if (typeof e.sequence !== "number" || !Number.isInteger(e.sequence) || e.sequence < 1) {
    return { valid: false, error: "Sequence must be a positive integer" };
  }
  if (
    e.tsEventNanos !== undefined &&
    typeof e.tsEventNanos !== "bigint" &&
    (typeof e.tsEventNanos !== "string" || !/^-?\d+$/.test(e.tsEventNanos.trim()))
  ) {
    return { valid: false, error: "tsEventNanos must be a bigint or numeric string" };
  }
  if (
    e.tsRecvNanos !== undefined &&
    typeof e.tsRecvNanos !== "bigint" &&
    (typeof e.tsRecvNanos !== "string" || !/^-?\d+$/.test(e.tsRecvNanos.trim()))
  ) {
    return { valid: false, error: "tsRecvNanos must be a bigint or numeric string" };
  }

  switch (e.kind) {
    case "trade": {
      const t = e as Partial<TradeEvent>;
      if (typeof t.price !== "number" || !Number.isFinite(t.price)) {
        return { valid: false, error: "Trade price must be a finite number" };
      }
      if (typeof t.size !== "number" || !Number.isFinite(t.size) || t.size <= 0) {
        return { valid: false, error: "Trade size must be a positive number" };
      }
      if (t.aggressorSide !== "BUY" && t.aggressorSide !== "SELL" && t.aggressorSide !== "UNKNOWN") {
        return { valid: false, error: "Trade aggressorSide must be 'BUY', 'SELL', or 'UNKNOWN'" };
      }
      return { valid: true };
    }
    case "depth-delta": {
      const d = e as Partial<DepthDeltaEvent>;
      if (d.side !== "bid" && d.side !== "ask") {
        return { valid: false, error: "Depth side must be 'bid' or 'ask'" };
      }
      if (d.action !== "add" && d.action !== "modify" && d.action !== "delete") {
        return { valid: false, error: "Depth action must be 'add', 'modify', or 'delete'" };
      }
      if (typeof d.price !== "number" || !Number.isFinite(d.price)) {
        return { valid: false, error: "Depth price must be a finite number" };
      }
      if (typeof d.size !== "number" || !Number.isFinite(d.size) || (d.action !== "delete" && d.size <= 0)) {
        return { valid: false, error: "Depth size must be positive (or non-negative for delete)" };
      }
      if (d.orderCount !== undefined && (!Number.isInteger(d.orderCount) || d.orderCount < 0)) {
        return { valid: false, error: "Depth orderCount must be a non-negative integer when specified" };
      }
      return { valid: true };
    }
    case "quote": {
      const q = e as Partial<QuoteEvent>;
      if (
        typeof q.bid !== "number" ||
        !Number.isFinite(q.bid) ||
        typeof q.ask !== "number" ||
        !Number.isFinite(q.ask) ||
        typeof q.bidSize !== "number" ||
        !Number.isFinite(q.bidSize) ||
        typeof q.askSize !== "number" ||
        !Number.isFinite(q.askSize)
      ) {
        return { valid: false, error: "Quote must contain finite bid, ask, bidSize, and askSize numbers" };
      }
      return { valid: true };
    }
    case "l2": {
      const l = e as Partial<L2Event>;
      if (!Array.isArray(l.bids) || !Array.isArray(l.asks)) {
        return { valid: false, error: "L2 event must contain bids and asks arrays" };
      }
      return { valid: true };
    }
    case "book-reset": {
      return { valid: true };
    }
    default:
      return { valid: false, error: `Unknown event kind: ${(e as { kind: string }).kind}` };
  }
}

/**
 * Safely serialize a normalized market event to JSON, converting `bigint` fields to strings.
 */
export function serializeNormalizedEvent(ev: NormalizedMarketEvent): string {
  return JSON.stringify(ev, (_key, val) => (typeof val === "bigint" ? val.toString() : val));
}

/**
 * Parse a serialized JSON event into a NormalizedMarketEvent.
 */
export function deserializeNormalizedEvent(json: string): NormalizedMarketEvent {
  const parsed = JSON.parse(json) as unknown;
  const validation = validateNormalizedEvent(parsed);
  if (!validation.valid) {
    throw new Error(`Deserialization validation failed: ${validation.error}`);
  }
  return parsed as NormalizedMarketEvent;
}
