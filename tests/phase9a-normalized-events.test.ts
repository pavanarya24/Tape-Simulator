import { describe, expect, test } from "bun:test";
import {
  compareNormalizedEvents,
  deserializeNormalizedEvent,
  isBookReset,
  isDepthDelta,
  isL2,
  isQuote,
  isTrade,
  serializeNormalizedEvent,
  toEventNanos,
  validateNormalizedEvent,
  type BookResetEvent,
  type DepthDeltaEvent,
  type MarketEvent,
  type NormalizedMarketEvent,
  type QuoteEvent,
  type TradeEvent,
} from "../src/flow/events";
import { SyntheticMarketDataFeed } from "../src/flow/synthetic";
import { OrderFlowEngine } from "../src/flow/orderFlow";
import { DOMEngine } from "../src/flow/dom";
import { TrainingEngine } from "../src/flow/training";

describe("Phase 9-A Normalized Microstructure Event Model", () => {
  const baseTs = 1710514200000;

  // 1. Normalized trade event
  test("1. normalized trade event adheres to contract with instrument, dual timestamps, and matchId", () => {
    const trade: TradeEvent = {
      kind: "trade",
      timestamp: baseTs + 500,
      sequence: 101,
      symbol: "NQ",
      price: 17825.25,
      size: 5,
      aggressorSide: "BUY",
      tsEventNanos: 1710514200500123456n,
      tsRecvNanos: 1710514200500456789n,
      matchId: "M-987654",
    };

    expect(isTrade(trade)).toBe(true);
    expect(isDepthDelta(trade)).toBe(false);
    expect(trade.symbol).toBe("NQ");
    expect(trade.price).toBe(17825.25);
    expect(trade.size).toBe(5);
    expect(trade.aggressorSide).toBe("BUY");
    expect(trade.matchId).toBe("M-987654");
    expect(trade.tsEventNanos).toBe(1710514200500123456n);
    expect(trade.tsRecvNanos).toBe(1710514200500456789n);

    const validation = validateNormalizedEvent(trade);
    expect(validation.valid).toBe(true);
  });

  // 2. Normalized quote event
  test("2. normalized quote event captures top-of-book state and sizes with instrument identity", () => {
    const quote: QuoteEvent = {
      kind: "quote",
      timestamp: baseTs + 100,
      sequence: 10,
      symbol: "ES",
      bid: 5120.25,
      bidSize: 45,
      ask: 5120.5,
      askSize: 60,
      tsEventNanos: "1710514200100999000",
    };

    expect(isQuote(quote)).toBe(true);
    expect(quote.symbol).toBe("ES");
    expect(quote.bid).toBe(5120.25);
    expect(quote.ask).toBe(5120.5);
    expect(quote.bidSize).toBe(45);
    expect(quote.askSize).toBe(60);

    const validation = validateNormalizedEvent(quote);
    expect(validation.valid).toBe(true);
  });

  // 3. Normalized depth ADD
  test("3. normalized depth ADD represents incremental order book resting liquidity introduction", () => {
    const depthAdd: DepthDeltaEvent = {
      kind: "depth-delta",
      timestamp: baseTs + 200,
      sequence: 25,
      symbol: "NQ",
      side: "bid",
      action: "add",
      price: 17825.0,
      size: 15,
      orderCount: 3,
      tsEventNanos: 1710514200200000100n,
    };

    expect(isDepthDelta(depthAdd)).toBe(true);
    expect(depthAdd.action).toBe("add");
    expect(depthAdd.side).toBe("bid");
    expect(depthAdd.price).toBe(17825.0);
    expect(depthAdd.size).toBe(15);
    expect(depthAdd.orderCount).toBe(3);

    const validation = validateNormalizedEvent(depthAdd);
    expect(validation.valid).toBe(true);
  });

  // 4. Normalized depth MODIFY
  test("4. normalized depth MODIFY represents order size or order count changes at a price level", () => {
    const depthMod: DepthDeltaEvent = {
      kind: "depth-delta",
      timestamp: baseTs + 250,
      sequence: 30,
      symbol: "NQ",
      side: "ask",
      action: "modify",
      price: 17826.0,
      size: 28,
      orderCount: 4,
    };

    expect(isDepthDelta(depthMod)).toBe(true);
    expect(depthMod.action).toBe("modify");
    expect(depthMod.side).toBe("ask");
    expect(depthMod.price).toBe(17826.0);
    expect(depthMod.size).toBe(28);

    const validation = validateNormalizedEvent(depthMod);
    expect(validation.valid).toBe(true);
  });

  // 5. Normalized depth DELETE
  test("5. normalized depth DELETE represents complete cancellation or exhaustion of a price level", () => {
    const depthDel: DepthDeltaEvent = {
      kind: "depth-delta",
      timestamp: baseTs + 300,
      sequence: 35,
      symbol: "NQ",
      side: "bid",
      action: "delete",
      price: 17824.5,
      size: 0,
      orderCount: 0,
    };

    expect(isDepthDelta(depthDel)).toBe(true);
    expect(depthDel.action).toBe("delete");
    expect(depthDel.price).toBe(17824.5);
    expect(depthDel.size).toBe(0);

    const validation = validateNormalizedEvent(depthDel);
    expect(validation.valid).toBe(true);
  });

  // 6. Book reset
  test("6. book reset event satisfies contract and resets market state", () => {
    const reset: BookResetEvent = {
      kind: "book-reset",
      timestamp: baseTs,
      sequence: 1,
      symbol: "NQ",
      tsEventNanos: 1710514200000000000n,
    };

    expect(isBookReset(reset)).toBe(true);
    expect(reset.sequence).toBe(1);

    const validation = validateNormalizedEvent(reset);
    expect(validation.valid).toBe(true);
  });

  // 7. Instrument identity
  test("7. instrument identity differentiates events across multiple contracts without conflict", () => {
    const nqTrade: TradeEvent = {
      kind: "trade",
      timestamp: baseTs,
      sequence: 1,
      symbol: "NQ",
      price: 17800,
      size: 1,
      aggressorSide: "BUY",
    };
    const esTrade: TradeEvent = {
      kind: "trade",
      timestamp: baseTs,
      sequence: 2,
      symbol: "ES",
      price: 5120,
      size: 10,
      aggressorSide: "SELL",
    };

    expect(nqTrade.symbol).toBe("NQ");
    expect(esTrade.symbol).toBe("ES");
    expect(nqTrade.symbol).not.toBe(esTrade.symbol);
  });

  // 8. Timestamp preservation (nanoseconds and milliseconds)
  test("8. timestamp preservation: converts milliseconds and nanoseconds faithfully without float truncation", () => {
    // Pure millisecond event
    const msEvent: TradeEvent = {
      kind: "trade",
      timestamp: baseTs + 500,
      sequence: 1,
      price: 100,
      size: 1,
      aggressorSide: "BUY",
    };
    expect(toEventNanos(msEvent)).toBe(BigInt(baseTs + 500) * 1_000_000n);

    // Explicit bigint nanosecond event
    const nanoBigIntEvent: TradeEvent = {
      ...msEvent,
      tsEventNanos: 1710514200500123456n,
    };
    expect(toEventNanos(nanoBigIntEvent)).toBe(1710514200500123456n);

    // String nanosecond event (e.g. from JSON fixture file)
    const nanoStringEvent: TradeEvent = {
      ...msEvent,
      tsEventNanos: "1710514200500987654",
    };
    expect(toEventNanos(nanoStringEvent)).toBe(1710514200500987654n);
  });

  // 9. Sequence preservation
  test("9. sequence preservation maintains strict monotonic event counter", () => {
    const events: NormalizedMarketEvent[] = [
      { kind: "book-reset", timestamp: baseTs, sequence: 1 },
      { kind: "quote", timestamp: baseTs + 1, sequence: 2, bid: 100, ask: 101, bidSize: 10, askSize: 10 },
      { kind: "trade", timestamp: baseTs + 2, sequence: 3, price: 101, size: 2, aggressorSide: "BUY" },
    ];

    for (let i = 0; i < events.length; i++) {
      expect(events[i].sequence).toBe(i + 1);
    }
  });

  // 10. Deterministic ordering
  test("10. deterministic ordering resolves sub-second bursts by nanoseconds, sequence, and event priority", () => {
    // Four events occurring within the exact same millisecond timestamp
    const tSame = baseTs + 500;
    const ev1: DepthDeltaEvent = {
      kind: "depth-delta",
      timestamp: tSame,
      sequence: 5,
      side: "bid",
      action: "add",
      price: 100,
      size: 10,
      tsEventNanos: 1710514200500000100n,
    };
    const ev2: DepthDeltaEvent = {
      kind: "depth-delta",
      timestamp: tSame,
      sequence: 6,
      side: "bid",
      action: "modify",
      price: 100,
      size: 20,
      tsEventNanos: 1710514200500000200n,
    };
    const ev3: QuoteEvent = {
      kind: "quote",
      timestamp: tSame,
      sequence: 7,
      bid: 100,
      ask: 101,
      bidSize: 20,
      askSize: 15,
      tsEventNanos: 1710514200500000300n,
    };
    const ev4: TradeEvent = {
      kind: "trade",
      timestamp: tSame,
      sequence: 8,
      price: 101,
      size: 5,
      aggressorSide: "BUY",
      tsEventNanos: 1710514200500000400n,
    };

    // Scramble order
    const scrambled = [ev4, ev2, ev1, ev3];
    scrambled.sort(compareNormalizedEvents);

    expect(scrambled).toEqual([ev1, ev2, ev3, ev4]);
  });

  // 11. Serialization / Deserialization
  test("11. serialization and deserialization preserves bigints and passes schema validation", () => {
    const original: DepthDeltaEvent = {
      kind: "depth-delta",
      timestamp: baseTs + 150,
      sequence: 42,
      symbol: "NQ",
      side: "bid",
      action: "add",
      price: 17825.25,
      size: 25,
      orderCount: 5,
      tsEventNanos: 1710514200150999888n,
      tsRecvNanos: 1710514200151000111n,
    };

    const json = serializeNormalizedEvent(original);
    expect(typeof json).toBe("string");
    expect(json).toContain('"tsEventNanos":"1710514200150999888"');

    const restored = deserializeNormalizedEvent(json) as DepthDeltaEvent;
    expect(restored.kind).toBe("depth-delta");
    expect(restored.price).toBe(17825.25);
    expect(restored.size).toBe(25);
    expect(restored.orderCount).toBe(5);
    expect(toEventNanos(restored)).toBe(1710514200150999888n);
  });

  // 12. Synthetic compatibility
  test("12. synthetic compatibility: existing SyntheticMarketDataFeed produces valid normalized events", () => {
    const feed = new SyntheticMarketDataFeed({ seed: 12345 });
    const events = feed.events();
    expect(events.length).toBeGreaterThan(100);

    for (const ev of events.slice(0, 50)) {
      const validation = validateNormalizedEvent(ev);
      expect(validation.valid).toBe(true);
      expect(isTrade(ev) || isL2(ev) || isBookReset(ev) || isQuote(ev)).toBe(true);
      expect(toEventNanos(ev)).toBe(BigInt(ev.timestamp) * 1_000_000n);
    }
  });

  // 13. Existing MarketEvent compatibility & downstream engine handling
  test("13. downstream engines process normalized events without regression", () => {
    const ofEngine = new OrderFlowEngine();
    const domEngine = new DOMEngine();

    const trade: TradeEvent = {
      kind: "trade",
      timestamp: baseTs,
      sequence: 1,
      symbol: "NQ",
      price: 17800.0,
      size: 10,
      aggressorSide: "BUY",
      tsEventNanos: 1710514200000000000n,
    };
    const depth: DepthDeltaEvent = {
      kind: "depth-delta",
      timestamp: baseTs + 5,
      sequence: 2,
      symbol: "NQ",
      side: "bid",
      action: "add",
      price: 17799.75,
      size: 20,
    };

    // Both OrderFlowEngine and DOMEngine safely accept NormalizedMarketEvent (MarketEvent)
    ofEngine.processEvent(trade);
    ofEngine.processEvent(depth); // unknown kind for OF engine ignored gracefully
    domEngine.processEvent(trade);
    domEngine.processEvent(depth); // depth-delta ignored gracefully until Phase 9-E/book engine

    const ofSnap = ofEngine.snapshot();
    expect(ofSnap.totalBuyVolume).toBe(10);
    expect(ofSnap.lastPrice).toBe(17800.0);
    expect(ofSnap.sequence).toBe(1);
  });

  // 14. Malformed/invalid values handling
  test("14. validation catches malformed, negative, or un-parseable values", () => {
    expect(validateNormalizedEvent(null).valid).toBe(false);
    expect(validateNormalizedEvent("not an object").valid).toBe(false);
    expect(validateNormalizedEvent({ kind: "trade", timestamp: -1, sequence: 1 }).valid).toBe(false);
    expect(validateNormalizedEvent({ kind: "trade", timestamp: 100, sequence: 0 }).valid).toBe(false);
    expect(validateNormalizedEvent({ kind: "trade", timestamp: 100, sequence: 1, price: NaN, size: 5, aggressorSide: "BUY" }).valid).toBe(false);
    expect(validateNormalizedEvent({ kind: "trade", timestamp: 100, sequence: 1, price: 100, size: -5, aggressorSide: "BUY" }).valid).toBe(false);
    expect(validateNormalizedEvent({ kind: "trade", timestamp: 100, sequence: 1, price: 100, size: 5, aggressorSide: "INVALID" }).valid).toBe(false);
    expect(validateNormalizedEvent({ kind: "depth-delta", timestamp: 100, sequence: 1, side: "invalid", action: "add", price: 100, size: 5 }).valid).toBe(false);
    expect(validateNormalizedEvent({ kind: "unknown-kind", timestamp: 100, sequence: 1 }).valid).toBe(false);
  });
});
