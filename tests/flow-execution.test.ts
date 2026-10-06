/**
 * Phase 7A — Flow Trading Simulator validation.
 *
 * Covers spec §16:
 *  - Execution: buy/sell from flat, flatten long/short, reverses, quantity,
 *    exact bid/ask fills, missing-book safety, no future-event usage.
 *  - P&L: profitable/losing long and short, commission, slippage,
 *    realized/unrealized, MFE, MAE.
 *  - Risk: maximum quantity, daily loss limit, stop loss, take profit.
 *  - Replay: execution at event N, P&L at N+1 onward, deterministic replay,
 *    reset clears position, restart produces identical results.
 *  - Blind mode: hidden truth never enters trader-facing state, journal keeps
 *    it internally, reveal exposes it only after reveal.
 *  - Scoring: correct/incorrect/no prediction, profit/loss/no trade,
 *    confidence tracking, direction, R multiple, entry timing, MFE capture.
 *
 * The OHLC terminal execution engine is intentionally untouched by all of it.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { CONTRACTS } from "../src/market/instruments";
import {
  DEFAULT_FLOW_COSTS,
  DEFAULT_FLOW_RISK,
  FlowExecutionEngine,
  type FlowCosts,
  type FlowDecision,
  type FlowMarketState,
  type FlowRisk,
} from "../src/flow/execution";
import { tradeView, type FlowTradeRecord } from "../src/flow/journal";
import { FlowTrainingSession } from "../src/flow/session";
import { generateScenario, scenarioName, type ScenarioTruth } from "../src/flow/scenarios";
import { scoreFlowSession, buildFlowNarrative, predictionName } from "../src/flow/scoring";
import { SyntheticMarketDataFeed } from "../src/flow/synthetic";

/* ------------------------------ helpers ------------------------------ */

const SEED = 424242;
const NQ = CONTRACTS.NQ;
const TS0 = 1_710_514_200_000;

/** commission $1/fill + slippage 1 tick ($5/fill on NQ) = $6/fill/contract. */
const TEST_COSTS: FlowCosts = { commissionPerContract: 1, slippageTicks: 1 };
const ZERO_COSTS: FlowCosts = { commissionPerContract: 0, slippageTicks: 0 };

