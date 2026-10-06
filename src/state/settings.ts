import type { ContractId, RootSymbol } from "../market/types";
import type { SessionType, TimezoneConfig } from "../data/types";
import { DEFAULT_TIMEZONE } from "../data/timezone";
import type { AmbiguityRule } from "../execution/types";

export interface Settings {
  instrument: RootSymbol;
  sessionType: SessionType;
  contract: ContractId;
  timezone: TimezoneConfig;
  openingRangeMinutes: number;
  ambiguityRule: AmbiguityRule;
  slippageTicks: number;
  commissionPerContractRoundTurn: number;
  startingBalance: number;
  requireStop: boolean;
  maxContracts: number;
  maxTradesPerSession: number;
  dailyLossLimit: number;
  indicators: {
    vwap: boolean;
    ema21: boolean;
    ema50: boolean;
    ema200: boolean;
    openingRange: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  instrument: "NQ",
  sessionType: "RTH",
  contract: "NQ",
  timezone: { sourceTimeZone: DEFAULT_TIMEZONE, displayTimeZone: DEFAULT_TIMEZONE },
  openingRangeMinutes: 15,
  ambiguityRule: "adverse-first",
  slippageTicks: 1,
  commissionPerContractRoundTurn: 4.5,
  startingBalance: 25000,
  requireStop: false,
  maxContracts: 5,
  maxTradesPerSession: 10,
  dailyLossLimit: 500,
  indicators: {
    vwap: true,
    ema21: true,
    ema50: false,
    ema200: false,
    openingRange: true,
  },
};

const KEY = "tapelab_settings_v1";

export function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      timezone: { ...DEFAULT_SETTINGS.timezone, ...(parsed.timezone ?? {}) },
      indicators: { ...DEFAULT_SETTINGS.indicators, ...(parsed.indicators ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota / private-mode failures */
  }
}
