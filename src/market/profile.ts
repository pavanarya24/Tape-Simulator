/**
 * Phase 10-B — Canonical MarketProfile Model and Validation
 *
 * Defines the vendor-neutral, instrument-first market profile abstraction.
 * Represents what an instrument/market IS (tick size, contract multiplier,
 * pricing precision, quantity step, session rules, currencies, PnL model),
 * completely decoupled from:
 *  1. Account/broker costs (commission schedules, slippage assumptions, fee tiers)
 *  2. Data source / adapter capabilities (hasTrades, hasDepth, hasMBO, etc.)
 *
 * Design Invariants:
 * - Immutable: All properties are `readonly` and runtime-protected via `deepFreeze`.
 * - Strictly Validated: Comprehensive sanity, precision, step, and coherence checks.
 * - Zero Unsafe Fallback: No silent coercion or fallback to NQ futures defaults.
 * - O(1) Replay Safe: Passed once at session initialization; never queried in hot event loops.
 */

/** High-level asset class classification */
export type AssetClass =
  | "futures"
  | "crypto_spot"
  | "crypto_perp"
  | "equities"
  | "fx";

/** Granular market/instrument type */
export type MarketType =
  | "futures"
  | "spot"
  | "perpetual"
  | "option";

/** Execution and PnL calculation methodology */
export type PnlCalculationModel =
  | "point_multiplier"  // (mark - entry) * direction * multiplier * contracts (USD)
  | "linear_crypto"     // (mark - entry) * direction * quantity (in quote currency, e.g. USDT)
  | "inverse_crypto";   // (1/entry - 1/mark) * direction * contracts (in base currency, e.g. BTC)

/** Market trading session calendar model */
export type SessionModel =
  | "cme_equity_futures" // RTH (09:30-16:00 ET), ETH (18:00-17:00 ET Sun-Fri)
  | "continuous_24_7";   // 24/7 continuous trading (Crypto spot & perpetuals)

/** Replay/UI session display template */
export type SessionDisplayTemplate =
  | "rth_eth"
  | "utc_daily"
  | "none";

/** Fee calculation model archetype */
export type FeeModel =
  | "per_contract_fixed"    // Fixed dollar amount per contract/side (e.g. CME futures)
  | "basis_points_notional"; // Percentage of trade notional value (e.g. crypto)

/** Identity and taxonomy properties */
export interface MarketProfileIdentity {
  /** Stable unique identifier (e.g. "CME:NQ", "BINANCE:BTCUSDT-SPOT") */
  readonly id: string;
  /** Tradable market/ticker symbol (e.g. "NQ", "ES", "BTCUSDT") */
  readonly symbol: string;
  /** Descriptive human-readable label */
  readonly label: string;
  /** Primary trading venue / exchange (e.g. "CME Globex", "Binance") */
  readonly venue: string;
  /** Primary asset classification */
  readonly assetClass: AssetClass;
  /** Market instrument structure */
  readonly marketType: MarketType;
  /** Whether this product is a derivative (futures, perpetuals, options) */
  readonly isDerivative: boolean;
}

/** Pricing and tick grid specifications */
export interface MarketProfilePricing {
  /** Minimum price fluctuation ("tick size"), e.g. 0.25 for NQ/ES, 0.01 for BTCUSDT Spot */
  readonly tickSize: number;
  /** Number of decimal places used for price display formatting */
  readonly pricePrecision: number;
  /** Explicit minimum price increment (alias of tickSize for verification consistency) */
  readonly minPriceIncrement?: number;
}

/** Units, currencies, and order quantity limits */
export interface MarketProfileUnits {
  /** Base asset or index root (e.g. "NQ", "ES", "BTC") */
  readonly baseCurrency: string;
  /** Quote and settlement currency (e.g. "USD", "USDT") */
  readonly quoteCurrency: string;
  /** Quantity display unit label (e.g. "contracts", "BTC") */
  readonly quantityUnit: string;
  /** Number of decimal places for quantity display (0 for futures, 3-6 for crypto) */
  readonly quantityPrecision: number;
  /** Minimum allowable order size */
  readonly minOrderQuantity: number;
  /** Minimum allowable order size increment / lot step */
  readonly quantityStep: number;
}

