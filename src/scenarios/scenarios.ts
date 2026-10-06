/**
 * Scenario framework.
 *
 * Scenarios tag historical sessions by their OHLC structure so a trainee can
 * drill a specific environment (Opening Range Breakout, Failed Breakout, Trend
 * Continuation, Range Day, Opening Reversal, VWAP Reversion).
 *
 * Classification uses ONLY price + volume — no order-flow inference is made or
 * implied. Tagged examples are produced from the loaded dataset, not invented.
 */

import type { BarSeries } from "../market/types";
import type { SessionBars } from "../data/types";
import { minutesOfDay } from "../data/timezone";
import { RTH_START_MINUTES } from "../data/types";
import { vwap } from "../indicators/indicators";

export type ScenarioId =
  | "opening-range-breakout"
  | "failed-breakout"
  | "trend-continuation"
  | "range-day"
  | "opening-reversal"
  | "vwap-reversion";

export interface ScenarioDefinition {
  id: ScenarioId;
  name: string;
  description: string;
  /** What the trainee should rehearse here. */
  focus: string;
  /** Order-flow features this scenario would eventually expose with tick data. */
  futureOrderFlow: string[];
}

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: "opening-range-breakout",
    name: "Opening Range Breakout",
    description: "Price breaks the 09:30–09:45 opening range and holds beyond it into the session.",
    focus: "Trade the first clean break of the opening range; manage size after the initial thrust.",
    futureOrderFlow: ["Breakout aggressor imbalance", "Ask/bid depletion at the ORH/ORL", "Delta confirmation on the break"],
  },
  {
    id: "failed-breakout",
    name: "Failed Breakout",
    description: "Price breaks the opening range, then closes back inside it — the break does not hold.",
    focus: "Recognise rejection and trade the failed break back through the range.",
    futureOrderFlow: ["Absorption at the extreme", "Failed auction / poor high-low", "Trapped-trader liquidity"],
  },
  {
    id: "trend-continuation",
    name: "Trend Continuation",
    description: "A directional day where pullbacks are shallow and the session closes near its extreme.",
    focus: "Hold trend trades, add on shallow pullbacks, avoid counter-trend scalps.",
    futureOrderFlow: ["Pullback absorption", "Cumulative delta trend alignment", "Initiative vs responsive activity"],
  },
  {
    id: "range-day",
    name: "Range Day",
    description: "Open-drive absent, rotation between two well-defined boundaries, small net change.",
    focus: "Fade the extremes, take quick targets, and stop expecting a trend that is not there.",
    futureOrderFlow: ["Value area migration", "Responsive buying/selling at boundaries", "Rotation balance"],
  },
  {
    id: "opening-reversal",
    name: "Opening Reversal",
    description: "The session opens with a directional move that reverses and closes opposite to it.",
    focus: "Sit through the false start, then position on the reversal with a defined risk.",
    futureOrderFlow: ["Exhaustion prints", "Absorption against the opening drive", "Delta divergence"],
  },
  {
    id: "vwap-reversion",
    name: "VWAP Reversion",
    description: "Price stretches far from session VWAP and is pulled back toward it.",
    focus: "Fade extension back to VWAP, or use VWAP as the target on a mean-reversion trade.",
    futureOrderFlow: ["Passive absorption at the extreme", "Cumulative delta divergence", "Large-print fade"],
  },
];

export interface SessionFeatures {
  orHigh: number;
  orLow: number;
  orBreakUp: boolean;
  orBreakDown: boolean;
  heldAbove: boolean;
  heldBelow: boolean;
  netMove: number;
  sessionRange: number;
  netToRange: number;
  closeLocationPct: number;
  vwapDistanceMax: number;
  vwapReturned: boolean;
  openingLeg: number;
  closeLeg: number;
}

export interface ScenarioMatch {
  scenario: ScenarioId;
  score: number;
  matched: boolean;
}

export interface SessionClassification {
  primary: ScenarioId | null;
  matches: ScenarioMatch[];
  features: SessionFeatures | null;
}