function mkt(seq: number, bid: number | null, ask: number | null, last: number | null = null): FlowMarketState {
  return { bid, ask, lastPrice: last, timestamp: TS0 + seq * 420, sequence: seq };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function engine(costs: FlowCosts = TEST_COSTS, risk: FlowRisk = DEFAULT_FLOW_RISK): FlowExecutionEngine {
  return new FlowExecutionEngine({ costs, risk });
}

function mkSession(
  id: Parameters<typeof generateScenario>[0] = "spring",
  seed = SEED,
  costs: FlowCosts = TEST_COSTS,
  risk: FlowRisk = DEFAULT_FLOW_RISK,
): FlowTrainingSession {
  const { feed, truth } = generateScenario(id, seed);
  return new FlowTrainingSession(feed, truth, { sessionId: `flow-${seed}`, costs, risk, contract: NQ });
}

const DECISION: FlowDecision = { bias: "LONG", expected: "unknown", level: 3, reason: "" };

/** Complete a LONG round trip: buy at the ask, then flatten at the bid. */
function closedLong(entryAsk: number, exitBid: number, qty = 1, costs: FlowCosts = TEST_COSTS) {
  const e = engine(costs);
  e.onMarket(mkt(10, entryAsk - 0.25, entryAsk, entryAsk));
  const opened = e.buy(qty);
  e.onMarket(mkt(20, exitBid, exitBid + 0.25, exitBid));
  const closed = e.flatten();
  if (!opened.ok || !closed.ok || !closed.closed) throw new Error("helper trade failed");
  return { engine: e, opened, trade: closed.closed };
}

/* --------------------------- execution --------------------------- */

describe("FlowExecutionEngine — execution", () => {
  test("buy from flat opens LONG at the current ask", () => {
    const e = engine();
    expect(e.buy(1).ok).toBe(false); // no market revealed at all
    e.onMarket(mkt(10, 100, 100.25, 100));
    const r = e.buy(1);
    expect(r.ok).toBe(true);
    expect(r.reversed).toBe(false);
    if (!r.ok) return;
    expect(r.fills[0].action).toBe("BUY");
    expect(r.fills[0].price).toBe(100.25); // ask
    const pos = e.positionView();
    expect(pos.side).toBe("LONG");
    expect(pos.quantity).toBe(1);
    expect(pos.averageEntryPrice).toBe(100.25);
    expect(pos.entryTimestamp).toBe(TS0 + 10 * 420);
  });

  test("sell from flat opens SHORT at the current bid", () => {
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    const r = e.sell(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fills[0].action).toBe("SELL");
    expect(r.fills[0].price).toBe(100); // bid
    const pos = e.positionView();
    expect(pos.side).toBe("SHORT");
    expect(pos.averageEntryPrice).toBe(100);
  });

  test("flatten closes a LONG at the bid and journals the trade", () => {
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    e.buy(1);
    e.onMarket(mkt(11, 100.5, 100.75, 100.5));
    const r = e.flatten();
    expect(r.ok).toBe(true);
    if (!r.ok || !r.closed) return;
    expect(r.fills[0].price).toBe(100.5); // long exits at bid
    expect(r.fills[0].action).toBe("SELL");
    expect(e.positionView().side).toBe("FLAT");
    expect(r.closed.exitReason).toBe("MANUAL");
    expect(r.closed.exitSequence).toBe(11);
    expect(e.closedTrades().length).toBe(1);
    expect(e.flatten().ok).toBe(false); // already flat
  });

  test("flatten closes a SHORT at the ask", () => {
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    e.sell(1);
    e.onMarket(mkt(11, 99.5, 99.75, 99.6));
    const r = e.flatten();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fills[0].price).toBe(99.75); // short exits at ask
    expect(r.fills[0].action).toBe("BUY");
    expect(e.positionView().side).toBe("FLAT");
  });

  test("LONG → SHORT reverses: flatten first, then open the opposite side", () => {
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    e.buy(1);
    e.onMarket(mkt(11, 101, 101.25, 101));
    const r = e.sell(2);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.closed) return;
    expect(r.reversed).toBe(true);
    expect(r.closed.exitReason).toBe("REVERSE");
    expect(r.closed.exitPrice).toBe(101); // old long closed at bid
    const pos = e.positionView();
    expect(pos.side).toBe("SHORT");
    expect(pos.quantity).toBe(2);
    expect(pos.averageEntryPrice).toBe(101); // new short opened at bid
    expect(e.closedTrades().length).toBe(1); // no double-positioning
  });

  test("SHORT → LONG reverses through the ask", () => {
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    e.sell(1);
    e.onMarket(mkt(11, 99, 99.25, 99));
    const r = e.buy(1);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.closed) return;
    expect(r.reversed).toBe(true);
    expect(r.closed.exitPrice).toBe(99.25); // old short closed at ask
    const pos = e.positionView();
    expect(pos.side).toBe("LONG");
    expect(pos.averageEntryPrice).toBe(99.25);
    expect(e.closedTrades().length).toBe(1);
  });

  test("quantity handling: adds average up within the position, never a second slot", () => {
    const e = engine();
    e.onMarket(mkt(10, 99.75, 100, 100));
    e.buy(2);
    e.onMarket(mkt(11, 100.25, 100.5, 100.4));
    const r = e.buy(1);
    expect(r.ok).toBe(true);
    const pos = e.positionView();
    expect(pos.side).toBe("LONG");
    expect(pos.quantity).toBe(3); // single netted position
    expect(pos.averageEntryPrice).toBeCloseTo((2 * 100 + 100.5) / 3, 6);
    expect(e.closedTrades().length).toBe(0);
  });

  test("fills record the exact event sequence and timestamp used", () => {
    const e = engine();
    e.onMarket(mkt(77, 100, 100.25, 100));
    const r = e.buy(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fills[0].sequence).toBe(77);
    expect(r.fills[0].timestamp).toBe(TS0 + 77 * 420);
  });

  test("missing book fails safely — no price is ever invented", () => {
    const e = engine();
    // No market at all.
    expect(e.buy(1)).toMatchObject({ reason: "NO BOOK" });
    expect(e.sell(1)).toMatchObject({ reason: "NO BOOK" });
    // Book exists but one side is missing.
    e.onMarket(mkt(5, 100, null, 100));
    expect(e.buy(1)).toMatchObject({ reason: "NO BOOK" });
    expect(e.sell(1)).toMatchObject({ reason: "NO BOOK" });
    expect(e.positionView().side).toBe("FLAT");
    // Open position + book disappears → flatten refuses instead of guessing.
    e.onMarket(mkt(6, 100, 100.25, 100));
    e.buy(1);
    e.onMarket(mkt(7, null, null, 100.5));
    expect(e.flatten()).toMatchObject({ reason: "NO BOOK" });
    expect(e.positionView().side).toBe("LONG");
  });

  test("invalid quantity is rejected", () => {
    const e = engine();
    e.onMarket(mkt(1, 100, 100.25, 100));
    expect(e.buy(0)).toMatchObject({ reason: "INVALID QUANTITY" });
    expect(e.buy(1.5)).toMatchObject({ reason: "INVALID QUANTITY" });
    expect(e.positionView().side).toBe("FLAT");
  });
});

/* ------------------------------- P&L ------------------------------- */

