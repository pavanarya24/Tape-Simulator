/**
 * FlowExecutionEngine — simulated market-order execution for Flow Lab.
 *
 * Phase 7A extends the synthetic order-flow training with
 * READ → DECIDE → EXECUTE → MANAGE → SCORE. This module owns execution ONLY:
 *
 *  - MARKET BUY / MARKET SELL / FLATTEN against the CURRENTLY REVEALED book.
 *    The caller (FlowTrainingSession) passes the bid/ask from the same event
 *    clock that feeds Time & Sales, DOM, CVD and the profile — never OHLC
 *    candles, never future events.
 *  - Position accounting: side, quantity, average entry, mark, realized and
 *    unrealized P&L (dollar values via the instrument's point value).
 *  - MFE / MAE tracking while a position is open.
 *  - Configurable simulated transaction costs (commission + slippage ticks),
 *    shown separately as Gross / Costs / Net.
 *  - Basic training risk controls: max position size, max daily (session)
 *    loss, optional stop-loss and take-profit. No prop-firm rules by default.
 *
 * BLIND-MODE GUARANTEE: this engine never imports or receives ScenarioTruth.
 * Hidden-pattern bookkeeping lives in the journal/scoring layer above it.
 *
 * SIMULATED TRADING — SYNTHETIC MARKET DATA. No brokerage connectivity, no
 * external APIs; fills are book-price reproductions, not real executions.
 *
 * This engine is completely separate from the OHLC ExecutionSimulator —
 * nothing here changes terminal replay behaviour.
 */

import { PROFILE_CME_NQ, PROFILE_CME_ES } from "../market/registry";
import type { FeeModel, MarketProfile, MarketProfileUnits } from "../market/profile";
import type { ContractId, ContractSpec, RootSymbol } from "../market/types";
import type { FlowScenarioId } from "./scenarios";

/* ------------------------------ decision ------------------------------ */

export type FlowBias = "LONG" | "SHORT" | "NEUTRAL";

/** The trader's own pattern prediction — "unknown" means no prediction. */
export type FlowPrediction = FlowScenarioId | "unknown";

/**
 * Decision capture recorded by the TRADER (never generator data). Stored with
 * a trade so post-reveal scoring can compare prediction vs hidden pattern.
 */
export interface FlowDecision {
  bias: FlowBias;
  expected: FlowPrediction;
  /** Conviction 1–5 (trader's own; unrelated to generator confidence). */
  level: number;
  reason: string;
}

export const DEFAULT_FLOW_DECISION: FlowDecision = {
  bias: "NEUTRAL",
  expected: "unknown",
  level: 3,
  reason: "",
};

export const FLOW_BIASES: readonly FlowBias[] = ["LONG", "SHORT", "NEUTRAL"];

/* ------------------------------- costs -------------------------------- */

/** Simulated transaction costs. NOT real brokerage costs. */
export interface FlowCosts {
  /** Optional fee model override ("per_contract_fixed" | "basis_points_notional"). Defaults to profile.execution.defaultFeeModel. */
  feeModel?: FeeModel;
  /** Simulated commission in dollars/quote currency per contract/unit (used for per_contract_fixed). */
  commissionPerContract?: number;
  /** Simulated fee rate (e.g. 0.0005 for 5 bps; used for basis_points_notional). */
  feeRate?: number;
  /** Simulated slippage in ticks, charged adversely per fill. */
  slippageTicks: number;
}

/**
 * Conservative simulated defaults: $2.25/contract/side (= $4.50 round turn,
 * matching the OHLC simulator's default) plus 1 tick of slippage per fill.
 */
export const DEFAULT_FLOW_COSTS: FlowCosts = {
  commissionPerContract: 2.25,
  slippageTicks: 1,
};

/* -------------------------------- risk -------------------------------- */

export interface FlowRisk {
  /** Maximum units/contracts that may be held at once. */
  maxPositionQty: number;
  /** Block new entries once session net realized P&L <= -maxDailyLoss. Null = off. */
  maxDailyLoss: number | null;
  /** Optional stop, in ticks from average entry (null/<=0 = off). */
  stopLossTicks: number | null;
  /** Optional take-profit, in ticks from average entry (null/<=0 = off). */
  takeProfitTicks: number | null;
}

