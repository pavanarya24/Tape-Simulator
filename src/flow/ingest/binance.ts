/**
 * Phase 9-Crypto — Binance market-data adapter.
 *
 * Supports the public Spot and USDⓈ-M Futures JSON websocket payloads for
 * aggTrade/trade, diff-depth, bookTicker, plus explicit offline snapshots and
 * reconnect/reset markers used by deterministic fixtures.
 *
 * Binance trade IDs and order-book update IDs are independent domains. The
 * normalized `sequence` is therefore a deterministic feed-local ordinal; raw
 * depth IDs are retained internally for continuity checks and are never
 * misrepresented as execution IDs or MBO order IDs.
 */

import type {
  Aggressor,
  BookSide,
  BookResetEvent,
  DepthDeltaEvent,
  NormalizedMarketEvent,
  QuoteEvent,
  TradeEvent,
} from "../events";
import { compareNormalizedEvents } from "../events";
import type { MarketDataFeed } from "../feed";
import { RealMarketDataFeed } from "./feed";
import type {
  IngestionOptions,
  IngestionValidationReport,
  MarketDataAdapter,
  MicrostructureCapabilities,
} from "./types";
import { MicrostructureValidator } from "./validator";

export type BinanceMarket = "spot" | "usdm";

type BinanceLevel = [string, string];

export interface BinanceAggTradeMessage {
  e: "aggTrade";
  E: number;
  s: string;
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
  f?: number;
  l?: number;
}

export interface BinanceTradeMessage {
  e: "trade";
  E: number;
  s: string;
  t: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export interface BinanceDepthUpdateMessage {
  e: "depthUpdate";
  E: number;
  T?: number;
  s: string;
  U: number;
  u: number;
  pu?: number;
  b: BinanceLevel[];
  a: BinanceLevel[];
}

/** Offline snapshot record. Binance supplies this through REST/WebSocket API, not a depth stream frame. */
export interface BinanceDepthSnapshotMessage {
  type: "snapshot";
  E?: number;
  T?: number;
  s: string;
  lastUpdateId: number;
  bids: BinanceLevel[];
  asks: BinanceLevel[];
}

/** Offline control record used to model reconnect/session reset deterministically. */
export interface BinanceResetMessage {
  type: "reset";
  E: number;
  s: string;
  reason?: "reconnect" | "gap" | "session";
}

export interface BinanceBookTickerMessage {
  e: "bookTicker";
  E?: number;
  T?: number;
  s: string;
  u?: number;
  b: string;
  B: string;
  a: string;
  A: string;
}

export type BinanceRawMessage =
  | BinanceAggTradeMessage
  | BinanceTradeMessage
  | BinanceDepthUpdateMessage
  | BinanceDepthSnapshotMessage
  | BinanceResetMessage
  | BinanceBookTickerMessage
  | { stream: string; data: BinanceRawMessage };

type BinanceWireMessage = Exclude<BinanceRawMessage, { stream: string; data: BinanceRawMessage }>;
type BinanceEventDraft =
  | Omit<TradeEvent, "sequence">
  | Omit<DepthDeltaEvent, "sequence">
  | Omit<BookResetEvent, "sequence">
  | Omit<QuoteEvent, "sequence">;

export interface BinanceIngestionOptions extends IngestionOptions {
  /** Optional symbol filter, e.g. BTCUSDT or ETHUSDT. */
  symbol?: string;
  /** Selects the documented continuity rule for diff-depth messages. */
  market?: BinanceMarket;
}

interface BookState {
  lastUpdateId: number;
  anchored: boolean;
  bids: Map<number, number>;
  asks: Map<number, number>;
}

export class BinanceAdapter implements MarketDataAdapter<string | BinanceRawMessage[]> {
  readonly name = "binance";

  readonly capabilities: MicrostructureCapabilities = {
    hasTrades: true,
    hasQuotes: true,
    hasDepth: true,
    hasMBO: false,
    hasAggressor: true,
    hasOrderCounts: false,
    hasNanosecondTimestamps: false,
    hasReceiveTimestamp: false,
    hasMatchIds: false,
  };

