/**
 * SyntheticMarketDataFeed — deterministic synthetic order-flow generator.
 *
 * Produces genuine synthetic MARKET EVENTS (executed trades + Level-2 book
 * snapshots + a book reset) with the same conceptual structure as a real
 * feed. It never derives Time & Sales or depth from OHLC candles: price,
 * aggressor side and book liquidity evolve together through regime phases the
 * way they do in live markets.
 *
 * Determinism: the same seed always produces identical output. Every random
 * decision draws from one seeded RNG (mulberry32); nothing reads the clock,
 * Math.random, or any external state.
 *
 * Realism: events are SEQUENCES, not independent draws. Price carries momentum
 * per regime; aggressor sides are correlated with the regime's pressure; book
 * sizes random-walk toward regime-dependent targets (stacking, pulling,
 * replenishment, absorption) instead of being re-rolled from scratch.
 */

import type {
  Aggressor,
  BookResetEvent,
  L2Event,
  Level,
  MarketEvent,
  TradeEvent,
} from "./events";
import type { MarketDataFeed } from "./feed";

export const FEED_TICK = 0.25;
/** Fixed session anchor so generated timestamps are reproducible: 2024-03-15 09:30 America/New_York. */
export const FEED_T0 = 1710514200000;

/* ------------------------------------------------------------------ */
/* Seeded RNG                                                          */
/* ------------------------------------------------------------------ */

/** mulberry32 — small, fast, fully deterministic 32-bit PRNG. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Regime phases                                                       */
/* ------------------------------------------------------------------ */

/**
 * Behaviour segments the feed walks through, in order. Each kind maps to a
 * correlated price/aggression/liquidity regime (see applyPhase).
 */
export type PhaseKind =
  | "meander"
  | "trend-up"
  | "trend-down"
  | "rotation"
  | "vol-expansion"
  | "vol-contraction"
  | "aggressive-buy"
  | "aggressive-sell"
  | "replenish"
  | "pull"
  | "bid-absorption"
  | "ask-absorption"
  | "sweep-buys"
  | "sweep-sells"
  | "delta-divergence"
  | "failed-breakout-up"
  | "failed-breakout-down"
  | "breakout-continuation-up"
  | "breakout-continuation-down";

export interface PhaseSpec {
  kind: PhaseKind;
  /** Number of trade events in this phase (L2 events are extra). */
  trades: number;
}

/**
 * Default plan: cycles through every behaviour the generator implements so a
 * plain feed exercises trending, rotation, volatility, aggression, liquidity
 * dynamics, absorption, sweeps, divergence and breakouts.
 */
export function defaultPlan(): PhaseSpec[] {
  return [
    { kind: "meander", trades: 60 },
    { kind: "trend-up", trades: 90 },
    { kind: "vol-expansion", trades: 60 },
    { kind: "vol-contraction", trades: 60 },
    { kind: "rotation", trades: 100 },
    { kind: "aggressive-buy", trades: 60 },
    { kind: "replenish", trades: 40 },
    { kind: "pull", trades: 40 },
    { kind: "aggressive-sell", trades: 60 },
    { kind: "bid-absorption", trades: 80 },
    { kind: "sweep-buys", trades: 50 },
    { kind: "delta-divergence", trades: 80 },
    { kind: "trend-down", trades: 90 },
    { kind: "ask-absorption", trades: 80 },
    { kind: "sweep-sells", trades: 50 },
    { kind: "failed-breakout-up", trades: 110 },
    { kind: "breakout-continuation-up", trades: 90 },
    { kind: "failed-breakout-down", trades: 110 },
    { kind: "breakout-continuation-down", trades: 90 },
  ];
}

interface Regime {
  /** Expected price drift in ticks per trade. */
  drift: number;
  /** Probability the next trade is a BUY aggressor. */
  buyProb: number;
  /** Expected absolute price movement in ticks. */
  vol: number;
  /** Mean size multiplier for aggressive prints. */
  sizeMult: number;
  /** Target resting size per book level. */
  levelTarget: number;
  /** Multiplier applied to the defended side's top levels (absorption/stack). */
  stackSide: 0 | -1 | 1; // -1 bid stacking, +1 ask stacking, 0 none
  /** Probability a book refresh removes/pulls top-of-book size. */
  pullRate: number;
  /** Probability pulled size is restored on a later refresh. */
  replenishRate: number;
  /** Probability of a sweep print in this regime. */
  sweepRate: number;
  /** Sweep direction: 1 buy-side lifts the offer, -1 sell-side hits the bid. */
  sweepSide: -1 | 0 | 1;
}