/** Defaults: qty 1 to trade, max 4, daily loss off, no bracket protection. */
export const DEFAULT_FLOW_RISK: FlowRisk = {
  maxPositionQty: 4,
  maxDailyLoss: null,
  stopLossTicks: null,
  takeProfitTicks: null,
};

/* ------------------------------ market state ------------------------------ */

/**
 * The revealed market state at the current event clock, supplied by the
 * training session. `null` bid/ask means no book has been revealed yet —
 * execution then fails safely instead of inventing a price.
 */
export interface FlowMarketState {
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  /** Epoch ms of the newest revealed event. */
  timestamp: number;
  /** Sequence number of the newest revealed event (the exact event used). */
  sequence: number;
}

/* ------------------------------- results ------------------------------- */

export interface FlowFill {
  action: "BUY" | "SELL";
  /** Exact book price used (BUY->ask, SELL->bid). Never invented. */
  price: number;
  quantity: number;
  timestamp: number;
  sequence: number;
  /** Simulated commission charged on this fill (quote currency). */
  commission: number;
  /** Simulated slippage charged on this fill (quote currency). */
  slippageCost: number;
}

export type FlowExitReason = "MANUAL" | "REVERSE" | "STOP" | "TARGET";

export interface FlowClosedTrade {
  tradeId: number;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  grossPnL: number;
  costs: number;
  netPnL: number;
  entryTimestamp: number;
  exitTimestamp: number;
  durationMs: number;
  /** Event sequence at entry / at exit (exact synthetic events used). */
  entrySequence: number;
  exitSequence: number;
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
  exitReason: FlowExitReason;
  /** Decision snapshot captured when the position was first opened. */
  entryDecision: FlowDecision;
  /** Currency the PnL and costs are settled in */
  currency?: string;
}

export type FlowExecResult =
  | {
      ok: true;
      reason: "FILLED";
      fills: FlowFill[];
      /** Trade closed by this action (flatten, reversal, stop or target). */
      closed: FlowClosedTrade | null;
      reversed: boolean;
    }
  | {
      ok: false;
      reason: "NO BOOK" | "MAX POSITION" | "DAILY LOSS LIMIT" | "ALREADY FLAT" | "INVALID QUANTITY";
      fills: [];
      closed: null;
      reversed: false;
    };

/* ------------------------------- position ------------------------------- */

export type FlowSide = "LONG" | "SHORT" | "FLAT";

/** Trader-facing position view (every field the spec requires). */
export interface FlowPosition {
  side: FlowSide;
  quantity: number;
  averageEntryPrice: number | null;
  currentPrice: number | null;
  realizedPnL: number;
  unrealizedPnL: number;
  totalPnL: number;
  entryTimestamp: number | null;
  exitTimestamp: number | null;
  /** Peak favourable / adverse excursion of the current (or last) trade, $+. */
  maxFavorableExcursion: number;
  maxAdverseExcursion: number;
  /** Simulated commission + slippage accrued so far (dollars). */
  costsAccrued: number;
}

interface OpenPosition {
  side: "LONG" | "SHORT";
  quantity: number;
  avgEntry: number;
  entryTimestamp: number;
  entrySequence: number;
  entryDecision: FlowDecision;
  /** Entry-fill costs (commission + slippage) accrued in quote currency. */
  entryCosts: number;
  mfe: number;
  mae: number;
}

