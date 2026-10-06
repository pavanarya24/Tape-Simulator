/** Shared fixtures for the Tape Lab test suites. */

import type { Bar, BarSeries } from "../src/market/types";
import { barSeriesFromBars } from "../src/data/types";
import type { SessionMeta } from "../src/data/types";
import { CONTRACTS } from "../src/market/instruments";
import type { ExecutionConfig } from "../src/execution/types";
import type { ExecutionContext } from "../src/execution/ExecutionSimulator";

/** Build a BarSeries from `[t, o, h, l, c, v]` tuples. */
export function series(rows: number[][]): BarSeries {
  const bars: Bar[] = rows.map((r) => ({ t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] ?? 0 }));
  return barSeriesFromBars(bars);
}

/** Bar tuples spaced `stepMs` apart starting at `t0`, ascending closes. */
export function trend(start: number, count: number, step: number, drift = 1, t0 = 1_700_000_000_000): BarSeries {
  const rows: number[][] = [];
  for (let i = 0; i < count; i++) {
    const c = start + i * drift;
    rows.push([t0 + i * step, c, c + 0.5, c - 0.5, c, 100 + i]);
  }
  return series(rows);
}

export function metaFor(bars: BarSeries, overrides: Partial<SessionMeta> = {}): SessionMeta {
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (let i = 0; i < bars.length; i++) {
    high = Math.max(high, bars.h[i]);
    low = Math.min(low, bars.l[i]);
    volume += bars.v[i];
  }
  return {
    id: "NQ:RTH:2024-01-02",
    instrument: "NQ",
    type: "RTH",
    date: "2024-01-02",
    startIndex: 0,
    endIndex: bars.length,
    bars: bars.length,
    firstTime: bars.t[0],
    lastTime: bars.t[bars.length - 1],
    open: bars.o[0],
    high,
    low,
    close: bars.c[bars.length - 1],
    volume,
    ...overrides,
  };
}

export function cfg(overrides: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    contract: CONTRACTS.NQ,
    ambiguityRule: "adverse-first",
    slippageTicks: 1,
    commissionPerContractRoundTurn: 0,
    requireStop: false,
    maxContracts: 10,
    maxTradesPerSession: 10,
    dailyLossLimit: 0,
    ...overrides,
  };
}

export const CTX: ExecutionContext = {
  instrument: "NQ",
  sessionId: "NQ:RTH:2024-01-02",
  sessionDate: "2024-01-02",
  sessionType: "RTH",
};

export const NQ_TICK = CONTRACTS.NQ.tickSize; // 0.25
