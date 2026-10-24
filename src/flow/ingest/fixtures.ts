/**
 * Phase 10-F — Genuine Market Data Fixture Registry & Feed Loaders
 *
 * Provides typed access to verified genuine exchange and vendor capture fixtures
 * stored in tests/fixtures/.
 *
 * Invariants:
 * - NEVER fabricates records or metadata.
 * - Always maps to strictly validated MarketProfiles.
 * - Honestly declares capture origin, date, venue, and microstructure capabilities.
 * - Distinguishes trade-only archives from Level-2 depth captures.
 *
 * The Databento CME NQ capture is deliberately NOT bundled. A `?raw` import inlines
 * the bytes into the shipped bundle, and the bundle is served to every visitor, so
 * bundling it would redistribute licensed CME data to the public. The adapter
 * (`./databento`) and the on-disk fixture remain for local, non-served use.
 */

import { BinanceAdapter } from "./binance";
import { RealMarketDataFeed } from "./feed";
import type { MicrostructureCapabilities } from "./types";
import {
  PROFILE_CME_NQ,
  PROFILE_BINANCE_BTCUSDT_SPOT,
} from "../../market/registry";
import type { MarketProfile } from "../../market/profile";

import binanceGenuineRaw from "../../../tests/fixtures/binance_btcusdt_genuine.jsonl?raw";
import binanceGenuineMeta from "../../../tests/fixtures/binance_btcusdt_genuine.meta.json";
import binanceHistoricalSliceRaw from "../../../tests/fixtures/binance_btcusdt_spot_historical_slice.csv?raw";
import binanceHistoricalSliceMeta from "../../../tests/fixtures/binance_btcusdt_spot_historical_slice.meta.json";

export type FlowDataSourceId =
  | "synthetic"
  | "binance-genuine-spot"
  | "binance-historical-trades";

export interface FlowDataSourceMeta {
  readonly id: FlowDataSourceId;
  readonly label: string;
  readonly description: string;
  readonly venue: string;
  readonly symbol: string;
  readonly isRealData: boolean;
  readonly isTradeOnly: boolean;
  readonly targetProfileId: string;
  readonly capturedAt?: string;
  readonly schemaDetails: string;
  readonly profile: Readonly<MarketProfile>;
}

export const FLOW_DATA_SOURCES: readonly FlowDataSourceMeta[] = [
  {
    id: "synthetic",
    label: "Synthetic Practice Scenario",
    description: "Generated deliberate practice patterns (Spring, Upthrust, Absorption, etc.)",
    venue: "Simulated",
    symbol: "Active Market",
    isRealData: false,
    isTradeOnly: false,
    targetProfileId: "CME:NQ",
    schemaDetails: "Procedural microstructural generator",
    profile: PROFILE_CME_NQ,
  },
  {
    id: "binance-genuine-spot",
    label: "Binance Spot BTCUSDT (Genuine Capture)",
    description: "Genuine public REST snapshot + WebSocket diff-depth and trade streams",
    venue: "Binance",
    symbol: "BTCUSDT",
    isRealData: true,
    isTradeOnly: false,
    targetProfileId: "BINANCE:BTCUSDT-SPOT",
    capturedAt: binanceGenuineMeta.capturedAt,
    schemaDetails: "REST depth snapshot (lastUpdateId: 101194629414) + WebSocket diff-depth & trades",
    profile: PROFILE_BINANCE_BTCUSDT_SPOT,
  },
  {
    id: "binance-historical-trades",
    label: "Binance Historical aggTrades (Trade-Only)",
    description: "Official Binance Vision historical aggTrades archive (trades only, no L2 depth)",
    venue: "Binance",
    symbol: "BTCUSDT",
    isRealData: true,
    isTradeOnly: true,
    targetProfileId: "BINANCE:BTCUSDT-SPOT",
    capturedAt: binanceHistoricalSliceMeta.date,
    schemaDetails: "Binance Vision aggTrades CSV (trade prints only; DOM displays estimated top-of-book)",
    profile: PROFILE_BINANCE_BTCUSDT_SPOT,
  },
] as const;

export function getDataSourceMeta(id: FlowDataSourceId): FlowDataSourceMeta {
  const found = FLOW_DATA_SOURCES.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown flow data source ID: ${id}`);
  return found;
}

/**
 * Creates a verified RealMarketDataFeed from the genuine Binance Spot capture.
 */
export function loadBinanceGenuineSpotFeed(): RealMarketDataFeed {
  const adapter = new BinanceAdapter();
  const { events, report } = adapter.normalize(binanceGenuineRaw, {
    market: "spot",
    symbol: "BTCUSDT",
    strict: true,
  });

  const capabilities: MicrostructureCapabilities = {
    ...adapter.capabilities,
    hasDepth: true,
  };

  return new RealMarketDataFeed(events, {
    source: "Binance Spot Public REST & WebSocket Capture",
    capabilities,
    validationReport: report,
    profile: PROFILE_BINANCE_BTCUSDT_SPOT,
  });
}

/**
 * Creates a verified RealMarketDataFeed from official Binance historical aggTrades.
 * Strictly disclaims Level-2 depth.
 */
export function loadBinanceHistoricalTradesFeed(): RealMarketDataFeed {
  const adapter = new BinanceAdapter();
  const { events, report } = adapter.normalize(binanceHistoricalSliceRaw, {
    market: "spot",
    symbol: "BTCUSDT",
    strict: false,
  });

  const capabilities: MicrostructureCapabilities = {
    ...adapter.capabilities,
    hasDepth: false,
    hasQuotes: false,
  };

  return new RealMarketDataFeed(events, {
    source: "Binance Vision Historical aggTrades (Trade prints only)",
    capabilities,
    validationReport: report,
    profile: PROFILE_BINANCE_BTCUSDT_SPOT,
  });
}
