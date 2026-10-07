import {
  ColorType,
  CrosshairMode,
  LineStyle,
  type AreaData,
  type AreaSeriesPartialOptions,
  type CandlestickData,
  type CandlestickSeriesPartialOptions,
  type ChartOptions,
  type DeepPartial,
  type LineData,
  type LineSeriesPartialOptions,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import { buildCandles, pickBucketMs, type FlowCandle, type FlowChartTrade } from "../components/FlowChart";
import type { VolumeAtPrice } from "./orderFlow";
import type { FlowAnnotation, FlowAnnotationType } from "./recognition";
import { compact, price as fmtPrice } from "../util/format";

/**
 * Standard colors for objective and interpretive Flow Lab chart annotations.
 */
export const ANNOTATION_COLORS: Record<FlowAnnotationType, string> = {
  aggression: "#4d8ff0",
  concentration: "#a78bfa",
  sweep: "#e5484d",
  divergence: "#7dd3fc",
  breakout: "#2fbf71",
  rejection: "#e6a93c",
  replenishment: "#4dd0e1",
};

/**
 * Professional chart theme tokens matching Tape Lab terminal aesthetics.
 */
export const CHART_THEME = {
  bg: "#0a0d10",
  pane: "#0b0f14",
  grid: "#161b21",
  axis: "#2a333d",
  crosshair: "#55606b",
  up: "#2fbf71",
  down: "#e5484d",
  vwap: "#4d8ff0",
  ama: "#22d3ee",
  cvd: "#a78bfa",
  cvdFill: "rgba(167, 139, 250, 0.18)",
  text: "#7c8894",
  font: "'IBM Plex Mono', monospace",
} as const;

/**
 * Options for adapting raw price series into candles.
 */
export interface AdaptPriceSeriesOptions {
  coarseContext?: boolean;
  targetCandles?: number;
  plotWidth?: number;
}

/**
 * Options for adapting CVD data into series points.
 */
export interface AdaptCvdOptions {
  tradeCount?: number;
  rawCandles?: FlowCandle[];
}

/**
 * Render items for Volume Profile gutter visualization.
 */
export interface ProfileRenderItem {
  price: number;
  formattedPrice: string;
  buy: number;
  sell: number;
  total: number;
  buyPct: number;
  sellPct: number;
  widthPct: number;
}

/**
 * Normalized data structure for Volume Profile presentation.
 */
export interface VolumeProfileRenderData {
  items: ProfileRenderItem[];
  maxTotal: number;
  formattedMax: string;
}

/**
 * Convert FlowCandle aggregates to strictly ascending Lightweight Charts CandlestickData.
 * Ensures timestamps are monotonically strictly increasing so the chart engine never throws.
 */
export function toCandlestickData(candles: FlowCandle[]): CandlestickData<UTCTimestamp>[] {
  if (candles.length === 0) return [];
  const result: CandlestickData<UTCTimestamp>[] = [];
  let prevTime = -Infinity;

  for (const c of candles) {
    let t = Math.floor(c.t / 1000);
    if (t <= prevTime) {
      t = prevTime + 1;
    }
    prevTime = t;
    result.push({
      time: t as UTCTimestamp,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    });
  }
  return result;
}

/**
 * Adapt raw revealed price series points from FlowState into candlestick data.
 */
export function adaptPriceSeriesToCandles(
  priceSeries: Array<{ t: number; price: number }>,
  options?: AdaptPriceSeriesOptions,
): CandlestickData<UTCTimestamp>[] {
  if (priceSeries.length === 0) return [];
  const t0 = priceSeries[0].t;
  const tEnd = priceSeries[priceSeries.length - 1].t;
  const span = Math.max(1, tEnd - t0);
  const plotW = options?.plotWidth ?? 800;
  const target = options?.targetCandles ?? Math.max(30, Math.min(90, Math.floor(plotW / 11)));
  const effectiveTarget = options?.coarseContext ? Math.max(8, Math.round(target / 3)) : target;
  const bucketMs = pickBucketMs(span, effectiveTarget);
  const candles = buildCandles(priceSeries, bucketMs);
  return toCandlestickData(candles);
}

/**
 * Adapt single current VWAP value to Lightweight Charts LineData aligned with candles.
 * Safely handles null, undefined, non-finite, and zero values by returning an empty series.
 */
export function adaptVwapToLineData(
  vwap: number | null | undefined,
  candles?: CandlestickData<UTCTimestamp>[],
): LineData<UTCTimestamp>[] {
  if (
    vwap === null ||
    vwap === undefined ||
    !Number.isFinite(vwap) ||
    vwap <= 0 ||
    !candles ||
    candles.length === 0
  ) {
    return [];
  }
  return candles.map((c) => ({
    time: c.time,
    value: +vwap.toFixed(2),
  }));
}

/**
 * Adapt Adaptive Moving Average values to Lightweight Charts LineData aligned with candles.
 * Missing / NaN values during the warmup period are safely skipped (not invented).
 * Timestamps are guaranteed to match candle coordinates and remain strictly monotonic.
 */
export function adaptAmaToLineData(
  ama: Array<{ t: number; value: number }> | null | undefined,
  candles?: CandlestickData<UTCTimestamp>[],
  bucketMs?: number,
  rawCandles?: FlowCandle[],
): LineData<UTCTimestamp>[] {
  if (!ama || ama.length === 0) return [];

  // When candles are provided, align AMA values with each candle's time coordinate
  if (candles && candles.length > 0) {
    const result: LineData<UTCTimestamp>[] = [];
    const step = bucketMs ?? 1000;

    for (let k = 0; k < candles.length; k++) {
      const rawBucketStart = rawCandles ? rawCandles[k].t : undefined;
      let latestVal: number | null = null;

      for (let i = 0; i < ama.length; i++) {
        const pt = ama[i];
        if (rawBucketStart !== undefined) {
          if (pt.t < rawBucketStart + step) {
            if (Number.isFinite(pt.value) && !Number.isNaN(pt.value)) {
              latestVal = pt.value;
            }
          } else {
            break;
          }
        } else {
          const cTimeSec = candles[k].time as number;
          if (Math.floor(pt.t / 1000) <= cTimeSec) {
            if (Number.isFinite(pt.value) && !Number.isNaN(pt.value)) {
              latestVal = pt.value;
            }
          }
        }
      }

      if (latestVal !== null && Number.isFinite(latestVal)) {
        result.push({
          time: candles[k].time,
          value: +latestVal.toFixed(2),
        });
      }
    }
    return result;
  }

  // Standalone mapping if no candles provided (e.g. direct test verification)
  const result: LineData<UTCTimestamp>[] = [];
  let prevTime = -Infinity;
  for (const pt of ama) {
    if (!Number.isFinite(pt.value) || Number.isNaN(pt.value)) continue;
    let t = Math.floor(pt.t / 1000);
    if (t <= prevTime) {
      t = prevTime + 1;
    }
    prevTime = t;
    result.push({
      time: t as UTCTimestamp,
      value: +pt.value.toFixed(2),
    });
  }
  return result;
}

/**
 * Adapt cumulative volume delta series to Lightweight Charts AreaData.
 * Maps values accurately through the trade count and candles so CVD aligns
 * with the time axis. Ensures timestamps are strictly ascending.
 */
export function adaptCvdToSeriesData(
  cvdSeries: number[] | null | undefined,
  candles?: CandlestickData<UTCTimestamp>[],
  options?: AdaptCvdOptions,
): AreaData<UTCTimestamp>[] {
  if (!cvdSeries || cvdSeries.length === 0) return [];

  // When candles are provided
  if (candles !== undefined) {
    if (candles.length === 0) return [];
    const result: AreaData<UTCTimestamp>[] = [];
    const rawCandles = options?.rawCandles;

    if (rawCandles && rawCandles.length === candles.length) {
      const tradeCount = options?.tradeCount ?? 0;
      const totalTrades = Math.max(tradeCount, cvdSeries.length, 1);
      const startIdx = Math.max(0, totalTrades - cvdSeries.length);

      let cumulativePrints = 0;
      for (let k = 0; k < candles.length; k++) {
        cumulativePrints += rawCandles[k].n;
        const tradeIdx = cumulativePrints - 1;

        if (tradeIdx >= startIdx) {
          const cvdIdx = tradeIdx - startIdx;
          if (cvdIdx >= 0 && cvdIdx < cvdSeries.length) {
            result.push({
              time: candles[k].time,
              value: cvdSeries[cvdIdx],
            });
          }
        }
      }
    } else {
      // Map proportionally across candle timestamps
      for (let k = 0; k < candles.length; k++) {
        const ratio = candles.length > 1 ? k / (candles.length - 1) : 0;
        const cvdIdx = Math.min(cvdSeries.length - 1, Math.floor(ratio * cvdSeries.length));
        result.push({
          time: candles[k].time,
          value: cvdSeries[cvdIdx],
        });
      }
    }

    return result;
  }

  // Standalone mapping (e.g. direct test verification)
  const result: AreaData<UTCTimestamp>[] = [];
  for (let i = 0; i < cvdSeries.length; i++) {
    result.push({
      time: (i + 1) as UTCTimestamp,
      value: cvdSeries[i],
    });
  }
  return result;
}

/**
 * Adapt raw VolumeAtPrice profile data into structured presentation data.
 * Does not recompute any volumes or shift price levels.
 */
export function adaptVolumeProfile(
  profile: VolumeAtPrice[] | null | undefined,
): VolumeProfileRenderData {
  if (!profile || profile.length === 0) {
    return { items: [], maxTotal: 0, formattedMax: "0" };
  }
  const maxTotal = Math.max(...profile.map((p) => p.total), 1);
  const items: ProfileRenderItem[] = profile.map((p) => {
    const total = Math.max(p.total, 1);
    const buyPct = (p.buy / total) * 100;
    const sellPct = (p.sell / total) * 100;
    const widthPct = Math.min(100, (p.total / maxTotal) * 100);
    return {
      price: p.price,
      formattedPrice: fmtPrice(p.price),
      buy: p.buy,
      sell: p.sell,
      total: p.total,
      buyPct,
      sellPct,
      widthPct,
    };
  });
  return {
    items,
    maxTotal,
    formattedMax: compact(maxTotal),
  };
}

/**
 * Build default chart options with professional terminal styling.
 */
export function getProfessionalChartOptions(
  width = 800,
  height = 420,
): DeepPartial<ChartOptions> {
  return {
    width,
    height,
    layout: {
      background: {
        type: ColorType.Solid,
        color: CHART_THEME.bg,
      },
      textColor: CHART_THEME.text,
      fontFamily: CHART_THEME.font,
      fontSize: 10,
    },
    grid: {
      vertLines: { color: CHART_THEME.grid },
      horzLines: { color: CHART_THEME.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: CHART_THEME.crosshair,
        width: 1,
        style: LineStyle.Dashed,
      },
      horzLine: {
        color: CHART_THEME.crosshair,
        width: 1,
        style: LineStyle.Dashed,
      },
    },
    rightPriceScale: {
      borderColor: CHART_THEME.axis,
      visible: true,
      scaleMargins: {
        top: 0.08,
        bottom: 0.08,
      },
    },
    timeScale: {
      borderColor: CHART_THEME.axis,
      timeVisible: true,
      secondsVisible: true,
      rightOffset: 5,
      barSpacing: 8,
      minBarSpacing: 2,
    },
    handleScroll: true,
    handleScale: true,
  };
}

/**
 * Candlestick series visual options adhering to Tape Lab up/down tokens.
 */
export function getCandlestickSeriesOptions(): CandlestickSeriesPartialOptions {
  return {
    upColor: CHART_THEME.up,
    downColor: CHART_THEME.down,
    borderVisible: true,
    borderUpColor: CHART_THEME.up,
    borderDownColor: CHART_THEME.down,
    wickVisible: true,
    wickUpColor: CHART_THEME.up,
    wickDownColor: CHART_THEME.down,
  };
}

/**
 * VWAP line series visual options (blue dashed line).
 */
export function getVwapSeriesOptions(): LineSeriesPartialOptions {
  return {
    color: CHART_THEME.vwap,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    title: "VWAP",
    crosshairMarkerVisible: true,
    lastPriceAnimation: 0,
    priceLineVisible: true,
  };
}

/**
 * AMA line series visual options (cyan solid line).
 */
export function getAmaSeriesOptions(): LineSeriesPartialOptions {
  return {
    color: CHART_THEME.ama,
    lineWidth: 2,
    lineStyle: LineStyle.Solid,
    title: "AMA",
    crosshairMarkerVisible: true,
    lastPriceAnimation: 0,
    priceLineVisible: false,
  };
}

/**
 * CVD area series visual options for the dedicated lower pane.
 */
export function getCvdSeriesOptions(): AreaSeriesPartialOptions {
  return {
    topColor: "rgba(167, 139, 250, 0.28)",
    bottomColor: "rgba(167, 139, 250, 0.04)",
    lineColor: CHART_THEME.cvd,
    lineWidth: 2,
    title: "CVD",
    priceLineVisible: false,
    lastPriceAnimation: 0,
  };
}

/**
 * Options for adapting event annotations and trade markers to Lightweight Charts markers.
 */
export interface AdaptFlowMarkersOptions {
  annotations?: FlowAnnotation[] | null;
  showAnnotations?: boolean;
  trades?: FlowChartTrade[] | null;
  showTradeMarkers?: boolean;
  priceSeries?: Array<{ t: number; price: number }>;
  candles?: CandlestickData<UTCTimestamp>[];
  rawCandles?: FlowCandle[];
  bucketMs?: number;
  /** Explicit blind-mode flag; when true, trade markers and interpretive labels are strictly rejected */
  isBlind?: boolean;
}

/**
 * Adapt revealed event annotations and completed trade markers into Lightweight Charts series markers.
 * Strictly enforces replay gating: no future information or unrevealed review data can leak.
 * Output markers are sorted strictly ascending by timestamp.
 */
export function adaptFlowMarkers(
  options: AdaptFlowMarkersOptions,
): SeriesMarker<UTCTimestamp>[] {
  const {
    annotations,
    showAnnotations = true,
    trades,
    showTradeMarkers = true,
    priceSeries,
    candles,
    rawCandles,
    bucketMs,
    isBlind = false,
  } = options;

  // If priceSeries is provided and empty, no markers can exist
  if (priceSeries !== undefined && priceSeries.length === 0) {
    return [];
  }

  // Determine revealed time bounds [minTime, maxTime]
  let minTime = -Infinity;
  let maxTime = Infinity;

  if (priceSeries && priceSeries.length > 0) {
    minTime = priceSeries[0].t;
    maxTime = priceSeries[priceSeries.length - 1].t;
  } else if (rawCandles && rawCandles.length > 0) {
    minTime = rawCandles[0].t;
    maxTime = rawCandles[rawCandles.length - 1].t + (bucketMs ?? 0);
  }

  const mapToCandleTime = (eventTimeMs: number): UTCTimestamp => {
    if (candles && rawCandles && candles.length === rawCandles.length && candles.length > 0) {
      let lo = 0;
      let hi = rawCandles.length - 1;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rawCandles[mid].t <= eventTimeMs) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return candles[best].time;
    }
    return Math.floor(eventTimeMs / 1000) as UTCTimestamp;
  };

  interface MarkerCandidate {
    marker: SeriesMarker<UTCTimestamp>;
    rawTime: number;
    priority: number;
  }

  const candidates: MarkerCandidate[] = [];

  // 1. Trade markers (entries and exits)
  // Gated by isBlind flag and trades existence (null while blind upstream)
  if (!isBlind && showTradeMarkers && trades && trades.length > 0) {
    for (const tr of trades) {
      if (!tr) continue;

      // Entry marker: strictly observable by entryTimestamp
      if (
        Number.isFinite(tr.entryTimestamp) &&
        tr.entryTimestamp >= minTime &&
        tr.entryTimestamp <= maxTime
      ) {
        const isLong = tr.side === "LONG";
        candidates.push({
          rawTime: tr.entryTimestamp,
          priority: 1,
          marker: {
            time: mapToCandleTime(tr.entryTimestamp),
            position: isLong ? "belowBar" : "aboveBar",
            shape: isLong ? "arrowUp" : "arrowDown",
            color: isLong ? CHART_THEME.up : CHART_THEME.down,
            text: `${tr.side} ${tr.quantity}`,
            id: `entry-${tr.tradeId}`,
            size: 1,
          },
        });
      }

      // Exit marker: strictly observable by exitTimestamp (trade closed)
      if (
        Number.isFinite(tr.exitTimestamp) &&
        tr.exitTimestamp >= minTime &&
        tr.exitTimestamp <= maxTime
      ) {
        const isProfitable = tr.netPnL >= 0;
        const isLong = tr.side === "LONG";
        candidates.push({
          rawTime: tr.exitTimestamp,
          priority: 3,
          marker: {
            time: mapToCandleTime(tr.exitTimestamp),
            position: isLong ? "aboveBar" : "belowBar",
            shape: "circle",
            color: isProfitable ? CHART_THEME.up : CHART_THEME.down,
            text: `${isProfitable ? "+" : "-"}$${Math.abs(tr.netPnL).toFixed(2)}`,
            id: `exit-${tr.tradeId}`,
            size: 1,
          },
        });
      }
    }
  }

  // 2. Annotations / evidence markers
  if (showAnnotations && annotations && annotations.length > 0) {
    for (let i = 0; i < annotations.length; i++) {
      const a = annotations[i];
      if (!a || !Number.isFinite(a.t)) continue;

      // In blind mode, interpretive annotations are forbidden
      if (isBlind && a.interpretive) {
        continue;
      }

      // Replay gating: future annotations are strictly forbidden
      if (a.t < minTime || a.t > maxTime) {
        continue;
      }

      const id = a.seq !== undefined ? `ann-${a.seq}` : `ann-${a.t}-${a.type}-${i}`;
      candidates.push({
        rawTime: a.t,
        priority: 2,
        marker: {
          time: mapToCandleTime(a.t),
          position: "inBar",
          shape: a.interpretive ? "square" : "circle",
          color: ANNOTATION_COLORS[a.type] ?? CHART_THEME.text,
          text: a.interpretive && a.label && a.label.trim().length > 0 ? a.label.toUpperCase() : undefined,
          id,
          size: 1,
        },
      });
    }
  }

  // Sort strictly ascending by horizontal scale time, then raw time, then priority, then id
  candidates.sort((a, b) => {
    const timeDiff = (a.marker.time as number) - (b.marker.time as number);
    if (timeDiff !== 0) return timeDiff;
    const rawDiff = a.rawTime - b.rawTime;
    if (rawDiff !== 0) return rawDiff;
    const prioDiff = a.priority - b.priority;
    if (prioDiff !== 0) return prioDiff;
    return (a.marker.id ?? "").localeCompare(b.marker.id ?? "");
  });

  return candidates.map((c) => c.marker);
}
