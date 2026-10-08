/**
 * Phase 9-C — Multi-Vendor Generic Microstructure Adapter
 *
 * Implements a secondary vendor-neutral microstructure adapter (representing
 * Rithmic, IQFeed, or generic proprietary JSON/CSV schema).
 *
 * Proves that multiple independent vendor adapters normalize directly into
 * canonical NormalizedMarketEvent records without requiring any modifications
 * to TrainingEngine, OrderFlowEngine, DOMEngine, or FlowTrainingSession.
 */

import type { NormalizedMarketEvent } from "../events";
import { compareNormalizedEvents } from "../events";
import type { MarketDataFeed } from "../feed";
import { RealMarketDataFeed } from "./feed";
import type { IngestionOptions, IngestionValidationReport, MarketDataAdapter, MicrostructureCapabilities } from "./types";
import { MicrostructureValidator } from "./validator";

export interface GenericMicrostructureRecord {
  time: number;
  type: "trade" | "depth" | "quote" | "reset";
  seq?: number;
  sym?: string;
  px?: number;
  sz?: number;
  side?: "buy" | "sell" | "bid" | "ask" | "unknown";
  act?: "add" | "modify" | "delete";
  cnt?: number;
  bid?: number;
  ask?: number;
  bidSz?: number;
  askSz?: number;
  nanos?: string | bigint;
}

export class GenericMicrostructureAdapter implements MarketDataAdapter<GenericMicrostructureRecord[]> {
  readonly name = "generic-fixture";

  readonly capabilities: MicrostructureCapabilities = {
    hasTrades: true,
    hasQuotes: true,
    hasDepth: true,
    hasMBO: false,
    hasAggressor: true,
    hasOrderCounts: true,
    hasNanosecondTimestamps: true,
    hasReceiveTimestamp: false,
    hasMatchIds: false,
  };

  normalize(
    raw: GenericMicrostructureRecord[],
    options: IngestionOptions = {},
  ): { events: NormalizedMarketEvent[]; report: IngestionValidationReport } {
    const validator = new MicrostructureValidator({
      strict: options.strict,
      source: "Generic Microstructure Fixture",
      instrument: options.instrument?.symbol ?? "ES",
    });

    const events: NormalizedMarketEvent[] = [];
    let autoSeq = 1;

    for (let i = 0; i < raw.length; i++) {
      if (options.maxEvents && events.length >= options.maxEvents) break;
      const rec = raw[i];
      const seq = rec.seq ?? autoSeq++;
      const sym = rec.sym ?? options.instrument?.symbol ?? "ES";
      const tsNanos = rec.nanos !== undefined ? (typeof rec.nanos === "bigint" ? rec.nanos : BigInt(rec.nanos)) : undefined;

      switch (rec.type) {
        case "trade": {
          const side = rec.side === "buy" ? "BUY" : rec.side === "sell" ? "SELL" : "UNKNOWN";
          const ev: NormalizedMarketEvent = {
            kind: "trade",
            timestamp: rec.time,
            sequence: seq,
            symbol: sym,
            price: rec.px ?? 0,
            size: rec.sz ?? 0,
            aggressorSide: side,
            tsEventNanos: tsNanos,
          };
          if (validator.validateEvent(ev, i)) events.push(ev);
          break;
        }
        case "depth": {
          const bSide = rec.side === "bid" ? "bid" : "ask";
          const act = rec.act ?? "add";
          const ev: NormalizedMarketEvent = {
            kind: "depth-delta",
            timestamp: rec.time,
            sequence: seq,
            symbol: sym,
            side: bSide,
            action: act,
            price: rec.px ?? 0,
            size: rec.sz ?? 0,
            orderCount: rec.cnt,
            tsEventNanos: tsNanos,
          };
          if (validator.validateEvent(ev, i)) events.push(ev);
          break;
        }
        case "quote": {
          const ev: NormalizedMarketEvent = {
            kind: "quote",
            timestamp: rec.time,
            sequence: seq,
            symbol: sym,
            bid: rec.bid ?? 0,
            bidSize: rec.bidSz ?? 0,
            ask: rec.ask ?? 0,
            askSize: rec.askSz ?? 0,
            tsEventNanos: tsNanos,
          };
          if (validator.validateEvent(ev, i)) events.push(ev);
          break;
        }
        case "reset": {
          const ev: NormalizedMarketEvent = {
            kind: "book-reset",
            timestamp: rec.time,
            sequence: seq,
            symbol: sym,
            tsEventNanos: tsNanos,
          };
          if (validator.validateEvent(ev, i)) events.push(ev);
          break;
        }
      }
    }

    events.sort(compareNormalizedEvents);
    const report = validator.buildReport(this.capabilities);
    return { events, report };
  }

  createFeed(raw: GenericMicrostructureRecord[], options: IngestionOptions = {}): MarketDataFeed {
    const { events, report } = this.normalize(raw, options);
    return new RealMarketDataFeed(events, {
      source: `Generic (${options.instrument?.symbol ?? "ES"})`,
      capabilities: this.capabilities,
      validationReport: report,
      instrument: options.instrument,
    });
  }
}
