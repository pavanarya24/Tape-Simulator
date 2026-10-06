/**
 * Timezone utilities.
 *
 * Historical OHLCV CSV files carry naive wall-clock timestamps with no offset
 * (e.g. `2019-08-05 09:30:00`). We interpret those timestamps in a configurable
 * *source timezone* (default America/New_York) and normalize everything to UTC
 * epoch milliseconds internally, so display can be rendered in any timezone.
 *
 * Implemented with `Intl.DateTimeFormat` only — no timezone library dependency.
 */

export const DEFAULT_TIMEZONE = "America/New_York";

export const TIMEZONE_CHOICES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Break an epoch-ms instant into wall-clock fields in `timeZone`. */
export function toWallClock(ms: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const hour = Number(get("hour"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // `hour12:false` can render midnight as 24 in some runtimes.
    hour: hour === 24 ? 0 : hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
  };
}

/** Offset (ms) added to UTC to obtain local time in `timeZone` at instant `ms`. */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const w = toWallClock(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - (ms - (ms % 1000));
}

/**
 * Convert naive wall-clock fields (interpreted in `timeZone`) to epoch ms.
 * Two-pass correction handles DST boundaries.
 */
export function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = tzOffsetMs(guess, timeZone);
  let candidate = guess - offset1;
  const offset2 = tzOffsetMs(candidate, timeZone);
  if (offset2 !== offset1) candidate = guess - offset2;
  return candidate;
}

/** `YYYY-MM-DD` for an instant in `timeZone`. */
export function isoDate(ms: number, timeZone: string): string {
  const w = toWallClock(ms, timeZone);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** `HH:MM` for an instant in `timeZone`. */
export function clockTime(ms: number, timeZone: string): string {
  const w = toWallClock(ms, timeZone);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/** `HH:MM:SS` for an instant in `timeZone`. */
export function clockTimeSeconds(ms: number, timeZone: string): string {
  const w = toWallClock(ms, timeZone);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}:${String(w.second).padStart(2, "0")}`;
}

/** Minutes since local midnight in `timeZone`. */
export function minutesOfDay(ms: number, timeZone: string): number {
  const w = toWallClock(ms, timeZone);
  return w.hour * 60 + w.minute;
}

/** Add days to a `YYYY-MM-DD` date string (calendar arithmetic, tz-agnostic). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function formatDateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