/** Execution mechanics and PnL accounting */
export interface MarketProfileExecution {
  /** PnL settlement calculation model */
  readonly pnlModel: PnlCalculationModel;
  /** Value of 1 index point move in quote currency per 1.0 unit (20 for NQ, 50 for ES, 1.0 for crypto) */
  readonly contractMultiplier: number;
  /** Dollar/quote value of 1 minimum tick move (tickSize * contractMultiplier) */
  readonly tickValue: number;
  /** Optional reference default slippage in ticks for simulation defaults */
  readonly defaultSlippageTicks?: number;
  /** Optional reference fee model archetype for simulation defaults */
  readonly defaultFeeModel?: FeeModel;
  /** Optional reference default fee rate ($2.25/contract or 0.0005 = 5 bps) */
  readonly defaultFeeRate?: number;
}

/** Session calendar and timezone rules */
export interface MarketProfileSession {
  /** Primary trading session calendar model */
  readonly model: SessionModel;
  /** Canonical exchange or market timezone (e.g. "America/New_York", "UTC") */
  readonly timezone: string;
  /** Whether trading is continuous 24 hours / 7 days without weekend or daily halts */
  readonly isContinuous24x7: boolean;
  /** Display template for session slicing and charting */
  readonly displayTemplate?: SessionDisplayTemplate;
  /** UTC hour for daily session roll in 24/7 markets (default 0 for 00:00 UTC) */
  readonly rollOverUtcHour?: number;
}

/**
 * Complete immutable MarketProfile definition.
 */
export interface MarketProfile {
  readonly id: string;
  readonly identity: MarketProfileIdentity;
  readonly pricing: MarketProfilePricing;
  readonly units: MarketProfileUnits;
  readonly execution: MarketProfileExecution;
  readonly session: MarketProfileSession;
}

/** Validation failure diagnostic record */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Structured validation report */
export interface ValidationResult {
  readonly isValid: boolean;
  readonly errors: readonly ValidationIssue[];
}

/**
 * Recursively freezes an object and all nested properties to guarantee runtime immutability.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) {
    return obj as Readonly<T>;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj as Readonly<T>;
}

/**
 * Tolerance for floating-point representability checks.
 */
const FP_TOLERANCE = 1e-7;

/**
 * Checks whether a number is a finite, strictly positive number (> 0).
 */
function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * Checks whether a number is an integer >= 0.
 */
function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/**
 * Validates whether a value is cleanly representable at the specified decimal precision.
 */
function isRepresentableAtPrecision(val: number, precision: number): boolean {
  if (!Number.isFinite(val) || precision < 0 || precision > 18) return false;
  const factor = Math.pow(10, precision);
  const scaled = val * factor;
  return Math.abs(Math.round(scaled) - scaled) < FP_TOLERANCE;
}

/** Prohibited adapter capability fields that must never be in a MarketProfile */
const PROHIBITED_FEED_CAPABILITIES = [
  "hasTrades",
  "hasQuotes",
  "hasDepth",
  "hasMBO",
  "hasAggressor",
  "hasOrderCounts",
  "hasNanosecondTimestamps",
  "hasReceiveTimestamp",
  "hasMatchIds",
] as const;

/**
 * Strictly validates a MarketProfile against all domain invariants.
 *
 * Rules:
 *  - Identity: Non-empty IDs, symbols, venues, supported asset classes, market types.
 *  - Pricing: Strictly positive tick size representable at declared price precision.
 *  - Units: Positive minimum order quantity and quantity step representable at quantity precision.
 *  - Futures Invariants: CME futures require integer contract quantities (precision 0, step >= 1).
 *  - Crypto Invariants: Allows fractional quantities, continuous 24/7 sessions.
 *  - Execution: Coherent PnL model, contract multiplier, and tickValue = tickSize * contractMultiplier.
 *  - Session: Valid IANA timezone, continuous 24/7 vs exchange session flags.
 *  - Boundary: Rejects embedded feed capabilities or malformed structures.
 */
