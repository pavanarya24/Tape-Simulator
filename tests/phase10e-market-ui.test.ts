import { describe, expect, test } from "bun:test";
import { TapeLabController } from "../src/state/app";
import {
  PROFILE_CME_NQ,
  PROFILE_CME_ES,
  PROFILE_BINANCE_BTCUSDT_SPOT,
  PROFILE_BINANCE_BTCUSDT_FUTURES,
  listMarketProfiles,
} from "../src/market/registry";
import { formatCurrency, formatSignedCurrency } from "../src/util/format";
import { getCandlestickSeriesOptions, adaptFlowMarkers } from "../src/flow/chartAdapter";

describe("Phase 10-E — MarketProfile UI Integration & Workspace", () => {
  test("1. FlowState includes active MarketProfile and defaults to CME:NQ", () => {
    const c = new TapeLabController();
    const state = c.getState();
    expect(state.flow.profile).toBeDefined();
    expect(state.flow.profile.id).toBe("CME:NQ");
    expect(state.flow.profile.identity.symbol).toBe("NQ");
    expect(state.flow.profile.units.quoteCurrency).toBe("USD");
    expect(state.flow.profile.pricing.tickSize).toBe(0.25);
  });

  test("2. Controller setFlowProfile switches between certified markets", () => {
    const c = new TapeLabController();

    // Switch to Binance Spot
    c.setFlowProfile("BINANCE:BTCUSDT-SPOT");
    let state = c.getState();
    expect(state.flow.profile.id).toBe("BINANCE:BTCUSDT-SPOT");
    expect(state.flow.profile.units.quoteCurrency).toBe("USDT");
    expect(state.flow.profile.units.quantityUnit).toBe("BTC");
    expect(state.flow.profile.execution.defaultFeeModel).toBe("basis_points_notional");

    // Switch to CME ES
    c.setFlowProfile("CME:ES");
    state = c.getState();
    expect(state.flow.profile.id).toBe("CME:ES");
    expect(state.flow.profile.identity.symbol).toBe("ES");
    expect(state.flow.profile.units.quoteCurrency).toBe("USD");
    expect(state.flow.profile.execution.pnlModel).toBe("point_multiplier");
    expect(state.flow.profile.execution.contractMultiplier).toBe(50);

    // Switch to Binance Futures
    c.setFlowProfile("BINANCE:BTCUSDT-FUTURES");
    state = c.getState();
    expect(state.flow.profile.id).toBe("BINANCE:BTCUSDT-FUTURES");
    expect(state.flow.profile.pricing.pricePrecision).toBe(1);
    expect(state.flow.profile.pricing.tickSize).toBe(0.1);
  });

  test("3. Controller generateFlowScenario respects the active MarketProfile", () => {
    const c = new TapeLabController();
    c.setFlowProfile("BINANCE:BTCUSDT-SPOT");
    c.generateFlowScenario("spring");

    const state = c.getState();
    expect(state.flow.active).toBe(true);
    expect(state.flow.profile.id).toBe("BINANCE:BTCUSDT-SPOT");
    expect(state.flow.isRealData).toBe(false);
    expect(state.flow.source).toBe("Synthetic Training Data");
    // Mid price should be in the crypto range (~65,000) not NQ (~18,000)
    expect(state.flow.priceSeries.length).toBeGreaterThan(0);
    expect(state.flow.priceSeries[0].price).toBeGreaterThan(40000);
  });

  test("4. Currency formatting respects USD prefix vs crypto quote currency suffix", () => {
    expect(formatCurrency(1234.5, "USD")).toBe("$1,234.50");
    expect(formatCurrency(-50, "USD")).toBe("-$50.00");
    expect(formatSignedCurrency(1234.5, "USD")).toBe("+$1,234.50");
    expect(formatSignedCurrency(-50, "USD")).toBe("-$50.00");
    expect(formatSignedCurrency(0, "USD")).toBe("$0.00");

    expect(formatCurrency(1234.5, "USDT")).toBe("1,234.50 USDT");
    expect(formatCurrency(-50, "USDT")).toBe("-50.00 USDT");
    expect(formatSignedCurrency(1234.5, "USDT")).toBe("+1,234.50 USDT");
    expect(formatSignedCurrency(-50, "USDT")).toBe("-50.00 USDT");
  });

  test("5. Candlestick series options configure priceFormat from MarketProfile", () => {
    const nqOpts = getCandlestickSeriesOptions(PROFILE_CME_NQ);
    expect(nqOpts.priceFormat).toEqual({
      type: "price",
      precision: 2,
      minMove: 0.25,
    });

    const btcFutOpts = getCandlestickSeriesOptions(PROFILE_BINANCE_BTCUSDT_FUTURES);
    expect(btcFutOpts.priceFormat).toEqual({
      type: "price",
      precision: 1,
      minMove: 0.1,
    });

    const btcSpotOpts = getCandlestickSeriesOptions(PROFILE_BINANCE_BTCUSDT_SPOT);
    expect(btcSpotOpts.priceFormat).toEqual({
      type: "price",
      precision: 2,
      minMove: 0.01,
    });
  });

  test("6. Chart markers adapt trade exit labels using profile quote currency", () => {
    const trades = [
      {
        tradeId: 1,
        side: "LONG" as const,
        quantity: 1,
        entryTimestamp: 1000,
        exitTimestamp: 2000,
        entryPrice: 65000,
        exitPrice: 65100,
        netPnL: 100,
        mfe: 120,
        mae: 10,
      },
    ];

    const usdMarkers = adaptFlowMarkers({
      trades,
      currency: "USD",
      isBlind: false,
      priceSeries: [{ t: 1000, price: 65000 }, { t: 2000, price: 65100 }],
    });
    const exitUsd = usdMarkers.find((m) => m.id === "exit-1");
    expect(exitUsd?.text).toBe("+$100.00");

    const usdtMarkers = adaptFlowMarkers({
      trades,
      currency: "USDT",
      isBlind: false,
      priceSeries: [{ t: 1000, price: 65000 }, { t: 2000, price: 65100 }],
    });
    const exitUsdt = usdtMarkers.find((m) => m.id === "exit-1");
    expect(exitUsdt?.text).toBe("+100.00 USDT");
  });

  test("7. Verification: no fake live crypto order book data is introduced", () => {
    const c = new TapeLabController();
    c.setFlowProfile("BINANCE:BTCUSDT-SPOT");
    c.generateFlowScenario("absorption");
    const flow = c.getState().flow;

    // Must be truthfully declared synthetic
    expect(flow.isRealData).toBe(false);
    expect(flow.source).toBe("Synthetic Training Data");
    // Ensure book levels match crypto tick scale (0.01)
    if (flow.book) {
      const topBid = flow.book.bids[0];
      const secondBid = flow.book.bids[1];
      if (topBid && secondBid) {
        const gap = Math.round((topBid.price - secondBid.price) * 100) / 100;
        expect(gap).toBeGreaterThanOrEqual(0.01);
      }
    }
  });

  test("8. Registry provides all four certified reference profiles for the UI selector", () => {
    const profiles = listMarketProfiles();
    expect(profiles.length).toBe(4);
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain("CME:NQ");
    expect(ids).toContain("CME:ES");
    expect(ids).toContain("BINANCE:BTCUSDT-SPOT");
    expect(ids).toContain("BINANCE:BTCUSDT-FUTURES");
  });

  test("9. Switching markets cleanly resets session, position, and book tracking", () => {
    const c = new TapeLabController();
    c.setFlowProfile("CME:NQ");
    c.generateFlowScenario("spring");

    // Open a long position in NQ
    c.flowBuy();
    let state = c.getState();
    expect(state.flow.position.side).toBe("LONG");
    expect(state.flow.position.quantity).toBe(1);

    // Switch market to Binance Spot
    c.setFlowProfile("BINANCE:BTCUSDT-SPOT");
    state = c.getState();

    // Verify session regenerated with a fresh flat position
    expect(state.flow.profile.id).toBe("BINANCE:BTCUSDT-SPOT");
    expect(state.flow.position.side).toBe("FLAT");
    expect(state.flow.position.quantity).toBe(0);
    expect(state.flow.position.realizedPnL).toBe(0);
    expect(state.flow.position.unrealizedPnL).toBe(0);
  });

  test("10. Profile switching resets replay progress and clears DOM diffs repeatedly", () => {
    const c = new TapeLabController();
    c.generateFlowScenario("spring");
    c.stepFlow(8);

    let state = c.getState().flow;
    expect(state.eventIndex).toBe(68);
    expect(state.bookChanges.length).toBeGreaterThan(0);

    for (const profileId of ["CME:ES", "BINANCE:BTCUSDT-SPOT", "BINANCE:BTCUSDT-FUTURES", "CME:NQ"]) {
      c.setFlowProfile(profileId);
      state = c.getState().flow;

      expect(state.profile.id).toBe(profileId);
      expect(state.eventIndex).toBe(0);
      expect(state.atStart).toBe(true);
      expect(state.bookChanges).toEqual([]);
      expect(state.position.side).toBe("FLAT");

      c.stepFlow(1);
      expect(c.getState().flow.eventIndex).toBe(1);
    }
  });
});
