/**
 * Phase 9-C — Data Quality Validation & Anomaly Detection
 *
 * Enforces rigorous market data quality verification:
 * - Checks structural and numerical limits (finite, positive size, valid prices)
 * - Detects sequence number regressions and duplicate records
 * - Detects timestamp regressions and out-of-order records
 * - Distinguishes between strict mode (throw) and tolerant mode (collect diagnostics)
 */

import type { NormalizedMarketEvent } from "../events";
import { validateNormalizedEvent, toEventNanos } from "../events";
import type { IngestionRejection, IngestionValidationReport, MicrostructureCapabilities } from "./types";

export interface ValidatorOptions {
  strict?: boolean;
  source?: string;
  instrument?: string;
}

export class MicrostructureValidator {
  private readonly strict: boolean;
  private readonly source: string;
  private readonly instrument: string;

  private recordCount = 0;
  private validCount = 0;
  private tradeCount = 0;
  private depthCount = 0;
  private quoteCount = 0;
  private resetCount = 0;
  private duplicateCount = 0;
  private rejected: IngestionRejection[] = [];

  private minTs = Number.POSITIVE_INFINITY;
  private maxTs = Number.NEGATIVE_INFINITY;
  private minNanos: bigint | undefined;
  private maxNanos: bigint | undefined;

  private minSeq = Number.POSITIVE_INFINITY;
  private maxSeq = Number.NEGATIVE_INFINITY;

  private lastNanos: bigint | null = null;
  private lastSeq: number | null = null;
  private seenSignatures = new Set<string>();

  private detectedCapabilities: MicrostructureCapabilities = {
    hasTrades: false,
    hasQuotes: false,
    hasDepth: false,
    hasMBO: false,
    hasAggressor: false,
    hasOrderCounts: false,
    hasNanosecondTimestamps: false,
    hasReceiveTimestamp: false,
    hasMatchIds: false,
  };

  constructor(opts: ValidatorOptions = {}) {
    this.strict = opts.strict ?? false;
    this.source = opts.source ?? "unknown";
    this.instrument = opts.instrument ?? "NQ";
  }

