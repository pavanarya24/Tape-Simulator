/**
 * Market data feed abstraction.
 *
 * The order-flow stack depends on THIS interface only. Today it is implemented
 * by SyntheticMarketDataFeed (deterministic training data); later, a real
 * adapter (DatabentoFeed, RithmicFeed, …) implements the same interface and the
 * engines, training layer and UI continue to work unchanged.
 *
 * The contract is pull-based and position-addressable so it fits Tape Lab's
 * replay architecture: the consumer walks forward with nextEvent(), can ask how
 * far along it is, and can jump back with seek() (downstream engines rebuild by
 * replaying from the start, exactly like the OHLC controller's rebuildTo).
 */

import type { MarketEvent } from "./events";

export interface MarketDataFeed {
  /** Stable, user-facing label. Synthetic data must identify itself. */
  readonly source: string;
  /** True only for real recorded/live market data — never for synthetic. */
  readonly isRealData: boolean;

  /** Rewind to the very beginning (before the first event). */
  reset(): void;

  /** True while at least one event remains unread. */
  hasNext(): boolean;

  /** Consume and return the next event, or null when exhausted. */
  nextEvent(): MarketEvent | null;

  /** Timestamp of the next unread event (null when exhausted). */
  currentTimestamp(): number | null;

  /**
   * Position the cursor so the next nextEvent() returns the event with the
   * given sequence number. Returns true if the position exists.
   */
  seek(sequence: number): boolean;

  /** Sequence number of the next unread event (1-based; totalEvents+1 at end). */
  position(): number;

  /** Total number of events in the stream. */
  totalEvents(): number;

  /** Read-only view of the underlying event array (for analysis/tests). */
  events(): readonly MarketEvent[];
}
