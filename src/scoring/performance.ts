/** Performance statistics computed purely from closed trades + account state. */

import type { ClosedTrade } from "../execution/types";

export interface PerformanceStats {
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  winRate: number;
  profitFactor: number;
  avgWinner: number;
  avgLoser: number;
  avgTrade: number;
  largestWinner: number;
  largestLoser: number;
  maxDrawdown: number;
  avgR: number | null;
  expectancy: number;
  totalCommission: number;
  equityCurve: number[];
}

export const EMPTY_STATS: PerformanceStats = {
  trades: 0,
  wins: 0,
  losses: 0,
  scratches: 0,
  netPnl: 0,
  grossProfit: 0,
  grossLoss: 0,
  winRate: 0,
  profitFactor: 0,
  avgWinner: 0,
  avgLoser: 0,
  avgTrade: 0,
  largestWinner: 0,
  largestLoser: 0,
  maxDrawdown: 0,
  avgR: null,
  expectancy: 0,
  totalCommission: 0,
  equityCurve: [0],
};

export function computePerformance(trades: ClosedTrade[]): PerformanceStats {
  if (trades.length === 0) return { ...EMPTY_STATS, equityCurve: [0] };

  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let scratches = 0;
  let largestWinner = 0;
  let largestLoser = 0;
  let rSum = 0;
  let rCount = 0;
  let commission = 0;
  const equityCurve: number[] = [0];
  let cumulative = 0;

  for (const t of trades) {
    commission += t.commission;
    cumulative += t.netPnl;
    equityCurve.push(cumulative);
    if (t.netPnl > 0) {
      wins++;
      grossProfit += t.netPnl;
      largestWinner = Math.max(largestWinner, t.netPnl);
    } else if (t.netPnl < 0) {
      losses++;
      grossLoss += Math.abs(t.netPnl);
      largestLoser = Math.min(largestLoser, t.netPnl);
    } else {
      scratches++;
    }
    if (t.rMultiple !== undefined && Number.isFinite(t.rMultiple)) {
      rSum += t.rMultiple;
      rCount++;
    }
  }

  const netPnl = grossProfit - grossLoss;
  const decided = wins + losses;
  const winRate = decided > 0 ? (wins / decided) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  return {
    trades: trades.length,
    wins,
    losses,
    scratches,
    netPnl,
    grossProfit,
    grossLoss,
    winRate,
    profitFactor,
    avgWinner: wins > 0 ? grossProfit / wins : 0,
    avgLoser: losses > 0 ? grossLoss / losses : 0,
    avgTrade: netPnl / trades.length,
    largestWinner,
    largestLoser,
    maxDrawdown: maxDrawdownFrom(equityCurve),
    avgR: rCount > 0 ? rSum / rCount : null,
    expectancy: trades.length > 0 ? netPnl / trades.length : 0,
    totalCommission: commission,
    equityCurve,
  };
}

/** Peak-to-trough drawdown of a cumulative-P&L curve (positive dollars). */
export function maxDrawdownFrom(equity: number[]): number {
  let peak = equity[0] ?? 0;
  let maxDd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    maxDd = Math.max(maxDd, peak - v);
  }
  return maxDd;
}

export interface SessionStats {
  startingBalance: number;
  endingBalance: number;
  sessionPnl: number;
  peakBalance: number;
  maxDrawdown: number;
}

export function computeSessionStats(
  startingBalance: number,
  stats: PerformanceStats,
): SessionStats {
  let peak = startingBalance;
  let peakBalance = startingBalance;
  let maxDd = 0;
  for (const v of stats.equityCurve) {
    const bal = startingBalance + v;
    if (bal > peak) peak = bal;
    peakBalance = Math.max(peakBalance, bal);
    maxDd = Math.max(maxDd, peak - bal);
  }
  return {
    startingBalance,
    endingBalance: startingBalance + stats.netPnl,
    sessionPnl: stats.netPnl,
    peakBalance,
    maxDrawdown: maxDd,
  };
}

/** Kelly-style expectancy expressed in R, plus naive standard error. */
export function rStatistics(trades: ClosedTrade[]): {
  n: number;
  meanR: number;
  sdR: number;
  seR: number;
  ci95: [number, number];
} | null {
  const rs = trades
    .map((t) => t.rMultiple)
    .filter((r): r is number => r !== undefined && Number.isFinite(r));
  if (rs.length < 2) return null;
  const n = rs.length;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const se = sd / Math.sqrt(n);
  return { n, meanR: mean, sdR: sd, seR: se, ci95: [mean - 1.96 * se, mean + 1.96 * se] };
}
