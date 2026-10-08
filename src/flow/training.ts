/**
 * TrainingEngine — drives order-flow training sessions.
 *
 * Pipeline (decoupled exactly as specified):
 *
 *   SyntheticMarketDataFeed (or a future DatabentoFeed)
 *        ↓ implements
 *   MarketDataFeed interface
 *        ↓ consumed by
 *   OrderFlowEngine + DOMEngine
 *        ↓ orchestrated by
 *   TrainingEngine
 *        ↓ observed by
 *   Tape Lab UI
 *
 * The engine holds the ScenarioTruth privately. `snapshot()` returns a
 * blind-safe view (price, tape, CVD, profile, order-flow stats, DOM) that
 * contains NO pattern name, truth, confidence or scenario id. `reveal()` is the
 * only way the truth leaves this class.
 */

import type { Level, MarketEvent } from "./events";
import type { MarketDataFeed } from "./feed";
import { DOMEngine, type DOMSnapshot, type DOMState } from "./dom";
import { OrderFlowEngine, type OrderFlowSnapshot, type OrderFlowState } from "./orderFlow";
import { CheckpointManager } from "./checkpointManager";
export { DEFAULT_CHECKPOINT_INTERVAL } from "./checkpointManager";
import type { ScenarioTruth } from "./scenarios";

/** Price points kept for the chart (decimated in place when exceeded). */
export const PRICE_SERIES_KEEP = 1200;

/**
 * Lightweight instrumentation record of where seek latency was spent.
 */
export interface SeekMetrics {
  targetIndex: number;
  checkpointIndex: number;
  rolledEvents: number;
  lookupMs: number;
  restoreMs: number;
  forwardRollMs: number;
  totalSeekLatencyMs: number;
}

export interface TrainingEngineOptions {
  checkpointInterval?: number;
}

/**
 * Immutable detached checkpoint capturing all state required for deterministic replay restoration.
 * Strictly decoupled from secret ScenarioTruth (blind-mode safe).
 */
export interface FlowEngineCheckpoint {
  /** Events consumed so far up to this checkpoint. */
  readonly eventIndex: number;
  /** Sequence number of the newest event consumed (0 if none). */
  readonly sequence: number;
  /** Timestamp of the newest event consumed (null if none). */
  readonly timestamp: number | null;
  /** Sequence position of the feed's next unread event. */
  readonly feedPosition: number;
  /** Complete OrderFlowEngine internal state. */
  readonly orderFlow: OrderFlowState;
  /** Complete DOMEngine internal state. */
  readonly dom: DOMState;
  /** Traded-price path (bounded/decimated), cloned. */
  readonly priceSeries: readonly { t: number; price: number; sequence: number }[];
}

export interface TrainingSnapshot {
  /** Feed label — synthetic data must always identify itself. */
  source: string;
  isRealData: boolean;
  /** Events revealed so far. */
  eventIndex: number;
  totalEvents: number;
  atEnd: boolean;
  atStart: boolean;
  /** Timestamp of the newest revealed event (null before the first event). */
  timestamp: number | null;
  /** Sequence of the newest revealed event (0 = none) — the exact clock. */
  sequence: number;
  orderFlow: OrderFlowSnapshot;
  dom: DOMSnapshot;
  /** Latest book (mirrored from the DOM engine for convenient rendering). */
  book: { bids: Level[]; asks: Level[] } | null;
  /** Revealed traded-price path (bounded, decimated). `sequence` tags the
   *  exact event so consumers never have to map by array index. */
  priceSeries: Array<{ t: number; price: number; sequence: number }>;
}

export class TrainingEngine {
  private readonly feed: MarketDataFeed;
  private readonly truth: ScenarioTruth | null;
  private readonly of = new OrderFlowEngine();
  private readonly dom = new DOMEngine();
  private readonly checkpoints: CheckpointManager;
  private consumed = 0;
  private lastTimestamp: number | null = null;
  private lastSequence = 0;
  private priceSeries: Array<{ t: number; price: number; sequence: number }> = [];
  private _lastSeekMetrics: SeekMetrics | null = null;

  constructor(
    feed: MarketDataFeed,
    truth: ScenarioTruth | null = null,
    options: TrainingEngineOptions = {},
  ) {
    this.feed = feed;
    this.truth = truth;
    this.checkpoints = new CheckpointManager({ interval: options.checkpointInterval });
    // Capture initial state at index 0 immediately
    this.checkpoints.save(this.captureCheckpoint());
  }

  /** The hidden answer. The ONLY path from generator truth to the UI. */
  reveal(): ScenarioTruth | null {
    return this.truth;
  }

  get eventIndex(): number {
    return this.consumed;
  }

  get totalEvents(): number {
    return this.feed.totalEvents();
  }

  get lastSeekMetrics(): SeekMetrics | null {
    return this._lastSeekMetrics;
  }

  get checkpointManager(): CheckpointManager {
    return this.checkpoints;
  }

  /** Consume up to `n` more events through both engines. */
  stepForward(n = 1): number {
    let taken = 0;
    for (let i = 0; i < n; i++) {
      const ev = this.feed.nextEvent();
      if (!ev) break;
      this.apply(ev);
      taken++;
    }
    return taken;
  }

  /** Rewind one event by deterministically restoring nearest checkpoint and rolling. */
  stepBack(): void {
    this.seekTo(this.consumed - 1);
  }

