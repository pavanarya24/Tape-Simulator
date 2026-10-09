/**
 * Phase 10-D — Market-Aware Execution and PnL Test Suite
 *
 * Verifies:
 * 1. CME NQ ($20/pt, $5/tick), CME ES ($50/pt, $12.50/tick), Binance Spot, and Binance USD-M Futures.
 * 2. Point multiplier, Linear crypto, and Inverse crypto PnL models for Long and Short positions.
 * 3. Fractional crypto quantities vs integer futures contracts (min size, step size, precision).
 * 4. Fixed contract commissions vs basis points notional fee models.
 * 5. Market-specific slippage and protective exits (stop loss / take profit).
 * 6. Historical NQ multiplier regression prevention ($20/pt vs $2/pt micro error).
 * 7. End-to-end FlowTrainingSession multi-market execution and post-reveal scoring.
 */

import { describe, expect, test } from "bun:test";
import {
  calculateGrossPnL,
  FlowExecutionEngine,
  validateOrderQuantity,
  type FlowCosts,
  type FlowDecision,
  type FlowMarketState,
  type FlowRisk,
} from "../src/flow/execution";
import {
  PROFILE_CME_NQ,
  PROFILE_CME_ES,
  PROFILE_BINANCE_BTCUSDT_SPOT,
  PROFILE_BINANCE_BTCUSDT_FUTURES,
  type MarketProfile,
} from "../src/market/registry";
import { FlowTrainingSession } from "../src/flow/session";
import { generateScenario } from "../src/flow/scenarios";
import { scoreFlowSession } from "../src/flow/scoring";

const TS0 = 1_710_514_200_000;

function mkt(seq: number, bid: number | null, ask: number | null, last: number | null = null): FlowMarketState {
  return { bid, ask, lastPrice: last, timestamp: TS0 + seq * 1000, sequence: seq };
}

const DECISION: FlowDecision = { bias: "LONG", expected: "unknown", level: 3, reason: "" };

