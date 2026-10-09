/**
 * Phase 10-B — MarketProfile Registry & Four Reference Profiles
 *
 * Implements a strongly typed, O(1) in-memory registry for MarketProfiles.
 * Pre-populates the four certified reference profiles:
 *  1. CME:NQ (E-mini Nasdaq-100 Futures)
 *  2. CME:ES (E-mini S&P 500 Futures)
 *  3. BINANCE:BTCUSDT-SPOT (Binance BTCUSDT Spot)
 *  4. BINANCE:BTCUSDT-FUTURES (Binance BTCUSDT USDⓈ-M Perpetual Futures)
 *
 * Invariants:
 * - All registered profiles are strictly pre-validated and deep-frozen.
 * - Unknown IDs explicitly return undefined or throw descriptive errors.
 * - NEVER silently falls back to NQ futures or any arbitrary default.
 * - Internal storage is completely encapsulated; returned collections are immutable copies.
 * - Replay event loops never query the registry.
 */

import {
  deepFreeze,
  validateMarketProfile,
  type MarketProfile,
} from "./profile";

/** CME E-mini Nasdaq-100 Reference Profile */
export const PROFILE_CME_NQ: Readonly<MarketProfile> = deepFreeze({
  id: "CME:NQ",
  identity: {
    id: "CME:NQ",
    symbol: "NQ",
    label: "NQ — E-mini Nasdaq-100 Futures",
    venue: "CME Globex",
    assetClass: "futures",
    marketType: "futures",
    isDerivative: true,
  },
  pricing: {
    tickSize: 0.25,
    pricePrecision: 2,
    minPriceIncrement: 0.25,
  },
  units: {
    baseCurrency: "NQ",
    quoteCurrency: "USD",
    quantityUnit: "contracts",
    quantityPrecision: 0,
    minOrderQuantity: 1,
    quantityStep: 1,
  },
  execution: {
    pnlModel: "point_multiplier",
    contractMultiplier: 20,
    tickValue: 5.0,
    defaultSlippageTicks: 1,
    defaultFeeModel: "per_contract_fixed",
    defaultFeeRate: 2.25, // $2.25/contract simulation default
  },
  session: {
    model: "cme_equity_futures",
    timezone: "America/New_York",
    isContinuous24x7: false,
    displayTemplate: "rth_eth",
  },
});

/** CME E-mini S&P 500 Reference Profile */
export const PROFILE_CME_ES: Readonly<MarketProfile> = deepFreeze({
  id: "CME:ES",
  identity: {
    id: "CME:ES",
    symbol: "ES",
    label: "ES — E-mini S&P 500 Futures",
    venue: "CME Globex",
    assetClass: "futures",
    marketType: "futures",
    isDerivative: true,
  },
  pricing: {
    tickSize: 0.25,
    pricePrecision: 2,
    minPriceIncrement: 0.25,
  },
  units: {
    baseCurrency: "ES",
    quoteCurrency: "USD",
    quantityUnit: "contracts",
    quantityPrecision: 0,
    minOrderQuantity: 1,
    quantityStep: 1,
  },
  execution: {
    pnlModel: "point_multiplier",
    contractMultiplier: 50,
    tickValue: 12.5,
    defaultSlippageTicks: 1,
    defaultFeeModel: "per_contract_fixed",
    defaultFeeRate: 2.25, // $2.25/contract simulation default
  },
  session: {
    model: "cme_equity_futures",
    timezone: "America/New_York",
    isContinuous24x7: false,
    displayTemplate: "rth_eth",
  },
});

/** Binance BTCUSDT Spot Reference Profile */
export const PROFILE_BINANCE_BTCUSDT_SPOT: Readonly<MarketProfile> = deepFreeze({
  id: "BINANCE:BTCUSDT-SPOT",
  identity: {
    id: "BINANCE:BTCUSDT-SPOT",
    symbol: "BTCUSDT",
    label: "BTCUSDT — Binance Spot",
    venue: "Binance",
    assetClass: "crypto_spot",
    marketType: "spot",
    isDerivative: false,
  },
  pricing: {
    tickSize: 0.01,
    pricePrecision: 2,
    minPriceIncrement: 0.01,
  },
  units: {
    baseCurrency: "BTC",
    quoteCurrency: "USDT",
    quantityUnit: "BTC",
    quantityPrecision: 5,
    minOrderQuantity: 0.00001,
    quantityStep: 0.00001,
  },
  execution: {
    pnlModel: "linear_crypto",
    contractMultiplier: 1.0,
    tickValue: 0.01,
    defaultSlippageTicks: 1,
    defaultFeeModel: "basis_points_notional",
    defaultFeeRate: 0.001, // 0.10% (10 bps) taker fee simulation default
  },
  session: {
    model: "continuous_24_7",
    timezone: "UTC",
    isContinuous24x7: true,
    displayTemplate: "utc_daily",
    rollOverUtcHour: 0,
  },
});