function reject(reason: "NO BOOK" | "MAX POSITION" | "DAILY LOSS LIMIT" | "ALREADY FLAT" | "INVALID QUANTITY"): FlowExecResult {
  return { ok: false, reason, fills: [], closed: null, reversed: false };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundQuantity(qty: number, precision: number): number {
  if (precision === 0) return Math.round(qty);
  const factor = Math.pow(10, precision);
  return Math.round(qty * factor) / factor;
}

/**
 * Validates order quantity against MarketProfileUnits constraints:
 *  - Minimum quantity
 *  - Step increment alignment
 *  - Integer vs fractional precision constraints
 */
export function validateOrderQuantity(qty: number, units: MarketProfileUnits): boolean {
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) {
    return false;
  }

  if (units.quantityPrecision === 0) {
    if (!Number.isInteger(qty) || qty < units.minOrderQuantity || qty % units.quantityStep !== 0) {
      return false;
    }
    return true;
  }

  // Fractional quantities (e.g. Crypto)
  if (qty < units.minOrderQuantity - 1e-9) {
    return false;
  }

  const factor = Math.pow(10, units.quantityPrecision);
  const scaled = qty * factor;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-5) {
    return false;
  }

  const qtyUnits = Math.round(scaled);
  const stepUnits = Math.round(units.quantityStep * factor);

  if (qtyUnits <= 0 || stepUnits <= 0 || qtyUnits % stepUnits !== 0) {
    return false;
  }

  return true;
}

/**
 * Calculates gross PnL for a position or fill based on the MarketProfile's pnlModel.
 *
 * Models:
 *  - point_multiplier: (exit - entry) * direction * multiplier * contracts (in quote currency USD)
 *  - linear_crypto:    (exit - entry) * direction * multiplier * quantity (in quote currency USDT, multiplier = 1.0)
 *  - inverse_crypto:   (1/entry - 1/exit) * direction * quantity (in base currency BTC)
 */
export function calculateGrossPnL(
  side: "LONG" | "SHORT",
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  profile: Readonly<MarketProfile>,
): number {
  const dir = side === "LONG" ? 1 : -1;
  switch (profile.execution.pnlModel) {
    case "point_multiplier": {
      return (exitPrice - entryPrice) * dir * profile.execution.contractMultiplier * quantity;
    }
    case "linear_crypto": {
      return (exitPrice - entryPrice) * dir * profile.execution.contractMultiplier * quantity;
    }
    case "inverse_crypto": {
      if (entryPrice <= 0 || exitPrice <= 0) {
        throw new Error("Invalid price for inverse crypto PnL calculation");
      }
      return (1 / entryPrice - 1 / exitPrice) * dir * quantity;
    }
    default: {
      const _exhaustive: never = profile.execution.pnlModel;
      throw new Error(`Unsupported PnL model: ${_exhaustive}`);
    }
  }
}

/* ------------------------------ the engine ------------------------------ */

export interface FlowExecutionOptions {
  /** MarketProfile defining instrument truth, multiplier, tick grid, and PnL model */
  profile?: Readonly<MarketProfile>;
  /** Legacy ContractSpec for backward compatibility */
  contract?: ContractSpec;
  costs?: Partial<FlowCosts>;
  risk?: Partial<FlowRisk>;
}

export class FlowExecutionEngine {
  readonly profile: Readonly<MarketProfile>;
  private costs: FlowCosts;
  private risk: FlowRisk;

  private market: FlowMarketState | null = null;
  private position: OpenPosition | null = null;
  private realized = 0;
  private closed: FlowClosedTrade[] = [];
  private nextTradeId = 1;
  private lastMark: number | null = null;

  constructor(opts: FlowExecutionOptions = {}) {
    if (opts.profile) {
      this.profile = opts.profile;
    } else if (opts.contract) {
      if (opts.contract.root === "ES" || opts.contract.id === "ES") {
        this.profile = PROFILE_CME_ES;
      } else {
        this.profile = PROFILE_CME_NQ;
      }
    } else {
      this.profile = PROFILE_CME_NQ;
    }

    this.costs = { ...DEFAULT_FLOW_COSTS, ...opts.costs };
    this.risk = { ...DEFAULT_FLOW_RISK, ...opts.risk };
  }

  /** Backward-compatible ContractSpec getter */
  get contract(): ContractSpec {
    const sym = this.profile.identity.symbol;
    const isES = sym === "ES" || sym === "MES";
    const isMNQ = sym === "MNQ";
    const isMES = sym === "MES";
    const id: ContractId = isMES ? "MES" : isES ? "ES" : isMNQ ? "MNQ" : "NQ";
    const root: RootSymbol = isES ? "ES" : "NQ";
    return {
      id,
      root,
      label: this.profile.identity.label,
      pointValue: this.profile.execution.contractMultiplier,
      tickSize: this.profile.pricing.tickSize,
      tickValue: this.profile.execution.tickValue,
      currency: "USD",
    };
  }

