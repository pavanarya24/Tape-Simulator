import { isoDate, clockTime, clockTimeSeconds, formatDateLabel } from "../data/timezone";

export function money(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function signedMoney(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function price(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function num(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function pct(n: number | undefined, digits = 1): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function compact(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export function tzDate(ms: number, tz: string): string {
  return formatDateLabel(isoDate(ms, tz));
}

export function tzTime(ms: number, tz: string): string {
  return clockTime(ms, tz);
}

export function tzTimeSec(ms: number, tz: string): string {
  return clockTimeSeconds(ms, tz);
}

export function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function timeframeLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const minutes = ms / 60000;
  return minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
}

export function pnlClass(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "up" : "down";
}
