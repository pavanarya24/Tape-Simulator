# Tape Reading Academy — Tape Lab

This repository now contains two things:

1. **Tape Lab** — the app at `/` — an educational OHLC futures market-replay and trading
   simulator for NQ and ES (Vite + React + TypeScript).
2. **Tape Reading Academy** — the original single-file course, preserved unchanged at
   `/academy.html` (see `HANDOFF.md`).

> **SIMULATED TRADING — HISTORICAL REPLAY.** Tape Lab is a training tool. Fills are
> simulated with a documented candle-based model; nothing here is a broker fill, and the
> OHLCV datasets contain **no** Time & Sales, bid/ask or Level-2 information.

## Running Tape Lab

```bash
bun install
bun run dev        # dev server (Vite). The host injects PORT in managed environments.
bun run build      # production build -> dist/
bun run typecheck  # tsc -b --noEmit
bun scripts/verify.ts   # core data / replay / execution checks
```

## What it does

- **Data layer** (`src/data`) — streaming CSV ingestion for `Time, Open, High, Low, Close,
  Volume`, OHLC validation, duplicate and gap detection, timeframe detection, timezone
  normalization (default `America/New_York`), a session index, and IndexedDB persistence.
  Only one session is ever loaded into the UI; the full multi-year series stays on disk.
- **Replay engine** (`src/replay`) — candle-by-candle playback at 0.5x–100x with step,
  reset, seek and keyboard shortcuts. The future is never revealed to the UI.
- **Trading** (`src/orders`, `src/execution`) — market / limit / stop orders, stop-loss,
  take-profit, flatten and reverse, with a documented candle-based fill model and a
  configurable intrabar ambiguity rule.
- **Analytics** (`src/indicators`, `src/scoring`, `src/journal`, `src/scenarios`) — VWAP,
  EMA, opening range, full performance statistics, a multi-factor replay score, blind-mode
  predictions, tagged historical scenarios and a CSV trade journal.
- **Future order-flow interfaces** (`src/market/types.ts`, `src/market/feed.ts`) — `Tick`,
  `Trade`, `Quote`, `OrderBookSnapshot` and `TickDataSource` are declared but intentionally
  unimplemented, so a real tick / Level-2 source can be added without redesigning the UI.

## Datasets

Real files are optional: Tape Lab seeds a clearly-labelled **synthetic demo dataset** so the
terminal works immediately. Import genuine 5-minute NQ/ES CSVs on the **Data** page — they
are parsed in the browser and stored in IndexedDB. Add `videos/` next to `academy.html` for
the course video slots.

## Deployment

Vercel (or any static host) builds with `bun run build`; output directory `dist`.
`academy.html` is copied to the site root by Vite's `public/` directory.