  normalize(
    raw: string | BinanceRawMessage[],
    options: BinanceIngestionOptions = {},
  ): { events: NormalizedMarketEvent[]; report: IngestionValidationReport } {
    const records = this.parseRawRecords(raw);
    const validator = new MicrostructureValidator({
      strict: options.strict,
      source: `Binance ${options.market === "usdm" ? "USDⓈ-M Futures" : "Spot"}`,
      instrument: options.symbol?.toUpperCase() ?? "BINANCE",
    });
    const events: NormalizedMarketEvent[] = [];
    const books = new Map<string, BookState>();
    const symbolFilter = options.symbol?.toUpperCase();
    let nextSequence = 1;
    let sequenceGapCount = 0;

    const emit = (event: BinanceEventDraft, recordIndex: number): void => {
      const sequenced = { ...event, sequence: nextSequence++ } as NormalizedMarketEvent;
      if (validator.validateEvent(sequenced, recordIndex)) events.push(sequenced);
    };

    for (let i = 0; i < records.length; i++) {
      if (options.maxEvents && events.length >= options.maxEvents) break;
      const rec = records[i];
      const message = this.unwrap(rec);
      const symbol = this.symbolOf(message);
      if (symbolFilter && symbol !== symbolFilter) continue;

      if (this.isReset(message)) {
        books.delete(symbol);
        emit({ kind: "book-reset", timestamp: this.requireTime(message.E, i), symbol }, i);
        continue;
      }

      if (this.isSnapshot(message)) {
        const state = this.newBookState(message.lastUpdateId, message.bids, message.asks);
        books.set(symbol, state);
        const timestamp = this.requireTime(message.T ?? message.E, i);
        emit({ kind: "book-reset", timestamp, symbol }, i);
        this.emitSnapshotDeltas(state, timestamp, symbol, emit, i);
        continue;
      }

      if (this.isAggTrade(message) || this.isTrade(message)) {
        emit(this.tradeEvent(message.s, message.T, message.p, message.q, message.m, i), i);
        continue;
      }
      if (this.isBookTicker(message)) {
        emit(this.quoteEvent(message, i), i);
        continue;
      }
      if (this.isDepthUpdate(message)) {
        const state = books.get(symbol);
        const depthTime = this.requireTime(message.T ?? message.E, i);
        if (!state || !state.anchored) {
          validator.validateEvent(null, i);
          continue;
        }
        const expected = state.lastUpdateId + 1;
        const contiguous =
          options.market === "usdm" && message.pu !== undefined
            ? message.pu === state.lastUpdateId && message.u >= expected
            : message.U <= expected && message.u >= expected;
        if (message.u <= state.lastUpdateId) continue;
        if (!contiguous) {
          sequenceGapCount++;
          books.delete(symbol);
          emit({ kind: "book-reset", timestamp: depthTime, symbol }, i);
          validator.validateEvent(null, i);
          continue;
        }
        this.emitDepthUpdates(message.b, "bid", state.bids, depthTime, symbol, emit, i);
        this.emitDepthUpdates(message.a, "ask", state.asks, depthTime, symbol, emit, i);
        state.lastUpdateId = message.u;
        continue;
      }

    }

    events.sort(compareNormalizedEvents);
    const report = validator.buildReport(this.capabilities);
    report.sequenceGapCount = sequenceGapCount;
    return { events, report };
  }

  createFeed(raw: string | BinanceRawMessage[], options: BinanceIngestionOptions = {}): MarketDataFeed {
    const { events, report } = this.normalize(raw, options);
    return new RealMarketDataFeed(events, {
      source: `Binance ${options.market === "usdm" ? "USDⓈ-M Futures" : "Spot"}${options.symbol ? ` (${options.symbol.toUpperCase()})` : ""}`,
      capabilities: this.capabilities,
      validationReport: report,
      instrument: options.instrument,
    });
  }

  private tradeEvent(
    symbol: string,
    time: number,
    priceRaw: string,
    sizeRaw: string,
    buyerIsMaker: boolean,
    recordIndex: number,
  ): Omit<TradeEvent, "sequence"> {
    if (typeof time !== "number" || !Number.isFinite(time)) throw new Error(`Invalid Binance trade timestamp at record ${recordIndex}`);
    const price = Number(priceRaw);
    const size = Number(sizeRaw);
    if (!Number.isFinite(price) || !Number.isFinite(size)) throw new Error(`Invalid Binance trade price/quantity at record ${recordIndex}`);
    const aggressorSide: Aggressor = buyerIsMaker ? "SELL" : "BUY";
    return { kind: "trade", timestamp: time, symbol: symbol.toUpperCase(), price, size, aggressorSide };
  }

