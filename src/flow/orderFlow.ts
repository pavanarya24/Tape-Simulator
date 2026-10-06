/**
 * OrderFlowEngine — consumes MarketEvents and computes order-flow analytics.
 *
 * Works on ANY MarketDataFeed (synthetic today, real vendor later). It never
 * infers aggressor side from price direction or candle colour: a trade's
 * aggressorSide comes from the feed and is used exactly as reported.
 *
 * Kept strictly separate from the DOM/L2 engine (dom.ts) — this file owns the
 * tape and trade-based statistics; it only reads top-of-book from L2 events for
 * spread / microprice / imbalance context.
 */

import type { Aggressor, L2Event, MarketEvent, TradeEvent } from "./events";

export interface VolumeAtPrice {
  price: number;
  buy: number;
  sell: number;
  total: number;
}

/** Immutable snapshot of everything the engine knows up to the cursor. */
export interface OrderFlowSnapshot {
  /** Newest-first Time & Sales (bounded — see TAPE_KEEP). */
  tape: TradeEvent[];
  totalBuyVolume: number;
  totalSellVolume: number;
  totalVolume: number;
  /** totalBuyVolume - totalSellVolume over the whole session. */
  delta: number;
  /** Running cumulative delta (CVD) after each trade — sampled for charts. */
  cumulativeDelta: number;
  cvdSeries: number[];
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  unknownCount: number;
  /** Share of volume traded by BUY vs SELL aggressors (percent). */
  buyAggressionPct: number;
  sellAggressionPct: number;
  /** Session VWAP from executed prints (Σ p·v / Σ v). */
  vwap: number;
  lastPrice: number;
  /** Best bid / best ask from the most recent L2 event, if any. */
  bestBid: number | null;
  bestAsk: number | null;
  /** ask - bid (ticks × tick size). Null before any L2 event. */
  spread: number | null;
  /** Size-weighted mid: (ask·bidSize + bid·askSize) / (bidSize + askSize). */
  microprice: number | null;
  /** (bidLiq - askLiq) / (bidLiq + askLiq) over the top 10 levels, -1..1. */
  bidAskImbalance: number | null;
  /** Trades per minute over the last VELOCITY_WINDOW_MS of revealed time. */
  velocityPerMin: number;
  /** Largest prints revealed so far, newest first, max LARGEST_KEEP. */
  largestTrades: TradeEvent[];
  /** Volume profile, ascending by price. */
  volumeAtPrice: VolumeAtPrice[];
  /** Sequence of the last processed event (0 = none). */
  sequence: number;
}

export const TAPE_KEEP = 60;
export const LARGEST_KEEP = 6;
export const CVD_SERIES_KEEP = 600;
export const VELOCITY_WINDOW_MS = 60_000;

export class OrderFlowEngine {
  private tape: TradeEvent[] = [];
  private totalBuy = 0;
  private totalSell = 0;
  private buyCount = 0;
  private sellCount = 0;
  private unknownCount = 0;
  private cvd = 0;
  private cvdSeries: number[] = [];
  private vwapNumerator = 0;
  private vwapDenominator = 0;
  private lastPrice = 0;
  private lastSequence = 0;
  private volumeByPrice = new Map<number, { buy: number; sell: number }>();
  private largest: TradeEvent[] = [];
  private tradeTimestamps: number[] = [];
  private bestBid: number | null = null;
  private bestAsk: number | null = null;
  private bidLiquidity: number | null = null;
  private askLiquidity: number | null = null;

  reset(): void {
    this.tape = [];
    this.totalBuy = 0;
    this.totalSell = 0;
    this.buyCount = 0;
    this.sellCount = 0;
    this.unknownCount = 0;
    this.cvd = 0;
    this.cvdSeries = [];
    this.vwapNumerator = 0;
    this.vwapDenominator = 0;
    this.lastPrice = 0;
    this.lastSequence = 0;
    this.volumeByPrice = new Map();
    this.largest = [];
    this.tradeTimestamps = [];
    this.bestBid = null;
    this.bestAsk = null;
    this.bidLiquidity = null;
    this.askLiquidity = null;
  }

  /** Consume one event. Unknown kinds are ignored (forward compatibility). */
  processEvent(ev: MarketEvent): void {
    if (ev.kind === "trade") this.onTrade(ev);
    else if (ev.kind === "l2") this.onL2(ev);
  }

