import { describe, expect, test } from "bun:test";
import { summarizeFeedIntegrity } from "../src/flow/ingest/diagnostics";
import type { IngestionValidationReport } from "../src/flow/ingest/types";

const report = (overrides: Partial<IngestionValidationReport> = {}): IngestionValidationReport => ({
  source: "fixture capture",
  instrument: "BTCUSDT",
  recordCount: 12,
  normalizedEventCount: 10,
  tradeCount: 4,
  depthCount: 6,
  quoteCount: 0,
  resetCount: 1,
  duplicateCount: 1,
  rejectedRecords: [],
  timestampRange: { min: 100, max: 200 },
  sequenceRange: { min: 1, max: 10 },
  capabilities: {
    hasTrades: true, hasQuotes: false, hasDepth: true, hasMBO: false,
    hasAggressor: true, hasOrderCounts: false, hasNanosecondTimestamps: false,
    hasReceiveTimestamp: false, hasMatchIds: false,
  },
  isValid: true,
  sequenceGapCount: 0,
  ...overrides,
});

describe("Phase 10-I — Feed integrity diagnostics", () => {
  test("does not invent a report for synthetic or unreported sources", () => {
    expect(summarizeFeedIntegrity(undefined)).toMatchObject({ status: "not-applicable", recordCount: 0, capabilityLabels: [] });
  });

  test("summarizes adapter counts and only declared capabilities", () => {
    expect(summarizeFeedIntegrity(report())).toMatchObject({
      status: "no-reported-defects", recordCount: 12, normalizedEventCount: 10,
      rejectedCount: 0, duplicateCount: 1, sequenceGapCount: 0,
      capabilityLabels: ["Trades", "L2 depth", "Aggressor side"],
    });
  });

  test("sequence gaps take precedence over tolerant-mode rejections", () => {
    const summary = summarizeFeedIntegrity(report({ sequenceGapCount: 2, rejectedRecords: [
      { recordIndex: 4, reason: "Malformed price" },
    ] }));
    expect(summary.status).toBe("sequence-gaps");
    expect(summary.rejectionReasons).toEqual([{ reason: "Malformed price", count: 1 }]);
  });

  test("aggregates rejection reasons without dropping duplicate or gap counts", () => {
    const summary = summarizeFeedIntegrity(report({
      duplicateCount: 2,
      rejectedRecords: [
        { recordIndex: 2, reason: "Bad timestamp" },
        { recordIndex: 3, reason: "Bad timestamp" },
        { recordIndex: 4, reason: "Invalid size" },
      ],
    }));
    expect(summary.status).toBe("rejections");
    expect(summary.rejectedCount).toBe(3);
    expect(summary.duplicateCount).toBe(2);
    expect(summary.rejectionReasons).toEqual([
      { reason: "Bad timestamp", count: 2 },
      { reason: "Invalid size", count: 1 },
    ]);
  });

  test("marks invalid or empty normalized feeds explicitly", () => {
    expect(summarizeFeedIntegrity(report({ isValid: false })).status).toBe("invalid");
    expect(summarizeFeedIntegrity(report({ normalizedEventCount: 0 })).status).toBe("invalid");
  });
});
