import { describe, expect, it } from "bun:test";
import {
  deepFreeze,
  validateMarketProfile,
  type MarketProfile,
} from "../src/market/profile";
import {
  MarketProfileRegistry,
  PROFILE_BINANCE_BTCUSDT_FUTURES,
  PROFILE_BINANCE_BTCUSDT_SPOT,
  PROFILE_CME_ES,
  PROFILE_CME_NQ,
  REFERENCE_PROFILES,
  getMarketProfile,
  hasMarketProfile,
  listMarketProfiles,
  registerMarketProfile,
  requireMarketProfile,
} from "../src/market/registry";
import { CONTRACTS } from "../src/market/instruments";

describe("Phase 10-B — MarketProfile Types, Registry & Strict Validation", () => {
  /* ------------------------------------------------------------------ */
  /* 1. Reference Profiles Specifications & Verification                */
  /* ------------------------------------------------------------------ */

  describe("1. Reference Profiles Specifications", () => {
    it("registers exactly the four initial certified reference profiles", () => {
      const list = listMarketProfiles();
      expect(list).toHaveLength(4);
      const ids = list.map((p) => p.id);
      expect(ids).toEqual([
        "CME:NQ",
        "CME:ES",
        "BINANCE:BTCUSDT-SPOT",
        "BINANCE:BTCUSDT-FUTURES",
      ]);
    });

    it("validates CME:NQ profile specifications", () => {
      const nq = requireMarketProfile("CME:NQ");
      expect(nq.identity).toMatchObject({
        id: "CME:NQ",
        symbol: "NQ",
        venue: "CME Globex",
        assetClass: "futures",
        marketType: "futures",
        isDerivative: true,
      });
      expect(nq.pricing).toMatchObject({
        tickSize: 0.25,
        pricePrecision: 2,
        minPriceIncrement: 0.25,
      });
      expect(nq.units).toMatchObject({
        baseCurrency: "NQ",
        quoteCurrency: "USD",
        quantityUnit: "contracts",
        quantityPrecision: 0,
        minOrderQuantity: 1,
        quantityStep: 1,
      });
      expect(nq.execution).toMatchObject({
        pnlModel: "point_multiplier",
        contractMultiplier: 20,
        tickValue: 5.0,
      });
      expect(nq.session).toMatchObject({
        model: "cme_equity_futures",
        timezone: "America/New_York",
        isContinuous24x7: false,
        displayTemplate: "rth_eth",
      });
    });

    it("validates CME:ES profile specifications", () => {
      const es = requireMarketProfile("CME:ES");
      expect(es.identity).toMatchObject({
        id: "CME:ES",
        symbol: "ES",
        venue: "CME Globex",
        assetClass: "futures",
        marketType: "futures",
        isDerivative: true,
      });
      expect(es.pricing).toMatchObject({
        tickSize: 0.25,
        pricePrecision: 2,
        minPriceIncrement: 0.25,
      });
      expect(es.units).toMatchObject({
        baseCurrency: "ES",
        quoteCurrency: "USD",
        quantityUnit: "contracts",
        quantityPrecision: 0,
        minOrderQuantity: 1,
        quantityStep: 1,
      });
      expect(es.execution).toMatchObject({
        pnlModel: "point_multiplier",
        contractMultiplier: 50,
        tickValue: 12.5,
      });
      expect(es.session).toMatchObject({
        model: "cme_equity_futures",
        timezone: "America/New_York",
        isContinuous24x7: false,
        displayTemplate: "rth_eth",
      });
    });

    it("validates Binance BTCUSDT Spot profile specifications", () => {
      const spot = requireMarketProfile("BINANCE:BTCUSDT-SPOT");
      expect(spot.identity).toMatchObject({
        id: "BINANCE:BTCUSDT-SPOT",
        symbol: "BTCUSDT",
        venue: "Binance",
        assetClass: "crypto_spot",
        marketType: "spot",
        isDerivative: false,
      });
      expect(spot.pricing).toMatchObject({
        tickSize: 0.01,
        pricePrecision: 2,
        minPriceIncrement: 0.01,
      });
      expect(spot.units).toMatchObject({
        baseCurrency: "BTC",
        quoteCurrency: "USDT",
        quantityUnit: "BTC",
        quantityPrecision: 5,
        minOrderQuantity: 0.00001,
        quantityStep: 0.00001,
      });
      expect(spot.execution).toMatchObject({
        pnlModel: "linear_crypto",
        contractMultiplier: 1.0,
        tickValue: 0.01,
      });
      expect(spot.session).toMatchObject({
        model: "continuous_24_7",
        timezone: "UTC",
        isContinuous24x7: true,
        displayTemplate: "utc_daily",
        rollOverUtcHour: 0,
      });
    });

    it("validates Binance BTCUSDT USDⓈ-M Perpetual Futures profile specifications", () => {
      const perp = requireMarketProfile("BINANCE:BTCUSDT-FUTURES");
      expect(perp.identity).toMatchObject({
        id: "BINANCE:BTCUSDT-FUTURES",
        symbol: "BTCUSDT",
        venue: "Binance",
        assetClass: "crypto_perp",
        marketType: "perpetual",
        isDerivative: true,
      });
      expect(perp.pricing).toMatchObject({
        tickSize: 0.1,
        pricePrecision: 1,
        minPriceIncrement: 0.1,
      });
      expect(perp.units).toMatchObject({
        baseCurrency: "BTC",
        quoteCurrency: "USDT",
        quantityUnit: "BTC",
        quantityPrecision: 3,
        minOrderQuantity: 0.001,
        quantityStep: 0.001,
      });
      expect(perp.execution).toMatchObject({
        pnlModel: "linear_crypto",
        contractMultiplier: 1.0,
        tickValue: 0.1,
      });
      expect(perp.session).toMatchObject({
        model: "continuous_24_7",
        timezone: "UTC",
        isContinuous24x7: true,
        displayTemplate: "utc_daily",
        rollOverUtcHour: 0,
      });
    });

    it("passes validation on all four built-in reference profiles", () => {
      for (const profile of REFERENCE_PROFILES) {
        const report = validateMarketProfile(profile);
        expect(report.isValid).toBe(true);
        expect(report.errors).toHaveLength(0);
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* 2. Runtime Immutability                                            */
  /* ------------------------------------------------------------------ */

  describe("2. Runtime Immutability", () => {
    it("freezes profile root and all nested configuration sections", () => {
      const profile = PROFILE_CME_NQ;
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.identity)).toBe(true);
      expect(Object.isFrozen(profile.pricing)).toBe(true);
      expect(Object.isFrozen(profile.units)).toBe(true);
      expect(Object.isFrozen(profile.execution)).toBe(true);
      expect(Object.isFrozen(profile.session)).toBe(true);
    });

    it("prevents mutating registered profiles at runtime", () => {
      const profile = getMarketProfile("CME:NQ")!;
      expect(() => {
        // @ts-expect-error mutating readonly property
        profile.id = "MUTATED";
      }).toThrow();

      expect(() => {
        // @ts-expect-error mutating nested property
        profile.pricing.tickSize = 0.5;
      }).toThrow();
    });

    it("protects registry storage from external mutation of registered copies", () => {
      const customProfile: MarketProfile = {
        id: "TEST:CUSTOM",
        identity: {
          id: "TEST:CUSTOM",
          symbol: "CUSTOM",
          label: "Custom Asset",
          venue: "TestVenue",
          assetClass: "equities",
          marketType: "spot",
          isDerivative: false,
        },
        pricing: {
          tickSize: 0.01,
          pricePrecision: 2,
        },
        units: {
          baseCurrency: "CUSTOM",
          quoteCurrency: "USD",
          quantityUnit: "shares",
          quantityPrecision: 0,
          minOrderQuantity: 1,
          quantityStep: 1,
        },
        execution: {
          pnlModel: "linear_crypto",
          contractMultiplier: 1.0,
          tickValue: 0.01,
        },
        session: {
          model: "continuous_24_7",
          timezone: "UTC",
          isContinuous24x7: true,
        },
      };

      const registry = new MarketProfileRegistry();
      registry.register(customProfile);

      // Mutating the original object after registration
      customProfile.pricing.tickSize = 100;

      // The registered copy remains unaffected and frozen
      const stored = registry.require("TEST:CUSTOM");
      expect(stored.pricing.tickSize).toBe(0.01);
      expect(Object.isFrozen(stored)).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 3. Strict Validation Engine                                        */
  /* ------------------------------------------------------------------ */

  describe("3. Strict Profile Validation Engine", () => {
    it("rejects non-object and null profiles", () => {
      expect(validateMarketProfile(null).isValid).toBe(false);
      expect(validateMarketProfile(undefined).isValid).toBe(false);
      expect(validateMarketProfile("string").isValid).toBe(false);
    });

    it("rejects missing or mismatched identity IDs", () => {
      const invalid = structuredClone(PROFILE_CME_NQ) as any;
      invalid.id = "";
      expect(validateMarketProfile(invalid).isValid).toBe(false);

      invalid.id = "CME:NQ";
      invalid.identity.id = "CME:MISMATCH";
      const report = validateMarketProfile(invalid);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "identity.id")).toBe(true);
    });

    it("rejects invalid assetClass and marketType enum values", () => {
      const invalid = structuredClone(PROFILE_CME_NQ) as any;
      invalid.identity.assetClass = "unknown_asset_class";
      invalid.identity.marketType = "binary_option";
      const report = validateMarketProfile(invalid);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "identity.assetClass")).toBe(true);
      expect(report.errors.some((e) => e.path === "identity.marketType")).toBe(true);
    });

    it("rejects non-finite, zero, or negative tick sizes and multipliers", () => {
      const zeroTick = structuredClone(PROFILE_CME_NQ) as any;
      zeroTick.pricing.tickSize = 0;
      expect(validateMarketProfile(zeroTick).isValid).toBe(false);

      const negTick = structuredClone(PROFILE_CME_NQ) as any;
      negTick.pricing.tickSize = -0.25;
      expect(validateMarketProfile(negTick).isValid).toBe(false);

      const nanMult = structuredClone(PROFILE_CME_NQ) as any;
      nanMult.execution.contractMultiplier = NaN;
      expect(validateMarketProfile(nanMult).isValid).toBe(false);

      const infMult = structuredClone(PROFILE_CME_NQ) as any;
      infMult.execution.contractMultiplier = Infinity;
      expect(validateMarketProfile(infMult).isValid).toBe(false);
    });

    it("rejects tick sizes that are unrepresentable at declared pricePrecision", () => {
      const unrepresentable = structuredClone(PROFILE_CME_NQ) as any;
      // 0.25 requires at least 2 decimal places; precision 1 makes it 2.5 (unrepresentable)
      unrepresentable.pricing.tickSize = 0.25;
      unrepresentable.pricing.pricePrecision = 1;
      const report = validateMarketProfile(unrepresentable);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "pricing.tickSize")).toBe(true);
    });

    it("rejects minPriceIncrement when it conflicts with tickSize", () => {
      const conflict = structuredClone(PROFILE_CME_NQ) as any;
      conflict.pricing.tickSize = 0.25;
      conflict.pricing.minPriceIncrement = 0.5;
      const report = validateMarketProfile(conflict);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "pricing.minPriceIncrement")).toBe(true);
    });

    it("rejects fractional CME futures contract quantities", () => {
      const fractionalStep = structuredClone(PROFILE_CME_NQ) as any;
      fractionalStep.units.quantityStep = 0.5; // fractional contract is invalid for CME futures
      const reportStep = validateMarketProfile(fractionalStep);
      expect(reportStep.isValid).toBe(false);
      expect(reportStep.errors.some((e) => e.path === "units.quantityStep")).toBe(true);

      const fractionalPrec = structuredClone(PROFILE_CME_NQ) as any;
      fractionalPrec.units.quantityPrecision = 2; // precision > 0 invalid for contracts
      const reportPrec = validateMarketProfile(fractionalPrec);
      expect(reportPrec.isValid).toBe(false);
      expect(reportPrec.errors.some((e) => e.path === "units.quantityPrecision")).toBe(true);
    });

    it("rejects spot markets classified as derivatives", () => {
      const spotAsDeriv = structuredClone(PROFILE_BINANCE_BTCUSDT_SPOT) as any;
      spotAsDeriv.identity.isDerivative = true;
      const report = validateMarketProfile(spotAsDeriv);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "identity.isDerivative")).toBe(true);
    });

    it("rejects perpetual futures classified as spot or non-derivatives", () => {
      const perpAsSpot = structuredClone(PROFILE_BINANCE_BTCUSDT_FUTURES) as any;
      perpAsSpot.identity.isDerivative = false;
      const report = validateMarketProfile(perpAsSpot);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "identity.isDerivative")).toBe(true);
    });

    it("rejects point_multiplier PnL model on Spot markets", () => {
      const spotPointMultiplier = structuredClone(PROFILE_BINANCE_BTCUSDT_SPOT) as any;
      spotPointMultiplier.execution.pnlModel = "point_multiplier";
      const report = validateMarketProfile(spotPointMultiplier);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "execution.pnlModel")).toBe(true);
    });

    it("rejects tickValue mismatch against tickSize * contractMultiplier", () => {
      const mismatch = structuredClone(PROFILE_CME_NQ) as any;
      mismatch.pricing.tickSize = 0.25;
      mismatch.execution.contractMultiplier = 20;
      mismatch.execution.tickValue = 10.0; // expected 0.25 * 20 = 5.0
      const report = validateMarketProfile(mismatch);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "execution.tickValue")).toBe(true);
    });

    it("rejects invalid IANA timezones", () => {
      const badTz = structuredClone(PROFILE_CME_NQ) as any;
      badTz.session.timezone = "Invalid/Timezone_Not_Real";
      const report = validateMarketProfile(badTz);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "session.timezone")).toBe(true);
    });

    it("rejects contradictory continuous 24/7 flags", () => {
      const contradictory = structuredClone(PROFILE_BINANCE_BTCUSDT_SPOT) as any;
      contradictory.session.model = "continuous_24_7";
      contradictory.session.isContinuous24x7 = false; // contradicts model
      const report = validateMarketProfile(contradictory);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "session.isContinuous24x7")).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 4. Registry Safety & O(1) Lookup Contract                          */
  /* ------------------------------------------------------------------ */

  describe("4. Registry Safety & O(1) Lookup Contract", () => {
    it("looks up profiles by exact ID in O(1) time", () => {
      expect(getMarketProfile("CME:NQ")?.id).toBe("CME:NQ");
      expect(getMarketProfile("CME:ES")?.id).toBe("CME:ES");
      expect(getMarketProfile("BINANCE:BTCUSDT-SPOT")?.id).toBe("BINANCE:BTCUSDT-SPOT");
      expect(getMarketProfile("BINANCE:BTCUSDT-FUTURES")?.id).toBe("BINANCE:BTCUSDT-FUTURES");
    });

    it("requireMarketProfile returns the profile or throws if missing", () => {
      expect(requireMarketProfile("CME:NQ").identity.symbol).toBe("NQ");
      expect(() => requireMarketProfile("NON_EXISTENT_ID")).toThrow(/MarketProfile not found for ID/);
    });

    it("NEVER falls back silently to NQ for unknown or invalid IDs", () => {
      expect(getMarketProfile("BTCUSDT")).toBeUndefined();
      expect(getMarketProfile("CME:MNQ")).toBeUndefined();
      expect(getMarketProfile("")).toBeUndefined();
      expect(hasMarketProfile("UNKNOWN")).toBe(false);

      // Verify that requesting an unknown profile does not return NQ
      const unknownResult = getMarketProfile("UNKNOWN");
      expect(unknownResult).toBeUndefined();
      expect(unknownResult).not.toEqual(PROFILE_CME_NQ);
    });

    it("rejects registering duplicate profile IDs", () => {
      const registry = new MarketProfileRegistry();
      expect(() => {
        registry.register(PROFILE_CME_NQ);
      }).toThrow(/already registered/);
    });

    it("rejects registering invalid profiles with diagnostic messages", () => {
      const registry = new MarketProfileRegistry();
      const invalid = structuredClone(PROFILE_CME_NQ) as any;
      invalid.id = "INVALID:TEST";
      invalid.pricing.tickSize = -1;
      expect(() => {
        registry.register(invalid);
      }).toThrow(/Cannot register invalid MarketProfile/);
    });

    it("allows resetting registry to reference state", () => {
      const registry = new MarketProfileRegistry();
      const custom: MarketProfile = {
        id: "TEST:RESET",
        identity: {
          id: "TEST:RESET",
          symbol: "RESET",
          label: "Reset Test",
          venue: "Test",
          assetClass: "equities",
          marketType: "spot",
          isDerivative: false,
        },
        pricing: { tickSize: 0.01, pricePrecision: 2 },
        units: {
          baseCurrency: "R",
          quoteCurrency: "USD",
          quantityUnit: "shares",
          quantityPrecision: 0,
          minOrderQuantity: 1,
          quantityStep: 1,
        },
        execution: { pnlModel: "linear_crypto", contractMultiplier: 1.0, tickValue: 0.01 },
        session: { model: "continuous_24_7", timezone: "UTC", isContinuous24x7: true },
      };

      registry.register(custom);
      expect(registry.has("TEST:RESET")).toBe(true);
      expect(registry.list()).toHaveLength(5);

      registry.reset();
      expect(registry.has("TEST:RESET")).toBe(false);
      expect(registry.list()).toHaveLength(4);
    });
  });

  /* ------------------------------------------------------------------ */
  /* 5. Architectural Boundary & Legacy Compatibility                   */
  /* ------------------------------------------------------------------ */

  describe("5. Architectural Boundary & Compatibility", () => {
    it("strictly rejects embedding MicrostructureCapabilities inside MarketProfile", () => {
      const contaminated = structuredClone(PROFILE_BINANCE_BTCUSDT_SPOT) as any;
      contaminated.hasTrades = true;
      contaminated.hasDepth = true;
      const report = validateMarketProfile(contaminated);
      expect(report.isValid).toBe(false);
      expect(report.errors.some((e) => e.path === "hasTrades")).toBe(true);
      expect(report.errors.some((e) => e.path === "hasDepth")).toBe(true);
    });

    it("ensures legacy CONTRACTS definitions continue working without breakage", () => {
      expect(CONTRACTS.NQ).toBeDefined();
      expect(CONTRACTS.NQ.pointValue).toBe(20);
      expect(CONTRACTS.NQ.tickSize).toBe(0.25);
      expect(CONTRACTS.ES).toBeDefined();
      expect(CONTRACTS.ES.pointValue).toBe(50);
      expect(CONTRACTS.ES.tickSize).toBe(0.25);
    });
  });
});
