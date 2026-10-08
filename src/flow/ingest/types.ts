/**
 * Phase 9-C — Vendor-Neutral Microstructure Ingestion Contracts
 *
 * Defines the vendor-neutral ingestion contracts, CME instrument metadata,
 * capability flags, and data quality validation report schemas.
 *
 * Design Invariants:
 * - Core engines never import vendor-specific types.
 * - Capabilities honestly report what microstructure fields are present.
 * - Unavailable fields remain explicitly undefined/UNKNOWN (no fabrication).
 * - Full CME instrument support (NQ, MNQ, ES, MES) with separate metadata.
 */

import type { NormalizedMarketEvent } from "../events";
import type { MarketDataFeed } from "../feed";

/** Microstructure capabilities supported by a dataset or vendor. */
export interface MicrostructureCapabilities {
  /** True Time & Sales executed trade prints. */
  hasTrades: boolean;
  /** Top-of-book best bid and ask quotes. */
  hasQuotes: boolean;
  /** Level-2 order book depth changes / snapshots. */
  hasDepth: boolean;
  /** Market-By-Order individual queue order events. */
  hasMBO: boolean;
  /** Venue-reported trade aggressor side (BUY vs SELL). */
  hasAggressor: boolean;
  /** Distinct resting order counts per book level. */
  hasOrderCounts: boolean;
  /** Nanosecond matching engine event timestamps. */
  hasNanosecondTimestamps: boolean;
  /** Packet receive / network capture timestamps. */
  hasReceiveTimestamp: boolean;
  /** Execution / match identifier linking split prints. */
  hasMatchIds: boolean;
}

/** Standard instrument specifications for futures contracts. */
export interface InstrumentDefinition {
  /** Contract symbol or root (e.g. "NQ", "ES", "MNQ", "MES"). */
  symbol: string;
  /** Descriptive name. */
  name: string;
  /** Primary trading exchange. */
  exchange: string;
  /** Minimum price fluctuation (e.g. 0.25). */
  tickSize: number;
  /** Value per full point in USD (e.g. $20 for NQ, $50 for ES). */
  pointValue: number;
  /** Value per tick = tickSize * pointValue. */
  tickValue: number;
  /** Currency code. */
  currency: string;
}

/** Pre-configured CME Globex equity futures specifications. */
export const CME_INSTRUMENTS: Record<string, InstrumentDefinition> = {
  NQ: {
    symbol: "NQ",
    name: "E-mini Nasdaq-100 Futures",
    exchange: "CME Globex",
    tickSize: 0.25,
    pointValue: 20,
    tickValue: 5.0,
    currency: "USD",
  },
  MNQ: {
    symbol: "MNQ",
    name: "Micro E-mini Nasdaq-100 Futures",
    exchange: "CME Globex",
    tickSize: 0.25,
    pointValue: 2,
    tickValue: 0.5,
    currency: "USD",
  },
  ES: {
    symbol: "ES",
    name: "E-mini S&P 500 Futures",
    exchange: "CME Globex",
    tickSize: 0.25,
    pointValue: 50,
    tickValue: 12.5,
    currency: "USD",
  },
  MES: {
    symbol: "MES",
    name: "Micro E-mini S&P 500 Futures",
    exchange: "CME Globex",
    tickSize: 0.25,
    pointValue: 5,
    tickValue: 1.25,
    currency: "USD",
  },
};

/** Diagnostic record for a rejected malformed record. */
export interface IngestionRejection {
  recordIndex: number;
  reason: string;
  raw?: unknown;
}

/** Validation and quality report produced when ingesting microstructure data. */
export interface IngestionValidationReport {
  /** Source name or adapter identification. */
  source: string;
  /** Target instrument symbol. */
  instrument: string;
  /** Total raw records examined in input. */
  recordCount: number;
  /** Total valid normalized events emitted. */
  normalizedEventCount: number;
  /** Total executed trades normalized. */
  tradeCount: number;
  /** Total depth events normalized (L2 snapshots or depth deltas). */
  depthCount: number;
  /** Total top-of-book quote events normalized. */
  quoteCount: number;
  /** Total book reset events normalized. */
  resetCount: number;
  /** Detected duplicate records ignored or filtered. */
  duplicateCount: number;
  /** Rejected malformed records with diagnostic details. */
  rejectedRecords: IngestionRejection[];
  /** Min and max timestamps found in the dataset. */
  timestampRange: {
    min: number;
    max: number;
    minNanos?: bigint;
    maxNanos?: bigint;
  };
  /** Min and max sequence numbers in the normalized output. */
  sequenceRange: {
    min: number;
    max: number;
  };
  /** Microstructure capabilities detected or declared for the dataset. */
  capabilities: MicrostructureCapabilities;
  /** True if validation passed within policy tolerance. */
  isValid: boolean;
}

/** Configuration options passed to an ingestion adapter. */
export interface IngestionOptions {
  /**
   * Strict mode: if true, any malformed record aborts ingestion immediately.
   * If false (default), malformed records are rejected and logged in the report.
   */
  strict?: boolean;
  /** Target instrument specification (defaults to NQ if unspecified). */
  instrument?: InstrumentDefinition;
  /** Maximum number of records or events to ingest. */
  maxEvents?: number;
  /** Optional session filtering. Filtering occurs above the raw normalization. */
  sessionFilter?: {
    timezone?: string;
    rthOnly?: boolean;
    startTime?: string;
    endTime?: string;
  };
}

/** Core vendor adapter abstraction. */
export interface MarketDataAdapter<TRaw = unknown> {
  /** Unique vendor adapter identifier (e.g. "databento", "generic-fixture"). */
  readonly name: string;
  /** Capabilities supported by this adapter format. */
  readonly capabilities: MicrostructureCapabilities;
  /** Normalize a raw batch, string, or record array into canonical events. */
  normalize(raw: TRaw, options?: IngestionOptions): {
    events: NormalizedMarketEvent[];
    report: IngestionValidationReport;
  };
  /** Create a replayable MarketDataFeed from the raw input. */
  createFeed(raw: TRaw, options?: IngestionOptions): MarketDataFeed;
}