function phaseRegime(kind: PhaseKind, prev: Regime, rng: () => number, index: number): Regime {
  const base: Regime = {
    drift: 0,
    buyProb: 0.5,
    vol: 1.1,
    sizeMult: 1,
    levelTarget: 120,
    stackSide: 0,
    pullRate: 0.06,
    replenishRate: 0.4,
    sweepRate: 0.008,
    sweepSide: 0,
  };
  switch (kind) {
    case "meander":
      return { ...base, vol: 0.8 };
    case "trend-up":
      return { ...base, drift: 0.55, buyProb: 0.62, vol: 1.4 };
    case "trend-down":
      return { ...base, drift: -0.55, buyProb: 0.38, vol: 1.4 };
    case "rotation": {
      // Alternating legs: direction flips every `leg` trades.
      const leg = 26 + Math.floor(rng() * 18);
      const dir = Math.floor(index / leg) % 2 === 0 ? 1 : -1;
      return { ...base, drift: dir * 0.32, buyProb: 0.5 + dir * 0.1, vol: 1.2 };
    }
    case "vol-expansion":
      return { ...prev, vol: Math.min(4.2, prev.vol * 1.22 + 0.35), drift: prev.drift * 1.3, levelTarget: prev.levelTarget * 0.85 };
    case "vol-contraction":
      return { ...prev, vol: Math.max(0.55, prev.vol * 0.72), drift: prev.drift * 0.6, levelTarget: prev.levelTarget * 1.05 };
    case "aggressive-buy":
      return { ...base, drift: 0.9, buyProb: 0.84, vol: 1.5, sizeMult: 2.1, sweepSide: 1, sweepRate: 0.05, levelTarget: 90 };
    case "aggressive-sell":
      return { ...base, drift: -0.9, buyProb: 0.16, vol: 1.5, sizeMult: 2.1, sweepSide: -1, sweepRate: 0.05, levelTarget: 90 };
    case "replenish":
      return { ...base, pullRate: 0.16, replenishRate: 0.85, levelTarget: 170, vol: 0.7 };
    case "pull":
      return { ...base, pullRate: 0.3, replenishRate: 0.1, levelTarget: 70, vol: 0.9 };
    case "bid-absorption":
      return { ...base, buyProb: 0.22, vol: 1.15, sizeMult: 1.9, stackSide: -1, levelTarget: 110, sweepSide: -1, sweepRate: 0.02 };
    case "ask-absorption":
      return { ...base, buyProb: 0.78, vol: 1.15, sizeMult: 1.9, stackSide: 1, levelTarget: 110, sweepSide: 1, sweepRate: 0.02 };
    case "sweep-buys":
      return { ...base, drift: 0.15, buyProb: 0.66, sweepSide: 1, sweepRate: 0.14, vol: 1.2 };
    case "sweep-sells":
      return { ...base, drift: -0.15, buyProb: 0.34, sweepSide: -1, sweepRate: 0.14, vol: 1.2 };
    case "delta-divergence":
      // Price grinds higher while aggressors keep selling — CVD diverges.
      return { ...base, drift: 0.4, buyProb: 0.26, vol: 1.1 };
    case "failed-breakout-up":
      // Handled with sub-stages inside the phase loop (approach → break → trap).
      return { ...base, drift: 0.7, buyProb: 0.72, vol: 1.5, sizeMult: 1.7 };
    case "failed-breakout-down":
      return { ...base, drift: -0.7, buyProb: 0.28, vol: 1.5, sizeMult: 1.7 };
    case "breakout-continuation-up":
      return { ...base, drift: 1.0, buyProb: 0.76, vol: 1.6, sizeMult: 1.8, sweepSide: 1, sweepRate: 0.04 };
    case "breakout-continuation-down":
      return { ...base, drift: -1.0, buyProb: 0.24, vol: 1.6, sizeMult: 1.8, sweepSide: -1, sweepRate: 0.04 };
  }
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface SyntheticFeedOptions {
  /** Any 32-bit integer. Same seed ⇒ identical event stream. */
  seed: number;
  /** Behaviour plan; defaults to defaultPlan(). */
  plan?: PhaseSpec[];
  /** Starting mid price (snapped to the tick grid). Default 18000.00. */
  startPrice?: number;
  /** Average milliseconds between prints. Default 420. */
  msPerTrade?: number;
}

/* ------------------------------------------------------------------ */
/* Book simulation state                                               */
/* ------------------------------------------------------------------ */

interface BookSideState {
  /** Resting size per level offset (index 0 = top). */
  sizes: number[];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/* ------------------------------------------------------------------ */
/* SyntheticMarketDataFeed                                             */
/* ------------------------------------------------------------------ */

export class SyntheticMarketDataFeed implements MarketDataFeed {
  readonly source = "Synthetic Training Data";
  readonly isRealData = false;

  private readonly eventsArr: MarketEvent[];
  private cursor = 0; // index of next event to emit

  constructor(options: SyntheticFeedOptions) {
    const seed = options.seed >>> 0;
    const rng = makeRng(seed ^ 0x9e3779b9);
    const plan = options.plan ?? defaultPlan();
    const msPerTrade = options.msPerTrade ?? 420;
    const startTicks = Math.round((options.startPrice ?? 18000) / FEED_TICK);

    const events: MarketEvent[] = [];
    let priceTicks = startTicks;
    let timestamp = FEED_T0;
    let sequence = 0;
    let prevRegime: Regime = emptyRegime();

    // Book state: two sides of 10 levels, sizes random-walking to targets.
    const bid: BookSideState = { sizes: Array.from({ length: 10 }, () => 100 + Math.floor(rng() * 60)) };
    const ask: BookSideState = { sizes: Array.from({ length: 10 }, () => 100 + Math.floor(rng() * 60)) };
    let orderSizeMean = 45;

    type EventInput =
      | Omit<TradeEvent, "sequence">
      | Omit<L2Event, "sequence">
      | Omit<BookResetEvent, "sequence">;
    const push = (ev: EventInput) => {
      sequence += 1;
      events.push({ ...ev, sequence } as MarketEvent);
    };

    const emitBookReset = () => {
      timestamp += 60;
      push({ kind: "book-reset", timestamp });
    };

    const buildLevel = (priceTicksAt: number, size: number): Level => {
      const orders = clamp(Math.round(size / orderSizeMean), 1, 40);
      return { price: +(priceTicksAt * FEED_TICK).toFixed(2), size: Math.round(size), orderCount: orders };
    };

    const emitL2 = () => {
      const bestBid = priceTicks - 1;
      const bestAsk = priceTicks;
      const bids: Level[] = [];
      const asks: Level[] = [];
      for (let i = 0; i < 10; i++) {
        bids.push(buildLevel(bestBid - i, bid.sizes[i]));
        asks.push(buildLevel(bestAsk + i, ask.sizes[i]));
      }
      push({ kind: "l2", timestamp, bids, asks });
    };

    /** Random-walk one side's 10 level sizes toward the regime target. */
    const evolveSide = (
      side: BookSideState,
      regime: Regime,
      defended: boolean,
      rngLocal: () => number,
    ): void => {
      for (let i = 0; i < 10; i++) {
        let target = regime.levelTarget;
        if (defended && i < 3) target *= 2.6; // absorption / stacking at the defended levels
        if (regime.stackSide !== 0 && i < 2) target *= 1.8;
        const cur = side.sizes[i];
        let next = cur + (target - cur) * 0.35 + (rngLocal() - 0.5) * 26;
        // Pulling: occasionally strip top-of-book size.
        if (i < 2 && rngLocal() < regime.pullRate) next *= 0.25 + rngLocal() * 0.3;
        // Replenishment: occasionally restore top-of-book size generously.
        if (i < 2 && rngLocal() < regime.replenishRate * 0.35) next = Math.max(next, regime.levelTarget * 1.3);
        side.sizes[i] = clamp(next, 4, 950);
      }
    };

    emitBookReset();

    for (const phase of plan) {
      const regime = phaseRegime(phase.kind, prevRegime, rng, events.length);
      prevRegime = regime;
      // Phase anchor for absorption pinning / breakout levels.
      const anchorTicks = priceTicks;
      const stageCount = phase.trades;
      for (let t = 0; t < stageCount; t++) {
        const stage = t / Math.max(1, stageCount - 1); // 0..1 through the phase
        let drift = regime.drift;
        let buyProb = regime.buyProb;
        let vol = regime.vol;
        let sizeMult = regime.sizeMult;
        let pinFloor: number | null = null;
        let pinCeil: number | null = null;

        switch (phase.kind) {
          case "bid-absorption": {
            // Sell pressure hammers a floor that refuses to break.
            pinFloor = anchorTicks;
            buyProb = 0.2 + 0.12 * Math.sin(stage * Math.PI);
            sizeMult = 1.6 + stage * 1.2; // sell prints grow as they are absorbed
            drift = stage < 0.75 ? -0.25 : 0.35; // small stall, then recovery
            break;
          }
          case "ask-absorption": {
            pinCeil = anchorTicks;
            buyProb = 0.8 - 0.12 * Math.sin(stage * Math.PI);
            sizeMult = 1.6 + stage * 1.2;
            drift = stage < 0.75 ? 0.25 : -0.35;
            break;
          }
          case "failed-breakout-up": {
            if (stage < 0.45) {
              // Approach: firm run up to the level.
              drift = 0.8; buyProb = 0.68;
            } else if (stage < 0.65) {
              // Break: aggressive buying pushes above the recent high.
              drift = 1.2; buyProb = 0.88; sizeMult = 2.2;
            } else {
              // Trap: initiative buyers vanish, responsive sellers slam it back.
              drift = -1.1; buyProb = 0.18; sizeMult = 2.3;
            }
            break;
          }
          case "failed-breakout-down": {
            if (stage < 0.45) {
              drift = -0.8; buyProb = 0.32;
            } else if (stage < 0.65) {
              drift = -1.2; buyProb = 0.12; sizeMult = 2.2;
            } else {
              drift = 1.1; buyProb = 0.82; sizeMult = 2.3;
            }
            break;
          }
          case "breakout-continuation-up": {
            if (stage < 0.3) {
              drift = 1.2; buyProb = 0.85; sizeMult = 2.0; // the break
            } else {
              drift = 0.9; buyProb = 0.72; sizeMult = 1.7; // continuation
            }
            break;
          }
          case "breakout-continuation-down": {
            if (stage < 0.3) {
              drift = -1.2; buyProb = 0.15; sizeMult = 2.0;
            } else {
              drift = -0.9; buyProb = 0.28; sizeMult = 1.7;
            }
            break;
          }
          default:
            break;
        }

        // ---- aggressor side (regime-driven, never inferred elsewhere) ----
        const side: Aggressor = rng() < buyProb ? "BUY" : "SELL";

        // ---- size: fat-tailed-ish around regime mean ----
        const u = rng();
        let size = Math.round(6 * sizeMult * (0.35 + u * u * 4.2) + 1);
        if (side === "BUY" && regime.sweepSide === 1 && rng() < regime.sweepRate * 3) size = Math.round(size * 3.5 + 40);
        if (side === "SELL" && regime.sweepSide === -1 && rng() < regime.sweepRate * 3) size = Math.round(size * 3.5 + 40);
        size = clamp(size, 1, 999);

        // ---- price movement consistent with the aggressor + regime ----
        const signed = side === "BUY" ? 1 : -1;
        const noise = (rng() - 0.5) * 2; // -1..1
        let moveTicks = Math.round((signed * vol * (0.45 + rng() * 0.9)) + noise * vol * 0.55 + drift * (rng() < 0.6 ? 1 : 0));
        if (side === "BUY") moveTicks = Math.max(moveTicks, -1);
        if (side === "SELL") moveTicks = Math.min(moveTicks, 1);
        let nextTicks = priceTicks + moveTicks;
        if (pinFloor !== null) nextTicks = Math.max(nextTicks, pinFloor);
        if (pinCeil !== null) nextTicks = Math.min(nextTicks, pinCeil);
        nextTicks = Math.max(startTicks - 900, Math.min(startTicks + 900, nextTicks));
        priceTicks = nextTicks;

        // ---- emit trade + cadenced book refresh ----
        timestamp += Math.round(msPerTrade * (0.55 + rng() * 0.9));
        push({ kind: "trade", timestamp, price: +(priceTicks * FEED_TICK).toFixed(2), size, aggressorSide: side });

        evolveSide(bid, regime, regime.stackSide === -1 || pinFloor !== null, rng);
        evolveSide(ask, regime, regime.stackSide === 1 || pinCeil !== null, rng);
        orderSizeMean = clamp(orderSizeMean + (rng() - 0.5) * 4, 22, 85);

        if (t % 3 === 2) emitL2();
      }
      // Refresh the book at every phase boundary.
      emitL2();
    }

    this.eventsArr = events;
  }

  /* --------------------------- MarketDataFeed --------------------------- */

  reset(): void {
    this.cursor = 0;
  }

  hasNext(): boolean {
    return this.cursor < this.eventsArr.length;
  }

  nextEvent(): MarketEvent | null {
    if (!this.hasNext()) return null;
    return this.eventsArr[this.cursor++];
  }

  currentTimestamp(): number | null {
    if (!this.hasNext()) return null;
    return this.eventsArr[this.cursor].timestamp;
  }

  seek(sequence: number): boolean {
    // Sequences are 1-based and dense: event i has sequence i+1.
    if (sequence < 1 || sequence > this.eventsArr.length) return false;
    this.cursor = sequence - 1;
    return true;
  }

  position(): number {
    return this.cursor + 1;
  }

  totalEvents(): number {
    return this.eventsArr.length;
  }

  events(): readonly MarketEvent[] {
    return this.eventsArr;
  }
}

function emptyRegime(): Regime {
  return {
    drift: 0,
    buyProb: 0.5,
    vol: 1,
    sizeMult: 1,
    levelTarget: 120,
    stackSide: 0,
    pullRate: 0.05,
    replenishRate: 0.35,
    sweepRate: 0.005,
    sweepSide: 0,
  };
}

