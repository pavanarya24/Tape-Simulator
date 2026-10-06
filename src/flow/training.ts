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
import { DOMEngine, type DOMSnapshot } from "./dom";
import { OrderFlowEngine, type OrderFlowSnapshot } from "./orderFlow";
import type { ScenarioTruth } from "./scenarios";

/** Price points kept for the chart (decimated in place when exceeded). */
export const PRICE_SERIES_KEEP = 1200;

export interface TrainingSnapshot {
  /** Feed label — synthetic data must always identify itself. */
  source: string;
  isRealData: boolean;
  /** Events revealed so far. */
  eventIndex: number;
  totalEvents: number;
  atEnd: boolean;
  atStart: boolean;
  orderFlow: OrderFlowSnapshot;
  dom: DOMSnapshot;
  /** Latest book (mirrored from the DOM engine for convenient rendering). */
  book: { bids: Level[]; asks: Level[] } | null;
  /** Revealed traded-price path (bounded, decimated). */
  priceSeries: Array<{ t: number; price: number }>;
}

export class TrainingEngine {
  private readonly feed: MarketDataFeed;
  private readonly truth: ScenarioTruth | null;
  private readonly of = new OrderFlowEngine();
  private readonly dom = new DOMEngine();
  private consumed = 0;
  private priceSeries: Array<{ t: number; price: number }> = [];

  constructor(feed: MarketDataFeed, truth: ScenarioTruth | null = null) {
    this.feed = feed;
    this.truth = truth;
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

  /** Rewind one event by deterministically rebuilding from the start. */
  stepBack(): void {
    this.seekTo(this.consumed - 1);
  }

  /** Jump to exactly `index` revealed events (0 = nothing revealed yet). */
  seekTo(index: number): void {
    const target = Math.max(0, Math.min(index, this.feed.totalEvents()));
    this.feed.reset();
    this.of.reset();
    this.dom.reset();
    this.priceSeries = [];
    this.consumed = 0;
    for (let i = 0; i < target; i++) {
      const ev = this.feed.nextEvent();
      if (!ev) break;
      this.apply(ev);
    }
  }

  reset(): void {
    this.seekTo(0);
  }

  private apply(ev: MarketEvent): void {
    this.of.processEvent(ev);
    this.dom.processEvent(ev);
    if (ev.kind === "trade") {
      this.priceSeries.push({ t: ev.timestamp, price: ev.price });
      if (this.priceSeries.length > PRICE_SERIES_KEEP) {
        // Deterministic decimation: drop every other point once, keeping order.
        this.priceSeries = this.priceSeries.filter((_, i) => i % 2 === 0);
      }
    }
    this.consumed++;
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
      orderFlow: of,
      dom,
      book: dom.hasBook ? { bids: dom.bids, asks: dom.asks } : null,
      priceSeries: [...this.priceSeries],
    };
  }
}
