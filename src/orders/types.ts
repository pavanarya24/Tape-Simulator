/** Simulated order model. Orders never touch a broker — this is a replay lab. */

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop";
export type OrderStatus = "working" | "filled" | "cancelled" | "rejected";

export interface OrderRequest {
  side: OrderSide;
  type: OrderType;
  qty: number;
  /** Limit price or stop trigger price. Ignored for market orders. */
  price?: number;
  /** Protective stop attached to the resulting position. */
  stopLoss?: number;
  /** Protective target attached to the resulting position. */
  takeProfit?: number;
  /** Set when the order is closing an existing position. */
  reduceOnly?: boolean;
  tag?: string;
}

export interface Order extends OrderRequest {
  id: string;
  status: OrderStatus;
  /** Replay timestamp when the order was submitted. */
  createdAt: number;
  /** Bar index at submission (order may only act on later bars). */
  createdIndex: number;
  filledAt?: number;
  filledIndex?: number;
  fillPrice?: number;
  /** Human-readable explanation of the last state change. */
  note: string;
}

export interface Fill {
  id: string;
  orderId: string;
  side: OrderSide;
  qty: number;
  price: number;
  time: number;
  index: number;
  /** How the fill was produced under the OHLC model. */
  kind: "market-next-open" | "limit-touch" | "stop-trigger" | "stop-loss" | "take-profit" | "session-close";
  note: string;
}