export function validateMarketProfile(profile: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];

  const addError = (path: string, message: string) => {
    errors.push({ path, message });
  };

  if (!profile || typeof profile !== "object") {
    return {
      isValid: false,
      errors: [{ path: "root", message: "MarketProfile must be a non-null object" }],
    };
  }

  const p = profile as Record<string, unknown>;

  // Check for forbidden feed capability contamination
  for (const cap of PROHIBITED_FEED_CAPABILITIES) {
    if (cap in p) {
      addError(cap, `Data feed capability '${cap}' must not be embedded in MarketProfile.`);
    }
  }

  // 1. Root ID
  if (typeof p.id !== "string" || p.id.trim() === "") {
    addError("id", "Profile ID must be a non-empty string");
  }

  // 2. Identity
  if (!p.identity || typeof p.identity !== "object") {
    addError("identity", "Missing or invalid identity section");
  } else {
    const id = p.identity as Record<string, unknown>;
    if (typeof id.id !== "string" || id.id.trim() === "") {
      addError("identity.id", "identity.id must be a non-empty string");
    } else if (typeof p.id === "string" && id.id !== p.id) {
      addError("identity.id", `identity.id '${id.id}' does not match root profile id '${p.id}'`);
    }

    if (typeof id.symbol !== "string" || id.symbol.trim() === "") {
      addError("identity.symbol", "identity.symbol must be a non-empty string");
    }
    if (typeof id.label !== "string" || id.label.trim() === "") {
      addError("identity.label", "identity.label must be a non-empty string");
    }
    if (typeof id.venue !== "string" || id.venue.trim() === "") {
      addError("identity.venue", "identity.venue must be a non-empty string");
    }

    const validAssetClasses: AssetClass[] = ["futures", "crypto_spot", "crypto_perp", "equities", "fx"];
    if (!validAssetClasses.includes(id.assetClass as AssetClass)) {
      addError("identity.assetClass", `Invalid assetClass '${String(id.assetClass)}'`);
    }

    const validMarketTypes: MarketType[] = ["futures", "spot", "perpetual", "option"];
    if (!validMarketTypes.includes(id.marketType as MarketType)) {
      addError("identity.marketType", `Invalid marketType '${String(id.marketType)}'`);
    }

    if (typeof id.isDerivative !== "boolean") {
      addError("identity.isDerivative", "identity.isDerivative must be a boolean");
    } else {
      // Coherence checks
      if (id.marketType === "spot") {
        if (id.isDerivative !== false) {
          addError("identity.isDerivative", "Spot market cannot be classified as a derivative (isDerivative must be false)");
        }
        if (id.assetClass === "futures" || id.assetClass === "crypto_perp") {
          addError("identity.assetClass", "Spot market cannot have derivative asset class 'futures' or 'crypto_perp'");
        }
      }
      if (id.marketType === "futures" || id.marketType === "perpetual") {
        if (id.isDerivative !== true) {
          addError("identity.isDerivative", "Futures and perpetual markets must have isDerivative = true");
        }
      }
      if (id.marketType === "perpetual" && id.assetClass !== "crypto_perp") {
        addError("identity.assetClass", "Perpetual market type must use assetClass 'crypto_perp'");
      }
      if (id.marketType === "futures" && id.assetClass !== "futures") {
        addError("identity.assetClass", "Futures market type must use assetClass 'futures'");
      }
    }
  }

  // 3. Pricing
  if (!p.pricing || typeof p.pricing !== "object") {
    addError("pricing", "Missing or invalid pricing section");
  } else {
    const pr = p.pricing as Record<string, unknown>;
    const tickSize = pr.tickSize;
    const pricePrecision = pr.pricePrecision;

    if (!isPositiveFinite(tickSize)) {
      addError("pricing.tickSize", "pricing.tickSize must be a finite number > 0");
    }
    if (!isNonNegativeInteger(pricePrecision)) {
      addError("pricing.pricePrecision", "pricing.pricePrecision must be a non-negative integer");
    }

    if (isPositiveFinite(tickSize) && isNonNegativeInteger(pricePrecision)) {
      if (!isRepresentableAtPrecision(tickSize, pricePrecision)) {
        addError(
          "pricing.tickSize",
          `tickSize ${tickSize} is not representable at declared pricePrecision ${pricePrecision}`,
        );
      }
    }

    if (pr.minPriceIncrement !== undefined) {
      if (!isPositiveFinite(pr.minPriceIncrement)) {
        addError("pricing.minPriceIncrement", "pricing.minPriceIncrement must be a finite number > 0");
      } else if (isPositiveFinite(tickSize) && Math.abs(pr.minPriceIncrement - tickSize) > FP_TOLERANCE) {
        addError(
          "pricing.minPriceIncrement",
          `minPriceIncrement (${pr.minPriceIncrement}) does not match tickSize (${tickSize})`,
        );
      }
    }
  }

  // 4. Units
  if (!p.units || typeof p.units !== "object") {
    addError("units", "Missing or invalid units section");
  } else {
    const u = p.units as Record<string, unknown>;
    if (typeof u.baseCurrency !== "string" || u.baseCurrency.trim() === "") {
      addError("units.baseCurrency", "units.baseCurrency must be a non-empty string");
    }
    if (typeof u.quoteCurrency !== "string" || u.quoteCurrency.trim() === "") {
      addError("units.quoteCurrency", "units.quoteCurrency must be a non-empty string");
    }
    if (typeof u.quantityUnit !== "string" || u.quantityUnit.trim() === "") {
      addError("units.quantityUnit", "units.quantityUnit must be a non-empty string");
    }

    const qPrec = u.quantityPrecision;
    const minQty = u.minOrderQuantity;
    const qStep = u.quantityStep;

    if (!isNonNegativeInteger(qPrec)) {
      addError("units.quantityPrecision", "units.quantityPrecision must be a non-negative integer");
    }
    if (!isPositiveFinite(minQty)) {
      addError("units.minOrderQuantity", "units.minOrderQuantity must be a finite number > 0");
    }
    if (!isPositiveFinite(qStep)) {
      addError("units.quantityStep", "units.quantityStep must be a finite number > 0");
    }

    if (isPositiveFinite(qStep) && isNonNegativeInteger(qPrec)) {
      if (!isRepresentableAtPrecision(qStep, qPrec)) {
        addError(
          "units.quantityStep",
          `quantityStep ${qStep} is not representable at declared quantityPrecision ${qPrec}`,
        );
      }
    }

    if (isPositiveFinite(minQty) && isPositiveFinite(qStep)) {
      if (minQty < qStep - FP_TOLERANCE) {
        addError(
          "units.minOrderQuantity",
          `minOrderQuantity (${minQty}) cannot be less than quantityStep (${qStep})`,
        );
      }
    }

    // CME futures integer contract checks
    const id = p.identity as Record<string, unknown> | undefined;
    if (id && id.assetClass === "futures" && u.quantityUnit === "contracts") {
      if (qPrec !== 0) {
        addError("units.quantityPrecision", "CME futures contracts must have quantityPrecision = 0 (integer contracts)");
      }
      if (isPositiveFinite(qStep) && (!Number.isInteger(qStep) || qStep < 1)) {
        addError("units.quantityStep", "CME futures contracts must have integer quantityStep >= 1");
      }
      if (isPositiveFinite(minQty) && (!Number.isInteger(minQty) || minQty < 1)) {
        addError("units.minOrderQuantity", "CME futures contracts must have integer minOrderQuantity >= 1");
      }
    }
  }

  // 5. Execution
  if (!p.execution || typeof p.execution !== "object") {
    addError("execution", "Missing or invalid execution section");
  } else {
    const ex = p.execution as Record<string, unknown>;
    const validPnlModels: PnlCalculationModel[] = ["point_multiplier", "linear_crypto", "inverse_crypto"];
    if (!validPnlModels.includes(ex.pnlModel as PnlCalculationModel)) {
      addError("execution.pnlModel", `Invalid pnlModel '${String(ex.pnlModel)}'`);
    }

    const mult = ex.contractMultiplier;
    const tickVal = ex.tickValue;

    if (!isPositiveFinite(mult)) {
      addError("execution.contractMultiplier", "execution.contractMultiplier must be a finite number > 0");
    }
    if (!isPositiveFinite(tickVal)) {
      addError("execution.tickValue", "execution.tickValue must be a finite number > 0");
    }

    const pr = p.pricing as Record<string, unknown> | undefined;
    if (pr && isPositiveFinite(pr.tickSize) && isPositiveFinite(mult) && isPositiveFinite(tickVal)) {
      const expectedTickValue = (pr.tickSize as number) * mult;
      if (Math.abs(tickVal - expectedTickValue) > FP_TOLERANCE) {
        addError(
          "execution.tickValue",
          `tickValue (${tickVal}) does not equal tickSize (${pr.tickSize}) * contractMultiplier (${mult}) = ${expectedTickValue}`,
        );
      }
    }

    // Model specific rules
    const id = p.identity as Record<string, unknown> | undefined;
    if (ex.pnlModel === "linear_crypto") {
      if (isPositiveFinite(mult) && Math.abs(mult - 1.0) > FP_TOLERANCE) {
        addError("execution.contractMultiplier", "linear_crypto PnL model must have contractMultiplier = 1.0");
      }
    }
    if (ex.pnlModel === "point_multiplier") {
      if (id && id.marketType === "spot") {
        addError("execution.pnlModel", "Spot market cannot use point_multiplier PnL model");
      }
    }

    if (ex.defaultSlippageTicks !== undefined && !isNonNegativeInteger(ex.defaultSlippageTicks)) {
      addError("execution.defaultSlippageTicks", "defaultSlippageTicks must be a non-negative integer when specified");
    }
    if (ex.defaultFeeModel !== undefined) {
      const validFeeModels: FeeModel[] = ["per_contract_fixed", "basis_points_notional"];
      if (!validFeeModels.includes(ex.defaultFeeModel as FeeModel)) {
        addError("execution.defaultFeeModel", `Invalid defaultFeeModel '${String(ex.defaultFeeModel)}'`);
      }
    }
    if (ex.defaultFeeRate !== undefined && (!Number.isFinite(ex.defaultFeeRate) || (ex.defaultFeeRate as number) < 0)) {
      addError("execution.defaultFeeRate", "defaultFeeRate must be a non-negative finite number when specified");
    }
  }

  // 6. Session
  if (!p.session || typeof p.session !== "object") {
    addError("session", "Missing or invalid session section");
  } else {
    const s = p.session as Record<string, unknown>;
    const validSessionModels: SessionModel[] = ["cme_equity_futures", "continuous_24_7"];
    if (!validSessionModels.includes(s.model as SessionModel)) {
      addError("session.model", `Invalid session model '${String(s.model)}'`);
    }

    if (typeof s.timezone !== "string" || s.timezone.trim() === "") {
      addError("session.timezone", "session.timezone must be a non-empty string");
    } else {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: s.timezone });
      } catch {
        addError("session.timezone", `Invalid IANA timezone identifier '${s.timezone}'`);
      }
    }

    if (typeof s.isContinuous24x7 !== "boolean") {
      addError("session.isContinuous24x7", "session.isContinuous24x7 must be a boolean");
    } else {
      if (s.model === "continuous_24_7" && s.isContinuous24x7 !== true) {
        addError("session.isContinuous24x7", "continuous_24_7 session model must have isContinuous24x7 = true");
      }
      if (s.model === "cme_equity_futures" && s.isContinuous24x7 !== false) {
        addError("session.isContinuous24x7", "cme_equity_futures session model must have isContinuous24x7 = false");
      }
    }

    if (s.displayTemplate !== undefined) {
      const validTemplates: SessionDisplayTemplate[] = ["rth_eth", "utc_daily", "none"];
      if (!validTemplates.includes(s.displayTemplate as SessionDisplayTemplate)) {
        addError("session.displayTemplate", `Invalid displayTemplate '${String(s.displayTemplate)}'`);
      }
    }

    if (s.rollOverUtcHour !== undefined) {
      if (
        typeof s.rollOverUtcHour !== "number" ||
        !Number.isInteger(s.rollOverUtcHour) ||
        s.rollOverUtcHour < 0 ||
        s.rollOverUtcHour > 23
      ) {
        addError("session.rollOverUtcHour", "rollOverUtcHour must be an integer between 0 and 23");
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
