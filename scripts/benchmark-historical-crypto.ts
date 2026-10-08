/**
 * Phase 9-Crypto.2 — Scale & Performance Benchmark on Genuine Historical Binance Data
 *
 * Measures ingestion, normalization, replay throughput, checkpoint seeking, and determinism
 * on genuine historical Binance Spot trade data (100k, 500k, 1M, and 1.85M events).
 *
 * Run with: bun scripts/benchmark-historical-crypto.ts
 */

import { existsSync, createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { BinanceAdapter } from "../src/flow/ingest";
import { TrainingEngine } from "../src/flow/training";

const CSV_FILE = resolve(process.cwd(), "tests/fixtures/extracted/BTCUSDT-aggTrades-2024-05-01.csv");

async function loadLines(maxLines: number): Promise<string> {
  const lines: string[] = [];
  const rl = createInterface({
    input: createReadStream(CSV_FILE),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }

  return lines.join("\n");
}

interface BenchmarkResult {
  targetEvents: number;
  actualEvents: number;
  normDurationMs: number;
  normThroughput: number;
  replayDurationMs: number;
  replayThroughput: number;
  checkpoints: number;
  seekLatencyMs: number;
  heapUsedMb: number;
  deterministicEquivalence: boolean;
  totalVolume: number;
  cumulativeDelta: number;
}

async function runBenchmarkForCount(count: number): Promise<BenchmarkResult> {
  console.log(`\n================================================================`);
  console.log(`RUNNING BENCHMARK: ${count.toLocaleString()} EVENTS`);
  console.log(`================================================================`);

  // 1. Load lines
  const tLoadStart = performance.now();
  const rawCsv = await loadLines(count);
  const tLoadEnd = performance.now();
  console.log(`- Loaded ${count.toLocaleString()} CSV lines in ${(tLoadEnd - tLoadStart).toFixed(2)} ms`);

  // 2. Normalization
  const adapter = new BinanceAdapter();
  const heapBefore = process.memoryUsage().heapUsed;

  const tNormStart = performance.now();
  const { events, report } = adapter.normalize(rawCsv, {
    market: "spot",
    symbol: "BTCUSDT",
    strict: false,
  });
  const tNormEnd = performance.now();
  const normDurationMs = tNormEnd - tNormStart;
  const normThroughput = Math.round((events.length / normDurationMs) * 1000);

  console.log(`- Normalization:`);
  console.log(`  Events: ${events.length.toLocaleString()} (Trades: ${report.tradeCount.toLocaleString()})`);
  console.log(`  Duration: ${normDurationMs.toFixed(2)} ms`);
  console.log(`  Throughput: ${normThroughput.toLocaleString()} ev/s`);
  console.log(`  Report valid: ${report.isValid}, gaps: ${report.sequenceGapCount}, regressions: ${report.rejectedRecords.length}`);

  // 3. Engine Replay with CheckpointManager
  const feed = adapter.createFeed(rawCsv, { market: "spot", symbol: "BTCUSDT" });
  const interval = 10000;
  const engine = new TrainingEngine(feed, null, { checkpointInterval: interval });

  const tReplayStart = performance.now();
  engine.stepForward(feed.totalEvents());
  const tReplayEnd = performance.now();
  const replayDurationMs = tReplayEnd - tReplayStart;
  const replayThroughput = Math.round((feed.totalEvents() / replayDurationMs) * 1000);

  const snap = engine.snapshot();
  const heapAfter = process.memoryUsage().heapUsed;
  const heapUsedMb = Math.round((heapAfter - heapBefore) / (1024 * 1024));

  console.log(`- Engine Replay:`);
  console.log(`  Duration: ${replayDurationMs.toFixed(2)} ms`);
  console.log(`  Throughput: ${replayThroughput.toLocaleString()} ev/s`);
  console.log(`  Volume: ${snap.orderFlow.totalVolume.toFixed(4)} BTC`);
  console.log(`  Delta: ${snap.orderFlow.delta.toFixed(4)} BTC`);
  console.log(`  Tape prints: ${snap.orderFlow.tape.length}`);
  console.log(`  Heap delta: ~${heapUsedMb} MB`);

  // 4. Checkpoint Seek Equivalence
  const checkpoints = Math.floor(events.length / interval);
  console.log(`- Checkpoints created: ${checkpoints} (interval: ${interval})`);

  // Measure worst-case seek target: (last event - 1)
  const seekTarget = events.length - 1;
  const tSeekStart = performance.now();
  engine.seekTo(seekTarget);
  const tSeekEnd = performance.now();
  const seekLatencyMs = tSeekEnd - tSeekStart;
  console.log(`- Accelerated Seek to ${seekTarget.toLocaleString()} took: ${seekLatencyMs.toFixed(2)} ms`);

  // Verify equivalence: seek forward 1 step to reach end
  engine.stepForward(1);
  const endSeekSnap = engine.snapshot();

  // Sequential from scratch
  const freshEngine = new TrainingEngine(adapter.createFeed(rawCsv, { market: "spot", symbol: "BTCUSDT" }), null);
  freshEngine.stepForward(events.length);
  const freshSnap = freshEngine.snapshot();

  const isEquivalent =
    endSeekSnap.orderFlow.totalVolume === freshSnap.orderFlow.totalVolume &&
    endSeekSnap.orderFlow.delta === freshSnap.orderFlow.delta &&
    endSeekSnap.orderFlow.tradeCount === freshSnap.orderFlow.tradeCount &&
    endSeekSnap.orderFlow.tape.length === freshSnap.orderFlow.tape.length;

  console.log(`- Deterministic Equivalence (Sequential === Checkpoint Replay): ${isEquivalent ? "PASS (100% match)" : "FAIL"}`);

  return {
    targetEvents: count,
    actualEvents: events.length,
    normDurationMs,
    normThroughput,
    replayDurationMs,
    replayThroughput,
    checkpoints,
    seekLatencyMs,
    heapUsedMb,
    deterministicEquivalence: isEquivalent,
    totalVolume: snap.orderFlow.totalVolume,
    cumulativeDelta: snap.orderFlow.delta,
  };
}

async function main() {
  console.log("================================================================================");
  console.log("PHASE 9-CRYPTO.2: GENUINE HISTORICAL BINANCE SCALE BENCHMARK");
  console.log("================================================================================");
  console.log(`Source File: ${CSV_FILE}`);

  if (!existsSync(CSV_FILE)) {
    console.error(`File not found: ${CSV_FILE}`);
    console.error("Please extract BTCUSDT-aggTrades-2024-05-01.csv into tests/fixtures/extracted/");
    process.exit(1);
  }

  const counts = [100000, 500000, 1000000, 1852572];
  const results: BenchmarkResult[] = [];

  for (const count of counts) {
    const res = await runBenchmarkForCount(count);
    results.push(res);
  }

  console.log("\n================================================================================");
  console.log("BENCHMARK SUMMARY TABLE");
  console.log("================================================================================");
  console.log(
    "Events".padStart(10) +
      " | " +
      "Norm Speed".padStart(14) +
      " | " +
      "Replay Speed".padStart(15) +
      " | " +
      "Seek Latency".padStart(12) +
      " | " +
      "Checkpoints".padStart(11) +
      " | " +
      "Equivalence".padStart(11),
  );
  console.log("-".repeat(84));

  for (const r of results) {
    console.log(
      r.actualEvents.toLocaleString().padStart(10) +
        " | " +
        `${r.normThroughput.toLocaleString()} ev/s`.padStart(14) +
        " | " +
        `${r.replayThroughput.toLocaleString()} ev/s`.padStart(15) +
        " | " +
        `${r.seekLatencyMs.toFixed(2)} ms`.padStart(12) +
        " | " +
        r.checkpoints.toString().padStart(11) +
        " | " +
        (r.deterministicEquivalence ? "PASS" : "FAIL").padStart(11),
    );
  }

  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
