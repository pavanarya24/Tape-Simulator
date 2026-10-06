/**
 * §4 Futures mathematics — explicit unit tests for the contract multipliers.
 * §6 P&L — entry, exit, realized, unrealized, commission, net, R, balance, drawdown.
 */

import { describe, expect, test } from "bun:test";
import { CONTRACTS, CONTRACT_IDS, priceToDollars, roundToTick, contractsForRoot } from "../src/market/instruments";
import { computePerformance, computeSessionStats, maxDrawdownFrom, rStatistics } from "../src/scoring/performance";
import type { ClosedTrade } from "../src/execution/types";
import { ExecutionSimulator } from "../src/execution/ExecutionSimulator";
import { barAt } from "../src/data/types";
import { cfg, CTX, series } from "./helpers";

describe("futures contract specifications", () => {
  const expected = {
    NQ: { pointValue: 20, tickSize: 0.25, tickValue: 5 },
    MNQ: { pointValue: 2, tickSize: 0.25, tickValue: 0.5 },
    ES: { pointValue: 50, tickSize: 0.25, tickValue: 12.5 },
    MES: { pointValue: 5, tickSize: 0.25, tickValue: 1.25 },
  } as const;

  test("all four contracts match the published specs", () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual(["ES", "MES", "MNQ", "NQ"]);
    for (const id of CONTRACT_IDS) {
      const spec = CONTRACTS[id];
      expect({ id, pointValue: spec.pointValue, tickSize: spec.tickSize, tickValue: spec.tickValue }).toEqual({
        id,
        ...expected[id],
      });
    }
  });

  test("tickValue === tickSize × pointValue for every contract", () => {
    for (const id of CONTRACT_IDS) {
      const spec = CONTRACTS[id];
      expect(spec.tickSize * spec.pointValue).toBeCloseTo(spec.tickValue, 10);
    }
  });

  test("micros share the root but not the multiplier", () => {
    expect(contractsForRoot("NQ").map((c) => c.id)).toEqual(["NQ", "MNQ"]);
    expect(contractsForRoot("ES").map((c) => c.id)).toEqual(["ES", "MES"]);
  });

  test("point → dollar conversion", () => {
    expect(priceToDollars(1, CONTRACTS.NQ, 1)).toBe(20);
    expect(priceToDollars(1, CONTRACTS.MNQ, 1)).toBe(2);
    expect(priceToDollars(1, CONTRACTS.ES, 1)).toBe(50);
    expect(priceToDollars(1, CONTRACTS.MES, 1)).toBe(5);
    // 4 ticks = 1 point
    expect(priceToDollars(4 * CONTRACTS.NQ.tickSize, CONTRACTS.NQ, 1)).toBe(20);
    expect(priceToDollars(4 * CONTRACTS.MES.tickSize, CONTRACTS.MES, 3)).toBe(15); // 1pt × $5 × 3
  });

  test("price rounding snaps to the 0.25 tick grid for all four", () => {
    for (const id of CONTRACT_IDS) {
      const spec = CONTRACTS[id];
      expect(roundToTick(100.13, spec)).toBe(100.25);
      expect(roundToTick(100.11, spec)).toBe(100);
      expect(roundToTick(100.375, spec)).toBe(100.5);
    }
  });
});

describe("P&L accounting", () => {
  const bars = series([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 101, 99, 100.5, 10], // entry fills here at open
    [3000, 100.5, 104, 100.4, 103, 10],
  ]);

  test("unrealized P&L, realized P&L and net P&L tie out", () => {
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 2 }, 1000, 0);

    // Before the fill: flat.
    expect(sim.snapshot().unrealized).toBe(0);

    sim.onBar(barAt(bars, 1), 1);
    const pos = sim.getPosition()!;
    expect(pos.avgEntry).toBe(100.25); // 100 + 1 tick slippage
    expect(pos.contracts).toBe(2);
    // mark = close of the fill bar (100.5)
    expect(sim.snapshot().unrealized).toBeCloseTo((100.5 - 100.25) * 20 * 2, 6);

    sim.onBar(barAt(bars, 2), 2);
    // mark 103, entry 100.25 → 2.75 pts × $20 × 2 contracts
    expect(sim.snapshot().unrealized).toBeCloseTo(2.75 * 20 * 2, 6);
    expect(sim.getRealized()).toBe(0);
  });

  test("commission is charged once per contract on the round turn", () => {
    const sim = new ExecutionSimulator(cfg({ commissionPerContractRoundTurn: 4.5 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 2, takeProfit: 103 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.onBar(barAt(bars, 2), 2);
    const t = sim.closedTrades[0];
    expect(t.commission).toBe(9); // 4.5 × 2
    expect(t.grossPnl).toBeCloseTo((103 - 100.25) * 20 * 2, 6);
    expect(t.netPnl).toBeCloseTo(t.grossPnl - 9, 6);
    expect(sim.getRealized()).toBeCloseTo(t.netPnl, 6);
  });

  test("R multiple = net P&L / dollars risked at entry", () => {
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 99, takeProfit: 103 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.onBar(barAt(bars, 2), 2);
    const t = sim.closedTrades[0];
    const riskDollars = (100.25 - 99) * 20;
    expect(t.rMultiple).toBeCloseTo(t.netPnl / riskDollars, 8);
  });

  test("short P&L is the mirror image", () => {
    const shortBars = series([
      [1000, 100, 101, 99, 100, 10],
      [2000, 100, 101, 99, 100, 10],
      [3000, 100, 99.5, 97.5, 98, 10],
    ]);
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(shortBars, 0), 0);
    sim.submit({ side: "sell", type: "market", qty: 1, takeProfit: 98 }, 1000, 0);
    sim.onBar(barAt(shortBars, 1), 1);
    const pos = sim.getPosition()!;
    expect(pos.avgEntry).toBe(99.75); // 100 − 1 tick
    expect(pos.contracts).toBe(-1);
    sim.onBar(barAt(shortBars, 2), 2);
    const t = sim.closedTrades[0];
    expect(t.direction).toBe("short");
    expect(t.exitPrice).toBe(98);
    expect(t.netPnl).toBeCloseTo((99.75 - 98) * 20, 6);
  });

  test("scale-in averages the entry price and sizes the P&L correctly", () => {
    const s = series([
      [1000, 100, 101, 99, 100, 10],
      [2000, 100, 101, 99, 100, 10],
      [3000, 102, 106, 101, 105, 10],
      [4000, 105, 106, 104, 105, 10],
    ]);
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0 }), CTX);
    sim.onBar(barAt(s, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, takeProfit: 200 }, 1000, 0);
    sim.onBar(barAt(s, 1), 1);
    sim.submit({ side: "buy", type: "market", qty: 3, takeProfit: 200 }, 2000, 1);
    sim.onBar(barAt(s, 2), 2);
    const pos = sim.getPosition()!;
    expect(pos.contracts).toBe(4);
    expect(pos.avgEntry).toBeCloseTo((100 + 102 * 3) / 4, 8);
    expect(sim.snapshot().unrealized).toBeCloseTo((105 - pos.avgEntry) * 20 * 4, 6);
  });
});

