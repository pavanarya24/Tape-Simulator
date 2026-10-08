# Phase 9-C — Vendor-Neutral Real Microstructure Ingestion Architecture

## 1. Overview
Phase 9-C implements end-to-end, vendor-neutral ingestion of real market microstructure data (Time & Sales, L2 depth deltas, top-of-book quotes, book resets). External market data is normalized at the adapter boundary into canonical `NormalizedMarketEvent`s, which are fed into `RealMarketDataFeed` and consumed by `TrainingEngine`, `CheckpointManager`, `FlowTrainingSession`, and Tape Lab without contaminating core engines with vendor-specific schemas.

```
REAL DATA SOURCE (JSON / JSONL / CSV / Stream)
                    ↓
        VENDOR ADAPTER / PARSER
 (e.g. DatabentoAdapter, BinanceAdapter, GenericMicrostructureAdapter)
                    ↓
    VENDOR-NEUTRAL INGESTION CONTRACT
   (MicrostructureCapabilities, IngestionValidationReport)
                    ↓
          NormalizedMarketEvent
   (trade | depth-delta | quote | book-reset)
                    ↓
            RealMarketDataFeed
  (MarketDataFeed: isRealData: true, O(1) indexed seek)
                    ↓
              TrainingEngine
                    ↓
          CheckpointManager (K = 10,000)
                    ↓
           FlowTrainingSession
                    ↓
        Tape / DOM / Chart / Training
```

---

## 2. Supported Sources & Adapters
1. **DatabentoAdapter (`src/flow/ingest/databento.ts`)**:
   - Parses CME Globex futures market data (MDP 3.0, MBP-1, MBP-10, Trades schema).
   - Ingests JSONL strings, arrays of record objects, or JSON files.
   - Dual nanosecond timestamps (`ts_event`, `ts_recv`).
   - Maps CME trade aggressor actions strictly (`action: 'T'`, `side: 'A'` -> `SELL`, `side: 'B'` -> `BUY`, `side: 'N'`/missing -> `UNKNOWN` without heuristics).
   - Maps depth actions (`action: 'A'` -> `add`, `'M'` -> `modify`, `'D'`/`'C'` -> `delete`, `'R'` -> `book-reset`).
   - Strictly keeps `order_id` distinct as a resting order identifier; only maps genuine venue match/trade identifiers (`match_id`, `trade_id`) to `matchId`.
   - Preserves resting order counts per level (`order_cnt` -> `orderCount`).

2. **GenericMicrostructureAdapter (`src/flow/ingest/generic.ts`)**:
   - Demonstrates multi-vendor pluggability (representing Rithmic, IQFeed, or proprietary feeds).
   - Normalizes trades, depth, quotes, and resets without changing downstream code.

3. **BinanceAdapter (`src/flow/ingest/binance.ts`) — Phase 9-Crypto**:
   - Parses public Spot and USDⓈ-M Futures `aggTrade`/`trade`, `depthUpdate`, and `bookTicker` JSON websocket payloads, including combined-stream wrappers.
   - Targets BTCUSDT and ETHUSDT through an optional symbol filter; no API key is required for the normalization contract.
   - Uses Binance's `m` buyer-maker flag for truthful aggressor mapping (`m: false` → BUY taker, `m: true` → SELL taker). Aggregate/trade IDs are not mapped to `matchId` because they are not asserted to be execution IDs in this normalized contract.
   - Uses millisecond exchange timestamps only. Binance does not provide nanosecond timestamps or packet receive timestamps in these public market streams, so those capability flags remain false.
   - Requires an anchored depth snapshot before applying diff-depth updates. Spot continuity uses `U/u`; USDⓈ-M additionally honors `pu`. A discontinuity emits a normalized book reset, records `sequenceGapCount`, drops the untrusted update, and waits for the next snapshot.
   - Snapshot levels are emitted as `depth-delta` adds with `orderCount: undefined`; they are not fabricated as MBO or individual queue orders. Explicit reconnect/reset fixture markers clear the local book.

### 2a. Data-certification status

The checked-in Binance coverage is a representative schema fixture in `tests/phase9crypto-binance.test.ts`. It is **not genuine Binance market data** and no live websocket session or credentialed vendor export was processed during this implementation. The adapter is contract-tested offline against documented Spot and USDⓈ-M message shapes; genuine data certification remains a follow-up operational step.