  /**
   * Validate a single candidate normalized event.
   * Returns true if the event is valid and accepted, false if rejected.
   */
  validateEvent(ev: unknown, recordIndex: number): boolean {
    this.recordCount++;

    // 1. Structural schema validation
    const structCheck = validateNormalizedEvent(ev);
    if (!structCheck.valid) {
      return this.reject(recordIndex, structCheck.error ?? "Invalid structure", ev);
    }

    const event = ev as NormalizedMarketEvent;

    // 2. Numerical bounds check
    if (event.kind === "trade") {
      if (event.price <= 0 || !Number.isFinite(event.price)) {
        return this.reject(recordIndex, `Invalid trade price: ${event.price}`, event);
      }
      if (event.size <= 0 || !Number.isFinite(event.size)) {
        return this.reject(recordIndex, `Invalid trade size: ${event.size}`, event);
      }
    } else if (event.kind === "depth-delta") {
      if (event.price <= 0 || !Number.isFinite(event.price)) {
        return this.reject(recordIndex, `Invalid depth price: ${event.price}`, event);
      }
      if (event.action !== "delete" && (event.size <= 0 || !Number.isFinite(event.size))) {
        return this.reject(recordIndex, `Invalid depth size: ${event.size}`, event);
      }
    } else if (event.kind === "quote") {
      if (event.bid <= 0 || event.ask <= 0 || event.bid >= event.ask) {
        return this.reject(recordIndex, `Invalid crossed or negative quote: ${event.bid} / ${event.ask}`, event);
      }
    }

    // 3. Duplicate check (fingerprint signature)
    const sig = `${event.kind}:${event.timestamp}:${event.sequence}:${event.symbol ?? ""}:${
      event.kind === "trade"
        ? `${event.price}:${event.size}:${event.aggressorSide}`
        : event.kind === "depth-delta"
        ? `${event.side}:${event.action}:${event.price}:${event.size}`
        : event.kind === "quote"
        ? `${event.bid}:${event.ask}`
        : ""
    }`;

    if (this.seenSignatures.has(sig)) {
      this.duplicateCount++;
      return this.reject(recordIndex, "Duplicate record detected", event);
    }
    this.seenSignatures.add(sig);

    // 4. Timestamp & Sequence regression checks
    const nanos = toEventNanos(event);
    if (this.lastNanos !== null && nanos < this.lastNanos) {
      return this.reject(
        recordIndex,
        `Timestamp regression: current ${nanos} is earlier than previous ${this.lastNanos}`,
        event,
      );
    }

    if (this.lastSeq !== null && event.sequence < this.lastSeq) {
      return this.reject(
        recordIndex,
        `Sequence regression: current ${event.sequence} is lower than previous ${this.lastSeq}`,
        event,
      );
    }

    // Update state tracking
    this.lastNanos = nanos;
    this.lastSeq = event.sequence;

    this.validCount++;
    this.minTs = Math.min(this.minTs, event.timestamp);
    this.maxTs = Math.max(this.maxTs, event.timestamp);

    if (this.minNanos === undefined || nanos < this.minNanos) this.minNanos = nanos;
    if (this.maxNanos === undefined || nanos > this.maxNanos) this.maxNanos = nanos;

    this.minSeq = Math.min(this.minSeq, event.sequence);
    this.maxSeq = Math.max(this.maxSeq, event.sequence);

    // Track capabilities and event kinds
    if (event.tsEventNanos !== undefined) this.detectedCapabilities.hasNanosecondTimestamps = true;
    if (event.tsRecvNanos !== undefined) this.detectedCapabilities.hasReceiveTimestamp = true;

    switch (event.kind) {
      case "trade":
        this.tradeCount++;
        this.detectedCapabilities.hasTrades = true;
        if (event.aggressorSide !== "UNKNOWN") this.detectedCapabilities.hasAggressor = true;
        if (event.matchId !== undefined) this.detectedCapabilities.hasMatchIds = true;
        break;
      case "depth-delta":
        this.depthCount++;
        this.detectedCapabilities.hasDepth = true;
        if (event.orderCount !== undefined) this.detectedCapabilities.hasOrderCounts = true;
        break;
      case "l2":
        this.depthCount++;
        this.detectedCapabilities.hasDepth = true;
        break;
      case "quote":
        this.quoteCount++;
        this.detectedCapabilities.hasQuotes = true;
        break;
      case "book-reset":
        this.resetCount++;
        break;
    }

    return true;
  }

  private reject(recordIndex: number, reason: string, raw: unknown): boolean {
    const rejection: IngestionRejection = { recordIndex, reason, raw };
    this.rejected.push(rejection);
    if (this.strict) {
      throw new Error(`[Strict Ingestion Error at record ${recordIndex}]: ${reason}`);
    }
    return false;
  }

  buildReport(explicitCapabilities?: Partial<MicrostructureCapabilities>): IngestionValidationReport {
    return {
      source: this.source,
      instrument: this.instrument,
      recordCount: this.recordCount,
      normalizedEventCount: this.validCount,
      tradeCount: this.tradeCount,
      depthCount: this.depthCount,
      quoteCount: this.quoteCount,
      resetCount: this.resetCount,
      duplicateCount: this.duplicateCount,
      rejectedRecords: [...this.rejected],
      timestampRange: {
        min: Number.isFinite(this.minTs) ? this.minTs : 0,
        max: Number.isFinite(this.maxTs) ? this.maxTs : 0,
        minNanos: this.minNanos,
        maxNanos: this.maxNanos,
      },
      sequenceRange: {
        min: Number.isFinite(this.minSeq) ? this.minSeq : 0,
        max: Number.isFinite(this.maxSeq) ? this.maxSeq : 0,
      },
      capabilities: {
        ...this.detectedCapabilities,
        ...(explicitCapabilities ?? {}),
      },
      isValid: this.validCount > 0 && (this.strict ? this.rejected.length === 0 : true),
    };
  }
}
