/**
 * Phase 9-C — Databento Real Microstructure Adapter
 *
 * Implements normalization for Databento CME Globex futures market data
 * (CME MDP 3.0 / MBP-1 / MBP-10 / MBO / Trades schemas).
 *
 * Format Mapping:
 * - Trade records (action 'T'):
 *   - price (scaled integer or float) -> price
 *   - size -> size
 *   - ts_event (nanoseconds) -> tsEventNanos & timestamp (ms)
 *   - ts_recv (nanoseconds) -> tsRecvNanos
 *   - side 'A' (Ask/Buy aggressor) -> "BUY", 'B' (Bid/Sell aggressor) -> "SELL", 'N'/' ' -> "UNKNOWN"
 *   - sequence -> sequence
 *   - order_id / match_id -> matchId
 * - Depth updates (MBP/MBO action 'A', 'M', 'C'/'D', 'R'):
 *   - 'A' -> 'add'
 *   - 'M' -> 'modify'
 *   - 'C' / 'D' -> 'delete'
 *   - 'R' -> BookResetEvent
 *   - side 'A' -> 'ask', 'B' -> 'bid'
 *   - order_cnt -> orderCount
 * - BBO / Top-of-book quotes:
 *   - bid_px_00, ask_px_00, bid_sz_00, ask_sz_00 -> QuoteEvent
 *
 * Invariant: Never fabricates nanoseconds, aggressor sides, or depth.
 */

import type { Aggressor, BookResetEvent, BookSide, DepthAction, DepthDeltaEvent, NormalizedMarketEvent, QuoteEvent, TradeEvent } from "../events";
import { compareNormalizedEvents } from "../events";
import type { MarketDataFeed } from "../feed";
import { RealMarketDataFeed } from "./feed";
import type { IngestionOptions, IngestionValidationReport, MarketDataAdapter, MicrostructureCapabilities } from "./types";
import { MicrostructureValidator } from "./validator";

/** Databento record structure for JSON / JSONL representation. */
export interface DatabentoRawRecord {
  /** High-resolution matching engine event timestamp (nanoseconds UTC). */
  ts_event?: string | number | bigint;
  /** Packet receive / network capture timestamp (nanoseconds UTC). */
  ts_recv?: string | number | bigint;
  /** Record action flag: 'T'=Trade, 'A'=Add, 'M'=Modify, 'C'=Cancel, 'D'=Delete, 'R'=Reset. */
  action?: string;
  /** Side: 'A'=Ask/Sell, 'B'=Bid/Buy, 'N'/' '=None. */
  side?: string;
  /** Instrument price (floating point or integer with price_scale). */
  price?: number;
  /** Quantity / contract size. */
  size?: number;
  /** Number of resting orders at price level (MBP/MBO). */
  order_cnt?: number;
  /** Event sequence number from CME Globex. */
  sequence?: number;
  /** Order or match identifier. */
  order_id?: string | number;
  /** Contract or product symbol (e.g. "NQ", "NQM4", "ES"). */
  symbol?: string;
  /** Top-of-book fields for MBP-1 / BBO records. */
  bid_px_00?: number;
  ask_px_00?: number;
  bid_sz_00?: number;
  ask_sz_00?: number;
}

export class DatabentoAdapter implements MarketDataAdapter<string | DatabentoRawRecord[]> {
  readonly name = "databento";

  readonly capabilities: MicrostructureCapabilities = {
    hasTrades: true,
    hasQuotes: true,
    hasDepth: true,
    hasMBO: false,
    hasAggressor: true,
    hasOrderCounts: true,
    hasNanosecondTimestamps: true,
    hasReceiveTimestamp: true,
    hasMatchIds: true,
  };

