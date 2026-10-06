/**
 * §4/§12 Risk rules, including regressions for two defects found by this audit:
 *   1. the revenge-trade rule flagged *every* entry after a loss, ignoring the
 *      documented time window;
 *   2. a single stop-less entry produced two `no-stop` violations, double
 *      penalising the discipline score.
 */

import { describe, expect, test } from "bun:test";
import { ExecutionSimulator } from "../src/execution/ExecutionSimulator";
import { evaluateRisk, REVENGE_WINDOW_MS } from "../src/risk/rules";
import { CONTRACTS } from "../src/market/instruments";
import { barAt } from "../src/data/types";
import { cfg, CTX, series } from "./helpers";

const spec = CONTRACTS.NQ;

function baseRiskState(over: Partial<Parameters<typeof evaluateRisk>[0]> = {}) {
  return {
    openAfter: 1,
    realized: 0,
    tradesOpened: 0,
    lastLossTime: null,
    nowTime: 1_000_000,
    hasStopAfter: true,
    isEntry: true,
    ...over,
  };
}

describe("risk rule evaluation (pure)", () => {
  const limits = { maxContracts: 5, maxTradesPerSession: 10, dailyLossLimit: 500, requireStop: false };

  test("a clean order produces no breaches", () => {
    expect(evaluateRisk(baseRiskState(), limits, spec)).toEqual([]);
  });

  test("size cap", () => {
    const b = evaluateRisk(baseRiskState({ openAfter: 6 }), limits, spec);
    expect(b.map((x) => x.kind)).toEqual(["size"]);
    expect(b[0].detail).toContain("6");
  });

  test("size cap counts absolute exposure, so shorts are covered too", () => {
    expect(evaluateRisk(baseRiskState({ openAfter: -6 }), limits, spec)[0].kind).toBe("size");
  });

  test("max trades only applies to entries, not to exits", () => {
    const state = baseRiskState({ tradesOpened: 10 });
    expect(evaluateRisk(state, limits, spec).map((b) => b.kind)).toEqual(["max-trades"]);
    expect(evaluateRisk({ ...state, isEntry: false }, limits, spec)).toEqual([]);
  });

  test("daily loss limit triggers at the threshold and can be disabled", () => {
    expect(evaluateRisk(baseRiskState({ realized: -500 }), limits, spec).map((b) => b.kind)).toEqual(["daily-loss"]);
    expect(evaluateRisk(baseRiskState({ realized: -400 }), limits, spec)).toEqual([]);
    expect(evaluateRisk(baseRiskState({ realized: -9999 }), { ...limits, dailyLossLimit: 0 }, spec)).toEqual([]);
  });

  test("requireStop only fires for entries without a stop", () => {
    const strict = { ...limits, requireStop: true };
    expect(evaluateRisk(baseRiskState({ hasStopAfter: false }), strict, spec).map((b) => b.kind)).toEqual(["no-stop"]);
    expect(evaluateRisk(baseRiskState({ hasStopAfter: false, isEntry: false }), strict, spec)).toEqual([]);
    expect(evaluateRisk(baseRiskState({ hasStopAfter: true }), strict, spec)).toEqual([]);
  });

  test("revenge window: inside the window yes, outside the window no", () => {
    const lossAt = 1_000_000;
    const inside = evaluateRisk(baseRiskState({ lastLossTime: lossAt, nowTime: lossAt + 60_000 }), limits, spec);
    expect(inside.map((b) => b.kind)).toEqual(["revenge"]);
    const edge = evaluateRisk(baseRiskState({ lastLossTime: lossAt, nowTime: lossAt + REVENGE_WINDOW_MS }), limits, spec);
    expect(edge.map((b) => b.kind)).toEqual(["revenge"]);
    const outside = evaluateRisk(
      baseRiskState({ lastLossTime: lossAt, nowTime: lossAt + REVENGE_WINDOW_MS + 1 }),
      limits,
      spec,
    );
    expect(outside).toEqual([]);
    expect(REVENGE_WINDOW_MS).toBe(180_000);
  });
});

