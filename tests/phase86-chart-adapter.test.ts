import { describe, expect, test } from "bun:test";
import {
  adaptAmaToLineData,
  adaptCvdToSeriesData,
  adaptFlowMarkers,
  adaptPriceSeriesToCandles,
  adaptVolumeProfile,
  adaptVwapToLineData,
  getAmaSeriesOptions,
  getCandlestickSeriesOptions,
  getCvdSeriesOptions,
  getProfessionalChartOptions,
  getVwapSeriesOptions,
  toCandlestickData,
  ANNOTATION_COLORS,
  CHART_THEME,
} from "../src/flow/chartAdapter";
import type { FlowCandle, FlowChartTrade } from "../src/components/FlowChart";
import { FlowChartToolbar } from "../src/components/FlowChartToolbar";
import {
  enterChartFullscreen,
  exitChartFullscreen,
  isFullscreenSupported,
  isElementFullscreen,
} from "../src/flow/chartFullscreen";
import type { FlowAnnotation } from "../src/flow/recognition";
import type { UTCTimestamp } from "lightweight-charts";
import { renderToStaticMarkup } from "react-dom/server";

describe("Phase 8.6-A Chart Adapter", () => {
  test("empty series yields empty candlestick data", () => {
    expect(adaptPriceSeriesToCandles([])).toEqual([]);
    expect(toCandlestickData([])).toEqual([]);
  });

  test("single trade yields a single candlestick with equal OHLC", () => {
    const t0 = 1704465000000;
    const price = 17825.5;
    const result = adaptPriceSeriesToCandles([{ t: t0, price }]);
    expect(result.length).toBe(1);
    expect(result[0].open).toBe(price);
    expect(result[0].high).toBe(price);
    expect(result[0].low).toBe(price);
    expect(result[0].close).toBe(price);
    expect(result[0].time).toBe(Math.floor(t0 / 1000));
  });

  test("multiple trades in a bucket form correct OHLC structure", () => {
    const t0 = 1704465000000;
    const candle: FlowCandle = {
      t: t0,
      o: 100,
      h: 105,
      l: 95,
      c: 102,
      n: 4,
    };
    const result = toCandlestickData([candle]);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual({
      time: Math.floor(t0 / 1000),
      open: 100,
      high: 105,
      low: 95,
      close: 102,
    });
  });

  test("all adapted candle timestamps are strictly monotonically increasing", () => {
    const t0 = 1704465000000;
    const points: Array<{ t: number; price: number }> = [];
    for (let i = 0; i < 200; i++) {
      points.push({
        t: t0 + i * 250,
        price: 17800 + Math.sin(i / 5) * 10,
      });
    }
    const candles = adaptPriceSeriesToCandles(points);
    expect(candles.length).toBeGreaterThan(1);
    for (let i = 1; i < candles.length; i++) {
      expect((candles[i].time as number)).toBeGreaterThan((candles[i - 1].time as number));
    }
  });

  test("rapid clustered trades within the same second are enforced to strictly ascending time", () => {
    const t0 = 1704465000000;
    const candles: FlowCandle[] = [
      { t: t0 + 100, o: 100, h: 101, l: 99, c: 100, n: 1 },
      { t: t0 + 300, o: 100, h: 102, l: 100, c: 102, n: 1 },
      { t: t0 + 700, o: 102, h: 103, l: 101, c: 103, n: 1 },
    ];
    const adapted = toCandlestickData(candles);
    expect(adapted.length).toBe(3);
    expect(adapted[1].time as number).toBeGreaterThan(adapted[0].time as number);
    expect(adapted[2].time as number).toBeGreaterThan(adapted[1].time as number);
  });

  test("coarseContext coarsens candle aggregation", () => {
    const t0 = 1704465000000;
    const points: Array<{ t: number; price: number }> = [];
    for (let i = 0; i < 500; i++) {
      points.push({
        t: t0 + i * 500,
        price: 17800 + (i % 20),
      });
    }
    const standard = adaptPriceSeriesToCandles(points, { coarseContext: false });
    const coarse = adaptPriceSeriesToCandles(points, { coarseContext: true });
    expect(coarse.length).toBeLessThan(standard.length);
  });

  test("professional chart options match terminal aesthetics", () => {
    const opts = getProfessionalChartOptions(1000, 500);
    expect(opts.width).toBe(1000);
    expect(opts.height).toBe(500);
    expect(opts.layout?.background?.color).toBe(CHART_THEME.bg);
    expect(opts.layout?.textColor).toBe(CHART_THEME.text);
    expect(opts.rightPriceScale?.visible).toBe(true);
    expect(opts.timeScale?.timeVisible).toBe(true);
    expect(opts.timeScale?.secondsVisible).toBe(true);
    expect(opts.handleScroll).toBe(true);
    expect(opts.handleScale).toBe(true);
  });

  test("candlestick series options adhere to Tape Lab color tokens", () => {
    const opts = getCandlestickSeriesOptions();
    expect(opts.upColor).toBe(CHART_THEME.up);
    expect(opts.downColor).toBe(CHART_THEME.down);
    expect(opts.borderUpColor).toBe(CHART_THEME.up);
    expect(opts.borderDownColor).toBe(CHART_THEME.down);
    expect(opts.wickUpColor).toBe(CHART_THEME.up);
    expect(opts.wickDownColor).toBe(CHART_THEME.down);
  });
});