---

## 3. Supported vs Unavailable Fields

| Microstructure Field | Supported | Handling / Invariant |
|----------------------|-----------|----------------------|
| **Symbol / Instrument** | YES | CME instruments: NQ, MNQ, ES, MES (`src/flow/ingest/types.ts`) |
| **Event Timestamp (ms)** | YES | Preserved exactly (`timestamp`) |
| **Matching Nanos** | Conditional | Databento preserves nanoseconds; Binance public Spot/Futures streams provide milliseconds only |
| **Packet Receive Nanos** | Conditional | Preserved when a vendor supplies it; Binance public streams do not |
| **Sequence Number** | YES | Preserved from feed sequence or deterministic sequence |
| **Trade Price & Size** | YES | Finite positive numbers enforced by validator |
| **Trade Aggressor** | YES | Explicit vendor side mapped ('A'->SELL, 'B'->BUY, 'N'/missing->`UNKNOWN`); zero heuristics |
| **Match ID** | CONDITIONAL | Populated only when genuine execution ID (`match_id`/`trade_id`) is present; `order_id` is kept separate |
| **L2 Depth Deltas** | YES | `add`, `modify`, `delete` actions with price, size, orderCount |
| **Snapshot Conversion** | YES | `SnapshotDeltaConverter` converts L2 snapshots to incremental deltas |
| **Book Reset** | YES | `BookResetEvent` clears DOM book cleanly |
| **Top-of-Book Quotes** | YES | `QuoteEvent` with bid, ask, bidSize, askSize |
| **MBO Individual Orders** | NO | MBP/Trades formats do not include MBO; declared honestly (`hasMBO: false`) |
| **Fabricated Metrics** | NO | Zero fabrication: missing fields remain explicitly `undefined` or `UNKNOWN` |

### 3a. Binance Semantics, Limitations & Certification

- **Microstructure Style**: Binance public market streams are MBP-style price/quantity updates, not MBO. Queue position, per-order IDs, order counts, and execution match IDs are unavailable and intentionally remain unavailable (`hasMBO: false`, `hasOrderCounts: false`, `hasMatchIds: false`).
- **Identifier Domains**: Binance trade and depth identifiers use separate domains. The adapter uses raw depth IDs only for continuity validation (`U`/`u` on Spot, `pu`/`u` on USDⓈ-M) and assigns a deterministic feed-local normalized sequence to the shared event stream.
- **Snapshot Anchoring**: A depth stream without a preceding snapshot is rejected as unanchored; this prevents partial deltas from being presented as a complete book.
- **Spot vs. USDⓈ-M Futures Separation**:
  - Ingestion options require explicit `market: 'spot'` or `market: 'usdm'`.
  - Spot uses `U <= lastUpdateId + 1 && u >= lastUpdateId + 1` continuity.
  - Futures uses `pu === lastUpdateId && u >= lastUpdateId + 1` continuity.
  - Ingestion sources, validation reports, and feeds declare their market type explicitly.
- **Representative Fixtures vs. Genuine Historical Data**:
  - `tests/fixtures/binance_btcusdt_representative.jsonl`: Synthetic 4-record test schema fixture used for fast deterministic unit tests.
  - `tests/fixtures/binance_btcusdt_genuine.jsonl`: Certified live capture of Binance Spot market data (`api.binance.com` REST snapshot + `stream.binance.com` WebSocket depth/trade stream).
  - `tests/fixtures/binance_btcusdt_spot_historical_slice.csv`: Genuine historical Spot aggTrades slice (500 records) from `data.binance.vision`.
  - `tests/fixtures/binance_btcusdt_futures_historical_slice.csv`: Genuine historical USDⓈ-M Futures aggTrades slice (500 records) from `data.binance.vision`.
  - Full genuine historical datasets: 1,852,572 Spot events and 3,029,000 Futures events from official Binance Vision archives (May 1, 2024).
  - Opt-in certification runners: `bun scripts/certify-binance.ts` and `bun scripts/benchmark-historical-crypto.ts`.

### 3b. Genuine Historical Binance Scale Benchmarks

