/* Temporary verification harness — run with `bun scripts/verify.ts`. */
import assert from "node:assert";

import { readCsvColumns } from "../src/data/csv";
import { normalizeColumns } from "../src/data/normalize";
import { buildSessionIndex } from "../src/data/sessions";
import { buildDemoDataset } from "../src/data/sample";
import { barAt, sliceBarSeries } from "../src/data/types";
import { ReplayEngine } from "../src/replay/ReplayEngine";
import { ExecutionSimulator } from "../src/execution/ExecutionSimulator";
import { barSeriesFromBars } from "../src/data/types";
import { CONTRACTS } from "../src/market/instruments";
import { computeIndicators } from "../src/indicators/indicators";
import { evaluatePrediction, DEFAULT_PREDICTION_RULES } from "../src/scoring/predictions";
import { computePerformance } from "../src/scoring/performance";
import { computeScore } from "../src/scoring/scoring";

const TZ = "America/New_York";

/* ---------------- CSV + normalization ---------------- */
const csv = [
  "Time,Open,High,Low,Close,Volume",
  "2019-08-05 09:30:00,7700.00,7702.00,7698.00,7701.00,1200",
  "2019-08-05 09:35:00,7701.00,7705.00,7700.00,7704.00,1500",
  "2019-08-05 09:35:00,7701.00,7705.00,7700.00,7704.00,1500", // duplicate
  "2019-08-05 09:40:00,7704.00,7703.00,7699.00,7700.00,900", // invalid: high < open
  "2019-08-05 09:50:00,7700.00,7708.00,7699.00,7707.00,1100", // gap (missing 09:45)
].join("\n");

const cols = await readCsvColumns(new Blob([csv]), { timeZone: TZ });
assert.equal(cols.time.length, 5, "all 5 numeric rows parse (dupes/invalid are flagged later)");
const { series, quality } = normalizeColumns(cols, TZ);
assert.equal(series.length, 3, "duplicate removed and invalid row dropped");
assert.equal(quality.duplicateTimestamps, 1, "one duplicate detected");
assert.equal(quality.invalidOhlc, 1, "one invalid OHLC detected");
assert.equal(quality.missingBars, 2, "two missing bars detected across the gap");
assert.equal(quality.detectedTimeframeMs, 5 * 60 * 1000, "5m timeframe detected");
assert.equal(quality.passed, false, "quality report should flag issues");

// Timestamp must be interpreted as New York wall-clock (EDT = UTC-4 in August).
const first = new Date(series.t[0]);
assert.equal(first.toISOString(), "2019-08-05T13:30:00.000Z", "09:30 ET normalizes to 13:30Z");

/* ---------------- demo dataset + session indexing ---------------- */
const demo = buildDemoDataset("NQ", 12);
assert.equal(demo.index.rth.length, 12, "expected 12 RTH sessions");
assert.ok(demo.index.eth.length >= 12, "expected ETH sessions too");
for (const s of demo.index.rth) assert.equal(s.bars, 78, "RTH session should hold 78 five-minute bars");
assert.ok(
  demo.index.eth.every((s) => s.bars === 275),
  "ETH session should hold 275 five-minute bars",
);
assert.ok(demo.series.length === 12 * 275, "series length matches generated bars");

/* ---------------- indicators ---------------- */
const session = demo.index.eth[0];
const bars = sliceBarSeries(demo.series, session.startIndex, session.endIndex);
const ind = computeIndicators(bars, 15, TZ);
assert.ok(Number.isFinite(ind.vwap[10]), "vwap computed");
assert.ok(Number.isFinite(ind.ema21[30]), "ema21 computed");
assert.equal(ind.openingRange.ready, true, "opening range resolves");
assert.ok(ind.openingRange.high >= ind.openingRange.low, "opening range ordered");

/* ---------------- replay engine ---------------- */
const engine = new ReplayEngine(demo.index.eth[0], bars, 0);
assert.equal(engine.state.barsElapsed, 1);
assert.equal(engine.revealed().length, 1, "only the first bar is revealed at start");
engine.stepForward();
assert.equal(engine.state.cursor, 1);
assert.equal(engine.revealed().length, 2);
engine.stepBack();
assert.equal(engine.state.cursor, 0);
engine.reveal(5);
assert.equal(engine.state.cursor, 5, "reveal advances five bars");
assert.equal(engine.revealed().length, 6, "future bars remain hidden");
engine.reset();
assert.equal(engine.state.cursor, 0);
engine.dispose();

