/**
 * Replay scoring.
 *
 * Deliberately multi-factor: profitability is only one input, and a profitable
 * but undisciplined replay scores worse than a flat, well-managed one.
 */

import type { RuleViolation } from "../execution/types";
import type { PerformanceStats } from "./performance";
import type { PredictionRecord } from "./predictions";

export interface ReplayScore {
  riskManagement: number;
  execution: number;
  prediction: number;
  discipline: number;
  overall: number;
  notes: string[];
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export interface ScoreInput {
  stats: PerformanceStats;
  startingBalance: number;
  violations: RuleViolation[];
  predictions: PredictionRecord[];
  maxContracts: number;
}

export function computeScore(input: ScoreInput): ReplayScore {
  const { stats, startingBalance, violations, predictions, maxContracts } = input;
  const notes: string[] = [];

  /* ---- Risk management ---- */
  let risk = 100;
  const ddPct = startingBalance > 0 ? (stats.maxDrawdown / startingBalance) * 100 : 0;
  risk -= clamp(ddPct * 2.5, 0, 55);
  const riskViolations = violations.filter(
    (v) => v.kind === "size" || v.kind === "no-stop" || v.kind === "daily-loss" || v.kind === "max-trades",
  ).length;
  risk -= Math.min(30, riskViolations * 5);
  const avgLoss = stats.avgLoser;
  if (stats.trades > 0 && avgLoss > startingBalance * 0.01) {
    risk -= 8;
    notes.push("Average loss exceeds 1% of starting balance per trade.");
  }
  if (stats.trades === 0) notes.push("No trades taken — risk score reflects inactivity only.");
  risk = clamp(risk);

  /* ---- Execution ---- */
  let execution = 55;
  if (stats.trades > 0) {
    const pf = Number.isFinite(stats.profitFactor) ? stats.profitFactor : 3;
    execution = clamp(35 + pf * 22);
    execution += (stats.winRate - 50) * 0.35;
    if (stats.avgR !== null) execution += stats.avgR * 8;
    execution = clamp(execution);
    if (pf < 1) notes.push("Profit factor below 1.0 — the session lost money per unit of risk.");
  } else {
    notes.push("No closed trades — execution scored neutrally.");
  }

  /* ---- Prediction ---- */
  let prediction = 70;
  if (predictions.length >= 3) {
    const correct = predictions.filter((p) => p.correct).length;
    prediction = clamp((correct / predictions.length) * 100);
  } else if (predictions.length > 0) {
    prediction = 65;
    notes.push("Fewer than 3 predictions — accuracy is not yet meaningful.");
  } else {
    notes.push("No predictions recorded (Blind Mode was not used).");
  }

  /* ---- Discipline ---- */
  const weighted = violations.reduce(
    (acc, v) => acc + (v.kind === "no-stop" || v.kind === "daily-loss" ? 8 : 5),
    0,
  );
  const discipline = clamp(100 - weighted);

  const overall = Math.round(
    risk * 0.3 + execution * 0.25 + prediction * 0.2 + discipline * 0.25,
  );

  if (maxContracts > 0 && stats.trades > 0) {
    const perTradeRisk = (stats.maxDrawdown / stats.trades) / startingBalance;
    if (perTradeRisk < 0.002) notes.push("Drawdown per trade is tightly controlled.");
  }

  return {
    riskManagement: Math.round(risk),
    execution: Math.round(execution),
    prediction: Math.round(prediction),
    discipline: Math.round(discipline),
    overall,
    notes,
  };
}

export const VIOLATION_LABELS: Record<RuleViolation["kind"], string> = {
  "no-stop": "Entry without a protective stop",
  size: "Position size above the contract cap",
  "max-trades": "Exceeded the session trade limit",
  "daily-loss": "Traded past the daily loss limit",
  revenge: "Immediate re-entry after a loss",
};

export function scoreGrade(overall: number): { grade: string; label: string } {
  if (overall >= 90) return { grade: "A", label: "Desk-ready process" };
  if (overall >= 80) return { grade: "B", label: "Solid, minor leaks" };
  if (overall >= 70) return { grade: "C", label: "Developing" };
  if (overall >= 55) return { grade: "D", label: "Needs structural work" };
  return { grade: "F", label: "Process is not yet repeatable" };
}