  /* --------------------------- configuration --------------------------- */

  get costsConfig(): FlowCosts {
    return { ...this.costs };
  }

  setCosts(costs: FlowCosts): void {
    this.costs = { ...costs };
  }

  get riskConfig(): FlowRisk {
    return { ...this.risk };
  }

  setRisk(risk: FlowRisk): void {
    this.risk = { ...risk };
  }

  /* ------------------------------ observers ------------------------------ */

  get realizedNet(): number {
    return this.realized;
  }

  get dailyLossHit(): boolean {
    const max = this.risk.maxDailyLoss;
    if (max === null || max <= 0) return false;
    return this.realized <= -max;
  }

  closedTrades(): readonly FlowClosedTrade[] {
    return this.closed;
  }

  positionView(): FlowPosition {
    const p = this.position;
    const last = this.closed.length > 0 ? this.closed[this.closed.length - 1] : null;
    if (!p) {
      return {
        side: "FLAT",
        quantity: 0,
        averageEntryPrice: null,
        currentPrice: this.lastMark,
        realizedPnL: round2(this.realized),
        unrealizedPnL: 0,
        totalPnL: round2(this.realized),
        entryTimestamp: null,
        exitTimestamp: last ? last.exitTimestamp : null,
        maxFavorableExcursion: last ? last.maxFavorableExcursion : 0,
        maxAdverseExcursion: last ? last.maxAdverseExcursion : 0,
        costsAccrued: 0,
      };
    }
    const mark = this.lastMark ?? p.avgEntry;
    const grossUnrealized = calculateGrossPnL(p.side, p.avgEntry, mark, p.quantity, this.profile);
    const unrealized = round2(grossUnrealized - p.entryCosts);
    return {
      side: p.side,
      quantity: p.quantity,
      averageEntryPrice: p.avgEntry,
      currentPrice: this.lastMark,
      realizedPnL: round2(this.realized),
      unrealizedPnL: unrealized,
      totalPnL: round2(this.realized + unrealized),
      entryTimestamp: p.entryTimestamp,
      exitTimestamp: null,
      maxFavorableExcursion: round2(p.mfe),
      maxAdverseExcursion: round2(p.mae),
      costsAccrued: round2(p.entryCosts),
    };
  }

  /* ----------------------------- event clock ----------------------------- */

  /**
   * Advance the execution engine's mark to the current revealed market state.
   * Called by the training session after every event batch with the SAME
   * snapshot the tape/DOM/CVD render from — never with future data. Also
   * evaluates optional stop-loss / take-profit exits (on the executable side).
   * Returns the auto-exit result when a protective exit fired, else null.
   */
  onMarket(m: FlowMarketState): FlowExecResult | null {
    this.market = m;
    const mark = m.lastPrice ?? (m.bid !== null && m.ask !== null ? (m.bid + m.ask) / 2 : null) ?? this.lastMark;
    if (mark !== null) this.lastMark = mark;
    const p = this.position;
    if (!p) return null;
    if (mark !== null) this.updateExcursion(mark);
    return this.checkProtectiveExits(m);
  }

  private updateExcursion(mark: number): void {
    const p = this.position;
    if (!p) return;
    const gross = calculateGrossPnL(p.side, p.avgEntry, mark, p.quantity, this.profile);
    if (gross > p.mfe) p.mfe = round2(gross);
    if (-gross > p.mae) p.mae = round2(-gross);
  }

  /** Stop/target evaluated on the position's EXIT side (long->bid, short->ask). */
  private checkProtectiveExits(m: FlowMarketState): FlowExecResult | null {
    const p = this.position;
    if (!p) return null;
    const exitPrice = p.side === "LONG" ? m.bid : m.ask;
    if (exitPrice === null) return null;
    const stop = this.risk.stopLossTicks;
    const target = this.risk.takeProfitTicks;
    const tick = this.profile.pricing.tickSize;
    const long = p.side === "LONG";
    if (stop !== null && stop > 0) {
      const trigger = long ? p.avgEntry - stop * tick : p.avgEntry + stop * tick;
      const hit = long ? exitPrice <= trigger + 1e-9 : exitPrice >= trigger - 1e-9;
      if (hit) return this.close(exitPrice, m, "STOP");
    }
    if (target !== null && target > 0) {
      const trigger = long ? p.avgEntry + target * tick : p.avgEntry - target * tick;
      const hit = long ? exitPrice >= trigger - 1e-9 : exitPrice <= trigger + 1e-9;
      if (hit) return this.close(exitPrice, m, "TARGET");
    }
    return null;
  }