Benchmarked on `tests/fixtures/extracted/BTCUSDT-aggTrades-2024-05-01.csv` (1,852,572 genuine trades):

| Event Count | Normalization Throughput | Replay Throughput | Checkpoints (K=10k) | Worst-Case Seek Latency | Sequential === Seek Equivalence |
|---|---|---|---|---|---|
| **100,000** | 432,370 ev/s | 1,015,471 ev/s | 10 | 11.97 ms | **PASS (100% match)** |
| **500,000** | 403,673 ev/s | 970,379 ev/s | 50 | 19.61 ms | **PASS (100% match)** |
| **1,000,000** | 431,354 ev/s | 700,103 ev/s | 100 | 68.23 ms | **PASS (100% match)** |
| **1,852,572** | 319,996 ev/s | 658,624 ev/s | 185 | 95.74 ms | **PASS (100% match)** |

- **Sequential Equivalence**: Replaying sequentially from event 0 vs accelerated seeking via sparse checkpoint lookup + forward roll produces identical order-flow state, trade counts, tape, total volume, and CVD.
- **Historical Order Book Availability Limitation**: Public Binance Vision archives publish historical executed trades (`aggTrades` / `trades`) and `klines`, but do not distribute historical tick-by-tick order-book diffs. Order-book reconstruction is certified via live websocket captures and REST snapshots.

---

## 4. Capability Flags & Validation Report
Every ingested dataset is analyzed by `MicrostructureValidator` (`src/flow/ingest/validator.ts`), producing an `IngestionValidationReport`:
- `source`: Vendor adapter name.
- `instrument`: Contract symbol (e.g. "NQ").
- `recordCount`: Total raw input records.
- `normalizedEventCount`: Successfully validated normalized events.
- `tradeCount`, `depthCount`, `quoteCount`, `resetCount`: Breakdown of events.
- `duplicateCount`: Duplicate records filtered by fingerprint signature.
- `rejectedRecords`: Diagnostics for any malformed or out-of-order records.
- `timestampRange` & `sequenceRange`: Min/max bounds across the dataset.
- `capabilities`: Explicit boolean flags (`hasTrades`, `hasQuotes`, `hasDepth`, `hasMBO`, `hasAggressor`, `hasOrderCounts`, `hasNanosecondTimestamps`, `hasReceiveTimestamp`, `hasMatchIds`).
- `isValid`: Boolean flag indicating dataset integrity.

---

## 5. Usage & Replay

### Ingesting & Replaying Databento Data
```typescript
import { DatabentoAdapter, CME_INSTRUMENTS } from "./flow/ingest";
import { TrainingEngine } from "./flow/training";

const adapter = new DatabentoAdapter();
const feed = adapter.createFeed(rawJsonlString, {
  instrument: CME_INSTRUMENTS.NQ,
  strict: false, // collects diagnostics without throwing
  sessionFilter: { rthOnly: true }, // optional RTH filtering (13:30 - 20:00 UTC)
});

// Replay with TrainingEngine & CheckpointManager
const engine = new TrainingEngine(feed, null, { checkpointInterval: 10000 });
engine.stepForward(500);

// Inspect deterministic state
const snapshot = engine.snapshot();
console.log("Tape prints:", snapshot.orderFlow.tape.length);
console.log("CVD:", snapshot.orderFlow.cumulativeDelta);
console.log("DOM best bid/ask:", snapshot.dom.bestBid, snapshot.dom.bestAsk);
```

### Loading Real Feeds in TapeLabController
```typescript
controller.loadRealFlowFeed(feed, CONTRACTS.NQ);
```

---

## 6. Adding a New Vendor Adapter
To add a new vendor adapter (e.g., Rithmic or IQFeed):
1. Implement `MarketDataAdapter<TRaw>` from `src/flow/ingest/types.ts`.
2. Define the vendor's raw record interface.
3. In `normalize(raw, options)`:
   - Validate and convert raw records to `TradeEvent`, `DepthDeltaEvent`, `QuoteEvent`, or `BookResetEvent`.
   - Pass events through `MicrostructureValidator.validateEvent()`.
   - Sort normalized events with `events.sort(compareNormalizedEvents)`.
4. Return `RealMarketDataFeed` from `createFeed(raw, options)`.