describe("FlowExecutionEngine — P&L", () => {
  test("profitable long: gross, costs and net split correctly", () => {
    const { trade, engine: e } = closedLong(100, 102);
    expect(trade.grossPnL).toBe(40); // (102−100) × $20 × 1
    expect(trade.costs).toBe(12); // 2 fills × ($1 commission + 1 tick × $5)
    expect(trade.netPnL).toBe(28);
    expect(e.realizedNet).toBe(28);
    const pos = e.positionView();
    expect(pos.side).toBe("FLAT");
    expect(pos.realizedPnL).toBe(28);
    expect(pos.unrealizedPnL).toBe(0);
    expect(pos.totalPnL).toBe(28);
  });

  test("losing long produces a negative net", () => {
    const { trade } = closedLong(100, 98);
    expect(trade.grossPnL).toBe(-40);
    expect(trade.netPnL).toBe(-52);
  });

  test("profitable short: entry at bid, exit at ask", () => {
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    e.sell(1);
    e.onMarket(mkt(20, 98, 98.25, 98));
    const r = e.flatten();
    expect(r.ok).toBe(true);
    if (!r.ok || !r.closed) return;
    expect(r.closed.grossPnL).toBe(35); // (100−98.25) × $20
    expect(r.closed.costs).toBe(12);
    expect(r.closed.netPnL).toBe(23);
    expect(e.realizedNet).toBe(23);
  });

  test("losing short goes negative", () => {
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    e.sell(1);
    e.onMarket(mkt(20, 101.75, 102, 102)); // short exits at the ask
    const r = e.flatten();
    expect(r.ok).toBe(true);
    if (!r.ok || !r.closed) return;
    expect(r.closed.grossPnL).toBe(-40); // (100−102) × $20
    expect(r.closed.netPnL).toBe(-52); // −40 − $12 round-turn costs
  });

  test("commission is configurable and charged per fill", () => {
    const free = closedLong(100, 102, 1, ZERO_COSTS).trade;
    const paid = closedLong(100, 102, 1, { commissionPerContract: 2, slippageTicks: 0 }).trade;
    expect(free.costs).toBe(0);
    expect(paid.costs).toBe(4); // $2 × 2 fills × 1 contract
    expect(paid.netPnL).toBe(free.netPnL - 4);
    expect(paid.grossPnL).toBe(free.grossPnL); // gross untouched by costs
  });

  test("slippage ticks are configurable and charged per fill", () => {
    const clean = closedLong(100, 102, 1, { commissionPerContract: 0, slippageTicks: 0 }).trade;
    const slipped = closedLong(100, 102, 1, { commissionPerContract: 0, slippageTicks: 2 }).trade;
    expect(clean.costs).toBe(0);
    expect(slipped.costs).toBe(20); // 2 ticks × $5 × 2 fills
    expect(slipped.netPnL).toBe(clean.netPnL - 20);
    // Defaults are conservative and labelled simulated in the UI.
    expect(DEFAULT_FLOW_COSTS.slippageTicks).toBeGreaterThan(0);
    expect(DEFAULT_FLOW_COSTS.commissionPerContract).toBeGreaterThan(0);
  });

  test("realized vs unrealized: open marks move unrealized, closing realizes net", () => {
    const e = engine();
    e.onMarket(mkt(10, 99.75, 100, 100));
    e.buy(1);
    let pos = e.positionView();
    expect(pos.realizedPnL).toBe(0);
    expect(pos.unrealizedPnL).toBe(-6); // mark at entry: only entry costs accrued
    e.onMarket(mkt(11, 100.75, 101, 101));
    pos = e.positionView();
    expect(pos.currentPrice).toBe(101);
    expect(pos.unrealizedPnL).toBe(14); // (101−100)×$20 − $6 accrued
    expect(pos.totalPnL).toBe(14);
    e.onMarket(mkt(12, 102, 102.25, 102));
    e.flatten();
    pos = e.positionView();
    expect(pos.realizedPnL).toBe(28); // 40 gross − 12 round-turn costs
    expect(pos.unrealizedPnL).toBe(0);
    expect(pos.totalPnL).toBe(28);
  });

  test("MFE tracks the best favourable mark and MAE the worst adverse one (long)", () => {
    const e = engine();
    e.onMarket(mkt(10, 99.75, 100, 100));
    e.buy(1);
    e.onMarket(mkt(11, 104.75, 105, 105));
    let pos = e.positionView();
    expect(pos.maxFavorableExcursion).toBe(100); // (105−100) × $20
    e.onMarket(mkt(12, 96.75, 97, 97));
    pos = e.positionView();
    expect(pos.maxFavorableExcursion).toBe(100); // peak preserved
    expect(pos.maxAdverseExcursion).toBe(60); // (100−97) × $20
  });

  test("MFE/MAE invert for shorts", () => {
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    e.sell(1);
    e.onMarket(mkt(11, 94.75, 95, 95));
    expect(e.positionView().maxFavorableExcursion).toBe(100); // (100−95) × $20
    e.onMarket(mkt(12, 102.75, 103, 103));
    const pos = e.positionView();
    expect(pos.maxFavorableExcursion).toBe(100);
    expect(pos.maxAdverseExcursion).toBe(60); // (103−100) × $20
  });

  test("the trade record carries duration, MFE and MAE at close", () => {
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    e.buy(1);
    e.onMarket(mkt(11, 104.75, 105, 105));
    e.onMarket(mkt(12, 101, 101.25, 101));
    const r = e.flatten();
    expect(r.ok).toBe(true);
    if (!r.ok || !r.closed) return;
    expect(r.closed.durationMs).toBe((TS0 + 12 * 420) - (TS0 + 10 * 420));
    expect(r.closed.entrySequence).toBe(10);
    expect(r.closed.exitSequence).toBe(12);
    // Filled at the ask 100.25; peak mark was 105 → (105−100.25) × $20.
    expect(r.closed.maxFavorableExcursion).toBe(95);
    expect(r.closed.maxAdverseExcursion).toBe(0); // never traded below entry
  });
});

