/**
 * Execution simulator — the ONLY place fills are produced.
 *
 * ── OHLC FILL MODEL (documented limitation) ────────────────────────────────
 * The datasets are 5-minute OHLCV bars, not tick data. Every rule below is an
 * explicit *assumption*, not a reconstruction of what really happened:
 *
 *  • Market orders fill at the NEXT revealed candle's open (never the current
 *    one), plus `slippageTicks` in the adverse direction.
 *  • Limit orders fill only if the bar's range reaches the limit price, at the
 *    limit price (or the bar open if that is more favourable).
 *  • Stop orders trigger when the bar's range reaches the stop price, filled at
 *    the trigger plus slippage.
 *  • Protective exits are evaluated from the bar AFTER entry, never the entry
 *    bar itself.
 *  • If one bar contains BOTH the stop and the target, the intrabar path is
 *    unknowable. `ambiguityRule` decides: default "adverse-first" (the stop is
 *    assumed hit first, for both longs and shorts).
 *
 * This module knows nothing about React, the chart, or the replay engine's
 * timing — it only receives revealed bars.
 */

import type { Bar } from "../market/types";
import type { SessionType } from "../data/types";
import type { Order, OrderRequest, Fill } from "../orders/types";
import { evaluateRisk } from "../risk/rules";
import {
  EMPTY_NOTES,
  type ClosedTrade,
  type Direction,
  type ExecutionConfig,
  type PositionSnapshot,
  type PositionState,
  type RuleViolation,
  type ViolationKind,
} from "./types";

export interface ExecutionContext {
  instrument: ExecutionConfig["contract"]["root"];
  sessionId: string;
  sessionDate: string;
  sessionType: SessionType;
}

export class ExecutionSimulator {
  config: ExecutionConfig;
  ctx: ExecutionContext;

  orders: Order[] = [];
  fills: Fill[] = [];
  closedTrades: ClosedTrade[] = [];
  violations: RuleViolation[] = [];

  private position: PositionState | null = null;
  private mark = NaN;
  private realized = 0;
  private tradesOpened = 0;
  private lastLossTime: number | null = null;
  private seq = 0;
  private lastBar: Bar | null = null;