function fakeTrade(over: Partial<ClosedTrade>): ClosedTrade {
  return {
    id: over.id ?? "t",
    instrument: "NQ",
    contract: "NQ",
    sessionId: "NQ:RTH:2024-01-02",
    sessionDate: "2024-01-02",
    sessionType: "RTH",
    direction: "long",
    contracts: 1,
    entryTime: 0,
    entryIndex: 0,
    entryPrice: 100,
    exitTime: 1,
    exitIndex: 1,
    exitPrice: 101,
    grossPnl: 20,
    commission: 4.5,
    netPnl: 15.5,
    rMultiple: 1,
    holdingMs: 1000,
    exitReason: "target",
    notes: { thesis: "", saw: "", whyEntered: "", whyExited: "", mistake: "", lesson: "" },
    ...over,
  };
}

describe("performance statistics", () => {
  test("win rate, profit factor, averages and largest winner/loser", () => {
    const trades = [
      fakeTrade({ id: "1", netPnl: 100, rMultiple: 2 }),
      fakeTrade({ id: "2", netPnl: -50, rMultiple: -1 }),
      fakeTrade({ id: "3", netPnl: 200, rMultiple: 4 }),
      fakeTrade({ id: "4", netPnl: -25, rMultiple: -0.5 }),
      fakeTrade({ id: "5", netPnl: 0, rMultiple: 0 }),
    ];
    const s = computePerformance(trades);
    expect(s.trades).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.scratches).toBe(1);
    expect(s.winRate).toBe(50); // scratches excluded from the decision count
    expect(s.grossProfit).toBe(300);
    expect(s.grossLoss).toBe(75);
    expect(s.profitFactor).toBe(4);
    expect(s.avgWinner).toBe(150);
    expect(s.avgLoser).toBe(37.5);
    expect(s.netPnl).toBe(225);
    expect(s.avgTrade).toBe(45);
    expect(s.largestWinner).toBe(200);
    expect(s.largestLoser).toBe(-50);
    expect(s.avgR).toBeCloseTo((2 - 1 + 4 - 0.5 + 0) / 5, 10);
    expect(s.expectancy).toBe(45);
  });

  test("empty trade list yields a neutral, non-throwing result", () => {
    const s = computePerformance([]);
    expect(s.trades).toBe(0);
    expect(s.profitFactor).toBe(0);
    expect(s.avgR).toBeNull();
    expect(s.equityCurve).toEqual([0]);
  });

  test("maximum drawdown is peak-to-trough of the equity curve", () => {
    // +100 → 50 → 150 → 0  ⇒ peak 150, trough 0
    expect(maxDrawdownFrom([0, 100, 50, 150, 0])).toBe(150);
    expect(maxDrawdownFrom([0, -10, -30, -20])).toBe(30);
    expect(maxDrawdownFrom([])).toBe(0);
  });

  test("session statistics: starting, ending, peak balance and drawdown", () => {
    const trades = [fakeTrade({ netPnl: 100 }), fakeTrade({ netPnl: -250 }), fakeTrade({ netPnl: 50 })];
    const s = computeSessionStats(25_000, computePerformance(trades));
    expect(s.startingBalance).toBe(25_000);
    expect(s.sessionPnl).toBe(-100);
    expect(s.endingBalance).toBe(24_900);
    expect(s.peakBalance).toBe(25_100);
    expect(s.maxDrawdown).toBe(250);
  });

  test("R statistics need at least two samples and report a confidence interval", () => {
    expect(rStatistics([fakeTrade({ rMultiple: 1 })])).toBeNull();
    const r = rStatistics([fakeTrade({ id: "a", rMultiple: 1 }), fakeTrade({ id: "b", rMultiple: 3 })])!;
    expect(r.n).toBe(2);
    expect(r.meanR).toBe(2);
    expect(r.sdR).toBeCloseTo(Math.SQRT2, 10);
    expect(r.ci95[0]).toBeLessThan(r.meanR);
    expect(r.ci95[1]).toBeGreaterThan(r.meanR);
  });
});