/** Opening range over the first `orMinutes` after 09:30. */
function openingRangeLevels(
  bars: BarSeries,
  timeZone: string,
  orMinutes: number,
): { startIndex: number; endIndex: number; high: number; low: number } | null {
  let startIndex = -1;
  for (let i = 0; i < bars.length; i++) {
    if (minutesOfDay(bars.t[i], timeZone) >= RTH_START_MINUTES) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return null;
  const startMinute = minutesOfDay(bars.t[startIndex], timeZone);
  let endIndex = startIndex;
  let high = -Infinity;
  let low = Infinity;
  for (let i = startIndex; i < bars.length; i++) {
    if (minutesOfDay(bars.t[i], timeZone) - startMinute >= orMinutes) break;
    high = Math.max(high, bars.h[i]);
    low = Math.min(low, bars.l[i]);
    endIndex = i;
  }
  if (!Number.isFinite(high)) return null;
  return { startIndex, endIndex, high, low };
}

export function extractFeatures(
  bars: BarSeries,
  timeZone: string,
  orMinutes: number,
): SessionFeatures | null {
  const or = openingRangeLevels(bars, timeZone, orMinutes);
  if (!or || bars.length === 0) return null;

  const close = bars.c[bars.length - 1];
  const first = bars.o[0] ?? bars.c[0];
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = 0; i < bars.length; i++) {
    hi = Math.max(hi, bars.h[i]);
    lo = Math.min(lo, bars.l[i]);
  }
  const sessionRange = hi - lo;
  const netMove = close - first;

  let orBreakUp = false;
  let orBreakDown = false;
  let heldAbove = false;
  let heldBelow = false;
  for (let i = or.endIndex + 1; i < bars.length; i++) {
    if (bars.h[i] > or.high) orBreakUp = true;
    if (bars.l[i] < or.low) orBreakDown = true;
  }
  if (orBreakUp) heldAbove = close > or.high;
  if (orBreakDown) heldBelow = close < or.low;

  const vw = vwap(bars);
  let vwapDistanceMax = 0;
  let vwapReturned = false;
  let stretched = false;
  const atr = sessionRange / Math.max(1, bars.length) * 1.5 || 1;
  for (let i = or.endIndex; i < bars.length; i++) {
    const d = Math.abs(bars.c[i] - vw[i]);
    vwapDistanceMax = Math.max(vwapDistanceMax, d);
    if (d > atr * 2) stretched = true;
    if (stretched && i > 0 && Math.abs(bars.c[i] - vw[i]) < atr * 0.4) vwapReturned = true;
  }

  // Opening leg: first 30 minutes after 09:30. Close leg: last hour.
  const openLegEnd = Math.min(bars.length - 1, or.startIndex + 6);
  const openingLeg = bars.c[openLegEnd] - bars.o[or.startIndex];
  const lastHourStart = Math.max(or.startIndex, bars.length - 12);
  const closeLeg = close - bars.c[lastHourStart];

  const closeLocationPct =
    sessionRange > 0 ? ((close - lo) / sessionRange) * 100 : 50;

  return {
    orHigh: or.high,
    orLow: or.low,
    orBreakUp,
    orBreakDown,
    heldAbove,
    heldBelow,
    netMove,
    sessionRange,
    netToRange: sessionRange > 0 ? Math.abs(netMove) / sessionRange : 0,
    closeLocationPct,
    vwapDistanceMax,
    vwapReturned,
    openingLeg,
    closeLeg,
  };
}

export function classifySession(
  session: BarSeries,
  timeZone: string,
  orMinutes = 15,
): SessionClassification {
  const f = extractFeatures(session, timeZone, orMinutes);
  if (!f) return { primary: null, matches: [], features: null };

  const m = (id: ScenarioId, score: number): ScenarioMatch => ({
    scenario: id,
    score: Math.max(0, Math.min(1, score)),
    matched: score >= 0.6,
  });

  const matches: ScenarioMatch[] = [
    m("opening-range-breakout", f.orBreakUp || f.orBreakDown ? Math.min(1, (f.heldAbove || f.heldBelow ? 0.7 : 0.4) + f.netToRange * 0.4) : 0),
    m("failed-breakout", (f.orBreakUp && !f.heldAbove) || (f.orBreakDown && !f.heldBelow) ? 0.85 - f.netToRange * 0.2 : 0),
    m("trend-continuation", f.netToRange * 1.15 * (f.closeLocationPct > 75 || f.closeLocationPct < 25 ? 1.2 : 0.8) - (f.vwapReturned ? 0.15 : 0)),
    m("range-day", (1 - f.netToRange * 1.8) * 0.95 + (f.closeLocationPct > 30 && f.closeLocationPct < 70 ? 0.15 : 0)),
    m("opening-reversal", f.openingLeg !== 0 && Math.sign(f.openingLeg) !== Math.sign(f.closeLeg) && Math.abs(f.closeLeg) > Math.abs(f.openingLeg) * 0.6 ? 0.5 + Math.abs(f.closeLeg) / (f.sessionRange || 1) : 0),
    m("vwap-reversion", f.vwapReturned && f.vwapDistanceMax > 0 ? 0.5 + Math.min(0.5, f.vwapDistanceMax / (f.sessionRange || 1)) : 0),
  ];

  let primary: ScenarioId | null = null;
  let best = 0.6;
  for (const match of matches) {
    if (match.score > best) {
      best = match.score;
      primary = match.scenario;
    }
  }

  return { primary, matches, features: f };
}

export function scenarioById(id: ScenarioId): ScenarioDefinition {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

/** Classify a list of sessions, keeping it bounded for large datasets. */
export function classifySessions(
  sessions: Array<{ meta: SessionBars["meta"]; bars: BarSeries }>,
  timeZone: string,
  orMinutes = 15,
): Array<{ meta: SessionBars["meta"]; classification: SessionClassification }> {
  return sessions.map((s) => ({
    meta: s.meta,
    classification: classifySession(s.bars, timeZone, orMinutes),
  }));
}