  /**
   * Parse and normalize raw Databento data (JSON string, JSONL lines, or record objects).
   */
  normalize(
    raw: string | DatabentoRawRecord[],
    options: IngestionOptions = {},
  ): { events: NormalizedMarketEvent[]; report: IngestionValidationReport } {
    const records = this.parseRawRecords(raw);
    const validator = new MicrostructureValidator({
      strict: options.strict,
      source: "Databento CME",
      instrument: options.instrument?.symbol ?? "NQ",
    });

    const events: NormalizedMarketEvent[] = [];
    let autoSeq = 1;

    for (let i = 0; i < records.length; i++) {
      if (options.maxEvents && events.length >= options.maxEvents) break;
      const rec = records[i];

      // 1. Timestamps
      const rawNanos = rec.ts_event;
      if (rawNanos === undefined || rawNanos === null) {
        validator.validateEvent(null, i); // Log missing timestamp
        continue;
      }

      const tsNanos = typeof rawNanos === "bigint" ? rawNanos : BigInt(String(rawNanos).trim());
      const tsMs = Number(tsNanos / 1_000_000n);

      // Session filtering if configured
      if (options.sessionFilter?.rthOnly) {
        const date = new Date(tsMs);
        const hours = date.getUTCHours();
        const mins = date.getUTCMinutes();
        const timeVal = hours * 60 + mins;
        // RTH for CME equities: 13:30 - 20:00 UTC (09:30 - 16:00 ET)
        if (timeVal < 810 || timeVal > 1200) {
          continue;
        }
      }

      const seq = rec.sequence !== undefined && rec.sequence > 0 ? rec.sequence : autoSeq++;
      const symbol = rec.symbol ?? options.instrument?.symbol ?? "NQ";
      const recvNanos = rec.ts_recv !== undefined ? BigInt(String(rec.ts_recv).trim()) : undefined;

      // 2. Action classification
      const action = String(rec.action ?? "").toUpperCase();

      if (action === "R") {
        // Book Reset
        const resetEv: BookResetEvent = {
          kind: "book-reset",
          timestamp: tsMs,
          sequence: seq,
          symbol,
          tsEventNanos: tsNanos,
          tsRecvNanos: recvNanos,
        };
        if (validator.validateEvent(resetEv, i)) {
          events.push(resetEv);
        }
      } else if (action === "T" || (rec.price !== undefined && rec.size !== undefined && action === "")) {
        // Executed Trade
        const aggressor = this.mapAggressor(rec.side);
        const tradeEv: TradeEvent = {
          kind: "trade",
          timestamp: tsMs,
          sequence: seq,
          symbol,
          price: rec.price!,
          size: rec.size!,
          aggressorSide: aggressor,
          tsEventNanos: tsNanos,
          tsRecvNanos: recvNanos,
          matchId: rec.order_id !== undefined ? String(rec.order_id) : undefined,
        };
        if (validator.validateEvent(tradeEv, i)) {
          events.push(tradeEv);
        }
      } else if (action === "A" || action === "M" || action === "C" || action === "D") {
        // Depth Delta
        const side = this.mapSide(rec.side);
        const depthAction: DepthAction = action === "A" ? "add" : action === "M" ? "modify" : "delete";

        if (side && rec.price !== undefined && rec.size !== undefined) {
          const depthEv: DepthDeltaEvent = {
            kind: "depth-delta",
            timestamp: tsMs,
            sequence: seq,
            symbol,
            side,
            action: depthAction,
            price: rec.price,
            size: rec.size,
            orderCount: rec.order_cnt,
            tsEventNanos: tsNanos,
            tsRecvNanos: recvNanos,
          };
          if (validator.validateEvent(depthEv, i)) {
            events.push(depthEv);
          }
        }
      } else if (rec.bid_px_00 !== undefined && rec.ask_px_00 !== undefined) {
        // BBO / Quote
        const quoteEv: QuoteEvent = {
          kind: "quote",
          timestamp: tsMs,
          sequence: seq,
          symbol,
          bid: rec.bid_px_00,
          bidSize: rec.bid_sz_00 ?? 1,
          ask: rec.ask_px_00,
          askSize: rec.ask_sz_00 ?? 1,
          tsEventNanos: tsNanos,
          tsRecvNanos: recvNanos,
        };
        if (validator.validateEvent(quoteEv, i)) {
          events.push(quoteEv);
        }
      }
    }

    // Sort strictly by tsEventNanos -> sequence -> stable source order
    events.sort(compareNormalizedEvents);

    const report = validator.buildReport(this.capabilities);
    return { events, report };
  }

  /**
   * Create a replayable RealMarketDataFeed from raw Databento records.
   */
  createFeed(raw: string | DatabentoRawRecord[], options: IngestionOptions = {}): MarketDataFeed {
    const { events, report } = this.normalize(raw, options);
    return new RealMarketDataFeed(events, {
      source: `Databento (${options.instrument?.symbol ?? "NQ"})`,
      capabilities: this.capabilities,
      validationReport: report,
      instrument: options.instrument,
    });
  }

  private parseRawRecords(raw: string | DatabentoRawRecord[]): DatabentoRawRecord[] {
    if (Array.isArray(raw)) return raw;
    const str = raw.trim();
    if (!str) return [];

    if (str.startsWith("[") && str.endsWith("]")) {
      return JSON.parse(str) as DatabentoRawRecord[];
    }

    // Parse JSONL (one JSON object per line)
    const lines = str.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l) as DatabentoRawRecord);
  }

  private mapAggressor(side?: string): Aggressor {
    if (!side) return "UNKNOWN";
    const s = side.trim().toUpperCase();
    if (s === "A" || s === "BUY" || s === "B_AGG") return "BUY";
    if (s === "B" || s === "SELL" || s === "A_AGG") return "SELL";
    return "UNKNOWN";
  }

  private mapSide(side?: string): BookSide | null {
    if (!side) return null;
    const s = side.trim().toUpperCase();
    if (s === "B" || s === "BID") return "bid";
    if (s === "A" || s === "ASK") return "ask";
    return null;
  }
}
