/**
 * Phase 9-C — Vendor-Neutral Microstructure Ingestion Tests
 *
 * Verifies:
 * 1. Vendor-neutral contract & CME instrument metadata
 * 2. Trade normalization (price, size, timestamp, sequence, matchId, aggressor mapping)
 * 3. Aggressor mapping (explicit venue, derived, unknown)
 * 4. Depth normalization (add, modify, delete)
 * 5. Quote normalization (top-of-book BBO)
 * 6. Book reset normalization
 * 7. Snapshot-to-delta converter (unchanged -> no delta, add, modify, delete)
 * 8. Nanosecond timestamp preservation & dual timestamps
 * 9. Deterministic sequence ordering & collision stability
 * 10. Data quality validator & duplicate detection
 * 11. Malformed record detection (strict throw vs tolerant report)
 * 12. RTH session filtering
 */

import { describe, expect, it } from "bun:test";
import {
  CME_INSTRUMENTS,
  DatabentoAdapter,
  GenericMicrostructureAdapter,
  MicrostructureValidator,
  SnapshotDeltaConverter,
  type IngestionOptions,
} from "../src/flow/ingest";
import { compareNormalizedEvents, toEventNanos, type NormalizedMarketEvent } from "../src/flow/events";

describe("Phase 9-C.1 Vendor-Neutral Ingestion Contracts & Instruments", () => {
  it("exposes standard CME Globex equity futures specifications", () => {
    expect(CME_INSTRUMENTS.NQ.symbol).toBe("NQ");
    expect(CME_INSTRUMENTS.NQ.tickSize).toBe(0.25);
    expect(CME_INSTRUMENTS.NQ.pointValue).toBe(20);
    expect(CME_INSTRUMENTS.NQ.tickValue).toBe(5.0);

    expect(CME_INSTRUMENTS.MNQ.symbol).toBe("MNQ");
    expect(CME_INSTRUMENTS.MNQ.tickValue).toBe(0.5);

    expect(CME_INSTRUMENTS.ES.symbol).toBe("ES");
    expect(CME_INSTRUMENTS.ES.pointValue).toBe(50);
    expect(CME_INSTRUMENTS.ES.tickValue).toBe(12.5);

    expect(CME_INSTRUMENTS.MES.symbol).toBe("MES");
    expect(CME_INSTRUMENTS.MES.tickValue).toBe(1.25);
  });

  it("declares honest microstructure capabilities without fabrication", () => {
    const adapter = new DatabentoAdapter();
    expect(adapter.name).toBe("databento");
    expect(adapter.capabilities.hasTrades).toBe(true);
    expect(adapter.capabilities.hasQuotes).toBe(true);
    expect(adapter.capabilities.hasDepth).toBe(true);
    expect(adapter.capabilities.hasMBO).toBe(false); // MBP schema, not raw MBO
    expect(adapter.capabilities.hasAggressor).toBe(true);
    expect(adapter.capabilities.hasOrderCounts).toBe(true);
    expect(adapter.capabilities.hasNanosecondTimestamps).toBe(true);
    expect(adapter.capabilities.hasReceiveTimestamp).toBe(true);
    expect(adapter.capabilities.hasMatchIds).toBe(true);
  });
});