  private onTrade(t: TradeEvent): void {
    this.tape.push(t);
    if (this.tape.length > TAPE_KEEP) this.tape.shift();

    const signed = t.aggressorSide === "BUY" ? t.size : t.aggressorSide === "SELL" ? -t.size : 0;
    if (t.aggressorSide === "BUY") {
      this.totalBuy += t.size;
      this.buyCount++;
    } else if (t.aggressorSide === "SELL") {
      this.totalSell += t.size;
      this.sellCount++;
    } else {
      this.unknownCount++;
    }

    this.cvd += signed;
    this.cvdSeries.push(this.cvd);
    if (this.cvdSeries.length > CVD_SERIES_KEEP) this.cvdSeries.shift();

    this.vwapNumerator += t.price * t.size;
    this.vwapDenominator += t.size;
    this.lastPrice = t.price;
    this.lastSequence = t.sequence;

    const bucket = this.volumeByPrice.get(t.price) ?? { buy: 0, sell: 0 };
    if (t.aggressorSide === "BUY") bucket.buy += t.size;
    else if (t.aggressorSide === "SELL") bucket.sell += t.size;
    this.volumeByPrice.set(t.price, bucket);

    // Largest prints: keep the biggest LARGEST_KEEP, newest first on ties.
    this.largest.push(t);
    this.largest.sort((a, b) => b.size - a.size || b.sequence - a.sequence);
    if (this.largest.length > LARGEST_KEEP) this.largest.length = LARGEST_KEEP;

    this.tradeTimestamps.push(t.timestamp);
    const cutoff = t.timestamp - VELOCITY_WINDOW_MS;
    while (this.tradeTimestamps.length > 0 && this.tradeTimestamps[0] < cutoff) this.tradeTimestamps.shift();
  }

  private onL2(ev: L2Event): void {
    if (ev.bids.length > 0) {
      this.bestBid = ev.bids[0].price;
      this.bidLiquidity = ev.bids.reduce((s, l) => s + l.size, 0);
    }
    if (ev.asks.length > 0) {
      this.bestAsk = ev.asks[0].price;
      this.askLiquidity = ev.asks.reduce((s, l) => s + l.size, 0);
    }
  }

  snapshot(): OrderFlowSnapshot {
    const totalVolume = this.totalBuy + this.totalSell;
    const spread = this.bestBid !== null && this.bestAsk !== null ? +(this.bestAsk - this.bestBid).toFixed(2) : null;
    let microprice: number | null = null;
    if (this.bestBid !== null && this.bestAsk !== null && this.bidLiquidity !== null && this.askLiquidity !== null) {
      // Size-weighted mid using total displayed liquidity as the weighting:
      // heavy bid liquidity pulls the fair value toward the bid side.
      const bb = this.bestBid;
      const ba = this.bestAsk;
      const total = this.bidLiquidity + this.askLiquidity;
      const ratio = total > 0 ? this.bidLiquidity / total : 0.5;
      microprice = +(bb * ratio + ba * (1 - ratio)).toFixed(2);
    }
    const bidAskImbalance =
      this.bidLiquidity !== null && this.askLiquidity !== null && this.bidLiquidity + this.askLiquidity > 0
        ? +((this.bidLiquidity - this.askLiquidity) / (this.bidLiquidity + this.askLiquidity)).toFixed(4)
        : null;

    let velocityPerMin = 0;
    if (this.tradeTimestamps.length > 1) {
      const spanMs = this.tradeTimestamps[this.tradeTimestamps.length - 1] - this.tradeTimestamps[0];
      velocityPerMin = spanMs > 0 ? +((this.tradeTimestamps.length / spanMs) * 60_000).toFixed(1) : 0;
    }

    const volumeAtPrice: VolumeAtPrice[] = [...this.volumeByPrice.entries()]
      .map(([price, v]) => ({ price, buy: v.buy, sell: v.sell, total: v.buy + v.sell }))
      .sort((a, b) => a.price - b.price);

    return {
      tape: [...this.tape],
      totalBuyVolume: this.totalBuy,
      totalSellVolume: this.totalSell,
      totalVolume,
      delta: this.totalBuy - this.totalSell,
      cumulativeDelta: this.cvd,
      cvdSeries: [...this.cvdSeries],
      tradeCount: this.buyCount + this.sellCount + this.unknownCount,
      buyCount: this.buyCount,
      sellCount: this.sellCount,
      unknownCount: this.unknownCount,
      buyAggressionPct: totalVolume > 0 ? +((this.totalBuy / totalVolume) * 100).toFixed(1) : 0,
      sellAggressionPct: totalVolume > 0 ? +((this.totalSell / totalVolume) * 100).toFixed(1) : 0,
      vwap: this.vwapDenominator > 0 ? +(this.vwapNumerator / this.vwapDenominator).toFixed(2) : 0,
      lastPrice: this.lastPrice,
      bestBid: this.bestBid,
      bestAsk: this.bestAsk,
      spread,
      microprice,
      bidAskImbalance,
      velocityPerMin,
      largestTrades: [...this.largest],
      volumeAtPrice,
      sequence: this.lastSequence,
    };
  }
}

/** Aggression label for a side. */
export function aggressionLabel(side: Aggressor): string {
  return side === "BUY" ? "Aggressive buy" : side === "SELL" ? "Aggressive sell" : "Unattributed";
}