/* ------------------------------- risk ------------------------------- */

describe("FlowExecutionEngine — risk controls", () => {
  test("maximum position size blocks oversized orders and adds", () => {
    const e = engine(TEST_COSTS, { ...DEFAULT_FLOW_RISK, maxPositionQty: 2 });
    e.onMarket(mkt(10, 100, 100.25, 100));
    expect(e.buy(3)).toMatchObject({ reason: "MAX POSITION" });
    expect(e.buy(2).ok).toBe(true);
    expect(e.buy(1)).toMatchObject({ reason: "MAX POSITION" }); // would be 3 > 2
    expect(e.positionView().quantity).toBe(2);
    // Reversal open is also capped.
    e.onMarket(mkt(11, 101, 101.25, 101));
    expect(e.sell(3)).toMatchObject({ reason: "MAX POSITION" });
    expect(e.positionView().side).toBe("LONG");
  });

  test("default risk: quantity 1, max quantity 4", () => {
    expect(DEFAULT_FLOW_RISK.maxPositionQty).toBe(4);
    const e = engine();
    e.onMarket(mkt(10, 100, 100.25, 100));
    expect(e.buy(5)).toMatchObject({ reason: "MAX POSITION" });
    expect(e.buy(4).ok).toBe(true);
  });

  test("daily loss limit blocks new entries once breached", () => {
    const e = engine(ZERO_COSTS, { ...DEFAULT_FLOW_RISK, maxDailyLoss: 100 });
    e.onMarket(mkt(1, 99.75, 100, 100));
    e.buy(1);
    e.onMarket(mkt(2, 95, 95.25, 95)); // −$100
    e.flatten();
    expect(e.realizedNet).toBe(-100);
    expect(e.dailyLossHit).toBe(true);
    expect(e.buy(1)).toMatchObject({ reason: "DAILY LOSS LIMIT" });
    expect(e.sell(1)).toMatchObject({ reason: "DAILY LOSS LIMIT" });
    expect(e.positionView().side).toBe("FLAT");
  });

  test("daily loss limit off (null) never blocks", () => {
    const e = engine(ZERO_COSTS, { ...DEFAULT_FLOW_RISK, maxDailyLoss: null });
    e.onMarket(mkt(1, 99.75, 100, 100));
    e.buy(1);
    e.onMarket(mkt(2, 95, 95.25, 95));
    e.flatten();
    expect(e.realizedNet).toBe(-100);
    expect(e.dailyLossHit).toBe(false);
    expect(e.buy(1).ok).toBe(true);
  });

  test("optional stop-loss exits a long on the bid", () => {
    const e = engine(ZERO_COSTS, { ...DEFAULT_FLOW_RISK, stopLossTicks: 4 });
    e.onMarket(mkt(10, 99.75, 100, 100));
    e.buy(1);
    // No trigger yet: bid still above 100 − 1.00 = 99.
    expect(e.onMarket(mkt(11, 99.25, 99.5, 99.4))).toBeNull();
    expect(e.positionView().side).toBe("LONG");
    const auto = e.onMarket(mkt(12, 98.75, 99, 98.9));
    expect(auto).not.toBeNull();
    if (!auto || !auto.ok || !auto.closed) return;
    expect(auto.closed.exitReason).toBe("STOP");
    expect(auto.closed.exitPrice).toBe(98.75);
    expect(e.positionView().side).toBe("FLAT");
    expect(e.realizedNet).toBe(-25); // (98.75−100) × $20, zero costs
  });

  test("optional take-profit exits a long at the target", () => {
    const e = engine(ZERO_COSTS, { ...DEFAULT_FLOW_RISK, takeProfitTicks: 4 });
    e.onMarket(mkt(10, 99.75, 100, 100));
    e.buy(1);
    expect(e.onMarket(mkt(11, 100.5, 100.75, 100.6))).toBeNull();
    const auto = e.onMarket(mkt(12, 101, 101.25, 101.1));
    expect(auto).not.toBeNull();
    if (!auto || !auto.ok || !auto.closed) return;
    expect(auto.closed.exitReason).toBe("TARGET");
    expect(auto.closed.exitPrice).toBe(101);
    expect(e.realizedNet).toBe(20);
  });

  test("stop-loss works for shorts on the ask", () => {
    const e = engine(ZERO_COSTS, { ...DEFAULT_FLOW_RISK, stopLossTicks: 4 });
    e.onMarket(mkt(10, 100, 100.25, 100));
    e.sell(1);
    expect(e.onMarket(mkt(11, 100.5, 100.75, 100.6))).toBeNull();
    const auto = e.onMarket(mkt(12, 101, 101.25, 101.1));
    expect(auto).not.toBeNull();
    if (!auto || !auto.ok || !auto.closed) return;
    expect(auto.closed.exitReason).toBe("STOP");
    expect(auto.closed.exitPrice).toBe(101.25);
    expect(e.positionView().side).toBe("FLAT");
  });

  test("protective exits never fire without a book", () => {
    const e = engine(ZERO_COSTS, { ...DEFAULT_FLOW_RISK, stopLossTicks: 4 });
    e.onMarket(mkt(10, 99.75, 100, 100));
    e.buy(1);
    expect(e.onMarket(mkt(11, null, null, 95))).toBeNull();
    expect(e.positionView().side).toBe("LONG");
  });
});