describe("risk rules in the simulator", () => {
  const losingSession = series([
    [1_000_000, 100, 101, 99, 100, 10],
    [1_100_000, 100, 101, 99, 100, 10], // entry here at 100
    [1_200_000, 100, 101, 98.5, 99, 10], // stop 99 hit → loss booked at t = 1_200_000
  ]);

  /** Run a session that books exactly one loss, then return the simulator. */
  function afterOneLoss(requireStop = false) {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0, requireStop }), CTX);
    sim.onBar(barAt(losingSession, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 99 }, 1_000_000, 0);
    sim.onBar(barAt(losingSession, 1), 1);
    sim.onBar(barAt(losingSession, 2), 2);
    expect(sim.closedTrades.length).toBe(1);
    expect(sim.closedTrades[0].netPnl).toBeLessThan(0);
    return sim;
  }

  test("regression: an entry 1 minute after a loss is flagged, 5 minutes later is not", () => {
    const inside = afterOneLoss();
    inside.submit({ side: "buy", type: "market", qty: 1 }, 1_260_000, 2); // +60s
    expect(inside.violations.filter((v) => v.kind === "revenge").length).toBe(1);

    const outside = afterOneLoss();
    outside.submit({ side: "buy", type: "market", qty: 1 }, 1_500_000, 2); // +300s
    expect(outside.violations.filter((v) => v.kind === "revenge").length).toBe(0);
  });

  test("regression: a stop-less entry records exactly one no-stop violation", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0, requireStop: true }), CTX);
    sim.onBar(barAt(losingSession, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1 }, 1_000_000, 0);
    sim.onBar(barAt(losingSession, 1), 1);
    expect(sim.getPosition()).not.toBeNull();
    expect(sim.violations.filter((v) => v.kind === "no-stop").length).toBe(1);
  });

  test("a flip still reports the stop-less position it opens", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0, requireStop: true }), CTX);
    sim.onBar(barAt(losingSession, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 95 }, 1_000_000, 0);
    sim.onBar(barAt(losingSession, 1), 1);
    // sell 2 with a stop-less flip leftover → new short 1 without a stop
    sim.submit({ side: "sell", type: "market", qty: 2 }, 1_100_000, 1);
    sim.onBar(barAt(losingSession, 2), 2);
    expect(sim.getPosition()!.contracts).toBe(-1);
    expect(sim.violations.filter((v) => v.kind === "no-stop").length).toBe(1);
  });

  test("requireStop off means no no-stop violations at all", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0, requireStop: false }), CTX);
    sim.onBar(barAt(losingSession, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1 }, 1_000_000, 0);
    sim.onBar(barAt(losingSession, 1), 1);
    expect(sim.violations.filter((v) => v.kind === "no-stop").length).toBe(0);
  });

  test("size cap is reported against the order that would breach it", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0, maxContracts: 2 }), CTX);
    sim.onBar(barAt(losingSession, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 3 }, 1_000_000, 0);
    const sizeViolations = sim.violations.filter((v) => v.kind === "size");
    expect(sizeViolations.length).toBe(1);
    expect(sizeViolations[0].detail).toContain("3");
  });

  test("daily loss limit is evaluated against realised P&L", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0, dailyLossLimit: 10 }), CTX);
    sim.onBar(barAt(losingSession, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 99 }, 1_000_000, 0);
    sim.onBar(barAt(losingSession, 1), 1);
    sim.onBar(barAt(losingSession, 2), 2); // realised −20
    expect(sim.getRealized()).toBeCloseTo(-20, 6);
    expect(sim.violations.filter((v) => v.kind === "daily-loss").length).toBe(0); // none yet at submit time
    sim.submit({ side: "buy", type: "market", qty: 1 }, 1_200_000, 2);
    expect(sim.violations.filter((v) => v.kind === "daily-loss").length).toBe(1);
  });

  test("violations carry an id, a timestamp and a human-readable detail", () => {
    const sim = new ExecutionSimulator(cfg({ slippageTicks: 0, maxContracts: 1 }), CTX);
    sim.onBar(barAt(losingSession, 0), 0);
    sim.submit({ side: "buy", type: "market", qty: 4 }, 1_000_000, 0);
    const v = sim.violations[0];
    expect(v.id).toMatch(/^viol_/);
    expect(v.time).toBe(1_000_000);
    expect(v.detail.length).toBeGreaterThan(10);
  });
});
