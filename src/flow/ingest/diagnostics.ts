import type { IngestionValidationReport } from "./types";

export type FeedIntegrityStatus = "not-applicable" | "invalid" | "sequence-gaps" | "rejections" | "no-reported-defects";

export interface FeedIntegritySummary {
  status: FeedIntegrityStatus;
  label: string;
  recordCount: number;
  normalizedEventCount: number;
  rejectedCount: number;
  duplicateCount: number;
  sequenceGapCount: number;
  capabilityLabels: string[];
  rejectionReasons: Array<{ reason: string; count: number }>;
}

/** Summarizes adapter-reported evidence without upgrading it to live-feed certification. */
export function summarizeFeedIntegrity(report: IngestionValidationReport | null | undefined): FeedIntegritySummary {
  if (!report) {
    return { status: "not-applicable", label: "Not available for this source", recordCount: 0, normalizedEventCount: 0, rejectedCount: 0, duplicateCount: 0, sequenceGapCount: 0, capabilityLabels: [], rejectionReasons: [] };
  }

  const sequenceGapCount = report.sequenceGapCount ?? 0;
  const rejectedCount = report.rejectedRecords.length;
  const status: FeedIntegrityStatus = !report.isValid || report.normalizedEventCount === 0
    ? "invalid"
    : sequenceGapCount > 0
      ? "sequence-gaps"
      : rejectedCount > 0
        ? "rejections"
        : "no-reported-defects";
  const label: Record<FeedIntegrityStatus, string> = {
    "not-applicable": "Not available for this source",
    invalid: "Invalid or empty normalized feed",
    "sequence-gaps": "Sequence gaps detected",
    rejections: "Rejected records reported",
    "no-reported-defects": "No defects reported by adapter validation",
  };
  const c = report.capabilities;
  const capabilityLabels = [
    c.hasTrades && "Trades",
    c.hasQuotes && "Top of book",
    c.hasDepth && "L2 depth",
    c.hasMBO && "MBO",
    c.hasAggressor && "Aggressor side",
    c.hasOrderCounts && "Order counts",
    c.hasNanosecondTimestamps && "Nanosecond timestamps",
    c.hasReceiveTimestamp && "Receive timestamps",
    c.hasMatchIds && "Match IDs",
  ].filter((value): value is string => typeof value === "string");
  const reasonCounts = new Map<string, number>();
  for (const rejection of report.rejectedRecords) reasonCounts.set(rejection.reason, (reasonCounts.get(rejection.reason) ?? 0) + 1);

  return {
    status,
    label: label[status],
    recordCount: report.recordCount,
    normalizedEventCount: report.normalizedEventCount,
    rejectedCount,
    duplicateCount: report.duplicateCount,
    sequenceGapCount,
    capabilityLabels,
    rejectionReasons: [...reasonCounts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}