/** Binance BTCUSDT USDⓈ-M Perpetual Futures Reference Profile */
export const PROFILE_BINANCE_BTCUSDT_FUTURES: Readonly<MarketProfile> = deepFreeze({
  id: "BINANCE:BTCUSDT-FUTURES",
  identity: {
    id: "BINANCE:BTCUSDT-FUTURES",
    symbol: "BTCUSDT",
    label: "BTCUSDT — Binance USDⓈ-M Perpetual Futures",
    venue: "Binance",
    assetClass: "crypto_perp",
    marketType: "perpetual",
    isDerivative: true,
  },
  pricing: {
    tickSize: 0.1,
    pricePrecision: 1,
    minPriceIncrement: 0.1,
  },
  units: {
    baseCurrency: "BTC",
    quoteCurrency: "USDT",
    quantityUnit: "BTC",
    quantityPrecision: 3,
    minOrderQuantity: 0.001,
    quantityStep: 0.001,
  },
  execution: {
    pnlModel: "linear_crypto",
    contractMultiplier: 1.0,
    tickValue: 0.1,
    defaultSlippageTicks: 1,
    defaultFeeModel: "basis_points_notional",
    defaultFeeRate: 0.0005, // 0.05% (5 bps) taker fee simulation default
  },
  session: {
    model: "continuous_24_7",
    timezone: "UTC",
    isContinuous24x7: true,
    displayTemplate: "utc_daily",
    rollOverUtcHour: 0,
  },
});

/** The initial certified reference profiles array */
export const REFERENCE_PROFILES: readonly Readonly<MarketProfile>[] = [
  PROFILE_CME_NQ,
  PROFILE_CME_ES,
  PROFILE_BINANCE_BTCUSDT_SPOT,
  PROFILE_BINANCE_BTCUSDT_FUTURES,
];

/**
 * In-memory MarketProfile registry with strict validation and immutability.
 */
export class MarketProfileRegistry {
  private readonly profiles = new Map<string, Readonly<MarketProfile>>();

  constructor(initialProfiles: readonly Readonly<MarketProfile>[] = REFERENCE_PROFILES) {
    for (const profile of initialProfiles) {
      this.register(profile);
    }
  }

  /**
   * Registers a new MarketProfile after running strict validation.
   *
   * @throws Error if profile validation fails or if a profile with the same ID already exists.
   */
  register(profile: MarketProfile): Readonly<MarketProfile> {
    const report = validateMarketProfile(profile);
    if (!report.isValid) {
      const errorMsg = report.errors.map((e) => `  - [${e.path}]: ${e.message}`).join("\n");
      throw new Error(`Cannot register invalid MarketProfile (${profile.id || "UNKNOWN"}):\n${errorMsg}`);
    }

    if (this.profiles.has(profile.id)) {
      throw new Error(`MarketProfile with ID '${profile.id}' is already registered.`);
    }

    const frozen = deepFreeze(structuredClone(profile));
    this.profiles.set(frozen.id, frozen);
    return frozen;
  }

  /**
   * Retrieves a registered MarketProfile by ID in O(1) time.
   *
   * @returns The immutable profile if found, or undefined if not registered.
   *          NEVER falls back silently to NQ or any default.
   */
  get(id: string): Readonly<MarketProfile> | undefined {
    return this.profiles.get(id);
  }

  /**
   * Retrieves a registered MarketProfile by ID, throwing a descriptive error if not found.
   *
   * @throws Error if ID is not registered.
   */
  require(id: string): Readonly<MarketProfile> {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new Error(`MarketProfile not found for ID '${id}'. Available IDs: ${[...this.profiles.keys()].join(", ")}`);
    }
    return profile;
  }

  /**
   * Checks whether a profile ID is registered.
   */
  has(id: string): boolean {
    return this.profiles.has(id);
  }

  /**
   * Returns a snapshot list of all currently registered profiles in insertion order.
   */
  list(): readonly Readonly<MarketProfile>[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Resets the registry to the initial four reference profiles.
   */
  reset(): void {
    this.profiles.clear();
    for (const profile of REFERENCE_PROFILES) {
      this.register(profile);
    }
  }
}

/** Global default MarketProfile registry instance */
export const marketProfileRegistry = new MarketProfileRegistry();

/** Convenience helper: lookup profile by ID (returns undefined if missing) */
export function getMarketProfile(id: string): Readonly<MarketProfile> | undefined {
  return marketProfileRegistry.get(id);
}

/** Convenience helper: lookup profile by ID (throws if missing) */
export function requireMarketProfile(id: string): Readonly<MarketProfile> {
  return marketProfileRegistry.require(id);
}

/** Convenience helper: check if profile ID exists */
export function hasMarketProfile(id: string): boolean {
  return marketProfileRegistry.has(id);
}

/** Convenience helper: list all registered profiles */
export function listMarketProfiles(): readonly Readonly<MarketProfile>[] {
  return marketProfileRegistry.list();
}

/** Convenience helper: register a profile with the global registry */
export function registerMarketProfile(profile: MarketProfile): Readonly<MarketProfile> {
  return marketProfileRegistry.register(profile);
}