describe("Phase 8.6-B Technical Indicator Overlays (VWAP & AMA)", () => {
  const t0 = 1704465000000;
  const mockCandles = [
    { time: 1704465000 as UTCTimestamp, open: 17800, high: 17805, low: 17798, close: 17802 },
    { time: 1704465005 as UTCTimestamp, open: 17802, high: 17810, low: 17801, close: 17808 },
    { time: 1704465010 as UTCTimestamp, open: 17808, high: 17815, low: 17807, close: 17814 },
  ];

  test("VWAP mapping produces line points aligned with candle timestamps", () => {
    const vwapValue = 17805.25;
    const lineData = adaptVwapToLineData(vwapValue, mockCandles);
    expect(lineData.length).toBe(mockCandles.length);
    for (let i = 0; i < lineData.length; i++) {
      expect(lineData[i].time).toBe(mockCandles[i].time);
      expect(lineData[i].value).toBe(vwapValue);
    }
  });

  test("VWAP mapping safely handles null, undefined, zero, negative, and empty candles", () => {
    expect(adaptVwapToLineData(null, mockCandles)).toEqual([]);
    expect(adaptVwapToLineData(undefined, mockCandles)).toEqual([]);
    expect(adaptVwapToLineData(0, mockCandles)).toEqual([]);
    expect(adaptVwapToLineData(-100, mockCandles)).toEqual([]);
    expect(adaptVwapToLineData(NaN, mockCandles)).toEqual([]);
    expect(adaptVwapToLineData(17800, [])).toEqual([]);
    expect(adaptVwapToLineData(17800, undefined)).toEqual([]);
  });

  test("VWAP line series visual options match specifications", () => {
    const opts = getVwapSeriesOptions();
    expect(opts.color).toBe(CHART_THEME.vwap);
    expect(opts.title).toBe("VWAP");
    expect(opts.lineStyle).toBeDefined();
    expect(opts.priceLineVisible).toBe(true);
  });

  test("AMA mapping produces line points aligned with candle timestamps", () => {
    const rawCandles: FlowCandle[] = [
      { t: t0, o: 17800, h: 17805, l: 17798, c: 17802, n: 2 },
      { t: t0 + 5000, o: 17802, h: 17810, l: 17801, c: 17808, n: 2 },
      { t: t0 + 10000, o: 17808, h: 17815, l: 17807, c: 17814, n: 2 },
    ];
    const amaPoints = [
      { t: t0 + 1000, value: 17801.5 },
      { t: t0 + 3000, value: 17802.25 },
      { t: t0 + 6000, value: 17805.0 },
      { t: t0 + 9000, value: 17807.5 },
      { t: t0 + 12000, value: 17812.0 },
    ];
    const lineData = adaptAmaToLineData(amaPoints, mockCandles, 5000, rawCandles);
    expect(lineData.length).toBe(3);
    expect(lineData[0].time).toBe(mockCandles[0].time);
    expect(lineData[0].value).toBe(17802.25);
    expect(lineData[1].time).toBe(mockCandles[1].time);
    expect(lineData[1].value).toBe(17807.5);
    expect(lineData[2].time).toBe(mockCandles[2].time);
    expect(lineData[2].value).toBe(17812.0);
  });

  test("AMA mapping safely handles null, undefined, empty list, and NaN warmup values", () => {
    expect(adaptAmaToLineData(null, mockCandles)).toEqual([]);
    expect(adaptAmaToLineData(undefined, mockCandles)).toEqual([]);
    expect(adaptAmaToLineData([], mockCandles)).toEqual([]);

    // AMA points with NaN during initial warmup period
    const rawCandles: FlowCandle[] = [
      { t: t0, o: 17800, h: 17805, l: 17798, c: 17802, n: 1 },
      { t: t0 + 5000, o: 17802, h: 17810, l: 17801, c: 17808, n: 1 },
      { t: t0 + 10000, o: 17808, h: 17815, l: 17807, c: 17814, n: 1 },
    ];
    const amaPointsWithWarmup = [
      { t: t0 + 1000, value: NaN },
      { t: t0 + 6000, value: NaN },
      { t: t0 + 11000, value: 17810.5 },
    ];
    const lineData = adaptAmaToLineData(amaPointsWithWarmup, mockCandles, 5000, rawCandles);
    // Only the third candle has a valid warmup-completed AMA value
    expect(lineData.length).toBe(1);
    expect(lineData[0].time).toBe(mockCandles[2].time);
    expect(lineData[0].value).toBe(17810.5);
  });

  test("standalone AMA mapping ensures strictly ascending timestamps", () => {
    const rawPoints = [
      { t: t0 + 100, value: 100.5 },
      { t: t0 + 200, value: 101.2 },
      { t: t0 + 1500, value: 102.0 },
    ];
    const lineData = adaptAmaToLineData(rawPoints);
    expect(lineData.length).toBe(3);
    for (let i = 1; i < lineData.length; i++) {
      expect((lineData[i].time as number)).toBeGreaterThan((lineData[i - 1].time as number));
    }
  });

  test("AMA line series visual options match specifications", () => {
    const opts = getAmaSeriesOptions();
    expect(opts.color).toBe(CHART_THEME.ama);
    expect(opts.title).toBe("AMA");
    expect(opts.lineWidth).toBe(2);
  });

  test("blind-mode safety: gated indicator values produce empty line data and never reveal future prints", () => {
    // When indicators are gated off by policy or user toggle, null is passed upstream
    const vwapGated = null;
    const amaGated = null;
    expect(adaptVwapToLineData(vwapGated, mockCandles)).toEqual([]);
    expect(adaptAmaToLineData(amaGated, mockCandles)).toEqual([]);

    // AMA points past the current revealed candle window are never emitted
    const rawCandles: FlowCandle[] = [
      { t: t0, o: 17800, h: 17805, l: 17798, c: 17802, n: 1 },
    ];
    const singleCandle = [mockCandles[0]];
    const pointsWithFuture = [
      { t: t0 + 1000, value: 17800.0 },
      // Future prints that have not yet occurred in the revealed candle window
      { t: t0 + 60000, value: 18000.0 },
    ];
    const lineData = adaptAmaToLineData(pointsWithFuture, singleCandle, 5000, rawCandles);
    expect(lineData.length).toBe(1);
    expect(lineData[0].value).toBe(17800.0);
  });

  test("replay synchronization: progressing candle count keeps overlays synchronized", () => {
    const rawCandles: FlowCandle[] = [
      { t: t0, o: 17800, h: 17805, l: 17798, c: 17802, n: 1 },
      { t: t0 + 5000, o: 17802, h: 17810, l: 17801, c: 17808, n: 1 },
    ];
    const step1Candles = [mockCandles[0]];
    const step2Candles = [mockCandles[0], mockCandles[1]];

    const vwap1 = adaptVwapToLineData(17802, step1Candles);
    const vwap2 = adaptVwapToLineData(17805, step2Candles);
    expect(vwap1.length).toBe(1);
    expect(vwap2.length).toBe(2);
    expect(vwap2[1].value).toBe(17805);

    const amaPoints = [
      { t: t0 + 2000, value: 17801 },
      { t: t0 + 7000, value: 17806 },
    ];
    const ama1 = adaptAmaToLineData(amaPoints, step1Candles, 5000, [rawCandles[0]]);
    const ama2 = adaptAmaToLineData(amaPoints, step2Candles, 5000, rawCandles);
    expect(ama1.length).toBe(1);
    expect(ama1[0].value).toBe(17801);
    expect(ama2.length).toBe(2);
    expect(ama2[1].value).toBe(17806);
  });
});

