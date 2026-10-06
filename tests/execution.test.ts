/**
 * §3 Execution — market/limit/stop buy & sell, stop loss, take profit,
 * flatten, reverse, multiple contracts.
 * §5 OHLC fill ambiguity — the conservative rule applied consistently, and the
 * guarantee that no fill ever consults a bar the replay has not revealed.
 */

import { describe, expect, test } from "bun:test";
import { ExecutionSimulator } from "../src/execution/ExecutionSimulator";
import { barAt } from "../src/data/types";
import { cfg, CTX, series } from "./helpers";

/** Feed the simulator bars 0..n and return it. */
function feed(sim: ExecutionSimulator, bars: ReturnType<typeof series>, upto = bars.length - 1): void {
  for (let i = 0; i <= upto; i++) sim.onBar(barAt(bars, i), i);
}

describe("market orders", () => {
  const bars = series([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 101, 99, 100.5, 10],
    [3000, 100.5, 102, 100.4, 101, 10],
  ]);

  test("market buy fills at the next revealed open plus adverse slippage", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 1 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1 }, 1000, 0);
    expect(sim.getPosition()).toBeNull(); // never on the submission bar
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()!.avgEntry).toBe(100.25);
    expect(sim.fills[0].kind).toBe("market-next-open");
    expect(sim.fills[0].index).toBe(1);
  });

  test("market sell fills at the next revealed open minus adverse slippage", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 1 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "sell", type: "market", qty: 2 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    const pos = sim.getPosition()!;
    expect(pos.contracts).toBe(-2);
    expect(pos.avgEntry).toBe(99.75);
  });

  test("slippage is configurable and applied in the adverse direction only", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 2 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()!.avgEntry).toBe(100.5); // 2 ticks = 0.5 pt
  });
});

describe("limit orders", () => {
  test("limit buy waits until the bar range reaches the price", () => {
    const bars = series([
      [1000, 100, 101, 99.9, 100, 10],
      [2000, 100, 100.5, 99.9, 100, 10], // never reaches 99.75
      [3000, 100, 101.5, 99.6, 101, 10], // trades through it
    ]);
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "limit", qty: 1, price: 99.75 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()).toBeNull();
    sim.onBar(barAt(bars, 2), 2);
    expect(sim.getPosition()!.avgEntry).toBe(99.75);
    expect(sim.fills.at(-1)!.kind).toBe("limit-touch");
  });

  test("limit buy fills at the open when the bar opens through the limit", () => {
    const bars = series([
      [1000, 100, 101, 99.9, 100, 10],
      [2000, 99.5, 99.6, 99, 99.4, 10],
    ]);
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "limit", qty: 1, price: 99.75 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()!.avgEntry).toBe(99.5);
  });

  test("limit sell waits for the bar high and fills at the limit", () => {
    const bars = series([
      [1000, 100, 100.4, 99, 100, 10],
      [2000, 100, 100.4, 99.9, 100, 10], // high 100.4 < 100.75
      [3000, 100, 101, 99.9, 100.6, 10], // high 101 ≥ 100.75
    ]);
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "sell", type: "limit", qty: 1, price: 100.75 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()).toBeNull();
    sim.onBar(barAt(bars, 2), 2);
    expect(sim.getPosition()!.contracts).toBe(-1);
    expect(sim.getPosition()!.avgEntry).toBe(100.75);
  });
});

describe("stop orders", () => {
  const quiet = [1000, 100, 100.2, 99.8, 100, 10];

  test("stop buy triggers only when the range reaches the trigger", () => {
    const bars = series([quiet, [2000, 100, 100.2, 99.8, 100, 10], [3000, 100, 103, 99.9, 102, 10]]);
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 1 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "stop", qty: 1, price: 101.5 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()).toBeNull();
    sim.onBar(barAt(bars, 2), 2);
    expect(sim.getPosition()!.avgEntry).toBe(101.75); // trigger + 1 tick
    expect(sim.fills.at(-1)!.kind).toBe("stop-trigger");
  });

  test("stop buy gaps through the trigger and fills from the open", () => {
    const bars = series([quiet, [2000, 102, 103, 101.5, 102.5, 10]]);
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 1 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "stop", qty: 1, price: 101.5 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()!.avgEntry).toBe(102.25);
  });

  test("stop sell triggers on the low and fills trigger minus slippage", () => {
    const bars = series([quiet, [2000, 100, 100.2, 99.9, 100, 10], [3000, 100, 100.1, 98, 98.4, 10]]);
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 1 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "sell", type: "stop", qty: 1, price: 98.5 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()).toBeNull();
    sim.onBar(barAt(bars, 2), 2);
    expect(sim.getPosition()!.contracts).toBe(-1);
    expect(sim.getPosition()!.avgEntry).toBe(98.25);
  });
});

