/**
 * Terminal journal persistence.
 *
 * The journal is the only part of Tape Lab the reader authors themselves — the
 * reflective notes especially — but the trades come from the execution simulator,
 * which is rebuilt from scratch on every seek and is gone on reload. This keeps
 * the finished trades and their notes in localStorage so a practice session
 * survives a page reload.
 *
 * Only the session currently loaded is stored, because the app only ever shows
 * one session's trades at a time: loading or resetting a session replaces the
 * simulator, and therefore the journal, exactly as it does without storage.
 */

import { EMPTY_NOTES, type ClosedTrade, type JournalNotes } from "../execution/types";

const KEY = "tl_journal_v1";

/** localStorage holds roughly 5MB and one trade serialises to well under 1KB. */
const MAX_TRADES = 2000;

const NOTE_KEYS = Object.keys(EMPTY_NOTES) as Array<keyof JournalNotes>;

/** Mirrors `ClosedTrade["exitReason"]`; a value outside this set is corruption. */
const EXIT_REASONS: ReadonlyArray<ClosedTrade["exitReason"]> = [
  "stop",
  "target",
  "manual",
  "reverse",
  "session-close",
];

export interface StoredJournal {
  /** The session these trades belong to; restored only when it is loaded again. */
  sessionId: string | null;
  /** Oldest first, so the newest trade stays last after a merge. */
  trades: ClosedTrade[];
  /** Notes keyed by the controller's trade key, kept even if the trade is not. */
  notes: Record<string, JournalNotes>;
}

const EMPTY: StoredJournal = { sessionId: null, trades: [], notes: {} };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Read notes defensively. A missing field becomes empty rather than invalidating
 * the record — a journal written by an older build must still load — but a field
 * that is present and not a string means the payload is corrupt.
 */
function readNotes(v: unknown): JournalNotes | null {
  if (!isRecord(v)) return null;
  const out = { ...EMPTY_NOTES };
  for (const k of NOTE_KEYS) {
    const s = v[k];
    if (s === undefined) continue;
    if (typeof s !== "string") return null;
    out[k] = s;
  }
  return out;
}

/**
 * Validate every field the journal table, the CSV export and the score read. A
 * record that fails is dropped rather than repaired: a half-invented trade would
 * be worse than a missing one, and a non-finite price would poison the stats.
 */
function readTrade(v: unknown): ClosedTrade | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== "string" || v.id === "") return null;
  if (typeof v.instrument !== "string" || typeof v.contract !== "string") return null;
  if (typeof v.sessionId !== "string" || typeof v.sessionDate !== "string") return null;
  if (typeof v.sessionType !== "string") return null;
  // The two union-typed fields are checked against their members, not just their
  // type: these are the values the journal prints, so an unknown one is corruption.
  if (!EXIT_REASONS.includes(v.exitReason as ClosedTrade["exitReason"])) return null;
  if (v.direction !== "long" && v.direction !== "short") return null;
  for (const f of [
    "contracts",
    "entryTime",
    "entryIndex",
    "entryPrice",
    "exitTime",
    "exitIndex",
    "exitPrice",
    "grossPnl",
    "commission",
    "netPnl",
    "holdingMs",
  ] as const) {
    if (!num(v[f])) return null;
  }
  // Optional numerics are only kept when they are actually numbers.
  for (const f of ["stop", "target", "rMultiple"] as const) {
    if (v[f] !== undefined && !num(v[f])) return null;
  }
  const notes = readNotes(v.notes);
  if (!notes) return null;
  return { ...(v as unknown as ClosedTrade), notes };
}

export function loadJournal(): StoredJournal {
  if (typeof localStorage === "undefined") return EMPTY;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Storage can be disabled outright; the journal then lives in memory only.
    return EMPTY;
  }
  if (!raw) return EMPTY;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return EMPTY;
    const trades = Array.isArray(parsed.trades)
      ? parsed.trades.map(readTrade).filter((t): t is ClosedTrade => t !== null)
      : [];
    const notes: Record<string, JournalNotes> = {};
    if (isRecord(parsed.notes)) {
      for (const [k, v] of Object.entries(parsed.notes)) {
        const n = readNotes(v);
        if (n) notes[k] = n;
      }
    }
    return {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      trades,
      notes,
    };
  } catch {
    // A corrupt payload is discarded whole, never partially applied.
    return EMPTY;
  }
}

export function saveJournal(journal: StoredJournal): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        sessionId: journal.sessionId,
        trades: journal.trades.slice(-MAX_TRADES),
        notes: journal.notes,
      }),
    );
  } catch {
    // Quota exceeded or storage revoked mid-session: the journal keeps working
    // in memory, and the next write will try again.
  }
}
