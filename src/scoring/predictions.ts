/**
 * Blind-mode predictions.
 *
 * The user sees only revealed history, states what they expect next, then the
 * engine reveals the next 5 / 10 / 20 bars. Correctness is judged by explicit,
 * configurable rules over OHLC bars — never by hindsight prose.
 */

import type { BarSeries } from "../market/types";

export type PredictionChoice = "Bullish" | "Bearish" | "Range" | "Breakout" | "Reversal";

export const PREDICTION_CHOICES: PredictionChoice[] = [
  "Bullish",
  "Bearish",
  "Range",
  "Breakout",
  "Reversal",
];

export const REVEAL_HORIZONS = [5, 10, 20] as const;
export type RevealHorizon = (typeof REVEAL_HORIZONS)[number];

export interface PredictionRules {
  /** Directional move must exceed this × mean bar range. */
  moveThresholdAtr: number;
  /** |net move| below this × mean bar range counts as "Range". */
  rangeMaxAtr: number;
  /** Horizon range must exceed prior range by this × mean bar range for a breakout. */
  breakoutAtr: number;
  /** Reversal must move this × mean bar range against the prior leg. */
  reversalAtr: number;
  /** Bars used to measure the prior range / prior leg. */
  lookback: number;
}

export const DEFAULT_PREDICTION_RULES: PredictionRules = {
  moveThresholdAtr: 0.6,
  rangeMaxAtr: 0.6,
  breakoutAtr: 1.0,
  reversalAtr: 0.6,
  lookback: 20,
};

export interface PredictionRecord {
  id: string;
  /** Replay timestamp of the prediction. */
  time: number;
  /** Bar index the prediction was made at (the last revealed bar). */
  index: number;
  choice: PredictionChoice;
  reasoning: string;
  horizon: number;
  startPrice: number;
  endIndex: number;
  endPrice: number;
  correct: boolean;
  detail: string;
}

export interface EvaluationResult {
  evaluable: boolean;
  correct: boolean;
  detail: string;
  endIndex: number;
  endPrice: number;
}

function meanRange(bars: BarSeries, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = from; i <= to && i < bars.length; i++) {
    sum += bars.h[i] - bars.l[i];
    n++;
  }
  return n > 0 ? sum / n : 0;
}

export function evaluatePrediction(
  choice: PredictionChoice,
  horizon: number,
  startIndex: number,
  bars: BarSeries,
  rules: PredictionRules,
): EvaluationResult {
  const endIndex = Math.min(startIndex + horizon, bars.length - 1);
  if (endIndex <= startIndex) {
    return { evaluable: false, correct: false, detail: "Not enough future bars to evaluate.", endIndex, endPrice: NaN };
  }

  const startPrice = bars.c[startIndex];
  const endPrice = bars.c[endIndex];
  const move = endPrice - startPrice;

  let hi = -Infinity;
  let lo = Infinity;
  for (let i = startIndex + 1; i <= endIndex; i++) {
    hi = Math.max(hi, bars.h[i]);
    lo = Math.min(lo, bars.l[i]);
  }
  const mr = meanRange(bars, startIndex + 1, endIndex) || Math.abs(move) || 1;
  const horizonMove = Math.abs(move);
  const threshold = rules.moveThresholdAtr * mr;

  const lbStart = Math.max(0, startIndex - rules.lookback);
  let priorHi = -Infinity;
  let priorLo = Infinity;
  for (let i = lbStart; i <= startIndex; i++) {
    priorHi = Math.max(priorHi, bars.h[i]);
    priorLo = Math.min(priorLo, bars.l[i]);
  }
  const priorRange = Math.max(mr, priorHi - priorLo);
  const priorLeg = startPrice - bars.c[lbStart];
  const horizonRange = hi - lo;

  let correct = false;
  let detail = "";

  switch (choice) {
    case "Bullish":
      correct = move >= threshold;
      detail = `Net move ${move >= 0 ? "+" : ""}${move.toFixed(2)} vs threshold +${threshold.toFixed(2)}`;
      break;
    case "Bearish":
      correct = move <= -threshold;
      detail = `Net move ${move.toFixed(2)} vs threshold -${threshold.toFixed(2)}`;
      break;
    case "Range":
      correct = horizonMove <= rules.rangeMaxAtr * mr;
      detail = `|Net move| ${horizonMove.toFixed(2)} vs range cap ${(rules.rangeMaxAtr * mr).toFixed(2)}`;
      break;
    case "Breakout":
      correct =
        horizonRange >= priorRange + rules.breakoutAtr * mr && horizonMove >= threshold;
      detail = `Horizon range ${horizonRange.toFixed(2)} vs prior ${priorRange.toFixed(2)} (+${(
        rules.breakoutAtr * mr
      ).toFixed(2)})`;
      break;
    case "Reversal":
      correct =
        Math.sign(move) !== 0 &&
        Math.sign(move) !== Math.sign(priorLeg) &&
        horizonMove >= rules.reversalAtr * mr;
      detail = `Prior leg ${priorLeg >= 0 ? "+" : ""}${priorLeg.toFixed(2)}, horizon move ${move.toFixed(2)}`;
      break;
  }

  return { evaluable: true, correct, detail, endIndex, endPrice };
}