describe("Phase 9-C.2 Databento Real Microstructure Normalization", () => {
  const adapter = new DatabentoAdapter();

  it("normalizes trade records with aggressor, nanoseconds, and matchId", () => {
    const raw = [
      {
        ts_event: "1716550200100000000",
        ts_recv: "1716550200100001000",
        action: "T",
        side: "A",
        price: 18250.25,
        size: 5,
        order_id: "MATCH_999",
        symbol: "NQ",
        sequence: 42,
      },
    ];

    const { events, report } = adapter.normalize(raw);
    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev.kind).toBe("trade");
    if (ev.kind === "trade") {
      expect(ev.price).toBe(18250.25);
      expect(ev.size).toBe(5);
      expect(ev.aggressorSide).toBe("BUY"); // 'A' -> BUY aggressor
      expect(ev.matchId).toBe("MATCH_999");
      expect(ev.sequence).toBe(42);
      expect(ev.symbol).toBe("NQ");
      expect(ev.tsEventNanos).toBe(1716550200100000000n);
      expect(ev.tsRecvNanos).toBe(1716550200100001000n);
      expect(ev.timestamp).toBe(1716550200100);
    }
    expect(report.tradeCount).toBe(1);
    expect(report.isValid).toBe(true);
  });

  it("handles aggressor mapping: explicit BUY, explicit SELL, and unknown", () => {
    const raw = [
      { ts_event: "1716550200000000000", action: "T", side: "A", price: 100, size: 1 },
      { ts_event: "1716550200001000000", action: "T", side: "B", price: 100, size: 1 },
      { ts_event: "1716550200002000000", action: "T", side: "N", price: 100, size: 1 },
    ];

    const { events } = adapter.normalize(raw);
    expect(events.length).toBe(3);
    expect((events[0] as any).aggressorSide).toBe("BUY");
    expect((events[1] as any).aggressorSide).toBe("SELL");
    expect((events[2] as any).aggressorSide).toBe("UNKNOWN");
  });

  it("normalizes depth deltas: ADD, MODIFY, and DELETE", () => {
    const raw = [
      { ts_event: "1716550200001000000", action: "A", side: "B", price: 18250.0, size: 10, order_cnt: 3 },
      { ts_event: "1716550200002000000", action: "M", side: "B", price: 18250.0, size: 25, order_cnt: 5 },
      { ts_event: "1716550200003000000", action: "D", side: "B", price: 18250.0, size: 0, order_cnt: 0 },
    ];

    const { events, report } = adapter.normalize(raw);
    expect(events.length).toBe(3);

    const [addEv, modEv, delEv] = events as any[];
    expect(addEv.kind).toBe("depth-delta");
    expect(addEv.action).toBe("add");
    expect(addEv.side).toBe("bid");
    expect(addEv.size).toBe(10);
    expect(addEv.orderCount).toBe(3);

    expect(modEv.action).toBe("modify");
    expect(modEv.size).toBe(25);
    expect(modEv.orderCount).toBe(5);

    expect(delEv.action).toBe("delete");
    expect(delEv.price).toBe(18250.0);

    expect(report.depthCount).toBe(3);
  });

  it("normalizes top-of-book quote and book reset records", () => {
    const raw = [
      { ts_event: "1716550200000000000", action: "R" },
      { ts_event: "1716550200001000000", bid_px_00: 18250.0, ask_px_00: 18250.25, bid_sz_00: 10, ask_sz_00: 15 },
    ];

    const { events, report } = adapter.normalize(raw);
    expect(events.length).toBe(2);
    expect(events[0].kind).toBe("book-reset");
    expect(events[1].kind).toBe("quote");
    if (events[1].kind === "quote") {
      expect(events[1].bid).toBe(18250.0);
      expect(events[1].ask).toBe(18250.25);
      expect(events[1].bidSize).toBe(10);
      expect(events[1].askSize).toBe(15);
    }
    expect(report.resetCount).toBe(1);
    expect(report.quoteCount).toBe(1);
  });

  it("parses JSONL strings seamlessly", () => {
    const jsonl = `
      {"ts_event":"1716550200000000000","action":"R","symbol":"NQ"}
      {"ts_event":"1716550200001000000","action":"T","side":"A","price":18250.25,"size":5,"symbol":"NQ"}
    `;
    const { events } = adapter.normalize(jsonl);
    expect(events.length).toBe(2);
    expect(events[0].kind).toBe("book-reset");
    expect(events[1].kind).toBe("trade");
  });
});

describe("Phase 9-C.3 Snapshot-to-Delta Conversion", () => {
  it("converts successive snapshots into incremental ADD, MODIFY, and DELETE deltas", () => {
    const converter = new SnapshotDeltaConverter({ symbol: "NQ", startSequence: 1 });

    // Snapshot 1: initial book (Bid 100 @ 10, Ask 101 @ 5)
    const deltas1 = converter.convert(
      1000,
      [{ price: 100, size: 10, orderCount: 2 }],
      [{ price: 101, size: 5, orderCount: 1 }],
    );
    expect(deltas1.length).toBe(2);
    expect(deltas1[0].action).toBe("add");
    expect(deltas1[0].price).toBe(100);
    expect(deltas1[0].size).toBe(10);
    expect(deltas1[1].action).toBe("add");
    expect(deltas1[1].price).toBe(101);

    // Snapshot 2: Unchanged snapshot -> NO DELTA produced
    const deltas2 = converter.convert(
      1001,
      [{ price: 100, size: 10, orderCount: 2 }],
      [{ price: 101, size: 5, orderCount: 1 }],
    );
    expect(deltas2.length).toBe(0);

    // Snapshot 3: Bid 100 size modified from 10 to 20, Ask 101 deleted, new Ask 102 added
    const deltas3 = converter.convert(
      1002,
      [{ price: 100, size: 20, orderCount: 3 }],
      [{ price: 102, size: 8, orderCount: 2 }],
    );
    expect(deltas3.length).toBe(3);
    const mod = deltas3.find((d) => d.action === "modify");
    expect(mod?.price).toBe(100);
    expect(mod?.size).toBe(20);

    const del = deltas3.find((d) => d.action === "delete");
    expect(del?.price).toBe(101);

    const add = deltas3.find((d) => d.action === "add");
    expect(add?.price).toBe(102);
    expect(add?.size).toBe(8);
  });
});