describe("stop loss and take profit", () => {
  const entryBars = series([
    [1000, 100, 101, 99.5, 100, 10],
    [2000, 100, 101, 99.9, 100, 10], // entry bar
    [3000, 100, 101, 99.5, 100.5, 10], // neither level
  ]);

  test("a protective exit never fires on the entry bar itself", () => {
    const bars = series([
      [1000, 100, 101, 99.5, 100, 10],
      [2000, 100, 101, 98, 100, 10], // contains the stop, but it is the entry bar
    ]);
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 99 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()).not.toBeNull();
    expect(sim.closedTrades.length).toBe(0);
  });

  test("long stop loss exits at the stop less slippage", () => {
    const bars = series([
      [1000, 100, 101, 99.5, 100, 10],
      [2000, 100, 101, 99.9, 100, 10],
      [3000, 100.5, 100.9, 98.5, 99, 10],
    ]);
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 1 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 99, takeProfit: 105 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.onBar(barAt(bars, 2), 2);
    const t = sim.closedTrades[0];
    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice).toBe(98.75); // 99 − 1 tick
    expect(t.entryPrice).toBe(100.25); // 100 + 1 tick
    expect(t.netPnl).toBeCloseTo((98.75 - 100.25) * 20, 6);
  });

  test("long take profit exits exactly at the target with no slippage", () => {
    const bars = series([
      [1000, 100, 101, 99.5, 100, 10],
      [2000, 100, 101, 99.9, 100, 10],
      [3000, 100.5, 103, 100.4, 102, 10],
    ]);
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 95, takeProfit: 102 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.onBar(barAt(bars, 2), 2);
    const t = sim.closedTrades[0];
    expect(t.exitReason).toBe("target");
    expect(t.exitPrice).toBe(102);
    expect(t.netPnl).toBeCloseTo((102 - 100) * 20, 6);
  });

  test("short stop loss exits above the stop, short target below the target", () => {
    const bars = series([
      [1000, 100, 101, 99.5, 100, 10],
      [2000, 100, 101, 99.9, 100, 10],
      [3000, 100, 102, 99.8, 101, 10], // stop 101.5 hit
    ]);
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 1 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "sell", type: "market", qty: 1, stopLoss: 101.5, takeProfit: 96 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.onBar(barAt(bars, 2), 2);
    const t = sim.closedTrades[0];
    expect(t.direction).toBe("short");
    expect(t.exitReason).toBe("stop");
    expect(t.exitPrice).toBe(101.75);
  });

  test("unrealized P&L and the reward/risk snapshot follow the mark", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0 }), CTX);
    sim.onBar(barAt(entryBars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 2, stopLoss: 98, takeProfit: 104 }, 1000, 0);
    sim.onBar(barAt(entryBars, 1), 1);
    sim.onBar(barAt(entryBars, 2), 2);
    const snap = sim.snapshot();
    expect(snap.mark).toBe(100.5);
    expect(snap.avgEntry).toBe(100);
    expect(snap.unrealized).toBeCloseTo(0.5 * 20 * 2, 6);
    expect(snap.risk).toBeCloseTo(2 * 20 * 2, 6);
    expect(snap.reward).toBeCloseTo(4 * 20 * 2, 6);
    expect(snap.rMultiple).toBeCloseTo(snap.unrealized / snap.risk!, 10);
  });
});

describe("flatten, reverse and multiple contracts", () => {
  const bars = series([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 101, 99, 100, 10],
    [3000, 102, 103, 101, 102, 10],
  ]);

  test("flatten closes the whole position at the next open", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 3 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.getPosition()!.contracts).toBe(3);
    sim.flatten(2000, 1);
    sim.onBar(barAt(bars, 2), 2);
    expect(sim.getPosition()).toBeNull();
    const t = sim.closedTrades[0];
    expect(t.exitReason).toBe("manual");
    expect(t.contracts).toBe(3);
    expect(t.netPnl).toBeCloseTo((102 - 100) * 20 * 3, 6);
    expect(sim.getRealized()).toBeCloseTo(120, 6);
  });

  test("flatten on a flat account is a no-op", () => {
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    expect(sim.flatten(1000, 0)).toBeNull();
  });

  test("reverse closes the position and opens the opposite size", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 2 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.reverse(2000, 1);
    sim.onBar(barAt(bars, 2), 2);
    const t = sim.closedTrades[0];
    expect(t.exitReason).toBe("reverse");
    expect(t.contracts).toBe(2);
    expect(t.netPnl).toBeCloseTo((102 - 100) * 20 * 2, 6);
    const pos = sim.getPosition()!;
    expect(pos.contracts).toBe(-2);
    expect(pos.avgEntry).toBe(102);
  });

  test("multiple contracts scale P&L linearly and the multiplier is per contract", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0, commissionPerContractRoundTurn: 5 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 4, takeProfit: 104 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.submit({ side: "sell", type: "market", qty: 4 }, 1000, 1);
    sim.onBar(barAt(bars, 2), 2);
    const t = sim.closedTrades[0];
    expect(t.contracts).toBe(4);
    expect(t.grossPnl).toBeCloseTo((102 - 100) * 20 * 4, 6);
    expect(t.commission).toBe(20); // 5 × 4 contracts
    expect(t.netPnl).toBeCloseTo(140, 6);
  });

  test("partial exit books only the closed quantity", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 4 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.submit({ side: "sell", type: "market", qty: 1, reduceOnly: true }, 2000, 1);
    sim.onBar(barAt(bars, 2), 2);
    expect(sim.closedTrades[0].contracts).toBe(1);
    expect(sim.getPosition()!.contracts).toBe(3);
  });
});

