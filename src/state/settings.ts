import type { ContractId, RootSymbol } from "../market/types";
import type { SessionType, TimezoneConfig } from "../data/types";
import { DEFAULT_TIMEZONE } from "../data/timezone";
import type { AmbiguityRule } from "../execution/types";
import { normalizeEmaLengths } from "../indicators/indicators";

/** Stock colours for the classic EMA periods. */
export const DEFAULT_EMA_COLORS: Record<string, string> = {
  "21": "#e6a93c",
  "50": "#a78bfa",
  "200": "#c8d2dc",
};

/** Colour cycle handed to newly added custom EMAs (never a gradient, just ink). */
export const EMA_PALETTE: readonly string[] = [
  "#e6a93c",
  "#a78bfa",
  "#4d8ff0",
  "#2fbf71",
  "#e5484d",
  "#c8d2dc",
  "#e0c36b",
  "#7ce0d3",
];

export const DEFAULT_VWAP_COLOR = "#4d8ff0";

/** EMA periods drawn before the user customises anything. */
export const DEFAULT_EMA_LENGTHS: readonly number[] = [21];

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
    /** Persisted colour of the VWAP line. */
    vwapColor: string;
    /** User-defined EMA periods, ascending and de-duplicated. */
    emaLengths: number[];
    /** Colour per EMA period (localStorage JSON keys are strings). */
    emaColors: Record<string, string>;
    openingRange: boolean;
  };
}

/** Booleans kept by builds before custom EMA lengths existed. */
type LegacyIndicators = {
  ema21?: boolean;
  ema50?: boolean;
  ema200?: boolean;
};

/** Shape of whatever is currently sitting in storage for `indicators`. */
type StoredIndicators = Partial<Settings["indicators"]> & LegacyIndicators;

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
    vwapColor: DEFAULT_VWAP_COLOR,
    emaLengths: [...DEFAULT_EMA_LENGTHS],
    emaColors: { ...DEFAULT_EMA_COLORS },
    openingRange: true,
  },
};

const KEY = "tapelab_settings_v1";

/** Fresh copy of the defaults — nested objects are never shared between callers. */
function defaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    timezone: { ...DEFAULT_SETTINGS.timezone },
    indicators: {
      ...DEFAULT_SETTINGS.indicators,
      emaLengths: [...DEFAULT_EMA_LENGTHS],
      emaColors: { ...DEFAULT_EMA_COLORS },
    },
  };
}

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

/** Keep only well-formed `#rrggbb`-style entries from stored colours. */
function sanitizeColors(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && HEX_COLOR.test(value)) out[key] = value;
    }
  }
  return out;
}

/**
 * Read whatever is in storage into a valid settings object. Pre-custom builds
 * only stored the `ema21/ema50/ema200` booleans, so those are translated into
 * an explicit length list; the booleans themselves are dropped rather than
 * carried along as dead keys. Every field is type-checked, so hand-edited or
 * corrupt storage can never inject a bad colour or a junk length.
 */
function migrateIndicators(raw: StoredIndicators | undefined): Settings["indicators"] {
  const stored = raw ?? {};

  const legacy: number[] = [];
  if (stored.ema21) legacy.push(21);
  if (stored.ema50) legacy.push(50);
  if (stored.ema200) legacy.push(200);

  const lengths: readonly number[] = Array.isArray(stored.emaLengths)
    ? stored.emaLengths
    : legacy.length > 0
      ? legacy
      : DEFAULT_EMA_LENGTHS;

  return {
    vwap: typeof stored.vwap === "boolean" ? stored.vwap : DEFAULT_SETTINGS.indicators.vwap,
    vwapColor:
      typeof stored.vwapColor === "string" && HEX_COLOR.test(stored.vwapColor)
        ? stored.vwapColor
        : DEFAULT_VWAP_COLOR,
    emaLengths: normalizeEmaLengths(lengths),
    emaColors: { ...DEFAULT_EMA_COLORS, ...sanitizeColors(stored.emaColors) },
    openingRange:
      typeof stored.openingRange === "boolean" ? stored.openingRange : DEFAULT_SETTINGS.indicators.openingRange,
  };
}

export function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<Settings> & { indicators?: StoredIndicators };
    return {
      ...defaults(),
      ...parsed,
      timezone: { ...DEFAULT_SETTINGS.timezone, ...(parsed.timezone ?? {}) },
      indicators: migrateIndicators(parsed.indicators),
    };
  } catch {
    return defaults();
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
