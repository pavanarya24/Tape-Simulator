import { describe, expect, test } from "bun:test";
import { BinanceAdapter, type BinanceRawMessage } from "../src/flow/ingest";

const snapshot = (lastUpdateId: number, time: number): BinanceRawMessage => ({
  type: "snapshot",
  E: time,
  s: "BTCUSDT",
  lastUpdateId,
  bids: [["60000", "2"]],
  asks: [["60001", "3"]],
});

const depth = (U: number, u: number, time: number): BinanceRawMessage => ({
  e: "depthUpdate",
  E: time,
  s: "BTCUSDT",
  U,
  u,
  b: [["60000", String(u)]],
  a: [],
});

describe("Phase 10-J — replay quality certification", () => {
  test("requires a fresh snapshot after each independent sequence gap", () => {
    const adapter = new BinanceAdapter();
    const raw: BinanceRawMessage[] = [
      snapshot(100, 1000),
      depth(101, 101, 1010),
      depth(105, 105, 1050), // gap: book must be discarded
      depth(106, 106, 1060), // ignored while unanchored
      snapshot(200, 2000),
      depth(201, 201, 2010),
      depth(205, 205, 2050), // second gap
      depth(206, 206, 2060), // ignored while unanchored
      snapshot(300, 3000),
      depth(301, 301, 3010),
    ];

    const { events, report } = adapter.normalize(raw, {
      market: "spot",
      symbol: "BTCUSDT",
      strict: false,
    });

    expect(report.sequenceGapCount).toBe(2);
    expect(events.filter((event) => event.kind === "book-reset")).toHaveLength(5);
    expect(events.some((event) => event.kind === "depth-delta" && event.price === 60000 && event.size === 106)).toBe(false);
    expect(events.some((event) => event.kind === "depth-delta" && event.price === 60000 && event.size === 206)).toBe(false);
    expect(events.some((event) => event.kind === "depth-delta" && event.price === 60000 && event.size === 201)).toBe(true);
    expect(events.some((event) => event.kind === "depth-delta" && event.price === 60000 && event.size === 301)).toBe(true);
  });

  test("produces byte-for-byte equivalent normalized events and report values for a fixed capture", () => {
    const adapter = new BinanceAdapter();
    const raw: BinanceRawMessage[] = [
      snapshot(100, 1000),
      depth(101, 101, 1010),
      depth(104, 104, 1040),
      snapshot(200, 2000),
      depth(201, 201, 2010),
      { e: "aggTrade", E: 2020, T: 2020, s: "BTCUSDT", a: 7, p: "60000.5", q: "0.25", m: false },
    ];

    const a = adapter.normalize(raw, { market: "spot", symbol: "BTCUSDT", strict: false });
    const b = adapter.normalize(raw, { market: "spot", symbol: "BTCUSDT", strict: false });

    expect(a.events).toEqual(b.events);
    expect(a.report).toEqual(b.report);
    expect(a.report.sequenceGapCount).toBe(1);
    expect(a.report.normalizedEventCount).toBe(a.events.length);
  });

  test("keeps genuine-capture certification bounded to recorded fixture evidence", async () => {
    const { loadBinanceGenuineSpotFeed, loadDatabentoGenuineNqFeed, loadBinanceHistoricalTradesFeed } = await import("../src/flow/ingest/fixtures");
    const spot = loadBinanceGenuineSpotFeed();
    const nq = loadDatabentoGenuineNqFeed();
    const trades = loadBinanceHistoricalTradesFeed();

    for (const feed of [spot, nq, trades]) {
      expect(feed.validationReport).toBeDefined();
      expect(feed.validationReport!.normalizedEventCount).toBe(feed.totalEvents());
      expect(feed.validationReport!.recordCount).toBeGreaterThan(0);
    }
    expect(spot.capabilities.hasDepth).toBe(true);
    expect(nq.capabilities.hasDepth).toBe(true);
    expect(trades.capabilities.hasDepth).toBe(false);
    expect(trades.capabilities.hasQuotes).toBe(false);
  });
});
