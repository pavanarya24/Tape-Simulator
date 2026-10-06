/**
 * Replaceable market data source contracts.
 *
 * The replay/trading UI talks to `MarketDataSource`, never to IndexedDB or CSV
 * directly. Swapping the data layer (a server, a different vendor, a tick feed)
 * means implementing these interfaces — the trading UI does not change.
 */

import type { RootSymbol } from "./types";
import type { DataCapabilities } from "./types";
import type { SessionBars, SessionMeta, SessionType } from "../data/types";

export interface MarketDataSource {
  readonly id: string;
  readonly label: string;
  readonly capabilities: DataCapabilities;
  /** Sessions available for an instrument, in chronological order. */
  listSessions(instrument: RootSymbol, type: SessionType): SessionMeta[];
  /** Load exactly one session's bars. Never the whole dataset. */
  loadSession(
    instrument: RootSymbol,
    type: SessionType,
    sessionId: string,
  ): Promise<SessionBars | null>;
}

export type Unsubscribe = () => void;

/**
 * Reserved for a future real-time / historical tick feed.
 *
 * Deliberately unimplemented: Tape Lab has no tick or Level-2 history, and will
 * not fabricate one. When a provider supplies `Trade`/`Quote`/`OrderBookSnapshot`
 * history, it implements this interface and the order-flow panels light up
 * without a redesign.
 */
export interface TickDataSource {
  readonly id: string;
  readonly capabilities: DataCapabilities;
  /** Historical ticks for a time range, oldest first. */
  ticks(range: { symbol: RootSymbol; from: number; to: number }): AsyncIterable<unknown>;
  /** Live subscription. */
  subscribe(symbol: RootSymbol, onTick: (tick: unknown) => void): Unsubscribe;
}

export function assertOrderFlowAvailable(caps: DataCapabilities): string | null {
  if (caps.orderFlow && caps.tick) return null;
  return "Not available: the loaded dataset is OHLCV only. Time & Sales, DOM depth, bid/ask volume and delta require historical tick / Level-2 data.";
}
