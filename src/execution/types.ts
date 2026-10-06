import type { ContractId, ContractSpec, RootSymbol } from "../market/types";
import type { SessionType } from "../data/types";

export type Direction = "long" | "short";

/**
 * What to assume when a single OHLC bar contains BOTH the protective stop and
 * the target. OHLC data cannot tell us the intrabar path, so this must be an
 * explicit, configurable assumption — never a guess presented as fact.
 */
export type AmbiguityRule = "adverse-first" | "favorable-first" | "skip";

export interface ExecutionConfig {
  contract: ContractSpec;
  ambiguityRule: AmbiguityRule;
  /** Extra ticks applied to market and stop-triggered fills. */
  slippageTicks: number;
  /** Dollars per contract charged when a position is closed (round turn). */
  commissionPerContractRoundTurn: number;
  requireStop: boolean;
  maxContracts: number;
  maxTradesPerSession: number;
  /** 0 disables the daily loss rule. */
  dailyLossLimit: number;
}

export interface JournalNotes {
  thesis: string;
  saw: string;
  whyEntered: string;
  whyExited: string;
  mistake: string;
  lesson: string;
}

export const EMPTY_NOTES: JournalNotes = {
  thesis: "",
  saw: "",
  whyEntered: "",
  whyExited: "",
  mistake: "",
  lesson: "",
};

export interface PositionState {
  /** Signed: positive = long, negative = short. */
  contracts: number;
  avgEntry: number;
  stop?: number;
  target?: number;
  openedAt: number;
  openedIndex: number;
  /** Dollars risked at entry (per contract × contracts), if a stop was set. */
  initialRiskDollars?: number;
}

export interface PositionSnapshot {
  direction: "flat" | "long" | "short";
  contracts: number;
  avgEntry: number;
  mark: number;
  unrealized: number;
  realized: number;
  stop?: number;
  target?: number;
  risk?: number;
  reward?: number;
  rMultiple?: number;
}

export interface ClosedTrade {
  id: string;
  instrument: RootSymbol;
  contract: ContractId;
  sessionId: string;
  sessionDate: string;
  sessionType: SessionType;
  direction: Direction;
  contracts: number;
  entryTime: number;
  entryIndex: number;
  entryPrice: number;
  exitTime: number;
  exitIndex: number;
  exitPrice: number;
  stop?: number;
  target?: number;
  grossPnl: number;
  commission: number;
  netPnl: number;
  rMultiple?: number;
  holdingMs: number;
  exitReason: "stop" | "target" | "manual" | "reverse" | "session-close";
  notes: JournalNotes;
}

export type ViolationKind = "no-stop" | "size" | "max-trades" | "daily-loss" | "revenge";

export interface RuleViolation {
  id: string;
  time: number;
  kind: ViolationKind;
  detail: string;
}

export const DEFAULT_EXECUTION_CONFIG: Omit<ExecutionConfig, "contract"> = {
  ambiguityRule: "adverse-first",
  slippageTicks: 1,
  commissionPerContractRoundTurn: 4.5,
  requireStop: false,
  maxContracts: 5,
  maxTradesPerSession: 10,
  dailyLossLimit: 500,
};