describe("Phase 8.6-C CVD and Volume Profile Integration", () => {
  const t0 = 1704465000000;
  const mockCandles = [
    { time: 1704465000 as UTCTimestamp, open: 17800, high: 17805, low: 17798, close: 17802 },
    { time: 1704465005 as UTCTimestamp, open: 17802, high: 17810, low: 17801, close: 17808 },
    { time: 1704465010 as UTCTimestamp, open: 17808, high: 17815, low: 17807, close: 17814 },
  ];
  const rawCandles: FlowCandle[] = [
    { t: t0, o: 17800, h: 17805, l: 17798, c: 17802, n: 3 },
    { t: t0 + 5000, o: 17802, h: 17810, l: 17801, c: 17808, n: 4 },
    { t: t0 + 10000, o: 17808, h: 17815, l: 17807, c: 17814, n: 3 },
  ];

  test("CVD mapping handles empty, null, or undefined data safely", () => {
    expect(adaptCvdToSeriesData(null, mockCandles)).toEqual([]);
    expect(adaptCvdToSeriesData(undefined, mockCandles)).toEqual([]);
    expect(adaptCvdToSeriesData([], mockCandles)).toEqual([]);
    expect(adaptCvdToSeriesData([10, 20], [])).toEqual([]);
  });

  test("CVD mapping produces points synchronized with candle timestamps and trade counts", () => {
    // 10 trades total across the 3 candles (3 in c0, 4 in c1, 3 in c2)
    const cvdValues = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
    const series = adaptCvdToSeriesData(cvdValues, mockCandles, {
      tradeCount: 10,
      rawCandles,
    });
    expect(series.length).toBe(3);
    expect(series[0].time).toBe(mockCandles[0].time);
    expect(series[0].value).toBe(15); // end of candle 0 (trade 3)
    expect(series[1].time).toBe(mockCandles[1].time);
    expect(series[1].value).toBe(35); // end of candle 1 (trade 7)
    expect(series[2].time).toBe(mockCandles[2].time);
    expect(series[2].value).toBe(50); // end of candle 2 (trade 10)
  });

  test("CVD timestamps are strictly monotonically increasing", () => {
    const cvdValues = Array.from({ length: 50 }, (_, i) => i * 4 - 100);
    const series = adaptCvdToSeriesData(cvdValues, mockCandles);
    expect(series.length).toBe(3);
    for (let i = 1; i < series.length; i++) {
      expect((series[i].time as number)).toBeGreaterThan((series[i - 1].time as number));
    }
  });

  test("truncated CVD series safely omits candles outside retained window without fabricating data", () => {
    // 10 trades total, but only the last 4 are retained in cvdSeries
    const truncatedCvd = [35, 40, 45, 50];
    const series = adaptCvdToSeriesData(truncatedCvd, mockCandles, {
      tradeCount: 10,
      rawCandles,
    });
    // Candle 1 ended at trade 7 (index 6 - 6 = 0 in truncated -> 35)
    // Candle 2 ended at trade 10 (index 9 - 6 = 3 in truncated -> 50)
    expect(series.length).toBe(2);
    expect(series[0].time).toBe(mockCandles[1].time);
    expect(series[0].value).toBe(35);
    expect(series[1].time).toBe(mockCandles[2].time);
    expect(series[1].value).toBe(50);
  });

  test("CVD visual options adhere to design tokens", () => {
    const opts = getCvdSeriesOptions();
    expect(opts.lineColor).toBe(CHART_THEME.cvd);
    expect(opts.title).toBe("CVD");
    expect(opts.lineWidth).toBe(2);
  });

  test("blind-mode safety: CVD gated off emits empty series and does not expose future prints", () => {
    expect(adaptCvdToSeriesData(null, mockCandles)).toEqual([]);
    // Single candle revealed in blind mode
    const singleCandle = [mockCandles[0]];
    const cvdAll = [10, 20, 30, 40, 50];
    const series = adaptCvdToSeriesData(cvdAll, singleCandle, {
      tradeCount: 3,
      rawCandles: [rawCandles[0]],
    });
    expect(series.length).toBe(1);
    expect(series[0].value).toBe(30);
  });

  test("Volume Profile mapping produces structured render data preserving all original values", () => {
    const profile = [
      { price: 17800.0, buy: 120, sell: 80, total: 200 },
      { price: 17800.25, buy: 300, sell: 100, total: 400 },
      { price: 17800.5, buy: 50, sell: 50, total: 100 },
    ];
    const data = adaptVolumeProfile(profile);
    expect(data.maxTotal).toBe(400);
    expect(data.formattedMax).toBe("400");
    expect(data.items.length).toBe(3);

    // Level 0: 200 total (50% width of 400 peak)
    expect(data.items[0].price).toBe(17800.0);
    expect(data.items[0].buy).toBe(120);
    expect(data.items[0].sell).toBe(80);
    expect(data.items[0].total).toBe(200);
    expect(data.items[0].buyPct).toBe(60);
    expect(data.items[0].sellPct).toBe(40);
    expect(data.items[0].widthPct).toBe(50);

    // Level 1: 400 total (100% width of peak)
    expect(data.items[1].widthPct).toBe(100);
    expect(data.items[1].buyPct).toBe(75);
    expect(data.items[1].sellPct).toBe(25);
  });

  test("Volume Profile mapping handles null, undefined, empty, and edge cases safely", () => {
    expect(adaptVolumeProfile(null)).toEqual({ items: [], maxTotal: 0, formattedMax: "0" });
    expect(adaptVolumeProfile(undefined)).toEqual({ items: [], maxTotal: 0, formattedMax: "0" });
    expect(adaptVolumeProfile([])).toEqual({ items: [], maxTotal: 0, formattedMax: "0" });

    // Single price level with zero sell
    const single = [{ price: 17800.0, buy: 50, sell: 0, total: 50 }];
    const res = adaptVolumeProfile(single);
    expect(res.maxTotal).toBe(50);
    expect(res.items.length).toBe(1);
    expect(res.items[0].buyPct).toBe(100);
    expect(res.items[0].sellPct).toBe(0);
    expect(res.items[0].widthPct).toBe(100);
  });
});

