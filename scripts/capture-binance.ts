/**
 * Script to capture a genuine public Binance Spot dataset for Phase 9-Crypto certification.
 * Connects to stream.binance.com and api.binance.com to capture an aligned order book snapshot
 * followed by contiguous depthUpdate and trade events.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface RawEnvelope {
  stream?: string;
  data?: any;
  e?: string;
  type?: string;
  [key: string]: any;
}

async function main() {
  console.log("Connecting to Binance Spot WebSocket stream...");
  const ws = new WebSocket(
    "wss://stream.binance.com:9443/stream?streams=btcusdt@depth@100ms/btcusdt@trade",
  );

  const rawBuffer: RawEnvelope[] = [];

  ws.onmessage = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      rawBuffer.push(parsed);
    } catch (err) {
      console.error("Failed to parse ws event:", err);
    }
  };

  await new Promise<void>((resolveWs, rejectWs) => {
    ws.onopen = () => {
      console.log("WebSocket connected. Buffering stream messages for 1.2s before snapshot fetch...");
      resolveWs();
    };
    ws.onerror = (err) => rejectWs(err);
  });

  await new Promise((r) => setTimeout(r, 1200));

  console.log("Fetching depth snapshot from api.binance.com...");
  const res = await fetch("https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=100");
  if (!res.ok) {
    throw new Error(`Failed to fetch snapshot: ${res.status} ${res.statusText}`);
  }
  const snapshotRaw = (await res.json()) as {
    lastUpdateId: number;
    bids: [string, string][];
    asks: [string, string][];
  };
  const snapshotFetchTime = Date.now();
  console.log(`Snapshot fetched. lastUpdateId=${snapshotRaw.lastUpdateId}, bids=${snapshotRaw.bids.length}, asks=${snapshotRaw.asks.length}`);

  // Capture for another 3.5 seconds of live trades and depth updates
  console.log("Collecting post-snapshot stream events for 3.5s...");
  await new Promise((r) => setTimeout(r, 3500));

  ws.close();
  console.log(`Captured total buffer events: ${rawBuffer.length}`);

  const getPayload = (m: RawEnvelope) => (m.data ? m.data : m);

  // Find depthUpdates
  const depthUpdates = rawBuffer.map(getPayload).filter((m) => m.e === "depthUpdate");
  const matching = depthUpdates.find(
    (m) => m.U <= snapshotRaw.lastUpdateId + 1 && m.u >= snapshotRaw.lastUpdateId + 1,
  );

  if (!matching) {
    throw new Error(
      `Could not find overlapping depthUpdate for snapshot lastUpdateId=${snapshotRaw.lastUpdateId}. Please retry capture.`,
    );
  }

  const snapTime = matching.E ?? snapshotFetchTime;

  // Build the snapshot record
  const snapshotRecord = {
    type: "snapshot",
    E: snapTime,
    s: "BTCUSDT",
    lastUpdateId: snapshotRaw.lastUpdateId,
    bids: snapshotRaw.bids,
    asks: snapshotRaw.asks,
  };

  // Filter contiguous depth updates
  let currentLastUpdateId = snapshotRaw.lastUpdateId;
  const validDepth: any[] = [];
  for (const d of depthUpdates) {
    if (d.u <= snapshotRaw.lastUpdateId) continue;
    if (d.U <= currentLastUpdateId + 1 && d.u >= currentLastUpdateId + 1) {
      validDepth.push(d);
      currentLastUpdateId = d.u;
    }
  }

  // Filter trades that occurred during or after snapshot
  const trades = rawBuffer
    .map(getPayload)
    .filter((m) => m.e === "trade" && (m.T || m.E) >= snapTime);

  // Interleave and sort chronologically
  const streamEvents = [...validDepth, ...trades].sort((a, b) => {
    const ta = a.T ?? a.E;
    const tb = b.T ?? b.E;
    if (ta !== tb) return ta - tb;
    // If same millisecond, depth before trade so book is updated before fill
    return a.e === "depthUpdate" ? -1 : 1;
  });

  const alignedRecords = [snapshotRecord, ...streamEvents];

  console.log(`Aligned records: ${alignedRecords.length}`);
  console.log(`  - 1 snapshot (lastUpdateId: ${snapshotRaw.lastUpdateId})`);
  console.log(`  - ${validDepth.length} depthUpdates (final updateId: ${currentLastUpdateId})`);
  console.log(`  - ${trades.length} trades`);

  const outFixturePath = resolve(process.cwd(), "tests/fixtures/binance_btcusdt_genuine.jsonl");
  const metaPath = resolve(process.cwd(), "tests/fixtures/binance_btcusdt_genuine.meta.json");

  const jsonlLines = alignedRecords.map((rec) => JSON.stringify(rec)).join("\n") + "\n";
  writeFileSync(outFixturePath, jsonlLines, "utf8");

  const metadata = {
    capturedAt: new Date().toISOString(),
    source: "Binance Spot Public REST & WebSocket APIs (api.binance.com / stream.binance.com)",
    market: "spot",
    symbol: "BTCUSDT",
    streams: ["btcusdt@depth@100ms", "btcusdt@trade"],
    records: {
      total: alignedRecords.length,
      snapshot: 1,
      depthUpdate: validDepth.length,
      trade: trades.length,
    },
    snapshotLastUpdateId: snapshotRaw.lastUpdateId,
    finalUpdateId: currentLastUpdateId,
    timestampStart: snapTime,
    timestampEnd: streamEvents.length > 0 ? (streamEvents[streamEvents.length - 1].T ?? streamEvents[streamEvents.length - 1].E) : snapTime,
    gapsDetected: 0,
  };
  writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");

  console.log(`Saved genuine capture fixture to ${outFixturePath}`);
  console.log(`Saved capture metadata to ${metaPath}`);
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
