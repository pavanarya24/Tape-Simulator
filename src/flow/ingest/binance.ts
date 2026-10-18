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

export interface BinanceRestAggTradeMessage {
  a: number;
  p: string;
  q: string;
  f?: number;
  l?: number;
  T: number;
  m: boolean;
  M?: boolean;
  s?: string;
}

export interface BinanceRestTradeMessage {
  id: number;
  price: string;
  qty: string;
  quoteQty?: string;
  time: number;
  isBuyerMaker: boolean;
  isBestMatch?: boolean;
  s?: string;
}

export type BinanceRawMessage =
  | BinanceAggTradeMessage
  | BinanceTradeMessage
  | BinanceDepthUpdateMessage
  | BinanceDepthSnapshotMessage
  | BinanceResetMessage
  | BinanceBookTickerMessage
  | BinanceRestAggTradeMessage
  | BinanceRestTradeMessage
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
    const fallbackSymbol = options.symbol?.toUpperCase() ?? "BTCUSDT";
    const records = this.parseRawRecords(raw, fallbackSymbol);
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
      const symbol = this.symbolOf(message, fallbackSymbol);
      if (symbolFilter && symbol !== symbolFilter) continue;

      if (this.isReset(message)) {
        books.delete(symbol);
        emit({ kind: "book-reset", timestamp: this.requireTime(message.E, i), symbol }, i);
        continue;
      }

      if (this.isSnapshot(message)) {
        const state = this.newBookState(message.lastUpdateId, message.bids, message.asks);
        books.set(symbol, state);
        let timestamp = this.requireTime(message.T ?? message.E, i);
        // Anchor snapshot timestamp to the first contiguous stream update if the capture's
        // REST wall-clock timestamp is later than buffered stream events that build on it.
        const contiguousTime = this.findFirstContiguousStreamTime(records, i + 1, message.lastUpdateId, symbolFilter);
        if (contiguousTime !== undefined && contiguousTime < timestamp) {
          timestamp = contiguousTime;
        }
        emit({ kind: "book-reset", timestamp, symbol }, i);
        this.emitSnapshotDeltas(state, timestamp, symbol, emit, i);
        continue;
      }

      if (this.isAggTrade(message) || this.isTrade(message)) {
        emit(this.tradeEvent(symbol, message.T, message.p, message.q, message.m, i), i);
        continue;
      }
      if (this.isRestAggTrade(message)) {
        emit(this.tradeEvent(symbol, message.T, message.p, message.q, message.m, i), i);
        continue;
      }
      if (this.isRestTrade(message)) {
        emit(this.tradeEvent(symbol, message.time, message.price, message.qty, message.isBuyerMaker, i), i);
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
        // Binance USDⓈ-M Futures diff-depth streams define continuity through `pu`.
        // Do not silently fall back to Spot's U/u overlap rule when a Futures frame
        // omits `pu`; accepting it could hide a missing update in the book sequence.
        const contiguous =
          options.market === "usdm"
            ? message.pu !== undefined && message.pu === state.lastUpdateId && message.u >= expected
            : message.U <= expected && message.u >= expected;
        if (message.u <= state.lastUpdateId) continue;
        if (!contiguous) {
          sequenceGapCount++;
          books.delete(symbol);
          emit({ kind: "book-reset", timestamp: depthTime, symbol }, i);
          validator.validateEvent(null, i);
          continue;
        }
        this.emitOrderedDepthUpdates(message.b, message.a, state, depthTime, symbol, emit, i);
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

  private emitOrderedDepthUpdates(
    bids: BinanceLevel[],
    asks: BinanceLevel[],
    state: BookState,
    timestamp: number,
    symbol: string,
    emit: (event: BinanceEventDraft, recordIndex: number) => void,
    recordIndex: number,
  ): void {
    const curBestBid = this.getBestPrice(state.bids, "bid");
    const curBestAsk = this.getBestPrice(state.asks, "ask");
    const maxNewBid = this.getMaxNonZeroPrice(bids);
    const minNewAsk = this.getMinNonZeroPrice(asks);

    const marketMovesUp = maxNewBid >= curBestAsk;
    const marketMovesDown = minNewAsk <= curBestBid;

    if (marketMovesUp && !marketMovesDown) {
      // Market stepped up: clear resting asks before placing higher bids to avoid false crossed book
      this.emitDepthUpdates(asks, "ask", state.asks, timestamp, symbol, emit, recordIndex);
      this.emitDepthUpdates(bids, "bid", state.bids, timestamp, symbol, emit, recordIndex);
    } else if (marketMovesDown && !marketMovesUp) {
      // Market stepped down: clear resting bids before placing lower asks to avoid false crossed book
      this.emitDepthUpdates(bids, "bid", state.bids, timestamp, symbol, emit, recordIndex);
      this.emitDepthUpdates(asks, "ask", state.asks, timestamp, symbol, emit, recordIndex);
    } else if (marketMovesUp && marketMovesDown) {
      // Both sides encroaching: clear deletions across both sides first, then additions
      const askDels = asks.filter(([, s]) => Number(s) === 0);
      const bidDels = bids.filter(([, s]) => Number(s) === 0);
      const askAdds = asks.filter(([, s]) => Number(s) > 0);
      const bidAdds = bids.filter(([, s]) => Number(s) > 0);
      this.emitDepthUpdates(askDels, "ask", state.asks, timestamp, symbol, emit, recordIndex);
      this.emitDepthUpdates(bidDels, "bid", state.bids, timestamp, symbol, emit, recordIndex);
      this.emitDepthUpdates(bidAdds, "bid", state.bids, timestamp, symbol, emit, recordIndex);
      this.emitDepthUpdates(askAdds, "ask", state.asks, timestamp, symbol, emit, recordIndex);
    } else {
      // Natural default order: bids then asks
      this.emitDepthUpdates(bids, "bid", state.bids, timestamp, symbol, emit, recordIndex);
      this.emitDepthUpdates(asks, "ask", state.asks, timestamp, symbol, emit, recordIndex);
    }
  }

  private getBestPrice(book: Map<number, number>, side: BookSide): number {
    if (book.size === 0) return side === "bid" ? -Infinity : Infinity;
    let best = side === "bid" ? -Infinity : Infinity;
    for (const [p, s] of book.entries()) {
      if (s > 0) {
        if (side === "bid" && p > best) best = p;
        else if (side === "ask" && p < best) best = p;
      }
    }
    return best;
  }

  private getMaxNonZeroPrice(levels: BinanceLevel[]): number {
    let max = -Infinity;
    for (const [p, s] of levels) {
      const price = Number(p);
      const size = Number(s);
      if (size > 0 && price > max) max = price;
    }
    return max;
  }

  private getMinNonZeroPrice(levels: BinanceLevel[]): number {
    let min = Infinity;
    for (const [p, s] of levels) {
      const price = Number(p);
      const size = Number(s);
      if (size > 0 && price < min) min = price;
    }
    return min;
  }

  private findFirstContiguousStreamTime(
    records: unknown[],
    startIndex: number,
    lastUpdateId: number,
    symbolFilter?: string,
  ): number | undefined {
    const expected = lastUpdateId + 1;
    for (let j = startIndex; j < records.length; j++) {
      const raw = records[j];
      const m = this.unwrap(raw as BinanceRawMessage);
      if (symbolFilter && this.symbolOf(m, symbolFilter) !== symbolFilter) continue;
      if (this.isDepthUpdate(m)) {
        const U = m.U;
        const u = m.u;
        if (U !== undefined && u !== undefined && U <= expected && u >= expected) {
          const t = m.T ?? m.E;
          if (typeof t === "number" && Number.isFinite(t)) return t;
        }
      }
    }
    return undefined;
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

  private symbolOf(message: BinanceRawMessage, fallbackSymbol = "BTCUSDT"): string {
    if ("data" in message) return this.symbolOf(message.data, fallbackSymbol);
    return ((message as any).s ?? fallbackSymbol).toUpperCase();
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

  private isRestAggTrade(message: BinanceWireMessage): message is BinanceRestAggTradeMessage {
    return "a" in message && "p" in message && "T" in message && "m" in message && !("e" in message);
  }

  private isRestTrade(message: BinanceWireMessage): message is BinanceRestTradeMessage {
    return "id" in message && "price" in message && "time" in message && "isBuyerMaker" in message && !("e" in message);
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

  private parseRawRecords(raw: string | BinanceRawMessage[], defaultSymbol = "BTCUSDT"): BinanceRawMessage[] {
    if (Array.isArray(raw)) return raw;
    const text = raw.trim();
    if (!text) return [];
    if (text.startsWith("[") && text.endsWith("]")) return JSON.parse(text) as BinanceRawMessage[];

    const lines = text.split(/\r?\n/).filter(Boolean);
    const records: BinanceRawMessage[] = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex].trim();
      if (!line) continue;

      if (line.startsWith("{")) {
        records.push(JSON.parse(line) as BinanceRawMessage);
        continue;
      }

      // CSV line parsing
      const cols = line.split(",");
      if (cols.length < 5) continue;

      // Skip header line if present (e.g. agg_trade_id, trade_id, or non-numeric first col)
      if (cols[0] === "agg_trade_id" || cols[0] === "trade_id" || isNaN(Number(cols[0]))) {
        continue;
      }

      // 1. Binance Vision aggTrades format:
      // agg_trade_id, price, quantity, first_trade_id, last_trade_id, transact_time, is_buyer_maker, [is_best_match]
      if (cols.length >= 7 && Number(cols[5]) > 1_000_000_000_000) {
        records.push({
          e: "aggTrade",
          E: Number(cols[5]),
          s: defaultSymbol,
          a: Number(cols[0]),
          p: cols[1].trim(),
          q: cols[2].trim(),
          T: Number(cols[5]),
          m: cols[6].trim().toLowerCase() === "true",
        });
        continue;
      }

      // 2. Binance Vision trades format:
      // trade_id, price, qty, quote_qty, time, is_buyer_maker, [is_best_match]
      if (cols.length >= 6 && Number(cols[4]) > 1_000_000_000_000) {
        records.push({
          e: "trade",
          E: Number(cols[4]),
          s: defaultSymbol,
          t: Number(cols[0]),
          p: cols[1].trim(),
          q: cols[2].trim(),
          T: Number(cols[4]),
          m: cols[5].trim().toLowerCase() === "true",
        });
        continue;
      }
    }

    return records;
  }
}
