/**
 * Market domain types.
 *
 * Tape Lab's chartable/tradeable primitives live here. The OHLC bar is the only
 * primitive the current datasets can supply. The remaining interfaces
 * (`Tick`, `Trade`, `Quote`, `OrderBookSnapshot`) are deliberately declared but
 * unimplemented: they describe the contract a future tick / Level-2 data source
 * must satisfy so the trading UI never has to be rewritten.
 *
 * IMPORTANT: historical OHLCV bars are NOT Time & Sales and are NOT Level 2.
 * Nothing in this codebase may present OHLC data as aggressor-side or book data.
 */

export type RootSymbol = "NQ" | "ES";

/** Tradeable contract (root or micro). */
export type ContractId = "NQ" | "MNQ" | "ES" | "MES";

export interface ContractSpec {
  id: ContractId;
  root: RootSymbol;
  label: string;
  /** Dollar value of one full index point, per contract. */
  pointValue: number;
  /** Minimum price increment ("tick"). */
  tickSize: number;
  /** Dollar value of one tick, per contract. */
  tickValue: number;
  currency: "USD";
}

/** A single OHLCV bar. `t` is the bar OPEN time in epoch milliseconds (UTC). */
export interface Bar {
  /** Epoch milliseconds, UTC. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Column-oriented bar storage — used for large session slices without object churn. */
export interface BarSeries {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
  /** Number of populated entries. */
  length: number;
}

/* ------------------------------------------------------------------ *
 * Future order-flow contracts (NOT implemented for OHLC datasets)
 * ------------------------------------------------------------------ */

/** Aggressor classification is only knowable from tick / Time & Sales data. */
export type AggressorSide = "buy" | "sell" | "unknown";

/** A single executed print from a tick / Time & Sales feed. */
export interface Trade {
  /** Epoch ms, UTC. */
  t: number;
  price: number;
  size: number;
  side: AggressorSide;
  exchange?: string;
}

/** A top-of-book quote update. Requires bid/ask data. */
export interface Quote {
  t: number;
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
}

/** One price-level aggregate of a Level-2 / DOM snapshot at an instant. */
export interface OrderBookLevel {
  price: number;
  size: number;
  orders?: number;
}

/** A point-in-time full-depth book snapshot. Requires Level-2 data. */
export interface OrderBookSnapshot {
  t: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

/** A single tick — the union a real tick feed would deliver. */
export type Tick =
  | { kind: "trade"; trade: Trade }
  | { kind: "quote"; quote: Quote }
  | { kind: "book"; book: OrderBookSnapshot };

/** What a data source can actually provide. Drives UI capability gating. */
export interface DataCapabilities {
  ohlc: boolean;
  tick: boolean;
  timeAndSales: boolean;
  quotes: boolean;
  level2: boolean;
  /** True only for real historical tick/L2 data, never for OHLC. */
  orderFlow: boolean;
}

export const OHLC_ONLY_CAPABILITIES: DataCapabilities = {
  ohlc: true,
  tick: false,
  timeAndSales: false,
  quotes: false,
  level2: false,
  orderFlow: false,
};
