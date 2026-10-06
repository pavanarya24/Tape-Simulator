/** Trade journal: every closed trade is recorded automatically; notes are user-editable. */

import type { ClosedTrade, JournalNotes } from "../execution/types";
import { isoDate, clockTimeSeconds } from "../data/timezone";

export const JOURNAL_NOTE_FIELDS: Array<{ key: keyof JournalNotes; label: string; hint: string }> = [
  { key: "thesis", label: "Trade thesis", hint: "What was the idea in one sentence?" },
  { key: "saw", label: "What I saw", hint: "Structure, level, context at the moment of entry." },
  { key: "whyEntered", label: "Why I entered", hint: "Trigger and confirmation." },
  { key: "whyExited", label: "Why I exited", hint: "Target, stop, or discretionary decision." },
  { key: "mistake", label: "Mistake", hint: "If any — process, not outcome." },
  { key: "lesson", label: "Lesson", hint: "What to change next time." },
];

function fmt(n: number | undefined, digits = 2): string {
  return n === undefined || !Number.isFinite(n) ? "" : n.toFixed(digits);
}

function holdingLabel(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function tradesToCsv(trades: ClosedTrade[], timeZone: string): string {
  const header = [
    "Instrument",
    "Contract",
    "Session Date",
    "Session",
    "Direction",
    "Contracts",
    "Entry Time",
    "Entry Price",
    "Exit Time",
    "Exit Price",
    "Stop",
    "Target",
    "Gross P&L",
    "Commission",
    "Net P&L",
    "R Multiple",
    "Holding Time",
    "Exit Reason",
    "Thesis",
    "What I Saw",
    "Why I Entered",
    "Why I Exited",
    "Mistake",
    "Lesson",
  ];

  const rows = trades.map((t) => [
    t.instrument,
    t.contract,
    t.sessionDate,
    t.sessionType,
    t.direction,
    String(t.contracts),
    `${isoDate(t.entryTime, timeZone)} ${clockTimeSeconds(t.entryTime, timeZone)}`,
    fmt(t.entryPrice),
    `${isoDate(t.exitTime, timeZone)} ${clockTimeSeconds(t.exitTime, timeZone)}`,
    fmt(t.exitPrice),
    fmt(t.stop),
    fmt(t.target),
    fmt(t.grossPnl),
    fmt(t.commission),
    fmt(t.netPnl),
    fmt(t.rMultiple),
    holdingLabel(t.holdingMs),
    t.exitReason,
    t.notes.thesis,
    t.notes.saw,
    t.notes.whyEntered,
    t.notes.whyExited,
    t.notes.mistake,
    t.notes.lesson,
  ]);

  const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header, ...rows].map((r) => r.map((c) => escape(String(c ?? ""))).join(",")).join("\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportJournalCsv(trades: ClosedTrade[], timeZone: string): void {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadCsv(`tape-lab-journal-${stamp}.csv`, tradesToCsv(trades, timeZone));
}

export function tradeDurationLabel(t: ClosedTrade): string {
  return holdingLabel(t.holdingMs);
}

export { holdingLabel };