  constructor(config: ExecutionConfig, ctx: ExecutionContext) {
    this.config = config;
    this.ctx = ctx;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  /* ------------------------------ state ------------------------------ */

  getPosition(): PositionState | null {
    return this.position;
  }

  getWorkingOrders(): Order[] {
    return this.orders.filter((o) => o.status === "working");
  }

  getMark(): number {
    return this.mark;
  }

  getRealized(): number {
    return this.realized;
  }

  snapshot(): PositionSnapshot {
    const mark = Number.isFinite(this.mark) ? this.mark : 0;
    const p = this.position;
    if (!p || p.contracts === 0) {
      return {
        direction: "flat",
        contracts: 0,
        avgEntry: 0,
        mark,
        unrealized: 0,
        realized: this.realized,
      };
    }
    const dir: Direction = p.contracts > 0 ? "long" : "short";
    const qty = Math.abs(p.contracts);
    const unrealized = (mark - p.avgEntry) * (p.contracts > 0 ? 1 : -1) * this.config.contract.pointValue * qty;
    const risk = p.stop !== undefined
      ? Math.abs(p.avgEntry - p.stop) * this.config.contract.pointValue * qty
      : undefined;
    const reward = p.target !== undefined
      ? Math.abs(p.target - p.avgEntry) * this.config.contract.pointValue * qty
      : undefined;
    const openR = risk && risk > 0 ? unrealized / risk : undefined;
    return {
      direction: dir,
      contracts: qty,
      avgEntry: p.avgEntry,
      mark,
      unrealized,
      realized: this.realized,
      stop: p.stop,
      target: p.target,
      risk,
      reward,
      rMultiple: openR,
    };
  }

  /* ------------------------------ orders ------------------------------ */

  submit(req: OrderRequest, time: number, index: number): Order {
    const order: Order = {
      ...req,
      id: this.nextId("ord"),
      status: "working",
      createdAt: time,
      createdIndex: index,
      note: "Working — acts only on bars revealed after submission.",
    };
    this.checkSubmitViolations(order);
    this.orders.push(order);
    return order;
  }

  cancel(orderId: string): void {
    const o = this.orders.find((x) => x.id === orderId);
    if (o && o.status === "working") {
      o.status = "cancelled";
      o.note = "Cancelled by user.";
    }
  }

  /** Market order that flattens the current position (fills next bar open). */
  flatten(time: number, index: number): Order | null {
    if (!this.position || this.position.contracts === 0) return null;
    const qty = Math.abs(this.position.contracts);
    const side = this.position.contracts > 0 ? "sell" : "buy";
    return this.submit({ side, type: "market", qty, reduceOnly: true, tag: "flatten" }, time, index);
  }

  /** Flatten then open the opposite side with the same size. */
  reverse(time: number, index: number): Order | null {
    if (!this.position || this.position.contracts === 0) return null;
    const qty = Math.abs(this.position.contracts) * 2;
    const side = this.position.contracts > 0 ? "sell" : "buy";
    return this.submit({ side, type: "market", qty, tag: "reverse" }, time, index);
  }

  private checkSubmitViolations(order: Order): void {
    const cfg = this.config;
    const signed = order.side === "buy" ? order.qty : -order.qty;
    const pos = this.position;
    const isEntry = !order.reduceOnly && (!pos || pos.contracts === 0 || Math.sign(signed) === Math.sign(pos.contracts));
    const breaches = evaluateRisk(
      {
        openAfter: (pos?.contracts ?? 0) + signed,
        realized: this.realized,
        tradesOpened: this.tradesOpened,
        lastLossTime: this.lastLossTime,
        nowTime: order.createdAt,
        hasStopAfter: order.stopLoss !== undefined || pos?.stop !== undefined,
        isEntry,
      },
      cfg,
      cfg.contract,
    );
    for (const b of breaches) this.pushViolation(b.kind, order.createdAt, b.detail);
  }

  private pushViolation(kind: ViolationKind, time: number, detail: string): void {
    this.violations.push({ id: this.nextId("viol"), time, kind, detail });
  }

  /* ---------------------------- bar loop ---------------------------- */

  /**
   * Process one newly revealed bar. Order of operations is fixed and
   * deterministic: market fills → working trigger orders → protective exits.
   */
  onBar(bar: Bar, index: number): void {
    this.mark = bar.c;
    this.lastBar = bar;

    this.fillMarketOrders(bar, index);
    this.processWorkingOrders(bar, index);
    this.processProtectiveExits(bar, index);
  }

  /** Session finished: settle anything still open at the final close. */
  onSessionEnd(bar: Bar, index: number): void {
    for (const o of this.orders) {
      if (o.status !== "working") continue;
      if (o.type === "market") {
        // The order was submitted on this very bar, so its open precedes the
        // order's existence. Settle at the final close instead — the same price
        // used to settle an open position — never at a pre-submission price.
        this.fillOrder(o, bar.c, bar.t, index, "session-close", "Filled at session close (no further bars).");
      } else {
        o.status = "cancelled";
        o.note = "Cancelled at session close.";
      }
    }
    if (this.position && this.position.contracts !== 0) {
      this.closePosition(bar.c, bar.t, index, "session-close");
    }
  }

  private fillMarketOrders(bar: Bar, index: number): void {
    for (const o of this.orders) {
      if (o.status !== "working" || o.type !== "market") continue;
      if (o.createdIndex >= index) continue; // next revealed bar only
      const slip = this.config.slippageTicks * this.config.contract.tickSize;
      const price = o.side === "buy" ? bar.o + slip : bar.o - slip;
      this.fillOrder(o, price, bar.t, index, "market-next-open", "Market order filled at next candle open + slippage.");
    }
  }

  private processWorkingOrders(bar: Bar, index: number): void {
    for (const o of this.orders) {
      if (o.status !== "working" || o.type === "market") continue;
      if (o.createdIndex >= index) continue;

      if (o.type === "limit" && o.price !== undefined) {
        if (o.side === "buy" && bar.l <= o.price) {
          const price = bar.o <= o.price ? bar.o : o.price;
          this.fillOrder(o, price, bar.t, index, "limit-touch", "Limit buy reached; filled at limit (or better open).");
        } else if (o.side === "sell" && bar.h >= o.price) {
          const price = bar.o >= o.price ? bar.o : o.price;
          this.fillOrder(o, price, bar.t, index, "limit-touch", "Limit sell reached; filled at limit (or better open).");
        }
      } else if (o.type === "stop" && o.price !== undefined) {
        const slip = this.config.slippageTicks * this.config.contract.tickSize;
        if (o.side === "buy" && bar.h >= o.price) {
          const price = Math.max(o.price, bar.o) + slip;
          this.fillOrder(o, price, bar.t, index, "stop-trigger", "Stop buy triggered; filled at trigger + slippage.");
        } else if (o.side === "sell" && bar.l <= o.price) {
          const price = Math.min(o.price, bar.o) - slip;
          this.fillOrder(o, price, bar.t, index, "stop-trigger", "Stop sell triggered; filled at trigger + slippage.");
        }
      }
    }
  }

  private processProtectiveExits(bar: Bar, index: number): void {
    const p = this.position;
    if (!p || p.contracts === 0) return;
    if (p.openedIndex >= index) return; // never exit on the entry bar

    const isLong = p.contracts > 0;
    const stop = p.stop;
    const target = p.target;
    const hitStop = stop !== undefined && (isLong ? bar.l <= stop : bar.h >= stop);
    const hitTarget = target !== undefined && (isLong ? bar.h >= target : bar.l <= target);

    const slippage = this.config.slippageTicks * this.config.contract.tickSize;

    if (hitStop && hitTarget) {
      if (this.config.ambiguityRule === "skip") {
        // Ambiguous bar: take no action and wait for a definite bar.
        return;
      }
      if (this.config.ambiguityRule === "favorable-first") {
        this.closePosition(target as number, bar.t, index, "target");
        return;
      }
      const price = isLong ? (stop as number) - slippage : (stop as number) + slippage;
      this.closePosition(price, bar.t, index, "stop");
      return;
    }

    if (hitStop) {
      const price = isLong ? (stop as number) - slippage : (stop as number) + slippage;
      this.closePosition(price, bar.t, index, "stop");
      return;
    }
    if (hitTarget) {
      this.closePosition(target as number, bar.t, index, "target");
    }
  }

  /* ---------------------------- fill logic ---------------------------- */

  private fillOrder(
    order: Order,
    price: number,
    time: number,
    index: number,
    kind: Fill["kind"],
    note: string,
  ): void {
    order.status = "filled";
    order.filledAt = time;
    order.filledIndex = index;
    order.fillPrice = price;
    order.note = note;

    this.fills.push({
      id: this.nextId("fill"),
      orderId: order.id,
      side: order.side,
      qty: order.qty,
      price,
      time,
      index,
      kind,
      note,
    });

    const signed = order.side === "buy" ? order.qty : -order.qty;
    this.applyToPosition(signed, price, time, index, order.stopLoss, order.takeProfit, order.tag);
  }

  private applyToPosition(
    signedQty: number,
    price: number,
    time: number,
    index: number,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    tag: string | undefined,
  ): void {
    const p = this.position;

    if (!p || p.contracts === 0) {
      // This entry already went through submit-time risk evaluation.
      this.openPosition(signedQty, price, time, index, stopLoss, takeProfit, true);
      return;
    }

    const sameDirection = Math.sign(signedQty) === Math.sign(p.contracts);

    if (sameDirection) {
      const totalQty = p.contracts + signedQty;
      p.avgEntry = (p.avgEntry * p.contracts + price * signedQty) / totalQty;
      p.contracts = totalQty;
      if (stopLoss !== undefined) p.stop = stopLoss;
      if (takeProfit !== undefined) p.target = takeProfit;
      p.initialRiskDollars = this.computeRisk(p);
      return;
    }

    // Reducing, closing or flipping.
    const closingQty = Math.min(Math.abs(signedQty), Math.abs(p.contracts));
    const exitReason: ClosedTrade["exitReason"] =
      tag === "reverse" ? "reverse" : Math.abs(signedQty) > Math.abs(p.contracts) ? "reverse" : "manual";
    this.realize(p, closingQty, price, time, index, exitReason);

    const remaining = p.contracts + signedQty;
    if (remaining === 0) {
      this.position = null;
      return;
    }
    if (Math.sign(remaining) === Math.sign(p.contracts)) {
      p.contracts = remaining;
      p.initialRiskDollars = this.computeRisk(p);
      return;
    }
    // Flipped: the remainder opens a fresh position in the new direction.
    const leftoverQty = Math.abs(remaining);
    // A flip is not an "entry" at submit time, so risk was never evaluated for
    // the leftover position — let openPosition record it.
    this.openPosition(
      Math.sign(remaining) * leftoverQty,
      price,
      time,
      index,
      undefined,
      undefined,
      false,
    );
  }

  private openPosition(
    signedQty: number,
    price: number,
    time: number,
    index: number,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    /** True when submit-time risk evaluation already ruled on this entry. */
    riskCheckedAtSubmit: boolean,
  ): void {
    this.position = {
      contracts: signedQty,
      avgEntry: price,
      stop: stopLoss,
      target: takeProfit,
      openedAt: time,
      openedIndex: index,
    };
    this.position.initialRiskDollars = this.computeRisk(this.position);
    this.tradesOpened += 1;

    if (this.config.requireStop && this.position.stop === undefined && !riskCheckedAtSubmit) {
      this.pushViolation("no-stop", time, "Position opened without a protective stop.");
    }
  }

  private computeRisk(p: PositionState): number | undefined {
    if (p.stop === undefined) return undefined;
    return Math.abs(p.avgEntry - p.stop) * this.config.contract.pointValue * Math.abs(p.contracts);
  }

  /** Close `qty` contracts at `price`, booking a ClosedTrade and P&L. */
  private realize(
    p: PositionState,
    qty: number,
    price: number,
    time: number,
    index: number,
    reason: ClosedTrade["exitReason"],
  ): void {
    const isLong = p.contracts > 0;
    const points = isLong ? price - p.avgEntry : p.avgEntry - price;
    const gross = points * this.config.contract.pointValue * qty;
    const commission = this.config.commissionPerContractRoundTurn * qty;
    const net = gross - commission;
    this.realized += net;

    const riskPerContract = p.stop !== undefined
      ? Math.abs(p.avgEntry - p.stop) * this.config.contract.pointValue
      : undefined;
    const riskDollars = riskPerContract !== undefined ? riskPerContract * qty : undefined;

    const trade: ClosedTrade = {
      id: this.nextId("trade"),
      instrument: this.ctx.instrument,
      contract: this.config.contract.id,
      sessionId: this.ctx.sessionId,
      sessionDate: this.ctx.sessionDate,
      sessionType: this.ctx.sessionType,
      direction: isLong ? "long" : "short",
      contracts: qty,
      entryTime: p.openedAt,
      entryIndex: p.openedIndex,
      entryPrice: p.avgEntry,
      exitTime: time,
      exitIndex: index,
      exitPrice: price,
      stop: p.stop,
      target: p.target,
      grossPnl: gross,
      commission,
      netPnl: net,
      rMultiple: riskDollars && riskDollars > 0 ? net / riskDollars : undefined,
      holdingMs: Math.max(0, time - p.openedAt),
      exitReason: reason,
      notes: { ...EMPTY_NOTES },
    };
    this.closedTrades.push(trade);
    if (net < 0) this.lastLossTime = time;
  }

  private closePosition(
    price: number,
    time: number,
    index: number,
    reason: ClosedTrade["exitReason"],
  ): void {
    const p = this.position;
    if (!p) return;
    this.realize(p, Math.abs(p.contracts), price, time, index, reason);
    this.position = null;
  }

  /** Promise-compatible list of trades closed by the most recent bar. */
  recentTrades(n = 1): ClosedTrade[] {
    return this.closedTrades.slice(-n);
  }

  getLastBar(): Bar | null {
    return this.lastBar;
  }
}