/* ---------------- execution simulator ---------------- */
function flatSeries(rows: number[][]): ReturnType<typeof barSeriesFromBars> {
  return barSeriesFromBars(rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })));
}

const cfgBase = {
  contract: CONTRACTS.NQ,
  ambiguityRule: "adverse-first" as const,
  slippageTicks: 1,
  commissionPerContractRoundTurn: 0,
  requireStop: false,
  maxContracts: 10,
  maxTradesPerSession: 10,
  dailyLossLimit: 0,
};
const ctx = { instrument: "NQ" as const, sessionId: "s1", sessionDate: "2024-01-02", sessionType: "RTH" as const };

// Market order fills at the NEXT bar's open + slippage, then target exit.
{
  const s = flatSeries([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 102, 100, 101, 10],
    [3000, 101, 103, 100.5, 102, 10],
    [4000, 102, 104, 101, 103, 10],
  ]);
  const sim = new ExecutionSimulator(cfgBase, ctx);
  sim.onBar(barAt(s, 0), 0);
  sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 99, takeProfit: 102.5 }, 1000, 0);
  sim.onBar(barAt(s, 1), 1);
  const pos = sim.getPosition();
  assert.ok(pos, "position opened");
  assert.equal(pos!.avgEntry, 100.25, "market fill at next open + 1 tick slippage");
  assert.equal(pos!.contracts, 1);
  sim.onBar(barAt(s, 2), 2);
  assert.equal(sim.getPosition(), null, "target closed the position");
  const t = sim.closedTrades[0];
  assert.equal(t.exitReason, "target");
  assert.equal(t.exitPrice, 102.5);
  assert.ok(Math.abs(t.grossPnl - (102.5 - 100.25) * 20) < 1e-6, "gross P&L in dollars");
  assert.ok(t.rMultiple !== undefined && Math.abs(t.rMultiple - (102.5 - 100.25) / (100.25 - 99)) < 1e-6, "R multiple");
}

// Limit order only fills when the bar range reaches it.
{
  const s = flatSeries([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 100.5, 99.9, 100, 10],
    [3000, 100, 101.5, 99.6, 101, 10],
  ]);
  const sim = new ExecutionSimulator(cfgBase, ctx);
  sim.onBar(barAt(s, 0), 0);
  sim.submit({ side: "buy", type: "limit", qty: 1, price: 99.75 }, 1000, 0);
  sim.onBar(barAt(s, 1), 1);
  assert.equal(sim.getPosition(), null, "limit not reached on bar 1");
  sim.onBar(barAt(s, 2), 2);
  assert.ok(sim.getPosition(), "limit filled when price traded through");
  assert.equal(sim.getPosition()!.avgEntry, 99.75);
  assert.equal(sim.fills[sim.fills.length - 1].kind, "limit-touch");
}

// Stop order triggers on the strong bar.
{
  const s = flatSeries([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 100.2, 99.8, 100, 10],
    [3000, 100, 103, 99.9, 102, 10],
  ]);
  const sim = new ExecutionSimulator(cfgBase, ctx);
  sim.onBar(barAt(s, 0), 0);
  sim.submit({ side: "buy", type: "stop", qty: 1, price: 101.5 }, 1000, 0);
  sim.onBar(barAt(s, 1), 1);
  assert.equal(sim.getPosition(), null, "stop not triggered on quiet bar");
  sim.onBar(barAt(s, 2), 2);
  const pos = sim.getPosition();
  assert.ok(pos, "stop triggered");
  assert.equal(pos!.avgEntry, 101.75, "stop fill at trigger + slippage");
  assert.equal(sim.fills[sim.fills.length - 1].kind, "stop-trigger");
}