/* ------------------------------- replay ------------------------------- */

describe("FlowTrainingSession — replay synchronisation", () => {
  test("execution at event N uses event N's state and consumes nothing", () => {
    const s = mkSession();
    s.warmup(60);
    s.step(40); // eventIndex 100
    const snap = s.snapshot();
    expect(snap.eventIndex).toBe(100);
    const r = s.buy();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Exact synthetic event used — never beyond the current clock.
    expect(r.fills[0].sequence).toBe(snap.sequence);
    expect(r.fills[0].sequence).toBeLessThanOrEqual(snap.sequence);
    expect(s.snapshot().eventIndex).toBe(100); // buy consumed no events
    expect(s.snapshot().position.entryTimestamp).toBe(snap.timestamp);
  });

  test("P&L updates as events N+1… arrive", () => {
    const s = mkSession();
    s.warmup(60);
    s.step(40);
    s.buy();
    const p0 = s.snapshot().position;
    expect(p0.side).toBe("LONG");
    s.step(10);
    const snap = s.snapshot();
    expect(snap.eventIndex).toBe(110);
    const p1 = snap.position;
    expect(p1.currentPrice).toBe(snap.orderFlow.lastPrice); // marked on the tape
    const expected = round2((p1.currentPrice! - p1.averageEntryPrice!) * NQ.pointValue * 1 - 6);
    expect(p1.unrealizedPnL).toBe(expected); // $6 = 1 commission + 1 tick slip entry
    expect(p1.entryTimestamp).toBe(p0.entryTimestamp); // entry clock frozen
  });

  test("deterministic replay: identical actions give identical snapshots", () => {
    const a = mkSession("spring", SEED);
    const b = mkSession("spring", SEED);
    for (const s of [a, b]) {
      s.warmup(60);
      s.step(30);
      s.buy();
      s.step(25);
      s.flatten();
      s.step(10);
    }
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
    expect(a.snapshot().trades.length).toBe(1);
  });

  test("reset clears the position, journal and clock", () => {
    const s = mkSession();
    s.warmup(60);
    s.step(40);
    s.buy();
    s.step(10);
    s.flatten();
    s.buy(); // leave one position open
    s.reset();
    const snap = s.snapshot();
    expect(snap.eventIndex).toBe(0);
    expect(snap.position.side).toBe("FLAT");
    expect(snap.position.realizedPnL).toBe(0);
    expect(snap.position.maxFavorableExcursion).toBe(0);
    expect(snap.trades).toEqual([]);
    expect(snap.notice).toBeNull();
  });

  test("restart replays the SAME seed — identical events, no regeneration", () => {
    const s = mkSession("upthrust", SEED);
    s.warmup(60);
    s.step(10);
    const before = JSON.stringify(s.snapshot().orderFlow.tape);
    s.buy();
    s.flatten();
    s.restart(60);
    const snap = s.snapshot();
    expect(snap.eventIndex).toBe(60); // back to warm-up
    expect(snap.trades).toEqual([]); // clean journal
    // Same seed ⇒ identical event sequence: replaying to the same index
    // reproduces byte-identical tape output.
    s.step(10);
    expect(s.snapshot().eventIndex).toBe(70);
    expect(JSON.stringify(s.snapshot().orderFlow.tape)).toBe(before);
  });

  test("replay-from-start rewinds but refuses while a position is open", () => {
    const s = mkSession();
    s.warmup(60);
    s.step(40);
    s.buy();
    expect(s.replayFromStart()).toBe(false);
    expect(s.snapshot().notice?.text).toContain("FLATTEN");
    expect(s.snapshot().eventIndex).toBe(100); // unchanged
    s.flatten();
    s.step(20);
    expect(s.replayFromStart()).toBe(true);
    expect(s.snapshot().eventIndex).toBe(0);
    expect(s.snapshot().trades.length).toBe(1); // journal kept
  });

  test("no future data: every snapshot field is bounded by the revealed clock", () => {
    const s = mkSession();
    s.warmup(60);
    const snap = s.snapshot();
    for (const t of snap.orderFlow.tape) expect(t.sequence).toBeLessThanOrEqual(snap.sequence);
    expect(snap.dom.sequence).toBeLessThanOrEqual(snap.sequence);
    const r = s.buy();
    if (r.ok) expect(r.fills[0].sequence).toBeLessThanOrEqual(snap.sequence);
    s.flatten();
  });
});

/* ----------------------------- blind mode ----------------------------- */