  /* ------------------------------- orders ------------------------------- */

  /** MARKET BUY: fills at the current ask. */
  buy(qty: number, decision: FlowDecision = DEFAULT_FLOW_DECISION): FlowExecResult {
    const guard = this.guardOrder(qty);
    if (guard) return guard;
    const m = this.market as FlowMarketState;
    if (this.position?.side === "SHORT") return this.reverse("LONG", qty, m, decision);
    if (this.position?.side === "LONG") return this.add("LONG", qty, m.ask as number, m, decision);
    return this.open("LONG", qty, m.ask as number, m, decision);
  }

  /** MARKET SELL: fills at the current bid (opens or reverses to SHORT). */
  sell(qty: number, decision: FlowDecision = DEFAULT_FLOW_DECISION): FlowExecResult {
    const guard = this.guardOrder(qty);
    if (guard) return guard;
    const m = this.market as FlowMarketState;
    if (this.position?.side === "LONG") return this.reverse("SHORT", qty, m, decision);
    if (this.position?.side === "SHORT") return this.add("SHORT", qty, m.bid as number, m, decision);
    return this.open("SHORT", qty, m.bid as number, m, decision);
  }

  /** FLATTEN: close the whole position — LONG exits at bid, SHORT at ask. */
  flatten(): FlowExecResult {
    const p = this.position;
    if (!p) return reject("ALREADY FLAT");
    const m = this.market;
    if (!m || m.bid === null || m.ask === null) return reject("NO BOOK");
    const exitPrice = p.side === "LONG" ? m.bid : m.ask;
    const result = this.close(exitPrice, m, "MANUAL");
    return result;
  }

  /** Reset the whole session: position, journal and marks. */
  reset(): void {
    this.market = null;
    this.position = null;
    this.realized = 0;
    this.closed = [];
    this.nextTradeId = 1;
    this.lastMark = null;
  }

  /* ----------------------------- internals ----------------------------- */

  private guardOrder(qty: number): FlowExecResult | null {
    if (!validateOrderQuantity(qty, this.profile.units)) {
      return reject("INVALID QUANTITY");
    }
    const m = this.market;
    if (!m || m.bid === null || m.ask === null) return reject("NO BOOK");
    // Once the session loss limit is hit every new entry / add / reversal is
    // blocked (flatten remains available). Closing is always allowed.
    if (this.dailyLossHit) return reject("DAILY LOSS LIMIT");
    return null;
  }

  private open(side: "LONG" | "SHORT", qty: number, price: number, m: FlowMarketState, decision: FlowDecision): FlowExecResult {
    if (qty > this.risk.maxPositionQty + 1e-9) return reject("MAX POSITION");
    const fill = this.makeFill(side === "LONG" ? "BUY" : "SELL", price, qty, m);
    this.position = {
      side,
      quantity: qty,
      avgEntry: price,
      entryTimestamp: m.timestamp,
      entrySequence: m.sequence,
      entryDecision: { ...decision },
      entryCosts: fill.commission + fill.slippageCost,
      mfe: 0,
      mae: 0,
    };
    return { ok: true, reason: "FILLED", fills: [fill], closed: null, reversed: false };
  }

  private add(side: "LONG" | "SHORT", qty: number, price: number, m: FlowMarketState, _decision: FlowDecision): FlowExecResult {
    const p = this.position;
    if (!p || p.side !== side) return this.open(side, qty, price, m, _decision);
    if (p.quantity + qty > this.risk.maxPositionQty + 1e-9) return reject("MAX POSITION");
    const fill = this.makeFill(side === "LONG" ? "BUY" : "SELL", price, qty, m);
    p.avgEntry = (p.avgEntry * p.quantity + price * qty) / (p.quantity + qty);
    p.quantity = roundQuantity(p.quantity + qty, this.profile.units.quantityPrecision);
    p.entryCosts += fill.commission + fill.slippageCost;
    // The read behind the FIRST entry stays attached to the eventual trade.
    return { ok: true, reason: "FILLED", fills: [fill], closed: null, reversed: false };
  }