  /**
   * Jump to exactly `index` revealed events via accelerated checkpoint lookup + forward roll.
   * Restores nearest checkpoint C <= target and replays remaining (target - C.eventIndex) events.
   */
  seekTo(index: number): void {
    const tStart = performance.now();
    // 1. Validate/clamp target according to existing feed semantics
    const target = Math.max(0, Math.min(index, this.feed.totalEvents()));

    const tLookupStart = performance.now();

    // 2. If T == 0: restore initial state
    if (target === 0) {
      const initialCp = this.checkpoints.get(0);
      const lookupMs = performance.now() - tLookupStart;
      let restoreMs = 0;
      if (initialCp) {
        const tRestoreStart = performance.now();
        this.restoreCheckpoint(initialCp);
        restoreMs = performance.now() - tRestoreStart;
      } else {
        this.feed.reset();
        this.of.reset();
        this.dom.reset();
        this.priceSeries = [];
        this.consumed = 0;
        this.lastTimestamp = null;
        this.lastSequence = 0;
      }

      this._lastSeekMetrics = {
        targetIndex: 0,
        checkpointIndex: 0,
        rolledEvents: 0,
        lookupMs,
        restoreMs,
        forwardRollMs: 0,
        totalSeekLatencyMs: performance.now() - tStart,
      };
      return;
    }

    // 3. Find nearest checkpoint C where: C.eventIndex <= T
    const nearest = this.checkpoints.findNearest(target);
    const lookupMs = performance.now() - tLookupStart;

    let checkpointIndex = 0;
    let restoreMs = 0;
    let forwardRollMs = 0;
    let rolledEvents = 0;

    if (nearest) {
      // 4. Restore C
      checkpointIndex = nearest.eventIndex;
      const tRestoreStart = performance.now();
      this.restoreCheckpoint(nearest);
      restoreMs = performance.now() - tRestoreStart;

      // 5. Forward replay exactly: T - C.eventIndex events
      rolledEvents = target - nearest.eventIndex;
      const tRollStart = performance.now();
      for (let i = 0; i < rolledEvents; i++) {
        const ev = this.feed.nextEvent();
        if (!ev) break;
        this.apply(ev);
      }
      forwardRollMs = performance.now() - tRollStart;
    } else {
      // Fallback: full rebuild from 0 if no applicable checkpoint exists
      this.feed.reset();
      this.of.reset();
      this.dom.reset();
      this.priceSeries = [];
      this.consumed = 0;
      this.lastTimestamp = null;
      this.lastSequence = 0;

      rolledEvents = target;
      const tRollStart = performance.now();
      for (let i = 0; i < target; i++) {
        const ev = this.feed.nextEvent();
        if (!ev) break;
        this.apply(ev);
      }
      forwardRollMs = performance.now() - tRollStart;
    }

    // 6. Produce resulting metrics & state
    this._lastSeekMetrics = {
      targetIndex: target,
      checkpointIndex,
      rolledEvents,
      lookupMs,
      restoreMs,
      forwardRollMs,
      totalSeekLatencyMs: performance.now() - tStart,
    };
  }

  reset(): void {
    this.seekTo(0);
  }

  /**
   * Capture an immutable, detached checkpoint of the entire engine state.
   * Completely isolated from ScenarioTruth (blind-mode safe).
   */
  captureCheckpoint(): FlowEngineCheckpoint {
    return {
      eventIndex: this.consumed,
      sequence: this.lastSequence,
      timestamp: this.lastTimestamp,
      feedPosition: this.feed.position(),
      orderFlow: this.of.captureState(),
      dom: this.dom.captureState(),
      priceSeries: this.priceSeries.map((p) => ({ t: p.t, price: p.price, sequence: p.sequence })),
    };
  }

  /**
   * Restore all engines and replay cursors from an immutable checkpoint.
   * Does NOT alter ScenarioTruth.
   */
  restoreCheckpoint(checkpoint: FlowEngineCheckpoint): void {
    this.consumed = checkpoint.eventIndex;
    this.lastSequence = checkpoint.sequence;
    this.lastTimestamp = checkpoint.timestamp;

    if (checkpoint.eventIndex === 0) {
      this.feed.reset();
    } else if (checkpoint.feedPosition <= this.feed.totalEvents()) {
      this.feed.seek(checkpoint.feedPosition);
    } else {
      this.feed.seek(this.feed.totalEvents());
      this.feed.nextEvent();
    }

    this.of.restoreState(checkpoint.orderFlow);
    this.dom.restoreState(checkpoint.dom);
    this.priceSeries = checkpoint.priceSeries.map((p) => ({ t: p.t, price: p.price, sequence: p.sequence }));
  }

  private apply(ev: MarketEvent): void {
    this.of.processEvent(ev);
    this.dom.processEvent(ev);
    if (ev.kind === "trade") {
      this.priceSeries.push({ t: ev.timestamp, price: ev.price, sequence: ev.sequence });
      if (this.priceSeries.length > PRICE_SERIES_KEEP) {
        // Deterministic decimation: drop every other point once, keeping order.
        this.priceSeries = this.priceSeries.filter((_, i) => i % 2 === 0);
      }
    }
    this.lastTimestamp = ev.timestamp;
    this.lastSequence = ev.sequence;
    this.consumed++;

    if (this.checkpoints.shouldCapture(this.consumed)) {
      this.checkpoints.save(this.captureCheckpoint());
    }
  }

  snapshot(): TrainingSnapshot {
    const of = this.of.snapshot();
    const dom = this.dom.snapshot();
    return {
      source: this.feed.source,
      isRealData: this.feed.isRealData,
      eventIndex: this.consumed,
      totalEvents: this.feed.totalEvents(),
      atEnd: this.consumed >= this.feed.totalEvents(),
      atStart: this.consumed === 0,
      timestamp: this.lastTimestamp,
      sequence: this.lastSequence,
      orderFlow: of,
      dom,
      book: dom.hasBook ? { bids: dom.bids, asks: dom.asks } : null,
      priceSeries: [...this.priceSeries],
    };
  }
}
