/**
 * Risk rules — pure evaluation of the simulator's trading constraints.
 *
 * Nothing here touches the DOM or the replay engine: the ExecutionSimulator
 * hands in the current risk state and an order request, and gets back the rules
 * that the order would break. Keeping this separate makes the rule set
 * extensible (e.g. consecutive-loss lockouts, per-day loss limits) without
 * touching fill logic.
 */

import type { ContractSpec } from "../market/types";
import type { ViolationKind } from "../execution/types";

export interface RiskState {
  /** Signed open contracts after the order would fill. */
  openAfter: number;
  realized: number;
  tradesOpened: number;
  lastLossTime: number | null;
  /** Replay timestamp of the order being evaluated. */
  nowTime: number;
  hasStopAfter: boolean;
  isEntry: boolean;
}

export interface RiskLimits {
  maxContracts: number;
  maxTradesPerSession: number;
  dailyLossLimit: number;
  requireStop: boolean;
}

export interface RiskBreach {
  kind: ViolationKind;
  detail: string;
}

export const REVENGE_WINDOW_MS = 3 * 60 * 1000;

export function evaluateRisk(
  state: RiskState,
  limits: RiskLimits,
  spec: ContractSpec,
): RiskBreach[] {
  const breaches: RiskBreach[] = [];

  if (limits.requireStop && state.isEntry && !state.hasStopAfter) {
    breaches.push({ kind: "no-stop", detail: "Entry submitted without a protective stop." });
  }

  const absOpen = Math.abs(state.openAfter);
  if (absOpen > limits.maxContracts) {
    breaches.push({
      kind: "size",
      detail: `Order would hold ${absOpen} contracts (cap ${limits.maxContracts}).`,
    });
  }

  if (state.isEntry && state.tradesOpened >= limits.maxTradesPerSession) {
    breaches.push({
      kind: "max-trades",
      detail: `Session trade limit reached (${limits.maxTradesPerSession}).`,
    });
  }

  if (limits.dailyLossLimit > 0 && state.realized <= -limits.dailyLossLimit) {
    breaches.push({
      kind: "daily-loss",
      detail: `Daily loss limit hit (${Math.abs(state.realized).toFixed(0)} ≤ -${limits.dailyLossLimit}).`,
    });
  }

  // Revenge trading is only the *immediate* re-entry after a loss: an entry
  // that lands later in the same session is a normal trade, not a violation.
  if (state.isEntry && state.lastLossTime !== null) {
    const elapsed = state.nowTime - state.lastLossTime;
    if (elapsed >= 0 && elapsed <= REVENGE_WINDOW_MS) {
      breaches.push({
        kind: "revenge",
        detail: `Re-entry ${Math.round(elapsed / 1000)}s after a loss (window ${Math.round(
          REVENGE_WINDOW_MS / 60000,
        )}m).`,
      });
    }
  }

  void spec;
  return breaches;
}