describe("Phase 8.6-D Chart Markers", () => {
  const baseT = 1704465000000;
  // Synthetic 120-event price series, 1-second intervals
  const testPoints = Array.from({ length: 120 }, (_, i) => ({
    t: baseT + i * 1000,
    price: 17800 + (i % 10) * 0.25,
  }));
  const rawCandles = toCandlestickData(
    Array.from({ length: 120 }, (_, i) => ({
      t: baseT + i * 1000,
      o: 17800,
      h: 17805,
      l: 17795,
      c: 17800,
      n: 1,
    })),
  );

  test("1. marker mapping: maps annotations and trades into valid Lightweight Charts markers", () => {
    const annotations: FlowAnnotation[] = [
      { t: baseT + 5000, seq: 5, type: "sweep", label: "sweep", interpretive: false },
    ];
    const trades: FlowChartTrade[] = [
      {
        tradeId: 1,
        side: "LONG",
        quantity: 2,
        entryTimestamp: baseT + 10000,
        exitTimestamp: baseT + 20000,
        entryPrice: 17800,
        exitPrice: 17810,
        netPnL: 100,
        mfe: 12,
        mae: -2,
      },
    ];

    const markers = adaptFlowMarkers({
      annotations,
      trades,
      priceSeries: testPoints.slice(0, 30),
      candles: rawCandles.slice(0, 30),
      rawCandles: Array.from({ length: 30 }, (_, i) => ({
        t: baseT + i * 1000,
        o: 17800,
        h: 17805,
        l: 17795,
        c: 17800,
        n: 1,
      })),
      isBlind: false,
    });

    expect(markers.length).toBe(3); // 1 annotation + 1 entry + 1 exit
    expect(markers[0].id).toBe("ann-5");
    expect(markers[1].id).toBe("entry-1");
    expect(markers[2].id).toBe("exit-1");
  });

  test("2. timestamp ordering: output markers are strictly non-decreasing in horizontal scale time", () => {
    const annotations: FlowAnnotation[] = [
      { t: baseT + 25000, seq: 25, type: "divergence", label: "div", interpretive: false },
      { t: baseT + 5000, seq: 5, type: "aggression", label: "aggr", interpretive: false },
      { t: baseT + 15000, seq: 15, type: "concentration", label: "conc", interpretive: false },
    ];
    const trades: FlowChartTrade[] = [
      {
        tradeId: 10,
        side: "SHORT",
        quantity: 1,
        entryTimestamp: baseT + 8000,
        exitTimestamp: baseT + 22000,
        entryPrice: 17805,
        exitPrice: 17800,
        netPnL: 50,
        mfe: 6,
        mae: -1,
      },
    ];

    const markers = adaptFlowMarkers({
      annotations,
      trades,
      priceSeries: testPoints.slice(0, 30),
      isBlind: false,
    });

    expect(markers.length).toBe(5);
    for (let i = 1; i < markers.length; i++) {
      expect((markers[i].time as number)).toBeGreaterThanOrEqual((markers[i - 1].time as number));
    }
  });

  test("3. replay progression & future gating: event 100 vs event 101 strict boundary", () => {
    // Session events 0..110
    // Event 100 timestamp is baseT + 100,000
    // Event 101 timestamp is baseT + 101,000
    const pointsAt100 = testPoints.slice(0, 101); // 0..100 (101 points, ending at index 100: baseT + 100,000)
    const pointsAt101 = testPoints.slice(0, 102); // 0..101 (102 points, ending at index 101: baseT + 101,000)

    const annotations: FlowAnnotation[] = [
      { t: baseT + 50000, seq: 50, type: "aggression", label: "aggr", interpretive: false },
      { t: baseT + 100000, seq: 100, type: "sweep", label: "sweep", interpretive: false },
      { t: baseT + 101000, seq: 101, type: "breakout", label: "breakout", interpretive: false },
    ];

    const trades: FlowChartTrade[] = [
      {
        tradeId: 1,
        side: "LONG",
        quantity: 1,
        entryTimestamp: baseT + 20000,
        exitTimestamp: baseT + 80000,
        entryPrice: 17800,
        exitPrice: 17810,
        netPnL: 100,
        mfe: 10,
        mae: 0,
      },
      {
        tradeId: 2,
        side: "SHORT",
        quantity: 1,
        entryTimestamp: baseT + 90000,
        exitTimestamp: baseT + 101000,
        entryPrice: 17810,
        exitPrice: 17805,
        netPnL: 50,
        mfe: 7,
        mae: -2,
      },
    ];

    // --- At Replay Event 100 in BLIND mode ---
    const blind100 = adaptFlowMarkers({
      annotations,
      trades: null, // policy-gated null in blind mode
      priceSeries: pointsAt100,
      isBlind: true,
    });
    // Must contain exactly event 50 and event 100 annotations. No event 101 annotation. No trade markers.
    expect(blind100.length).toBe(2);
    expect(blind100.map((m) => m.id)).toEqual(["ann-50", "ann-100"]);

    // --- At Replay Event 101 in BLIND mode ---
    const blind101 = adaptFlowMarkers({
      annotations,
      trades: null,
      priceSeries: pointsAt101,
      isBlind: true,
    });
    // Newly eligible event 101 annotation now appears!
    expect(blind101.length).toBe(3);
    expect(blind101.map((m) => m.id)).toEqual(["ann-50", "ann-100", "ann-101"]);

    // --- At Replay Event 100 in REVIEW mode ---
    const review100 = adaptFlowMarkers({
      annotations,
      trades,
      priceSeries: pointsAt100,
      isBlind: false,
    });
    // Observable by event 100:
    // - ann-50 (t=50k)
    // - ann-100 (t=100k)
    // - entry-1 (t=20k)
    // - exit-1 (t=80k)
    // - entry-2 (t=90k)
    // - BUT NOT exit-2 (t=101k)! Because trade 2 has not closed yet at event 100!
    // - AND NOT ann-101 (t=101k)!
    expect(review100.length).toBe(5);
    expect(review100.some((m) => m.id === "exit-2")).toBe(false);
    expect(review100.some((m) => m.id === "ann-101")).toBe(false);

    // --- At Replay Event 101 in REVIEW mode ---
    const review101 = adaptFlowMarkers({
      annotations,
      trades,
      priceSeries: pointsAt101,
      isBlind: false,
    });
    // Now both ann-101 and exit-2 appear!
    expect(review101.length).toBe(7);
    expect(review101.some((m) => m.id === "exit-2")).toBe(true);
    expect(review101.some((m) => m.id === "ann-101")).toBe(true);
  });

  test("4. entry marker mapping: LONG arrowUp below bar, SHORT arrowDown above bar", () => {
    const trades: FlowChartTrade[] = [
      {
        tradeId: 1,
        side: "LONG",
        quantity: 2,
        entryTimestamp: baseT + 1000,
        exitTimestamp: baseT + 3000,
        entryPrice: 17800,
        exitPrice: 17810,
        netPnL: 200,
        mfe: 10,
        mae: 0,
      },
      {
        tradeId: 2,
        side: "SHORT",
        quantity: 5,
        entryTimestamp: baseT + 2000,
        exitTimestamp: baseT + 4000,
        entryPrice: 17810,
        exitPrice: 17800,
        netPnL: 500,
        mfe: 10,
        mae: 0,
      },
    ];

    const markers = adaptFlowMarkers({
      trades,
      priceSeries: testPoints.slice(0, 10),
      isBlind: false,
    });

    const entryLong = markers.find((m) => m.id === "entry-1")!;
    expect(entryLong.shape).toBe("arrowUp");
    expect(entryLong.position).toBe("belowBar");
    expect(entryLong.color).toBe(CHART_THEME.up);
    expect(entryLong.text).toBe("LONG 2");

    const entryShort = markers.find((m) => m.id === "entry-2")!;
    expect(entryShort.shape).toBe("arrowDown");
    expect(entryShort.position).toBe("aboveBar");
    expect(entryShort.color).toBe(CHART_THEME.down);
    expect(entryShort.text).toBe("SHORT 5");
  });

  test("5. exit marker mapping: circle shape, P&L formatted text, green for profit and red for loss", () => {
    const trades: FlowChartTrade[] = [
      {
        tradeId: 101,
        side: "LONG",
        quantity: 1,
        entryTimestamp: baseT + 1000,
        exitTimestamp: baseT + 2000,
        entryPrice: 17800,
        exitPrice: 17812.5,
        netPnL: 250.0,
        mfe: 13,
        mae: -1,
      },
      {
        tradeId: 102,
        side: "SHORT",
        quantity: 1,
        entryTimestamp: baseT + 3000,
        exitTimestamp: baseT + 4000,
        entryPrice: 17800,
        exitPrice: 17806.25,
        netPnL: -125.5,
        mfe: 2,
        mae: -7,
      },
    ];

    const markers = adaptFlowMarkers({
      trades,
      priceSeries: testPoints.slice(0, 10),
      isBlind: false,
    });

    const exitWin = markers.find((m) => m.id === "exit-101")!;
    expect(exitWin.shape).toBe("circle");
    expect(exitWin.color).toBe(CHART_THEME.up);
    expect(exitWin.text).toBe("+$250.00");
    expect(exitWin.position).toBe("aboveBar");

    const exitLoss = markers.find((m) => m.id === "exit-102")!;
    expect(exitLoss.shape).toBe("circle");
    expect(exitLoss.color).toBe(CHART_THEME.down);
    expect(exitLoss.text).toBe("-$125.50");
    expect(exitLoss.position).toBe("belowBar");
  });

  test("6. evidence/annotation mapping: color tokens match ANNOTATION_COLORS and interpretive labels", () => {
    const annotations: FlowAnnotation[] = [
      { t: baseT + 1000, seq: 1, type: "sweep", label: "sweep", interpretive: false },
      { t: baseT + 2000, seq: 2, type: "breakout", label: "Breakout Buy", interpretive: true },
      { t: baseT + 3000, seq: 3, type: "concentration", label: "concentration", interpretive: false },
    ];

    const markers = adaptFlowMarkers({
      annotations,
      priceSeries: testPoints.slice(0, 10),
      isBlind: false,
    });

    expect(markers.length).toBe(3);
    const m1 = markers.find((m) => m.id === "ann-1")!;
    expect(m1.shape).toBe("circle");
    expect(m1.color).toBe(ANNOTATION_COLORS.sweep);
    expect(m1.position).toBe("inBar");
    expect(m1.text).toBeUndefined();

    const m2 = markers.find((m) => m.id === "ann-2")!;
    expect(m2.shape).toBe("square");
    expect(m2.color).toBe(ANNOTATION_COLORS.breakout);
    expect(m2.position).toBe("inBar");
    expect(m2.text).toBe("BREAKOUT BUY");
  });

  test("7. blind-mode marker gating: strictly rejects trade markers and interpretive annotations", () => {
    const annotations: FlowAnnotation[] = [
      { t: baseT + 1000, seq: 1, type: "aggression", label: "aggr", interpretive: false },
      { t: baseT + 2000, seq: 2, type: "divergence", label: "Hidden Pattern", interpretive: true },
    ];
    const trades: FlowChartTrade[] = [
      {
        tradeId: 1,
        side: "LONG",
        quantity: 1,
        entryTimestamp: baseT + 1000,
        exitTimestamp: baseT + 2000,
        entryPrice: 17800,
        exitPrice: 17810,
        netPnL: 100,
        mfe: 10,
        mae: 0,
      },
    ];

    // Even if trades and interpretive annotations are passed into options, isBlind: true discards them
    const markers = adaptFlowMarkers({
      annotations,
      trades,
      priceSeries: testPoints.slice(0, 10),
      isBlind: true,
    });

    expect(markers.length).toBe(1);
    expect(markers[0].id).toBe("ann-1");
    expect(markers[0].text).toBeUndefined();
  });

  test("8. reveal/review marker behavior: handles toggles for annotations and trades independently", () => {
    const annotations: FlowAnnotation[] = [
      { t: baseT + 1000, seq: 1, type: "rejection", label: "rej", interpretive: false },
    ];
    const trades: FlowChartTrade[] = [
      {
        tradeId: 1,
        side: "LONG",
        quantity: 1,
        entryTimestamp: baseT + 2000,
        exitTimestamp: baseT + 3000,
        entryPrice: 17800,
        exitPrice: 17810,
        netPnL: 100,
        mfe: 10,
        mae: 0,
      },
    ];

    // Turn trade markers off
    const noTrades = adaptFlowMarkers({
      annotations,
      trades,
      showTradeMarkers: false,
      priceSeries: testPoints.slice(0, 10),
      isBlind: false,
    });
    expect(noTrades.length).toBe(1);
    expect(noTrades[0].id).toBe("ann-1");

    // Turn annotations off
    const noAnns = adaptFlowMarkers({
      annotations,
      trades,
      showAnnotations: false,
      priceSeries: testPoints.slice(0, 10),
      isBlind: false,
    });
    expect(noAnns.length).toBe(2);
    expect(noAnns.map((m) => m.id)).toEqual(["entry-1", "exit-1"]);
  });

  test("9. empty marker sets: handles empty arrays, missing fields, and empty priceSeries safely", () => {
    expect(adaptFlowMarkers({})).toEqual([]);
    expect(adaptFlowMarkers({ annotations: [], trades: [] })).toEqual([]);
    expect(adaptFlowMarkers({ annotations: null, trades: null })).toEqual([]);
    expect(
      adaptFlowMarkers({
        annotations: [{ t: baseT + 1000, seq: 1, type: "sweep", label: "s", interpretive: false }],
        priceSeries: [], // No revealed prints
      }),
    ).toEqual([]);
  });

  test("10. invalid/missing timestamps: skips non-finite, negative, or malformed timestamps without crashing", () => {
    const annotations: FlowAnnotation[] = [
      { t: NaN, seq: 1, type: "sweep", label: "bad", interpretive: false },
      { t: -100, seq: 2, type: "sweep", label: "negative", interpretive: false },
      { t: Infinity, seq: 3, type: "sweep", label: "inf", interpretive: false },
      { t: baseT + 2000, seq: 4, type: "replenishment", label: "valid", interpretive: false },
    ];
    const trades: FlowChartTrade[] = [
      {
        tradeId: 1,
        side: "LONG",
        quantity: 1,
        entryTimestamp: NaN,
        exitTimestamp: baseT + 3000,
        entryPrice: 17800,
        exitPrice: 17810,
        netPnL: 100,
        mfe: 10,
        mae: 0,
      },
    ];

    const markers = adaptFlowMarkers({
      annotations,
      trades,
      priceSeries: testPoints.slice(0, 10),
      isBlind: false,
    });

    expect(markers.length).toBe(2);
    expect(markers.map((m) => m.id)).toEqual(["ann-4", "exit-1"]);
  });
});

