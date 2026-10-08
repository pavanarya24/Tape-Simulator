# Phase 9-C — Vendor-Neutral Real Microstructure Ingestion Architecture

## 1. Overview
Phase 9-C implements end-to-end, vendor-neutral ingestion of real market microstructure data (Time & Sales, L2 depth deltas, top-of-book quotes, book resets). External market data is normalized at the adapter boundary into canonical `NormalizedMarketEvent`s, which are fed into `RealMarketDataFeed` and consumed by `TrainingEngine`, `CheckpointManager`, `FlowTrainingSession`, and Tape Lab without contaminating core engines with vendor-specific schemas.

```
REAL DATA SOURCE (JSON / JSONL / CSV / Stream)
                    ↓
        VENDOR ADAPTER / PARSER
 (e.g. DatabentoAdapter, GenericMicrostructureAdapter)
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

---

## 3. Supported vs Unavailable Fields

| Microstructure Field | Supported | Handling / Invariant |
|----------------------|-----------|----------------------|
| **Symbol / Instrument** | YES | CME instruments: NQ, MNQ, ES, MES (`src/flow/ingest/types.ts`) |
| **Event Timestamp (ms)** | YES | Preserved exactly (`timestamp`) |
| **Matching Nanos** | YES | Preserved in `tsEventNanos: bigint` without floating-point truncation |
| **Packet Receive Nanos** | YES | Preserved in `tsRecvNanos: bigint` when provided by vendor |
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
