/**
 * Adaptive Moving Average (AMA) — Perry Kaufman's efficiency-ratio smoothing,
 * applied to the Flow Lab's revealed traded-price series.
 *
 *   ER   = |close − close₍ᵢ₋w₎| / Σ|Δclose| over the lookback window
 *   SC   = (ER × (fast − slow) + slow)²
 *   AMAᵢ = AMAᵢ₋₁ + SC × (closeᵢ − AMAᵢ₋₁)
 *
 * The average adapts: when the tape makes purposeful progress (ER → 1) it
 * tracks price closely; when the tape chops sideways (ER → 0) it slows down
 * and ignores the noise.
 *
 * Rules:
 *  - Pure and deterministic: identical prices ⇒ identical output, so seek /
 *    replay / restart reproduce it byte-for-byte.
 *  - Consumes ONLY prices — never ScenarioTruth, seeds or generator state,
 *    so it is safe to show while blind.
 *  - Warm-up: the efficiency ratio uses whatever window is available
 *    (min(i, period)), so a value exists for every print from the first one —
 *    no nulls for the chart or the readout to special-case.
 */

export interface AmaParams {
  /** Lookback, in prints, for the efficiency ratio. */
  period: number;
  /** Smoothing constant at efficiency 1 (fast tracking). */
  fast: number;
  /** Smoothing constant at efficiency 0 (slow drift). */
  slow: number;
}

/** Lookback used by the Flow Lab AMA. */
export const AMA_PERIOD = 10;
/** Kaufman's fast MA length: 2/(2+1) = 0.666… */
export const AMA_FAST_PERIOD = 2;
/** Kaufman's slow MA length: 2/(30+1) ≈ 0.0645. */
export const AMA_SLOW_PERIOD = 30;

export const AMA_FAST = 2 / (AMA_FAST_PERIOD + 1);
export const AMA_SLOW = 2 / (AMA_SLOW_PERIOD + 1);

export const AMA_DEFAULT_PARAMS: AmaParams = {
  period: AMA_PERIOD,
  fast: AMA_FAST,
  slow: AMA_SLOW,
};

function normalized(params: Partial<AmaParams> | undefined): AmaParams {
  const p = { ...AMA_DEFAULT_PARAMS, ...params };
  return {
    period: Number.isFinite(p.period) ? Math.max(1, Math.floor(p.period)) : AMA_PERIOD,
    fast: Number.isFinite(p.fast) ? p.fast : AMA_FAST,
    slow: Number.isFinite(p.slow) ? p.slow : AMA_SLOW,
  };
}

/**
 * Efficiency ratio for each print: 0 = pure sideways noise, 1 = a straight
 * line in one direction. The window is min(i, period) so early prints still
 * get a bounded, well-defined reading (ER[0] = 0 — no change yet).
 */
export function efficiencyRatio(
  prices: readonly number[],
  params?: Partial<AmaParams>,
): number[] {
  const { period } = normalized(params);
  const out: number[] = new Array(prices.length).fill(0);
  for (let i = 1; i < prices.length; i++) {
    const w = Math.min(i, period);
    const change = Math.abs(prices[i] - prices[i - w]);
    let total = 0;
    for (let k = i - w + 1; k <= i; k++) total += Math.abs(prices[k] - prices[k - 1]);
    out[i] = total > 0 ? Math.min(1, Math.max(0, change / total)) : 0;
  }
  return out;
}

/**
 * Adaptive Moving Average of the given prices — one value per input, aligned
 * index-for-index. The first value seeds at the first print; every later
 * value applies the smoothed efficiency-ratio recursion.
 */
export function computeAma(prices: readonly number[], params?: Partial<AmaParams>): number[] {
  if (prices.length === 0) return [];
  const { fast, slow } = normalized(params);
  const er = efficiencyRatio(prices, params);
  const out: number[] = new Array(prices.length);
  out[0] = prices[0];
  for (let i = 1; i < prices.length; i++) {
    const sc = er[i] * (fast - slow) + slow;
    const smooth = sc * sc;
    out[i] = out[i - 1] + smooth * (prices[i] - out[i - 1]);
  }
  return out;
}