describe("Phase 10-D — Market-Aware Execution and PnL", () => {
  /* ------------------------------------------------------------------ */
  /* 1. Instrument Specifications & Historical Regression Prevention     */
  /* ------------------------------------------------------------------ */
  describe("1. Instrument Specifications & Multiplier Regression Prevention", () => {
    test("CME NQ uses $20 per point ($5 per tick), NOT $2 micro multiplier", () => {
      expect(PROFILE_CME_NQ.execution.contractMultiplier).toBe(20);
      expect(PROFILE_CME_NQ.pricing.tickSize).toBe(0.25);
      expect(PROFILE_CME_NQ.execution.tickValue).toBe(5.0);

      const engine = new FlowExecutionEngine({ profile: PROFILE_CME_NQ });
      // Buy @ ask 18000.00
      engine.onMarket(mkt(1, 17999.75, 18000.00, 18000.0));
      engine.buy(1, DECISION);
      // Exit @ bid 18010.00 (+10.00 points move)
      engine.onMarket(mkt(2, 18010.0, 18010.25, 18010.0));
      const res = engine.flatten();
      expect(res.ok).toBe(true);
      if (!res.ok || !res.closed) throw new Error("Expected closed trade");
      // 10 points * $20/point * 1 contract = $200.00 gross
      expect(res.closed.grossPnL).toBe(200.0);
    });

    test("CME ES uses $50 per point ($12.50 per tick), NOT $5 micro multiplier", () => {
      expect(PROFILE_CME_ES.execution.contractMultiplier).toBe(50);
      expect(PROFILE_CME_ES.pricing.tickSize).toBe(0.25);
      expect(PROFILE_CME_ES.execution.tickValue).toBe(12.5);

      const engine = new FlowExecutionEngine({ profile: PROFILE_CME_ES });
      // Buy @ ask 5000.00
      engine.onMarket(mkt(1, 4999.75, 5000.00, 5000.0));
      engine.buy(2, DECISION);
      // Exit @ bid 5010.00 (+10.00 points move)
      engine.onMarket(mkt(2, 5010.0, 5010.25, 5010.0));
      const res = engine.flatten();
      expect(res.ok).toBe(true);
      if (!res.ok || !res.closed) throw new Error("Expected closed trade");
      // 10 points * $50/point * 2 contracts = $1000.00 gross
      expect(res.closed.grossPnL).toBe(1000.0);
    });

    test("Binance BTCUSDT Spot uses 1.0 linear crypto multiplier in USDT quote", () => {
      expect(PROFILE_BINANCE_BTCUSDT_SPOT.execution.contractMultiplier).toBe(1.0);
      expect(PROFILE_BINANCE_BTCUSDT_SPOT.execution.pnlModel).toBe("linear_crypto");
      expect(PROFILE_BINANCE_BTCUSDT_SPOT.units.quoteCurrency).toBe("USDT");

      const engine = new FlowExecutionEngine({ profile: PROFILE_BINANCE_BTCUSDT_SPOT });
      // Buy @ ask 60000.00
      engine.onMarket(mkt(1, 59999.99, 60000.00, 60000.0));
      engine.buy(0.5, DECISION);
      // Exit @ bid 61000.00 (+$1000.00 move)
      engine.onMarket(mkt(2, 61000.0, 61000.01, 61000.0));
      const res = engine.flatten();
      expect(res.ok).toBe(true);
      if (!res.ok || !res.closed) throw new Error("Expected closed trade");
      // ($61,000 - $60,000) * 0.5 = 500.00 USDT gross
      expect(res.closed.grossPnL).toBe(500.0);
    });

    test("Binance BTCUSDT Futures uses 1.0 linear crypto multiplier in USDT quote", () => {
      expect(PROFILE_BINANCE_BTCUSDT_FUTURES.execution.contractMultiplier).toBe(1.0);
      expect(PROFILE_BINANCE_BTCUSDT_FUTURES.execution.pnlModel).toBe("linear_crypto");
      expect(PROFILE_BINANCE_BTCUSDT_FUTURES.pricing.tickSize).toBe(0.1);

      const engine = new FlowExecutionEngine({ profile: PROFILE_BINANCE_BTCUSDT_FUTURES });
      engine.onMarket(mkt(1, 60000.0, 60000.1, 60000.0));
      engine.buy(1.5, DECISION);
      engine.onMarket(mkt(2, 60500.0, 60500.1, 60500.0)); // +$500 move
      const res = engine.flatten();
      expect(res.ok).toBe(true);
      if (!res.ok || !res.closed) throw new Error("Expected closed trade");
      // ($60,500 - $60,000.10) * 1.5 = 749.85 USDT gross
      expect(res.closed.grossPnL).toBe(749.85);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 2. Pure PnL Model Calculations (Long, Short, Inverse)              */
  /* ------------------------------------------------------------------ */
  describe("2. Pure PnL Model Calculations", () => {
    test("point_multiplier: long and short PnL with contract multipliers", () => {
      // NQ Long: entry 18000, exit 18050 (+50 pts), 2 contracts -> 50 * 20 * 2 = $2000
      expect(calculateGrossPnL("LONG", 18000, 18050, 2, PROFILE_CME_NQ)).toBe(2000);
      // NQ Short: entry 18050, exit 18000 (+50 pts profit), 2 contracts -> 50 * 20 * 2 = $2000
      expect(calculateGrossPnL("SHORT", 18050, 18000, 2, PROFILE_CME_NQ)).toBe(2000);
      // NQ Short Loss: entry 18000, exit 18050 (-50 pts loss), 1 contract -> -50 * 20 * 1 = -$1000
      expect(calculateGrossPnL("SHORT", 18000, 18050, 1, PROFILE_CME_NQ)).toBe(-1000);

      // ES Long: entry 5000, exit 5020 (+20 pts), 3 contracts -> 20 * 50 * 3 = $3000
      expect(calculateGrossPnL("LONG", 5000, 5020, 3, PROFILE_CME_ES)).toBe(3000);
      // ES Short: entry 5020, exit 5000 (+20 pts profit), 1 contract -> 20 * 50 * 1 = $1000
      expect(calculateGrossPnL("SHORT", 5020, 5000, 1, PROFILE_CME_ES)).toBe(1000);
    });

    test("linear_crypto: fractional quantity long and short PnL", () => {
      // BTC Spot Long: entry 60,000, exit 63,000 (+3000 USDT), 0.25 BTC -> 3000 * 0.25 = 750 USDT
      expect(calculateGrossPnL("LONG", 60000, 63000, 0.25, PROFILE_BINANCE_BTCUSDT_SPOT)).toBe(750);
      // BTC Spot Short: entry 63,000, exit 60,000 (+3000 USDT profit), 0.1 BTC -> 3000 * 0.1 = 300 USDT
      expect(calculateGrossPnL("SHORT", 63000, 60000, 0.1, PROFILE_BINANCE_BTCUSDT_SPOT)).toBe(300);
      // BTC Spot Short Loss: entry 60,000, exit 61,500 (-1500 USDT), 0.5 BTC -> -1500 * 0.5 = -750 USDT
      expect(calculateGrossPnL("SHORT", 60000, 61500, 0.5, PROFILE_BINANCE_BTCUSDT_SPOT)).toBe(-750);
    });

    test("inverse_crypto: base currency (BTC) PnL calculation", () => {
      const inverseProfile: MarketProfile = {
        ...PROFILE_BINANCE_BTCUSDT_FUTURES,
        id: "BINANCE:BTCUSD-INVERSE",
        execution: {
          ...PROFILE_BINANCE_BTCUSDT_FUTURES.execution,
          pnlModel: "inverse_crypto",
        },
      };

      // 10,000 contracts ($1 each). Long entry 50,000, exit 60,000
      // PnL in BTC = (1/50000 - 1/60000) * 10000 = (0.00002 - 0.0000166667) * 10000 = 0.033333 BTC
      const longPnl = calculateGrossPnL("LONG", 50000, 60000, 10000, inverseProfile);
      expect(Math.round(longPnl * 10000) / 10000).toBe(0.0333);

      // Short entry 60,000, exit 50,000
      // PnL in BTC = (1/50000 - 1/60000) * 10000 = 0.033333 BTC
      const shortPnl = calculateGrossPnL("SHORT", 60000, 50000, 10000, inverseProfile);
      expect(Math.round(shortPnl * 10000) / 10000).toBe(0.0333);

      // Invalid price throws
      expect(() => calculateGrossPnL("LONG", 0, 50000, 100, inverseProfile)).toThrow();
    });
  });

  /* ------------------------------------------------------------------ */
  /* 3. Quantity Validation & Precision Constraints                     */
  /* ------------------------------------------------------------------ */
  describe("3. Quantity Validation & Precision Constraints", () => {
    test("CME Futures enforces integer quantities and minOrderQuantity = 1", () => {
      const units = PROFILE_CME_NQ.units;
      expect(validateOrderQuantity(1, units)).toBe(true);
      expect(validateOrderQuantity(4, units)).toBe(true);
      expect(validateOrderQuantity(100, units)).toBe(true);

      expect(validateOrderQuantity(0, units)).toBe(false);
      expect(validateOrderQuantity(-1, units)).toBe(false);
      expect(validateOrderQuantity(0.5, units)).toBe(false);
      expect(validateOrderQuantity(1.25, units)).toBe(false);
      expect(validateOrderQuantity(NaN, units)).toBe(false);
      expect(validateOrderQuantity(Infinity, units)).toBe(false);
    });

    test("Binance Spot enforces 5 decimal places and minOrderQuantity = 0.00001", () => {
      const units = PROFILE_BINANCE_BTCUSDT_SPOT.units;
      expect(validateOrderQuantity(0.00001, units)).toBe(true);
      expect(validateOrderQuantity(0.00002, units)).toBe(true);
      expect(validateOrderQuantity(0.05, units)).toBe(true);
      expect(validateOrderQuantity(1.23456, units)).toBe(true);

      // Below min quantity
      expect(validateOrderQuantity(0.000005, units)).toBe(false);
      // Beyond 5 decimal places (step 0.00001)
      expect(validateOrderQuantity(0.000012, units)).toBe(false);
      expect(validateOrderQuantity(0, units)).toBe(false);
      expect(validateOrderQuantity(-0.01, units)).toBe(false);
    });

    test("Binance Futures enforces 3 decimal places and minOrderQuantity = 0.001", () => {
      const units = PROFILE_BINANCE_BTCUSDT_FUTURES.units;
      expect(validateOrderQuantity(0.001, units)).toBe(true);
      expect(validateOrderQuantity(0.005, units)).toBe(true);
      expect(validateOrderQuantity(0.5, units)).toBe(true);
      expect(validateOrderQuantity(2.500, units)).toBe(true);

      // Below min quantity
      expect(validateOrderQuantity(0.0005, units)).toBe(false);
      // Beyond 3 decimal places
      expect(validateOrderQuantity(0.0015, units)).toBe(false);
      expect(validateOrderQuantity(0, units)).toBe(false);
    });

    test("engine rejects invalid order quantities safely", () => {
      const engineFutures = new FlowExecutionEngine({ profile: PROFILE_CME_NQ });
      engineFutures.onMarket(mkt(1, 18000, 18000.25, 18000));
      expect(engineFutures.buy(0.5).ok).toBe(false);
      expect(engineFutures.buy(0).ok).toBe(false);
      expect(engineFutures.buy(-2).ok).toBe(false);

      const engineSpot = new FlowExecutionEngine({ profile: PROFILE_BINANCE_BTCUSDT_SPOT });
      engineSpot.onMarket(mkt(1, 60000, 60000.01, 60000));
      expect(engineSpot.buy(0.000005).ok).toBe(false);
      expect(engineSpot.buy(0.05).ok).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 4. Configurable Fee Models (Fixed vs Basis Points Notional)        */
  /* ------------------------------------------------------------------ */
  describe("4. Configurable Fee Models & Slippage Calculations", () => {
    test("per_contract_fixed: computes fixed commission per contract/side", () => {
      const costs: FlowCosts = {
        feeModel: "per_contract_fixed",
        commissionPerContract: 2.50, // $2.50 / contract / side
        slippageTicks: 0,
      };
      const engine = new FlowExecutionEngine({ profile: PROFILE_CME_ES, costs });
      engine.onMarket(mkt(1, 5000, 5000.25, 5000));
      const r1 = engine.buy(2, DECISION);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      // 2 contracts * $2.50 = $5.00
      expect(r1.fills[0].commission).toBe(5.0);

      engine.onMarket(mkt(2, 5005, 5005.25, 5005));
      const r2 = engine.flatten();
      expect(r2.ok).toBe(true);
      if (!r2.ok || !r2.closed) return;
      // Round turn commission = $5.00 entry + $5.00 exit = $10.00
      expect(r2.closed.costs).toBe(10.0);
    });

    test("basis_points_notional: computes percentage fee of trade notional value", () => {
      const costs: FlowCosts = {
        feeModel: "basis_points_notional",
        feeRate: 0.001, // 10 bps (0.10%)
        slippageTicks: 0,
      };
      const engine = new FlowExecutionEngine({ profile: PROFILE_BINANCE_BTCUSDT_SPOT, costs });
      // Buy 0.5 BTC @ $60,000 -> Notional = $30,000 -> Fee = $30.00 USDT
      engine.onMarket(mkt(1, 60000, 60000, 60000));
      const r1 = engine.buy(0.5, DECISION);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect(r1.fills[0].commission).toBe(30.0);

      // Sell 0.5 BTC @ $64,000 -> Notional = $32,000 -> Fee = $32.00 USDT
      engine.onMarket(mkt(2, 64000, 64000, 64000));
      const r2 = engine.flatten();
      expect(r2.ok).toBe(true);
      if (!r2.ok || !r2.closed) return;
      // Total commission = 30 + 32 = 62.00 USDT
      expect(r2.closed.costs).toBe(62.0);
      // Gross PnL = (64000 - 60000) * 0.5 = $2000.00
      expect(r2.closed.grossPnL).toBe(2000.0);
      // Net PnL = 2000 - 62 = $1938.00 USDT
      expect(r2.closed.netPnL).toBe(1938.0);
    });

    test("market-aware slippage: calculates correct tick value for fractional and futures", () => {
      // NQ: 1 tick = $5.00 / contract. 2 ticks slippage on 2 contracts = $20.00
      const engineNQ = new FlowExecutionEngine({
        profile: PROFILE_CME_NQ,
        costs: { slippageTicks: 2, commissionPerContract: 0 },
      });
      engineNQ.onMarket(mkt(1, 18000, 18000.25, 18000));
      const rNQ = engineNQ.buy(2, DECISION);
      expect(rNQ.ok).toBe(true);
      if (rNQ.ok) expect(rNQ.fills[0].slippageCost).toBe(20.0);

      // Binance Futures: tickSize 0.1, tickValue 0.1 USDT. 2 ticks slippage on 1.5 BTC = 2 * 0.1 * 1.5 = 0.30 USDT
      const engineBTC = new FlowExecutionEngine({
        profile: PROFILE_BINANCE_BTCUSDT_FUTURES,
        costs: { slippageTicks: 2, commissionPerContract: 0 },
      });
      engineBTC.onMarket(mkt(1, 60000, 60000.1, 60000));
      const rBTC = engineBTC.buy(1.5, DECISION);
      expect(rBTC.ok).toBe(true);
      if (rBTC.ok) expect(rBTC.fills[0].slippageCost).toBe(0.30);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 5. Risk Controls & Protective Exits (Market-Specific Tick Scaling)  */
  /* ------------------------------------------------------------------ */
  describe("5. Risk Controls & Protective Exits", () => {
    test("maxPositionQty enforces quantity limits for fractional and futures positions", () => {
      const risk: FlowRisk = {
        maxPositionQty: 1.5,
        maxDailyLoss: null,
        stopLossTicks: null,
        takeProfitTicks: null,
      };
      const engine = new FlowExecutionEngine({ profile: PROFILE_BINANCE_BTCUSDT_FUTURES, risk });
      engine.onMarket(mkt(1, 60000, 60000.1, 60000));
      expect(engine.buy(1.0, DECISION).ok).toBe(true);
      expect(engine.buy(0.6, DECISION).ok).toBe(false); // 1.0 + 0.6 = 1.6 > 1.5
      expect(engine.buy(0.5, DECISION).ok).toBe(true); // 1.0 + 0.5 = 1.5 (hits max)
      expect(engine.buy(0.001, DECISION).ok).toBe(false);
    });

    test("stop-loss exit scales with market profile tickSize", () => {
      // Binance Spot: tickSize 0.01. Stop 50 ticks = $0.50 below entry
      const risk: FlowRisk = {
        maxPositionQty: 10,
        maxDailyLoss: null,
        stopLossTicks: 50,
        takeProfitTicks: null,
      };
      const engine = new FlowExecutionEngine({ profile: PROFILE_BINANCE_BTCUSDT_SPOT, risk });
      engine.onMarket(mkt(1, 60000.0, 60000.01, 60000.0));
      engine.buy(0.5, DECISION); // Entry @ 60000.01. Stop trigger @ 60000.01 - 0.50 = 59999.51

      // Market drops to 59999.60 (not hit yet)
      const noExit = engine.onMarket(mkt(2, 59999.60, 59999.61, 59999.60));
      expect(noExit).toBeNull();
      expect(engine.positionView().side).toBe("LONG");

      // Market drops to 59999.50 (hit!)
      const exitResult = engine.onMarket(mkt(3, 59999.50, 59999.51, 59999.50));
      expect(exitResult).not.toBeNull();
      if (!exitResult || !exitResult.closed) throw new Error("Expected stop exit");
      expect(exitResult.closed.exitReason).toBe("STOP");
      expect(exitResult.closed.exitPrice).toBe(59999.50);
      expect(engine.positionView().side).toBe("FLAT");
    });

    test("take-profit exit scales with market profile tickSize for Short", () => {
      // CME ES: tickSize 0.25. Short entry @ 5000.00. Target 20 ticks = 5.00 pts -> 4995.00
      const risk: FlowRisk = {
        maxPositionQty: 10,
        maxDailyLoss: null,
        stopLossTicks: null,
        takeProfitTicks: 20,
      };
      const engine = new FlowExecutionEngine({ profile: PROFILE_CME_ES, risk });
      engine.onMarket(mkt(1, 5000.0, 5000.25, 5000.0));
      engine.sell(1, DECISION); // Short entry @ 5000.00 (bid). Target @ 5000.00 - 5.00 = 4995.00 (ask)

      // Market drops to ask 4995.00 (hit!)
      const exitResult = engine.onMarket(mkt(2, 4994.75, 4995.00, 4994.75));
      expect(exitResult).not.toBeNull();
      if (!exitResult || !exitResult.closed) throw new Error("Expected target exit");
      expect(exitResult.closed.exitReason).toBe("TARGET");
      expect(exitResult.closed.exitPrice).toBe(4995.00);
      expect(exitResult.closed.grossPnL).toBe(250.0); // 5 points * $50/pt = $250.00
    });
  });

  /* ------------------------------------------------------------------ */
  /* 6. Multi-Market Scoring & R-Multiple Evaluation                    */
  /* ------------------------------------------------------------------ */
  describe("6. Multi-Market Scoring & R-Multiple Evaluation", () => {
    test("R-multiple calculation accurately evaluates tickValue across ES and Crypto", () => {
      const truth = {
        pattern: "absorption_reversal",
        direction: "bullish",
        startEvent: 5,
        endEvent: 15,
        characteristics: [],
      } as any;

      const orderFlow = { cumulativeDelta: 100, delta: 10, buyAggressionPct: 70, sellAggressionPct: 30 };
      const dom = { replenishCount: 1, pullBidCount: 0, pullAskCount: 0, sweepBuyCount: 0, sweepSellCount: 0 };

      // ES: Stop 10 ticks = 10 * 12.50 = $125 risk/contract. Net PnL = $375 -> R-multiple = 3.0
      const scoreES = scoreFlowSession({
        truth,
        records: [
          {
            tradeId: 1,
            scenarioId: "test",
            hiddenPattern: "absorption_reversal",
            side: "LONG",
            quantity: 1,
            entryPrice: 5000,
            exitPrice: 5010,
            grossPnL: 500,
            costs: 125,
            netPnL: 375,
            entryTimestamp: TS0,
            exitTimestamp: TS0 + 1000,
            durationMs: 1000,
            entrySequence: 6,
            exitSequence: 14,
            maxFavorableExcursion: 500,
            maxAdverseExcursion: 0,
            exitReason: "TARGET",
            entryDecision: DECISION,
          },
        ],
        decision: { bias: "LONG", expected: "absorption_reversal", level: 5, reason: "" },
        risk: { maxPositionQty: 4, maxDailyLoss: null, stopLossTicks: 10, takeProfitTicks: 20 },
        profile: PROFILE_CME_ES,
        orderFlow,
        dom,
      });

      expect(scoreES.rMultiple).toBe(3.0);
      expect(scoreES.patternResult).toBe("CORRECT");
      expect(scoreES.tradeResult).toBe("PROFIT");
    });
  });

  /* ------------------------------------------------------------------ */
  /* 7. End-to-End FlowTrainingSession Integration                      */
  /* ------------------------------------------------------------------ */
  describe("7. End-to-End FlowTrainingSession Integration", () => {
    test("runs end-to-end FlowTrainingSession with CME:ES profile", () => {
      const { feed, truth } = generateScenario("spring", 12345, { profile: PROFILE_CME_ES });
      const session = new FlowTrainingSession(feed, truth, {
        profile: PROFILE_CME_ES,
        sessionId: "session-es",
      });

      expect(session.profile.id).toBe("CME:ES");
      session.step(10);
      session.setOrderQty(2);
      const buyRes = session.buy();
      expect(buyRes.ok).toBe(true);

      session.step(10);
      const flatRes = session.flatten();
      expect(flatRes.ok).toBe(true);

      session.markRevealed();
      const results = session.results();
      expect(results).not.toBeNull();
      expect(results?.trades).toBe(1);
    });

    test("runs end-to-end FlowTrainingSession with Binance Spot profile & fractional quantities", () => {
      const { feed, truth } = generateScenario("absorption", 54321, { profile: PROFILE_BINANCE_BTCUSDT_SPOT });
      const session = new FlowTrainingSession(feed, truth, {
        profile: PROFILE_BINANCE_BTCUSDT_SPOT,
        sessionId: "session-spot",
      });

      expect(session.profile.id).toBe("BINANCE:BTCUSDT-SPOT");
      session.step(10);
      session.setOrderQty(0.05);
      const buyRes = session.buy();
      expect(buyRes.ok).toBe(true);

      session.step(10);
      const flatRes = session.flatten();
      expect(flatRes.ok).toBe(true);

      session.markRevealed();
      const results = session.results();
      expect(results).not.toBeNull();
      expect(results?.trades).toBe(1);
    });
  });
});