describe("Phase 8.6-E Chart Toolbar & Fullscreen UX", () => {
  const defaultToolbarProps = {
    showVwap: true,
    onToggleVwap: () => {},
    showAma: true,
    onToggleAma: () => {},
    showCvd: true,
    onToggleCvd: () => {},
    showProfile: true,
    onToggleProfile: () => {},
    showAnnotations: true,
    onToggleAnnotations: () => {},
    showTradeMarkers: true,
    onToggleTradeMarkers: () => {},
    tradeMarkersAllowed: true,
    isFullscreen: false,
    onToggleFullscreen: () => {},
    currentAma: 17820.5,
    workspaceMode: "expanded" as const,
    onToggleWorkspaceMode: () => {},
  };

  test("1. toolbar renders accessible container with role=toolbar and aria-label", () => {
    const html = renderToStaticMarkup(FlowChartToolbar(defaultToolbarProps));
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Chart indicators and view controls"');
    expect(html).toContain("flow-chart-toolbar");
  });

  test("2. indicator visibility controls render on/off states and aria-pressed attributes", () => {
    // All on
    const htmlOn = renderToStaticMarkup(FlowChartToolbar(defaultToolbarProps));
    expect(htmlOn).toContain('aria-pressed="true"');
    expect(htmlOn).toContain("VWAP");
    expect(htmlOn).toContain("AMA");
    expect(htmlOn).toContain("CVD");
    expect(htmlOn).toContain("Profile");
    expect(htmlOn).toContain("Evidence");
    expect(htmlOn).toContain("Trades");

    // All off
    const htmlOff = renderToStaticMarkup(
      FlowChartToolbar({
        ...defaultToolbarProps,
        showVwap: false,
        showAma: false,
        showCvd: false,
        showProfile: false,
        showAnnotations: false,
        showTradeMarkers: false,
      }),
    );
    expect(htmlOff).toContain('aria-pressed="false"');
  });

  test("3. trade markers button is disabled with explanation when not allowed by policy (blind mode)", () => {
    const html = renderToStaticMarkup(
      FlowChartToolbar({
        ...defaultToolbarProps,
        tradeMarkersAllowed: false,
      }),
    );
    expect(html).toContain("disabled");
    expect(html).toContain("Entry/exit markers unlock after Reveal");
  });

  test("4. fullscreen button toggles between enter and exit states with accessible labels", () => {
    // Normal windowed state
    const htmlNormal = renderToStaticMarkup(
      FlowChartToolbar({
        ...defaultToolbarProps,
        isFullscreen: false,
      }),
    );
    expect(htmlNormal).toContain("FULLSCREEN ⛶");
    expect(htmlNormal).toContain('aria-label="Enter fullscreen chart mode"');
    expect(htmlNormal).toContain('aria-pressed="false"');

    // Fullscreen active
    const htmlFs = renderToStaticMarkup(
      FlowChartToolbar({
        ...defaultToolbarProps,
        isFullscreen: true,
      }),
    );
    expect(htmlFs).toContain("EXIT ⤢");
    expect(htmlFs).toContain('aria-label="Exit fullscreen chart mode"');
    expect(htmlFs).toContain('aria-pressed="true"');
  });

  test("5. current AMA badge renders formatted value when provided", () => {
    const htmlWithAma = renderToStaticMarkup(
      FlowChartToolbar({
        ...defaultToolbarProps,
        currentAma: 17825.25,
      }),
    );
    expect(htmlWithAma).toContain("AMA 17,825.25");

    const htmlNullAma = renderToStaticMarkup(
      FlowChartToolbar({
        ...defaultToolbarProps,
        currentAma: null,
      }),
    );
    expect(htmlNullAma).toContain("AMA —");
  });

  test("6. fullscreen fallback applies pseudo-fullscreen class when native API is unavailable", async () => {
    // Create a mock element
    const classList = new Set<string>();
    const mockElement = {
      classList: {
        add: (cls: string) => classList.add(cls),
        remove: (cls: string) => classList.delete(cls),
        contains: (cls: string) => classList.has(cls),
      },
    } as unknown as HTMLElement;

    expect(isElementFullscreen(mockElement)).toBe(false);

    // Call enterChartFullscreen (fallback mode)
    const result = await enterChartFullscreen(mockElement);
    expect(result).toBe(false); // indicates fallback class used
    expect(isElementFullscreen(mockElement)).toBe(true);
    expect(classList.has("flow-chart-pseudo-fullscreen")).toBe(true);

    // Call exitChartFullscreen
    await exitChartFullscreen(mockElement);
    expect(isElementFullscreen(mockElement)).toBe(false);
    expect(classList.has("flow-chart-pseudo-fullscreen")).toBe(false);
  });

  test("7. fullscreen fallback catches rejected native promises gracefully", async () => {
    const classList = new Set<string>();
    const mockElement = {
      requestFullscreen: async () => {
        throw new Error("Permissions check failed");
      },
      classList: {
        add: (cls: string) => classList.add(cls),
        remove: (cls: string) => classList.delete(cls),
        contains: (cls: string) => classList.has(cls),
      },
    } as unknown as HTMLElement;

    // Must not crash or re-throw; falls back to pseudo-fullscreen class
    const result = await enterChartFullscreen(mockElement);
    expect(result).toBe(false);
    expect(isElementFullscreen(mockElement)).toBe(true);
  });

  test("8. resize event is dispatched during fullscreen transitions", async () => {
    let resizeFired = false;
    const listener = () => {
      resizeFired = true;
    };
    if (typeof window !== "undefined") {
      window.addEventListener("resize", listener);
    }

    const classList = new Set<string>();
    const mockElement = {
      classList: {
        add: (cls: string) => classList.add(cls),
        remove: (cls: string) => classList.delete(cls),
        contains: (cls: string) => classList.has(cls),
      },
    } as unknown as HTMLElement;

    await enterChartFullscreen(mockElement);
    if (typeof window !== "undefined") {
      expect(resizeFired).toBe(true);
      window.removeEventListener("resize", listener);
    }
  });

  test("9. workspace mode toggle button renders correct mode text", () => {
    const htmlExp = renderToStaticMarkup(
      FlowChartToolbar({
        ...defaultToolbarProps,
        workspaceMode: "expanded",
      }),
    );
    expect(htmlExp).toContain("COMPACT ⤡");

    const htmlComp = renderToStaticMarkup(
      FlowChartToolbar({
        ...defaultToolbarProps,
        workspaceMode: "compact",
      }),
    );
    expect(htmlComp).toContain("EXPAND ⤢");
  });

  test("10. toolbar controls do not modify session data or compromise blind-mode gating", () => {
    // Marker adaptation honors showTradeMarkers and trade gating
    const baseT = 1704465000000;
    const trades: FlowChartTrade[] = [
      {
        tradeId: 1,
        side: "LONG",
        quantity: 1,
        entryTimestamp: baseT + 1000,
        exitTimestamp: baseT + 2000,
        entryPrice: 17800,
        exitPrice: 17810,
        netPnL: 100,
        mfe: 10,
        mae: 0,
      },
    ];

    // In blind mode (isBlind: true), trade markers are completely forbidden
    const blindMarkers = adaptFlowMarkers({
      trades,
      priceSeries: [{ t: baseT + 1000, price: 17800 }, { t: baseT + 2000, price: 17810 }],
      isBlind: true,
      showTradeMarkers: true,
    });
    expect(blindMarkers).toEqual([]);

    // In review mode, showTradeMarkers: false toggles them off cleanly
    const toggledOff = adaptFlowMarkers({
      trades,
      priceSeries: [{ t: baseT + 1000, price: 17800 }, { t: baseT + 2000, price: 17810 }],
      isBlind: false,
      showTradeMarkers: false,
    });
    expect(toggledOff).toEqual([]);
  });
});