describe("OHLC fill ambiguity rule", () => {
  // One bar that contains both the stop (99) and the target (102) for a long.
  const both = series([
    [1000, 100, 101, 99.5, 100, 10],
    [2000, 100, 101, 99.9, 100, 10],
    [3000, 100, 102.5, 98.5, 101, 10],
  ]);

  function longWith(rule: "adverse-first" | "favorable-first" | "skip") {
    const sim = new ExecutionSimulator(cfg({ ambiguityRule: rule, slippageTicks: 0 }), CTX);
    sim.onBar(barAt(both, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 99, takeProfit: 102 }, 1000, 0);
    sim.onBar(barAt(both, 1), 1);
    sim.onBar(barAt(both, 2), 2);
    return sim;
  }

  test("default rule assumes the adverse level is hit first (long)", () => {
    const sim = longWith("adverse-first");
    expect(sim.closedTrades.length).toBe(1);
    expect(sim.closedTrades[0].exitReason).toBe("stop");
    expect(sim.closedTrades[0].exitPrice).toBe(99);
  });

  test("default rule assumes the adverse level is hit first (short)", () => {
    const bars = series([
      [1000, 100, 101, 99.5, 100, 10],
      [2000, 100, 101, 99.9, 100, 10],
      [3000, 100, 102.5, 97.5, 99, 10], // contains stop 101.5 and target 98
    ]);
    const sim = new ExecutionSimulator(cfg({ ambiguityRule: "adverse-first", slippageTicks: 0 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "sell", type: "market", qty: 1, stopLoss: 101.5, takeProfit: 98 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.onBar(barAt(bars, 2), 2);
    expect(sim.closedTrades[0].exitReason).toBe("stop");
    expect(sim.closedTrades[0].exitPrice).toBe(101.5);
  });

  test("favorable-first is applied when configured", () => {
    const sim = longWith("favorable-first");
    expect(sim.closedTrades[0].exitReason).toBe("target");
    expect(sim.closedTrades[0].exitPrice).toBe(102);
  });

  test("skip takes no action on an ambiguous bar and waits for a definite one", () => {
    const bars = series([
      [1000, 100, 101, 99.5, 100, 10],
      [2000, 100, 101, 99.9, 100, 10],
      [3000, 100, 102.5, 98.5, 101, 10], // ambiguous → skipped
      [4000, 101, 101.5, 100.4, 101, 10], // definite: neither level
      [5000, 101, 102.2, 100.9, 102, 10], // definite: target only
    ]);
    const sim = new ExecutionSimulator(cfg({ ambiguityRule: "skip", slippageTicks: 0 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 99, takeProfit: 102 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.onBar(barAt(bars, 2), 2);
    expect(sim.closedTrades.length).toBe(0);
    expect(sim.getPosition()).not.toBeNull();
    sim.onBar(barAt(bars, 3), 3);
    expect(sim.closedTrades.length).toBe(0);
    sim.onBar(barAt(bars, 4), 4);
    expect(sim.closedTrades[0].exitReason).toBe("target");
  });

  test("the ambiguity rule is the only thing that changes — fills are otherwise identical", () => {
    const a = longWith("adverse-first").closedTrades[0];
    const b = longWith("favorable-first").closedTrades[0];
    expect(a.entryPrice).toBe(b.entryPrice);
    expect(a.entryIndex).toBe(b.entryIndex);
    expect(a.exitIndex).toBe(b.exitIndex);
    expect(a.exitReason).not.toBe(b.exitReason);
  });
});

describe("no lookahead — orders only touch revealed bars", () => {
  test("no fill can occur on or before the submission bar", () => {
    const bars = series([
      [1000, 100, 110, 90, 100, 10],
      [2000, 100, 110, 90, 100, 10],
      [3000, 100, 110, 90, 100, 10],
    ]);
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "limit", qty: 1, price: 95 }, 1000, 0);
    // The submission bar's own range contains 95, yet nothing may fill on it.
    expect(sim.getPosition()).toBeNull();
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.fills.every((f) => f.index > 0)).toBe(true);
    expect(sim.fills.at(-1)!.index).toBe(1);
  });

  test("a fill's price always comes from the bar it is stamped with", () => {
    const bars = series([
      [1000, 100, 101, 99, 100, 10],
      [2000, 200, 201, 199, 200, 10],
      [3000, 300, 301, 299, 300, 10],
    ]);
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(sim.fills[0].price).toBe(200); // bar 1's open, not bar 0's
    expect(sim.fills[0].index).toBe(1);
  });

  test("an untouched limit order never fills across an entire session", () => {
    const bars = series([
      [1000, 100, 101, 99, 100, 10],
      [2000, 100, 101, 99, 100, 10],
      [3000, 100, 101, 99, 100, 10],
    ]);
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "limit", qty: 1, price: 90 }, 1000, 0);
    feed(sim, bars, 2);
    expect(sim.getPosition()).toBeNull();
    expect(sim.fills.length).toBe(0);
  });
});

describe("session close settlement", () => {
  const bars = series([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 101, 99, 100.5, 10],
  ]);

  test("an open position is settled at the final close", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.onSessionEnd(barAt(bars, 1), 1);
    expect(sim.getPosition()).toBeNull();
    const t = sim.closedTrades[0];
    expect(t.exitReason).toBe("session-close");
    expect(t.exitPrice).toBe(100.5); // final close
    expect(t.netPnl).toBeCloseTo((100.5 - 100) * 20, 6);
  });

  test("regression: a market order submitted on the final bar settles at the close, never at a pre-submission price", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    sim.onBar(barAt(bars, 1), 1);
    sim.submit({ side: "buy", type: "market", qty: 1 }, 2000, 1);
    expect(sim.getPosition()).toBeNull();
    sim.onSessionEnd(barAt(bars, 1), 1);
    const fill = sim.fills[0];
    expect(fill.kind).toBe("session-close");
    expect(fill.price).toBe(100.5); // bar 1 close, NOT bar 1 open (100)
    expect(fill.index).toBe(1);
    // The order opened a position at the close and the session immediately
    // settled it flat at that same price — a flat, zero-P&L outcome.
    const t = sim.closedTrades[0];
    expect(t.entryPrice).toBe(100.5);
    expect(t.exitPrice).toBe(100.5);
    expect(t.exitReason).toBe("session-close");
    expect(t.netPnl).toBe(0);
    expect(sim.getPosition()).toBeNull();
  });

  test("working limit/stop orders are cancelled at session close, not filled", () => {
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    const limit = sim.submit({ side: "buy", type: "limit", qty: 1, price: 90 }, 1000, 0);
    const stop = sim.submit({ side: "sell", type: "stop", qty: 1, price: 110 }, 1000, 0);
    sim.onSessionEnd(barAt(bars, 1), 1);
    expect(limit.status).toBe("cancelled");
    expect(stop.status).toBe("cancelled");
    expect(sim.getWorkingOrders().length).toBe(0);
    expect(sim.fills.length).toBe(0);
  });
});

describe("order lifecycle bookkeeping", () => {
  const bars = series([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 101, 99, 100, 10],
  ]);

  test("submit records the working order, cancel closes it", () => {
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    const o = sim.submit({ side: "buy", type: "limit", qty: 1, price: 95 }, 1000, 0);
    expect(o.status).toBe("working");
    expect(sim.getWorkingOrders().length).toBe(1);
    sim.cancel(o.id);
    expect(sim.getWorkingOrders().length).toBe(0);
    expect(sim.orders[0].note).toMatch(/Cancelled/);
  });

  test("filled orders leave the working book and carry a fill stamp", () => {
    const sim = new ExecutionSimulator(cfg(), CTX);
    sim.onBar(barAt(bars, 0), 0);
    const o = sim.submit({ side: "buy", type: "market", qty: 1 }, 1000, 0);
    sim.onBar(barAt(bars, 1), 1);
    expect(o.status).toBe("filled");
    expect(o.filledIndex).toBe(1);
    expect(o.fillPrice).toBe(100.25);
    expect(o.note).toMatch(/next candle open/i);
    expect(sim.getWorkingOrders().length).toBe(0);
  });
});