describe("blind mode — truth isolation", () => {
  test("journal stores the hidden pattern internally", () => {
    const s = mkSession("spring", 7);
    s.warmup(60);
    s.step(30);
    s.buy();
    s.step(20);
    s.flatten();
    const records = s.records();
    expect(records.length).toBe(1);
    expect(records[0].hiddenPattern).toBe("spring"); // INTERNAL storage
    expect(records[0].scenarioId).toBe("flow-7"); // neutral id, no pattern
    expect(records[0].entryDecision.expected).toBe("unknown");
  });

  test("trader-facing views strip the pattern until reveal", () => {
    const s = mkSession("upthrust", 7);
    s.warmup(60);
    s.step(30);
    s.buy();
    s.step(20);
    s.flatten();
    expect(s.snapshot().trades[0].hiddenPattern).toBeNull(); // pre-reveal
    expect(JSON.stringify(s.snapshot().trades)).not.toContain("upthrust");
    s.markRevealed();
    expect(s.snapshot().trades[0].hiddenPattern).toBe("upthrust"); // post-reveal
    // The raw view helper is the single gating point.
    const raw = s.records()[0];
    expect(tradeView(raw, false).hiddenPattern).toBeNull();
    expect(tradeView(raw, true).hiddenPattern).toBe("upthrust");
  });

  test("results are only computable after markRevealed()", () => {
    const s = mkSession("absorption", 7);
    s.warmup(60);
    s.step(30);
    expect(s.results()).toBeNull();
    s.markRevealed();
    const results = s.results();
    expect(results).not.toBeNull();
    expect(results!.pattern).toBe(scenarioName("absorption"));
  });

  test("the execution layer never receives ScenarioTruth", () => {
    // Structural check: a truth-less session still trades fine, and its
    // journal carries a null hidden pattern.
    const feed = new SyntheticMarketDataFeed({ seed: 3 });
    const s = new FlowTrainingSession(feed, null, { costs: ZERO_COSTS });
    s.warmup(60);
    s.step(30);
    s.buy();
    s.step(10);
    s.flatten();
    expect(s.records()[0].hiddenPattern).toBeNull();
    expect(s.results()).toBeNull(); // never revealable → never scored
    s.markRevealed();
    expect(s.results()).toBeNull();
  });
});

/* ------------------------------ scoring ------------------------------ */

const TRUTH: ScenarioTruth = generateScenario("spring", 99).truth;

const ORDER_FLOW_STATS = {
  cumulativeDelta: 120,
  delta: 60,
  buyAggressionPct: 62.5,
  sellAggressionPct: 37.5,
};

const DOM_STATS = {
  replenishCount: 6,
  pullBidCount: 9,
  pullAskCount: 4,
  sweepBuyCount: 1,
  sweepSellCount: 0,
};

function record(partial: Partial<FlowTradeRecord> = {}): FlowTradeRecord {
  return {
    tradeId: 1,
    side: "LONG",
    quantity: 1,
    entryPrice: 100,
    exitPrice: 102,
    grossPnL: 40,
    costs: 12,
    netPnL: 28,
    entryTimestamp: 0,
    exitTimestamp: 1_000,
    durationMs: 1_000,
    entrySequence: TRUTH.startEvent,
    exitSequence: TRUTH.endEvent,
    maxFavorableExcursion: 60,
    maxAdverseExcursion: 10,
    exitReason: "MANUAL",
    entryDecision: { bias: "LONG", expected: "unknown", level: 3, reason: "" },
    scenarioId: "flow-test",
    hiddenPattern: TRUTH.pattern,
    ...partial,
  };
}

function score(args: {
  records?: FlowTradeRecord[];
  decision?: Partial<FlowDecision>;
  risk?: Partial<FlowRisk>;
}) {
  return scoreFlowSession({
    truth: TRUTH,
    records: args.records ?? [record()],
    decision: { bias: "LONG", expected: "unknown", level: 3, reason: "", ...args.decision },
    risk: { ...DEFAULT_FLOW_RISK, ...args.risk },
    contract: NQ,
    orderFlow: ORDER_FLOW_STATS,
    dom: DOM_STATS,
  });
}

