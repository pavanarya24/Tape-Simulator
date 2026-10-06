/**
 * Flow trade journal — records of completed Flow Lab trades.
 *
 * Every closed trade produces one FlowTradeRecord with the full spec fields
 * (id, scenario id, hidden pattern, trader prediction, direction, quantity,
 * entry, exit, gross/costs/net P&L, entry/exit time, duration, MFE, MAE).
 *
 * BLIND-MODE GUARANTEE: `hiddenPattern` is INTERNAL storage for post-reveal
 * scoring. Before reveal the controller only ever puts `tradeView(...)` with
 * `hiddenPattern: null` into trader-facing state, so JSON of the UI state can
 * never contain the answer. `scenarioId` is a neutral instance id (seed hex)
 * that deliberately does NOT encode the pattern.
 */

import type { FlowClosedTrade, FlowDecision } from "./execution";
import type { FlowScenarioId } from "./scenarios";

export interface FlowTradeRecord extends FlowClosedTrade {
  /** Neutral session instance id — never encodes the hidden pattern. */
  scenarioId: string;
  /** INTERNAL ONLY — hidden pattern, revealed to scoring after Reveal only. */
  hiddenPattern: FlowScenarioId | null;
}

/** Trader-facing view: identical fields, but the pattern is gated by reveal. */
export type FlowTradeView = FlowTradeRecord;

/** Strip (or expose) the hidden pattern depending on reveal state. */
export function tradeView(record: FlowTradeRecord, revealed: boolean): FlowTradeView {
  return { ...record, hiddenPattern: revealed ? record.hiddenPattern : null };
}

/** The decision fields the journal echoes back for convenience. */
export type { FlowDecision };
