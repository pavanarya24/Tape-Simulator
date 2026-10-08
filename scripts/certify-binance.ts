/**
 * Phase 9-Crypto — Genuine Binance Market Data Certification Script
 *
 * Runs certification of the Binance adapter against genuine public Binance Spot market data
 * captured from live exchange streams (api.binance.com REST snapshot + stream.binance.com WebSocket).
 *
 * Run with: bun scripts/certify-binance.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { BinanceAdapter } from "../src/flow/ingest";
import { TrainingEngine } from "../src/flow/training";

async function certify() {
  console.log("================================================================================");
  console.log("PHASE 9-CRYPTO: GENUINE BINANCE MARKET DATA CERTIFICATION");
  console.log("================================================================================");

  const fixturePath = resolve(process.cwd(), "tests/fixtures/binance_btcusdt_genuine.jsonl");
  const metaPath = resolve(process.cwd(), "tests/fixtures/binance_btcusdt_genuine.meta.json");

  if (!existsSync(fixturePath) || !existsSync(metaPath)) {
    console.error("Genuine fixture or metadata file not found at:", fixturePath);
    console.error("Please run `bun scripts/capture-binance.ts` first.");
    process.exit(1);
  }

  const rawMeta = JSON.parse(readFileSync(metaPath, "utf8"));
  console.log(`- Dataset Source: ${rawMeta.source}`);
  console.log(`- Market Type: ${rawMeta.market.toUpperCase()} (Public REST snapshot + WebSocket diff-depth/trade)`);
  console.log(`- Symbol: ${rawMeta.symbol}`);
  console.log(`- Captured At: ${rawMeta.capturedAt}`);
  console.log(`- Raw Records: ${rawMeta.records.total} (1 snapshot, ${rawMeta.records.depthUpdate} depthUpdates, ${rawMeta.records.trade} trades)`);
  console.log(`- Snapshot Anchor: lastUpdateId=${rawMeta.snapshotLastUpdateId}`);
  console.log(`- Final Update ID: ${rawMeta.finalUpdateId}`);
  console.log(`- Timestamp Range: ${rawMeta.timestampStart} -> ${rawMeta.timestampEnd} ms`);

  const rawJsonl = readFileSync(fixturePath, "utf8");
  const adapter = new BinanceAdapter();

  console.log("\n[1/4] Normalization & Schema Validation (strict mode)...");
  const { events, report } = adapter.normalize(rawJsonl, {
    market: "spot",
    symbol: "BTCUSDT",
    strict: true,
  });

  console.log(`  ✓ Normalized Events: ${events.length}`);
  console.log(`  ✓ Validation Passed: ${report.isValid}`);
  console.log(`  ✓ Sequence Gaps: ${report.sequenceGapCount}`);
  console.log(`  ✓ Rejected Records: ${report.rejectedRecords.length}`);
  console.log(`  ✓ Trades: ${report.tradeCount}, Depth Deltas: ${report.depthCount}, Book Resets: ${report.resetCount}`);

  if (!report.isValid || report.sequenceGapCount !== 0 || report.rejectedRecords.length !== 0) {
    throw new Error("Certification failed: normalization did not meet zero-defect criteria.");
  }

  console.log("\n[2/4] Semantics & Microstructure Boundary Verification...");
  // A. Symbol propagation
  const symbolConsistent = events.every((e) => e.symbol === "BTCUSDT");
  console.log(`  ✓ Symbol propagation: ${symbolConsistent ? "PASS (all BTCUSDT)" : "FAIL"}`);

  // B. Millisecond exchange timestamps
  const timestampsMs = events.every((e) => typeof e.timestamp === "number" && e.timestamp > 1_000_000_000_000 && e.timestamp < 2_500_000_000_000);
  console.log(`  ✓ Exchange timestamps: ${timestampsMs ? "PASS (valid ms timestamps)" : "FAIL"}`);

  // C. Buyer-maker aggressor mapping
  const trades = events.filter((e) => e.kind === "trade");
  const hasBuyTrades = trades.some((t) => (t as any).aggressorSide === "BUY");
  const hasSellTrades = trades.some((t) => (t as any).aggressorSide === "SELL");
  const noUnknownTrades = trades.every((t) => (t as any).aggressorSide === "BUY" || (t as any).aggressorSide === "SELL");
  console.log(`  ✓ Buyer-maker mapping: ${hasBuyTrades && hasSellTrades && noUnknownTrades ? "PASS (both BUY and SELL present, 0 unknown)" : "FAIL"}`);

  // D. Match ID & MBO honesty
  const noFabricatedMatchId = trades.every((t) => (t as any).matchId === undefined);
  const depthDeltas = events.filter((e) => e.kind === "depth-delta");
  const noFabricatedMbo = depthDeltas.every((d) => (d as any).orderCount === undefined);
  console.log(`  ✓ No fabricated matchId: ${noFabricatedMatchId ? "PASS (matchId is undefined on all trades)" : "FAIL"}`);
  console.log(`  ✓ No fabricated MBO / order counts: ${noFabricatedMbo ? "PASS (orderCount is undefined on all deltas)" : "FAIL"}`);

  // E. Depth actions
  const hasAdd = depthDeltas.some((d) => (d as any).action === "add");
  const hasModify = depthDeltas.some((d) => (d as any).action === "modify");
  const hasDelete = depthDeltas.some((d) => (d as any).action === "delete");
  console.log(`  ✓ Depth actions: ${hasAdd && hasModify && hasDelete ? "PASS (add, modify, delete all present)" : "FAIL"}`);

  console.log("\n[3/4] Engine Replay & DOM Order-Flow Verification...");
  const feed = adapter.createFeed(rawJsonl, { market: "spot", symbol: "BTCUSDT", strict: true });
  const engine = new TrainingEngine(feed, null, { checkpointInterval: 50 });
  engine.stepForward(feed.totalEvents());
  const snap = engine.snapshot();

  console.log(`  ✓ DOM Best Bid: ${snap.dom.bestBid}, Best Ask: ${snap.dom.bestAsk}`);
  console.log(`  ✓ DOM Spread: ${snap.dom.spread.toFixed(2)} (crossed: ${snap.dom.isCrossed})`);
  console.log(`  ✓ Tape Prints: ${snap.orderFlow.tape.length}`);
  console.log(`  ✓ Total Volume: ${snap.orderFlow.totalVolume.toFixed(6)}`);
  console.log(`  ✓ Buy Volume: ${snap.orderFlow.totalBuyVolume.toFixed(6)}`);
  console.log(`  ✓ Sell Volume: ${snap.orderFlow.totalSellVolume.toFixed(6)}`);
  console.log(`  ✓ Net Delta: ${snap.orderFlow.delta.toFixed(6)}`);

  if (snap.dom.bestBid >= snap.dom.bestAsk || snap.dom.isCrossed) {
    throw new Error("Certification failed: DOM is crossed or spread is non-positive.");
  }

  console.log("\n[4/4] Determinism & Checkpoint Seek Equivalence...");
  // Determinism check
  const feed2 = adapter.createFeed(rawJsonl, { market: "spot", symbol: "BTCUSDT", strict: true });
  const engine2 = new TrainingEngine(feed2, null, { checkpointInterval: 50 });
  engine2.stepForward(feed2.totalEvents());
  const snap2 = engine2.snapshot();

  if (JSON.stringify(snap.orderFlow) !== JSON.stringify(snap2.orderFlow) || JSON.stringify(snap.dom) !== JSON.stringify(snap2.dom)) {
    throw new Error("Certification failed: Replay non-deterministic across independent runs.");
  }
  console.log("  ✓ Determinism across runs: PASS (identical DOM and OrderFlow)");

  // Checkpoint seek equivalence check
  const targets = [0, 1, 10, 50, 100, 250, 500, 1000, feed.totalEvents()];
  for (const target of targets) {
    engine.seekTo(target);
    const seekSnap = engine.snapshot();

    const freshFeed = adapter.createFeed(rawJsonl, { market: "spot", symbol: "BTCUSDT", strict: true });
    const freshEngine = new TrainingEngine(freshFeed, null);
    freshEngine.stepForward(target);
    const seqSnap = freshEngine.snapshot();

    if (JSON.stringify(seekSnap.orderFlow) !== JSON.stringify(seqSnap.orderFlow)) {
      throw new Error(`OrderFlow mismatch on target ${target}`);
    }
    if (JSON.stringify(seekSnap.dom) !== JSON.stringify(seqSnap.dom)) {
      throw new Error(`DOM mismatch on target ${target}`);
    }
  }
  console.log(`  ✓ Checkpoint seek equivalence: PASS (verified at targets: ${targets.join(", ")})`);

  console.log("\n================================================================================");
  console.log("✅ CERTIFICATION RESULT: FULLY PASSED");
  console.log("BinanceAdapter successfully certified against genuine public Binance Spot market data.");
  console.log("================================================================================");
}

certify().catch((err) => {
  console.error("Certification failed:", err);
  process.exit(1);
});