describe("post-reveal scoring", () => {
  test("correct pattern prediction", () => {
    const r = score({ decision: { expected: "spring" } });
    expect(r.patternResult).toBe("CORRECT");
    expect(r.predictionName).toBe("Spring");
    expect(r.patternId).toBe("spring");
  });

  test("incorrect pattern prediction", () => {
    const r = score({ decision: { expected: "upthrust" } });
    expect(r.patternResult).toBe("INCORRECT");
  });

  test("no prediction", () => {
    const r = score({ decision: { expected: "unknown" } });
    expect(r.patternResult).toBe("NO PREDICTION");
    expect(r.predictionName).toBe("Unknown");
  });

  test("profitable trading result with wins/losses", () => {
    const r = score({ records: [record({ netPnL: 28 }), record({ tradeId: 2, netPnL: -10 })] });
    expect(r.tradeResult).toBe("PROFIT");
    expect(r.trades).toBe(2);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(1);
    expect(r.netPnL).toBe(18);
    expect(r.bestTrade).toBe(28);
    expect(r.worstTrade).toBe(-10);
    expect(r.grossPnL).toBe(80); // 40 + 40 gross before costs
    expect(r.costs).toBe(24);
  });

  test("losing trading result", () => {
    const r = score({ records: [record({ netPnL: -52 })] });
    expect(r.tradeResult).toBe("LOSS");
    expect(r.wins).toBe(0);
    expect(r.losses).toBe(1);
  });

  test("no trade at all", () => {
    const r = score({ records: [] });
    expect(r.trades).toBe(0);
    expect(r.tradeResult).toBe("FLAT");
    expect(r.directionResult).toBe("NO TRADE");
    expect(r.entryTiming).toBe("NONE");
    expect(r.mfeCapturePct).toBeNull();
    expect(r.netPnL).toBe(0);
  });

  test("trade direction judged against the hidden truth", () => {
    // Spring truth is bullish.
    expect(score({ decision: { bias: "LONG" } }).directionResult).toBe("CORRECT");
    expect(score({ decision: { bias: "SHORT" } }).directionResult).toBe("INCORRECT");
    expect(score({ decision: { bias: "NEUTRAL" }, records: [record({ side: "LONG" })] }).directionResult).toBe("CORRECT");
    expect(score({ decision: { bias: "NEUTRAL" }, records: [record({ side: "SHORT" })] }).directionResult).toBe("INCORRECT");
  });

  test("confidence tracked and compared against the result", () => {
    const r = score({ decision: { expected: "spring", level: 4 } });
    expect(r.confidence).toBe(4);
    expect(r.confidenceVsResult).toContain("4/5");
    expect(r.confidenceVsResult).toContain("CORRECT");
    const wrong = score({ decision: { expected: "upthrust", level: 5 } });
    expect(wrong.confidence).toBe(5);
    expect(wrong.confidenceVsResult).toContain("INCORRECT");
  });

  test("R multiple only when a stop configured the risk", () => {
    // Stop 4 ticks = $20/contract of risk; two qty-1 trades → $40 at risk.
    const r = score({
      records: [record({ netPnL: 28 }), record({ tradeId: 2, netPnL: -12 })],
      risk: { stopLossTicks: 4 },
    });
    expect(r.rMultiple).toBe(0.4); // net 16 / risk 40
    const noStop = score({ records: [record({ netPnL: 28 })], risk: { stopLossTicks: null } });
    expect(noStop.rMultiple).toBeNull();
  });

  test("entry timing vs the hidden pattern window", () => {
    const early = score({ records: [record({ entrySequence: TRUTH.startEvent - 1 })] });
    expect(early.entryTiming).toBe("EARLY");
    const inside = score({ records: [record({ entrySequence: TRUTH.startEvent })] });
    expect(inside.entryTiming).toBe("INSIDE");
    const late = score({ records: [record({ entrySequence: TRUTH.endEvent + 1 })] });
    expect(late.entryTiming).toBe("LATE");
  });

  test("MFE capture % = net ÷ MFE over capturable trades", () => {
    const r = score({ records: [record({ netPnL: 30, maxFavorableExcursion: 60 })] });
    expect(r.mfeCapturePct).toBe(50);
    const noMfe = score({ records: [record({ netPnL: 5, maxFavorableExcursion: 0 })] });
    expect(noMfe.mfeCapturePct).toBeNull();
  });

  test("MAE and MFE aggregates are the extremes across trades", () => {
    const r = score({
      records: [
        record({ maxFavorableExcursion: 40, maxAdverseExcursion: 15 }),
        record({ tradeId: 2, maxFavorableExcursion: 60, maxAdverseExcursion: 30 }),
      ],
    });
    expect(r.mfe).toBe(60);
    expect(r.mae).toBe(30);
  });

  test("narrative explains the scenario from measurable flow characteristics", () => {
    const r = score({ decision: { expected: "spring" } });
    expect(r.narrative.length).toBeGreaterThan(3);
    expect(r.narrative.join(" ")).toContain("Cumulative delta");
    expect(r.narrative.join(" ")).toContain("replenished 6×");
    expect(r.narrative.join(" ")).toContain("spring-style sequence");
    // Also available standalone for prose construction.
    const lines = buildFlowNarrative(TRUTH, ORDER_FLOW_STATS, DOM_STATS);
    expect(lines[lines.length - 1]).toContain("spring-style sequence");
    expect(predictionName("absorption")).toBe("Absorption");
  });
});

/* ------------------- controller: blind + replay wiring ------------------- */