  /** Opposite-side order: flatten the whole position, then open the other way. */
  private reverse(newSide: "LONG" | "SHORT", qty: number, m: FlowMarketState, decision: FlowDecision): FlowExecResult {
    if (qty > this.risk.maxPositionQty + 1e-9) return reject("MAX POSITION");
    const p = this.position;
    if (!p) return reject("ALREADY FLAT");
    const exitPrice = p.side === "LONG" ? (m.bid as number) : (m.ask as number);
    const closed = this.close(exitPrice, m, "REVERSE");
    const openResult = this.open(newSide, qty, newSide === "LONG" ? (m.ask as number) : (m.bid as number), m, decision);
    if (!openResult.ok) return openResult;
    return { ok: true, reason: "FILLED", fills: [...closed.fills, ...openResult.fills], closed: closed.closed, reversed: true };
  }

  private close(exitPrice: number, m: FlowMarketState, reason: FlowExitReason): FlowExecResult {
    const p = this.position;
    if (!p) return reject("ALREADY FLAT");
    // The exit mark counts toward MFE/MAE before the trade is snapshotted.
    this.updateExcursion(exitPrice);
    const fill = this.makeFill(p.side === "LONG" ? "SELL" : "BUY", exitPrice, p.quantity, m);
    const gross = round2(calculateGrossPnL(p.side, p.avgEntry, exitPrice, p.quantity, this.profile));
    const costs = round2(p.entryCosts + fill.commission + fill.slippageCost);
    const net = round2(gross - costs);
    const trade: FlowClosedTrade = {
      tradeId: this.nextTradeId++,
      side: p.side,
      quantity: p.quantity,
      entryPrice: p.avgEntry,
      exitPrice,
      grossPnL: gross,
      costs,
      netPnL: net,
      entryTimestamp: p.entryTimestamp,
      exitTimestamp: m.timestamp,
      durationMs: m.timestamp - p.entryTimestamp,
      entrySequence: p.entrySequence,
      exitSequence: m.sequence,
      maxFavorableExcursion: round2(p.mfe),
      maxAdverseExcursion: round2(p.mae),
      exitReason: reason,
      entryDecision: p.entryDecision,
      currency: this.profile.units.quoteCurrency,
    };
    this.closed.push(trade);
    this.realized = round2(this.realized + net);
    this.position = null;
    this.lastMark = exitPrice;
    return { ok: true, reason: "FILLED", fills: [fill], closed: trade, reversed: false };
  }

  private calculateFillCosts(
    _action: "BUY" | "SELL",
    price: number,
    qty: number,
  ): { commission: number; slippageCost: number } {
    const feeModel = this.costs.feeModel ?? this.profile.execution.defaultFeeModel ?? "per_contract_fixed";
    let commission = 0;

    if (feeModel === "basis_points_notional") {
      const rate = this.costs.feeRate ?? this.profile.execution.defaultFeeRate ?? 0.0005;
      const notional = price * qty;
      commission = round2(notional * rate);
    } else {
      // per_contract_fixed
      const rate = this.costs.commissionPerContract ?? this.profile.execution.defaultFeeRate ?? 2.25;
      commission = round2(rate * qty);
    }

    const slippageTicks = this.costs.slippageTicks ?? this.profile.execution.defaultSlippageTicks ?? 1;
    const tickVal = this.profile.execution.tickValue;
    const slippageCost = round2(slippageTicks * tickVal * qty);

    return { commission, slippageCost };
  }

  private makeFill(action: "BUY" | "SELL", price: number, qty: number, m: FlowMarketState): FlowFill {
    const { commission, slippageCost } = this.calculateFillCosts(action, price, qty);
    return {
      action,
      price,
      quantity: qty,
      timestamp: m.timestamp,
      sequence: m.sequence,
      commission,
      slippageCost,
    };
  }
}