  private quoteEvent(message: BinanceBookTickerMessage, recordIndex: number): Omit<QuoteEvent, "sequence"> {
    const time = this.requireTime(message.T ?? message.E, recordIndex);
    return {
      kind: "quote",
      timestamp: time,
      symbol: message.s.toUpperCase(),
      bid: Number(message.b),
      bidSize: Number(message.B),
      ask: Number(message.a),
      askSize: Number(message.A),
    };
  }

  private emitSnapshotDeltas(
    state: BookState,
    timestamp: number,
    symbol: string,
    emit: (event: BinanceEventDraft, recordIndex: number) => void,
    recordIndex: number,
  ): void {
    for (const [price, size] of this.sortedLevels(state.bids, "bid")) emit({ kind: "depth-delta", timestamp, symbol, side: "bid", action: "add", price, size }, recordIndex);
    for (const [price, size] of this.sortedLevels(state.asks, "ask")) emit({ kind: "depth-delta", timestamp, symbol, side: "ask", action: "add", price, size }, recordIndex);
  }

  private emitDepthUpdates(
    levels: BinanceLevel[],
    side: BookSide,
    book: Map<number, number>,
    timestamp: number,
    symbol: string,
    emit: (event: BinanceEventDraft, recordIndex: number) => void,
    recordIndex: number,
  ): void {
    for (const [priceRaw, sizeRaw] of levels) {
      const price = Number(priceRaw);
      const size = Number(sizeRaw);
      if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size < 0) {
        throw new Error(`Invalid Binance depth level at record ${recordIndex}`);
      }
      const existed = book.has(price);
      const action = size === 0 ? "delete" : existed ? "modify" : "add";
      emit({ kind: "depth-delta", timestamp, symbol, side, action, price, size }, recordIndex);
      if (size === 0) book.delete(price);
      else book.set(price, size);
    }
  }

  private newBookState(lastUpdateId: number, bids: BinanceLevel[], asks: BinanceLevel[]): BookState {
    const state: BookState = { lastUpdateId, anchored: true, bids: new Map(), asks: new Map() };
    for (const [price, size] of bids) state.bids.set(Number(price), Number(size));
    for (const [price, size] of asks) state.asks.set(Number(price), Number(size));
    return state;
  }

  private sortedLevels(book: Map<number, number>, side: BookSide): Array<[number, number]> {
    return [...book.entries()].sort((a, b) => (side === "bid" ? b[0] - a[0] : a[0] - b[0]));
  }

  private symbolOf(message: BinanceRawMessage): string {
    if ("data" in message) return this.symbolOf(message.data);
    return message.s.toUpperCase();
  }

  private unwrap(message: BinanceRawMessage): BinanceWireMessage {
    return "data" in message ? this.unwrap(message.data) : message;
  }

  private isSnapshot(message: BinanceWireMessage): message is BinanceDepthSnapshotMessage {
    return "type" in message && message.type === "snapshot";
  }

  private isReset(message: BinanceWireMessage): message is BinanceResetMessage {
    return "type" in message && message.type === "reset";
  }

  private isAggTrade(message: BinanceWireMessage): message is BinanceAggTradeMessage {
    return "e" in message && message.e === "aggTrade";
  }

  private isTrade(message: BinanceWireMessage): message is BinanceTradeMessage {
    return "e" in message && message.e === "trade";
  }

  private isDepthUpdate(message: BinanceWireMessage): message is BinanceDepthUpdateMessage {
    return "e" in message && message.e === "depthUpdate";
  }

  private isBookTicker(message: BinanceWireMessage): message is BinanceBookTickerMessage {
    return "e" in message && message.e === "bookTicker";
  }

  private requireTime(value: number | undefined, recordIndex: number): number {
    if (value === undefined || !Number.isFinite(value) || value < 0) throw new Error(`Missing Binance timestamp at record ${recordIndex}`);
    return value;
  }

  private parseRawRecords(raw: string | BinanceRawMessage[]): BinanceRawMessage[] {
    if (Array.isArray(raw)) return raw;
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith("[") && text.endsWith("]")) return JSON.parse(text) as BinanceRawMessage[];
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as BinanceRawMessage);
  }
}
