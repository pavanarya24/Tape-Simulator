/**
 * Session indexing.
 *
 * A session index is a list of contiguous ranges into the dataset's bar arrays,
 * so loading one session never pulls the full multi-year dataset into memory.
 *
 *  - RTH: 09:30–16:00 America/New_York, keyed by the calendar day.
 *  - ETH: the full CME trading day (18:00 prior day → 17:00), keyed by trade date.
 */

import type { BarSeries, RootSymbol } from "../market/types";
import {
  ETH_DAY_START_MINUTES,
  RTH_END_MINUTES,
  RTH_START_MINUTES,
  type SessionMeta,
  type SessionType,
} from "./types";
import { addDays, isoDate, minutesOfDay } from "./timezone";

interface Accumulator {
  key: string;
  start: number;
  end: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  firstTime: number;
  lastTime: number;
}

function close(acc: Accumulator, instrument: RootSymbol, type: SessionType): SessionMeta {
  return {
    id: `${instrument}:${type}:${acc.key}`,
    instrument,
    type,
    date: acc.key,
    startIndex: acc.start,
    endIndex: acc.end,
    bars: acc.end - acc.start,
    firstTime: acc.firstTime,
    lastTime: acc.lastTime,
    open: acc.open,
    high: acc.high,
    low: acc.low,
    close: acc.close,
    volume: acc.volume,
  };
}

export interface SessionIndex {
  rth: SessionMeta[];
  eth: SessionMeta[];
}

export function buildSessionIndex(
  series: BarSeries,
  instrument: RootSymbol,
  timezone: string,
): SessionIndex {
  const rth: SessionMeta[] = [];
  const eth: SessionMeta[] = [];

  let curRth: Accumulator | null = null;
  let curEth: Accumulator | null = null;

  const startAcc = (key: string, i: number): Accumulator => ({
    key,
    start: i,
    end: i + 1,
    open: series.o[i],
    high: series.h[i],
    low: series.l[i],
    close: series.c[i],
    volume: series.v[i],
    firstTime: series.t[i],
    lastTime: series.t[i],
  });

  const extend = (acc: Accumulator, i: number) => {
    acc.end = i + 1;
    acc.high = Math.max(acc.high, series.h[i]);
    acc.low = Math.min(acc.low, series.l[i]);
    acc.close = series.c[i];
    acc.volume += series.v[i];
    acc.lastTime = series.t[i];
  };

  for (let i = 0; i < series.length; i++) {
    const t = series.t[i];
    const minute = minutesOfDay(t, timezone);
    const calendarDay = isoDate(t, timezone);

    // ---- RTH ----
    if (minute >= RTH_START_MINUTES && minute < RTH_END_MINUTES) {
      if (curRth && curRth.key === calendarDay) {
        extend(curRth, i);
      } else {
        if (curRth) rth.push(close(curRth, instrument, "RTH"));
        curRth = startAcc(calendarDay, i);
      }
    } else if (curRth) {
      rth.push(close(curRth, instrument, "RTH"));
      curRth = null;
    }

    // ---- ETH (CME trade day rolls at 18:00) ----
    const tradeDay = minute >= ETH_DAY_START_MINUTES ? addDays(calendarDay, 1) : calendarDay;
    if (curEth && curEth.key === tradeDay) {
      extend(curEth, i);
    } else {
      if (curEth) eth.push(close(curEth, instrument, "ETH"));
      curEth = startAcc(tradeDay, i);
    }
  }

  if (curRth) rth.push(close(curRth, instrument, "RTH"));
  if (curEth) eth.push(close(curEth, instrument, "ETH"));

  return { rth, eth };
}

export function sessionsFor(index: SessionIndex, type: SessionType): SessionMeta[] {
  return type === "RTH" ? index.rth : index.eth;
}

export function findSession(
  index: SessionIndex,
  type: SessionType,
  id: string,
): SessionMeta | undefined {
  return sessionsFor(index, type).find((s) => s.id === id);
}
