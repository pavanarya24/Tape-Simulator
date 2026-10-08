/**
 * Phase 9-C — RealMarketDataFeed
 *
 * Implements the standard MarketDataFeed interface for real, recorded,
 * or vendor-normalized market microstructure events.
 *
 * Features:
 * - isRealData: true (honest reporting of real data)
 * - Dense, position-addressable O(1) indexed lookup for seek(sequence)
 * - Exposes data quality validation report and capability flags
 * - Fully compatible with TrainingEngine, CheckpointManager, and FlowTrainingSession
 */

import type { MarketEvent, NormalizedMarketEvent } from "../events";
import type { MarketDataFeed } from "../feed";
import type { IngestionValidationReport, InstrumentDefinition, MicrostructureCapabilities } from "./types";

export interface RealMarketDataFeedOptions {
  source?: string;
  capabilities?: MicrostructureCapabilities;
  validationReport?: IngestionValidationReport;
  instrument?: InstrumentDefinition;
}

export class RealMarketDataFeed implements MarketDataFeed {
  readonly source: string;
  readonly isRealData = true;
  readonly capabilities?: MicrostructureCapabilities;
  readonly validationReport?: IngestionValidationReport;
  readonly instrument?: InstrumentDefinition;

  private readonly eventsArr: readonly NormalizedMarketEvent[];
  private cursor = 0;

  constructor(events: NormalizedMarketEvent[], opts: RealMarketDataFeedOptions = {}) {
    this.eventsArr = events;
    this.source = opts.source ?? "Real Market Data Feed";
    this.capabilities = opts.capabilities;
    this.validationReport = opts.validationReport;
    this.instrument = opts.instrument;
  }

  reset(): void {
    this.cursor = 0;
  }

  hasNext(): boolean {
    return this.cursor < this.eventsArr.length;
  }

  nextEvent(): MarketEvent | null {
    if (!this.hasNext()) return null;
    return this.eventsArr[this.cursor++];
  }

  currentTimestamp(): number | null {
    if (!this.hasNext()) return null;
    return this.eventsArr[this.cursor].timestamp;
  }

  seek(sequence: number): boolean {
    // Sequence numbers in dense normalized feeds:
    // When sequence matches 1-based index (or mapped via sequence index)
    if (this.eventsArr.length === 0) return false;

    // Check direct sequence match if sequences are 1-based dense
    const directIdx = sequence - 1;
    if (directIdx >= 0 && directIdx < this.eventsArr.length && this.eventsArr[directIdx].sequence === sequence) {
      this.cursor = directIdx;
      return true;
    }

    // Binary search for sequence if sequences are sparse or from exchange
    let low = 0;
    let high = this.eventsArr.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const seq = this.eventsArr[mid].sequence;
      if (seq === sequence) {
        this.cursor = mid;
        return true;
      }
      if (seq < sequence) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    // If target sequence is out of bounds or not found
    if (sequence < 1 || sequence > this.eventsArr.length + 1) return false;
    // Fall back to clamped index
    this.cursor = Math.max(0, Math.min(sequence - 1, this.eventsArr.length));
    return true;
  }

  position(): number {
    return this.cursor + 1;
  }

  totalEvents(): number {
    return this.eventsArr.length;
  }

  events(): readonly MarketEvent[] {
    return this.eventsArr;
  }
}
