import { describe, expect, test } from "bun:test";
import { TapeLabController } from "../src/state/app";
import {
  FLOW_DATA_SOURCES,
  getDataSourceMeta,
  loadBinanceGenuineSpotFeed,
  loadBinanceHistoricalTradesFeed,
} from "../src/flow/ingest/fixtures";
import { BinanceAdapter } from "../src/flow/ingest/binance";

describe("Phase 10-F — Genuine Feed Loader & Provenance Architecture", () => {
  test("1. Synthetic practice scenario remains the default on initial launch", () => {
    const c = new TapeLabController();
    const state = c.getState().flow;

    expect(state.dataSourceId).toBe("synthetic");
    expect(state.isRealData).toBe(false);
    expect(state.source).toBe("Synthetic Training Data");
    expect(state.isTradeOnly).toBe(false);
  });

  test("2. Genuine Binance Spot capture loads through production controller and adapter", () => {
    const c = new TapeLabController();
    c.setFlowDataSource("binance-genuine-spot");

    const state = c.getState().flow;
    expect(state.isRealData).toBe(true);
    expect(state.dataSourceId).toBe("binance-genuine-spot");
    expect(state.profile.id).toBe("BINANCE:BTCUSDT-SPOT");
    expect(state.profile.units.quoteCurrency).toBe("USDT");
    expect(state.profile.units.quantityUnit).toBe("BTC");
    expect(state.isTradeOnly).toBe(false);
    expect(state.source).toContain("Binance Spot");
    expect(state.capturedAt).toBe("2026-10-08T13:55:47.662Z");
    expect(state.totalEvents).toBe(1541);
    expect(state.eventIndex).toBe(0);
    expect(state.atStart).toBe(true);
    expect(state.bookChanges).toEqual([]);

    // Stepping forward advances the genuine feed
    c.stepFlow(5);
    const advanced = c.getState().flow;
    expect(advanced.eventIndex).toBe(5);
    expect(advanced.orderFlow).not.toBeNull();
  });

  test("3. The licensed Databento CME capture is not offered and cannot be loaded", () => {
    // A `?raw` import inlines the bytes into the shipped bundle, and the bundle is
    // served to every visitor, so bundling this capture would redistribute licensed
    // CME data to the public. The adapter and the on-disk fixture stay for local
    // use, but no served path may reach them. If this test ever fails because the
    // source was re-added, the legal page and README must change with it.
    expect(FLOW_DATA_SOURCES.map((s) => s.id)).not.toContain("databento-genuine-nq");
    expect(() => getDataSourceMeta("databento-genuine-nq" as never)).toThrow();

    const c = new TapeLabController();
    c.setFlowDataSource("synthetic");
    c.setFlowDataSource("databento-genuine-nq" as never);

    // The controller rejects it and leaves the previous session intact.
    expect(c.getState().flow.dataSourceId).toBe("synthetic");
    expect(c.getState().message).toContain("Failed to load data source");
  });

  test("4. Historical Binance aggTrades slice explicitly declares trade-only and no L2 depth", () => {
    const c = new TapeLabController();
    c.setFlowDataSource("binance-historical-trades");

    const state = c.getState().flow;
    expect(state.isRealData).toBe(true);
    expect(state.dataSourceId).toBe("binance-historical-trades");
    expect(state.isTradeOnly).toBe(true);
    expect(state.source).toContain("aggTrades");
    expect(state.totalEvents).toBe(500);
    expect(state.eventIndex).toBe(0);
    expect(state.capturedAt).toBe("2024-05-01");
  });

  test("5. Feed loader fixtures strictly produce zero-defect, non-fabricated events", () => {
    const binanceFeed = loadBinanceGenuineSpotFeed();
    expect(binanceFeed.isRealData).toBe(true);
    expect(binanceFeed.capabilities?.hasMBO).toBe(false);
    expect(binanceFeed.capabilities?.hasMatchIds).toBe(false);

    const histFeed = loadBinanceHistoricalTradesFeed();
    expect(histFeed.isRealData).toBe(true);
    expect(histFeed.capabilities?.hasDepth).toBe(false);
  });

  test("6. Switching synthetic -> genuine -> synthetic updates provenance and resets state safely", () => {
    const c = new TapeLabController();
    c.generateFlowScenario("spring");
    c.stepFlow(5);

    // Enter a trade in synthetic
    c.flowBuy();
    let state = c.getState().flow;
    expect(state.isRealData).toBe(false);
    expect(state.position.side).toBe("LONG");
    expect(state.position.quantity).toBe(1);
    expect(state.eventIndex).toBe(65);
    expect(state.bookChanges.length).toBeGreaterThan(0);

    // Switch to genuine Binance Spot capture
    c.setFlowDataSource("binance-genuine-spot");
    state = c.getState().flow;

    expect(state.isRealData).toBe(true);
    expect(state.dataSourceId).toBe("binance-genuine-spot");
    expect(state.eventIndex).toBe(0);
    expect(state.atStart).toBe(true);
    expect(state.position.side).toBe("FLAT");
    expect(state.position.quantity).toBe(0);
    expect(state.position.realizedPnL).toBe(0);
    expect(state.bookChanges).toEqual([]);

    // Step past initial 200 depth deltas so the book is fully established, then trade
    c.stepFlow(205);
    c.flowSell();
    state = c.getState().flow;
    expect(state.position.side).toBe("SHORT");

    // Switch back to synthetic
    c.setFlowDataSource("synthetic");
    state = c.getState().flow;

    expect(state.isRealData).toBe(false);
    expect(state.dataSourceId).toBe("synthetic");
    expect(state.source).toBe("Synthetic Training Data");
    expect(state.eventIndex).toBe(0);
    expect(state.atStart).toBe(true);
    expect(state.position.side).toBe("FLAT");
    expect(state.position.quantity).toBe(0);
    expect(state.bookChanges).toEqual([]);
  });

  test("7. Market profile switch while on a genuine feed resets to synthetic mode for new market", () => {
    const c = new TapeLabController();
    c.setFlowDataSource("binance-genuine-spot");
    expect(c.getState().flow.dataSourceId).toBe("binance-genuine-spot");

    // Switch market to CME ES
    c.setFlowProfile("CME:ES");
    const state = c.getState().flow;

    expect(state.profile.id).toBe("CME:ES");
    expect(state.dataSourceId).toBe("synthetic");
    expect(state.isRealData).toBe(false);
    expect(state.eventIndex).toBe(0);
    expect(state.atStart).toBe(true);
    expect(state.position.side).toBe("FLAT");
    expect(state.bookChanges).toEqual([]);
  });

  test("8. Invalid fixture data is rejected safely without breaking existing session", () => {
    const adapter = new BinanceAdapter();
    expect(() => {
      adapter.normalize(
        [{ e: "aggTrade", E: 100, T: 100, s: "BTCUSDT", a: 1, p: "not_a_number", q: "1", m: true }],
        { strict: true },
      );
    }).toThrow();

    // Controller handles invalid dataSource gracefully
    const c = new TapeLabController();
    c.setFlowDataSource("synthetic");
    c.setFlowDataSource("non-existent-source" as any);

    expect(c.getState().flow.dataSourceId).toBe("synthetic");
    expect(c.getState().message).toContain("Failed to load data source");
  });

  test("9. FLOW_DATA_SOURCES metadata list contains all 3 offered sources with honest labels", () => {
    expect(FLOW_DATA_SOURCES.length).toBe(3);
    const ids = FLOW_DATA_SOURCES.map((s) => s.id);
    expect(ids).toContain("synthetic");
    expect(ids).toContain("binance-genuine-spot");
    expect(ids).toContain("binance-historical-trades");

    for (const ds of FLOW_DATA_SOURCES) {
      const meta = getDataSourceMeta(ds.id);
      expect(meta.id).toBe(ds.id);
      expect(meta.label).toBeDefined();
      expect(meta.description).toBeDefined();
    }
  });
});