describe("flow trading controller", () => {
  let controller: import("../src/state/app").TapeLabController;

  beforeAll(async () => {
    // Same browser-global stubs as controller.test.ts (idempotent if loaded).
    (globalThis as Record<string, unknown>).indexedDB = {
      open() {
        throw new Error("IndexedDB unavailable (simulated)");
      },
    };
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
    const mod = await import("../src/state/app");
    controller = mod.controller;
    await controller.initialize(); // idempotent — cached promise if already run
  });

  const BANNED = [
    "spring",
    "upthrust",
    "absorption",
    "initiative",
    "responsive",
    "confidence",
    "characteristics",
    "startEvent",
    "endEvent",
    "truth",
  ];

  test("trading never leaks the hidden truth into trader-facing state", () => {
    controller.generateFlowScenario("any");
    controller.stepFlow(30);
    controller.setFlowDecision({ bias: "LONG", level: 4, reason: "buyers keep lifting" });
    controller.flowBuy();
    controller.stepFlow(20);
    controller.flowFlatten();
    const flow = controller.getState().flow;
    expect(flow.active).toBe(true);
    expect(flow.trades.length).toBe(1);
    expect(flow.trades[0].hiddenPattern).toBeNull();
    expect(flow.results).toBeNull();
    expect(flow.revealed).toBeNull();
    // Scenario id is a neutral counter — no seed/pattern computable from it.
    expect(flow.trades[0].scenarioId).toMatch(/^flow-\d+$/);
    const json = JSON.stringify(flow).toLowerCase();
    for (const word of BANNED) expect(json).not.toContain(word);
    expect(json).not.toContain("\"pattern\"");
  });

  test("reveal exposes results, pattern and narrative only after reveal", () => {
    controller.generateFlowScenario("absorption");
    controller.stepFlow(30);
    controller.flowBuy();
    controller.stepFlow(25);
    controller.flowFlatten();
    expect(controller.getState().flow.results).toBeNull();
    controller.revealFlow();
    const flow = controller.getState().flow;
    expect(flow.revealed).not.toBeNull();
    expect(flow.held).toBe(true);
    expect(flow.results).not.toBeNull();
    expect(flow.results!.pattern).toBe(scenarioName("absorption"));
    expect(flow.results!.trades).toBe(1);
    expect(flow.results!.narrative.length).toBeGreaterThan(3);
    expect(flow.trades[0].hiddenPattern).toBe("absorption"); // gated open post-reveal
  });

  test("post-reveal hold pauses stepping until Continue After Reveal", () => {
    controller.generateFlowScenario("spring");
    const idx = controller.getState().flow.eventIndex;
    controller.revealFlow();
    expect(controller.stepFlow(10)).toBe(false);
    expect(controller.getState().flow.eventIndex).toBe(idx);
    expect(controller.stepFlowBack === undefined).toBe(false); // API still wired
    expect(controller.continueFlowAfterReveal()).toBe(true);
    expect(controller.getState().flow.held).toBe(false);
    expect(controller.stepFlow(10)).toBe(true);
    expect(controller.getState().flow.eventIndex).toBe(idx + 10);
  });

  test("reset clears the position and journal but keeps the reveal", () => {
    controller.generateFlowScenario("initiative-break");
    controller.stepFlow(40);
    controller.flowBuy();
    expect(controller.getState().flow.position.side).toBe("LONG");
    controller.resetFlow();
    const flow = controller.getState().flow;
    expect(flow.eventIndex).toBe(0);
    expect(flow.position.side).toBe("FLAT");
    expect(flow.position.realizedPnL).toBe(0);
    expect(flow.position.maxFavorableExcursion).toBe(0);
    expect(flow.trades).toEqual([]);
    expect(flow.notice).toBeNull();
  });

  test("restart replays the same scenario without regenerating it", () => {
    controller.generateFlowScenario("responsive-fade");
    controller.stepFlow(10);
    const tape = JSON.stringify(controller.getState().flow.orderFlow!.tape);
    controller.flowBuy();
    controller.flowFlatten();
    controller.restartFlowScenario();
    const flow = controller.getState().flow;
    expect(flow.eventIndex).toBe(60); // warm-up, same seed
    expect(flow.trades).toEqual([]); // clean journal
    controller.stepFlow(10);
    expect(JSON.stringify(controller.getState().flow.orderFlow!.tape)).toBe(tape); // identical events
  });

  test("decision, quantity, costs and risk round-trip through the controller", () => {
    const before = controller.getState().flow;
    controller.generateFlowScenario("spring");
    controller.setFlowDecision({ bias: "SHORT", expected: "upthrust", level: 5, reason: "buying climax" });
    controller.setFlowQty(3);
    controller.setFlowRisk({ stopLossTicks: 6, maxDailyLoss: 500 });
    controller.setFlowCosts({ commissionPerContract: 0, slippageTicks: 0 });
    let flow = controller.getState().flow;
    expect(flow.decision.bias).toBe("SHORT");
    expect(flow.decision.expected).toBe("upthrust");
    expect(flow.decision.level).toBe(5);
    expect(flow.decision.reason).toBe("buying climax");
    expect(flow.orderQty).toBe(3);
    expect(flow.risk.stopLossTicks).toBe(6);
    expect(flow.risk.maxDailyLoss).toBe(500);
    expect(flow.costs.commissionPerContract).toBe(0);
    // New scenarios reset the decision but keep the risk/cost configuration.
    controller.generateFlowScenario("spring");
    flow = controller.getState().flow;
    expect(flow.decision.expected).toBe("unknown");
    expect(flow.risk.maxDailyLoss).toBe(500);
    // Restore defaults so later suites see a clean controller.
    controller.setFlowRisk({ ...before.risk });
    controller.setFlowCosts({ ...before.costs });
    controller.setFlowQty(before.orderQty);
  });
});