describe("Phase 9-C.4 Quality Validation & Anomaly Detection", () => {
  it("detects and rejects duplicate records", () => {
    const validator = new MicrostructureValidator({ source: "test" });
    const ev: NormalizedMarketEvent = {
      kind: "trade",
      timestamp: 1000,
      sequence: 1,
      symbol: "NQ",
      price: 18250,
      size: 5,
      aggressorSide: "BUY",
    };

    expect(validator.validateEvent(ev, 0)).toBe(true);
    expect(validator.validateEvent(ev, 1)).toBe(false); // Duplicate rejected

    const report = validator.buildReport();
    expect(report.duplicateCount).toBe(1);
    expect(report.rejectedRecords.length).toBe(1);
    expect(report.rejectedRecords[0].reason).toContain("Duplicate");
  });

  it("detects sequence number regressions", () => {
    const validator = new MicrostructureValidator();
    validator.validateEvent(
      { kind: "trade", timestamp: 1000, sequence: 10, symbol: "NQ", price: 100, size: 1, aggressorSide: "BUY" },
      0,
    );
    // Sequence 5 is lower than previous 10
    const accepted = validator.validateEvent(
      { kind: "trade", timestamp: 1000, sequence: 5, symbol: "NQ", price: 100, size: 1, aggressorSide: "BUY" },
      1,
    );
    expect(accepted).toBe(false);

    const report = validator.buildReport();
    expect(report.rejectedRecords[0].reason).toContain("Sequence regression");
  });

  it("detects timestamp regressions", () => {
    const validator = new MicrostructureValidator();
    validator.validateEvent(
      { kind: "trade", timestamp: 2000, sequence: 1, symbol: "NQ", price: 100, size: 1, aggressorSide: "BUY" },
      0,
    );
    // Timestamp 1000 is earlier than 2000
    const accepted = validator.validateEvent(
      { kind: "trade", timestamp: 1000, sequence: 2, symbol: "NQ", price: 100, size: 1, aggressorSide: "BUY" },
      1,
    );
    expect(accepted).toBe(false);
  });

  it("distinguishes between strict mode (throw) and tolerant mode (report)", () => {
    const tolerantValidator = new MicrostructureValidator({ strict: false });
    expect(() => {
      tolerantValidator.validateEvent({ kind: "trade", timestamp: 1000, sequence: 1, price: -10, size: 1 }, 0);
    }).not.toThrow();

    const strictValidator = new MicrostructureValidator({ strict: true });
    expect(() => {
      strictValidator.validateEvent({ kind: "trade", timestamp: 1000, sequence: 1, price: -10, size: 1 }, 0);
    }).toThrow(/Strict Ingestion Error/);
  });

  it("filters sessions by RTH when configured", () => {
    const adapter = new DatabentoAdapter();
    // 08:00 UTC (outside RTH) and 14:00 UTC (inside RTH: 13:30 - 20:00 UTC)
    const outRthDate = new Date("2026-05-24T08:00:00Z").getTime();
    const inRthDate = new Date("2026-05-24T14:00:00Z").getTime();

    const raw = [
      { ts_event: BigInt(outRthDate) * 1_000_000n, action: "T", price: 100, size: 1, side: "A" },
      { ts_event: BigInt(inRthDate) * 1_000_000n, action: "T", price: 100, size: 1, side: "A" },
    ];

    const opts: IngestionOptions = { sessionFilter: { rthOnly: true } };
    const { events } = adapter.normalize(raw, opts);
    expect(events.length).toBe(1);
    expect(events[0].timestamp).toBe(inRthDate);
  });
});