// Ambiguity rule: bar contains both stop and target.
{
  const s = flatSeries([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 101, 100, 100.5, 10],
    [3000, 100.5, 103, 99, 101, 10], // contains stop 100.2 and target 102
    [4000, 101, 102, 100, 101.5, 10],
  ]);
  const sim = new ExecutionSimulator(cfgBase, ctx);
  sim.onBar(barAt(s, 0), 0);
  sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 100.2, takeProfit: 102 }, 1000, 0);
  sim.onBar(barAt(s, 1), 1);
  sim.onBar(barAt(s, 2), 2);
  const t = sim.closedTrades[0];
  assert.equal(t.exitReason, "stop", "adverse-first: stop is assumed hit first");
  assert.equal(t.exitPrice, 100.2 - 0.25, "stop exit includes slippage");
}

// Session end settles open positions at the final close.
{
  const s = flatSeries([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 101, 99, 100, 10],
  ]);
  const sim = new ExecutionSimulator(cfgBase, ctx);
  sim.onBar(barAt(s, 0), 0);
  sim.submit({ side: "buy", type: "market", qty: 2 }, 1000, 0);
  sim.onBar(barAt(s, 1), 1);
  const pos = sim.getPosition();
  assert.ok(pos);
  pos!.stop = 95; // gives the trade an R denominator
  sim.onSessionEnd(barAt(s, 1), 1);
  assert.equal(sim.getPosition(), null, "position closed at session end");
  assert.equal(sim.closedTrades[0].exitReason, "session-close");
}

// Orders never act on the bar they were submitted on.
{
  const s = flatSeries([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 101, 99, 100, 10],
  ]);
  const sim = new ExecutionSimulator(cfgBase, ctx);
  sim.onBar(barAt(s, 0), 0);
  sim.submit({ side: "buy", type: "limit", qty: 1, price: 100 }, 1000, 0);
  assert.equal(sim.getPosition(), null, "no same-bar fill");
  sim.onBar(barAt(s, 1), 1);
  assert.ok(sim.getPosition(), "filled on the next revealed bar");
}

/* ---------------- predictions ---------------- */
{
  const s = flatSeries([
    [1000, 100, 100.5, 99.5, 100, 10],
    [2000, 100, 100.5, 99.5, 100, 10],
    [3000, 100, 101, 99.9, 100.8, 10],
    [4000, 100.8, 102, 100.7, 101.8, 10],
    [5000, 101.8, 103, 101.7, 102.8, 10],
    [6000, 102.8, 104, 102.7, 103.8, 10],
  ]);
  const bull = evaluatePrediction("Bullish", 5, 1, s, DEFAULT_PREDICTION_RULES);
  assert.equal(bull.evaluable, true);
  assert.equal(bull.correct, true, "bullish call on a rising series is correct");
  const bear = evaluatePrediction("Bearish", 5, 1, s, DEFAULT_PREDICTION_RULES);
  assert.equal(bear.correct, false, "bearish call on a rising series is incorrect");
}

/* ---------------- performance + scoring ---------------- */
{
  const s = flatSeries([
    [1000, 100, 101, 99, 100, 10],
    [2000, 100, 103, 100, 102, 10],
    [3000, 102, 103, 101, 102, 10],
    [4000, 102, 103, 101, 102, 10],
  ]);
  const sim = new ExecutionSimulator({ ...cfgBase, commissionPerContractRoundTurn: 4 }, ctx);
  sim.onBar(barAt(s, 0), 0);
  sim.submit({ side: "buy", type: "market", qty: 1, stopLoss: 99, takeProfit: 102 }, 1000, 0);
  sim.onBar(barAt(s, 1), 1);
  assert.equal(sim.closedTrades.length, 0, "protective exits never fire on the entry bar");
  sim.onBar(barAt(s, 2), 2);
  const stats = computePerformance(sim.closedTrades);
  assert.equal(stats.trades, 1);
  assert.equal(stats.wins, 1);
  assert.equal(stats.winRate, 100);
  assert.ok(Math.abs(stats.netPnl - ((102 - 100.25) * 20 - 4)) < 1e-6, "net P&L after commission");

  const score = computeScore({
    stats,
    startingBalance: 25000,
    violations: [],
    predictions: [],
    maxContracts: 5,
  });
  assert.ok(score.overall >= 0 && score.overall <= 100, "overall score in range");
  assert.equal(score.discipline, 100, "no violations means full discipline");
}

console.log("✅ all Tape Lab core checks passed");
