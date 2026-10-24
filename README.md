# Tape Reading Academy — Tape Lab

This repository now contains two things:

1. **Tape Lab** — the app at `/` — an educational OHLC futures market-replay and trading
   simulator for NQ and ES (Vite + React + TypeScript).
2. **Tape Reading Academy** — the original single-file course, preserved unchanged at
   `/academy.html` (see `docs/COURSE_HANDOFF.md`).

> **SIMULATED TRADING — HISTORICAL REPLAY.** Tape Lab is a training tool. Fills are
> simulated with a documented candle-based model; nothing here is a broker fill, and the
> OHLCV datasets contain **no** Time & Sales, bid/ask or Level-2 information.
>
> **SYNTHETIC TRAINING DATA — FLOW LAB.** The Flow Lab order-flow experience runs on a
> deterministic synthetic event feed (seeded trades + Level-2 snapshots + book resets),
> labelled *Synthetic Training Data* everywhere it appears. It is never derived from OHLC
> candles and is never presented as real market data.
>
> **Correction (2026-10).** That is no longer the whole picture. Flow Lab now ships **four**
> selectable sources: the synthetic feed described here, plus three genuine recorded venue
> captures — Binance Spot BTCUSDT, Binance Vision historical aggTrades, and a Databento CME
> Globex NQ MBP-1 capture. Each is labelled in the app and listed with its basis in
> `public/legal.html`. Separately, the terminal's NQ/ES sessions are a seeded random walk
> generated in your browser, not recorded history. The bundled recordings are included for
> individual educational use only and are not licensed for redistribution. A real vendor
> adapter (Rithmic, ...) can implement the same `MarketDataFeed` interface with no engine or
> UI changes.
>
> **Correction (2026-10-24).** The Databento CME NQ capture has been removed from the app. A
> `?raw` import inlines the bytes into the shipped bundle, and that bundle is served to every
> visitor, so bundling it redistributed licensed CME data to the public. Flow Lab now offers
> **three** sources — the synthetic feed and two Binance captures. The Databento adapter
> (`src/flow/ingest/databento.ts`) and the on-disk fixture (`tests/fixtures/databento_cme_nq.jsonl`)
> remain for local verification; nothing served reaches them. The fixture is still a tracked file,
> so it is still published by this repository — removing it from the repo entirely would mean
> rewriting git history.

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
  custom-length EMAs (any period you like, persisted with its own colour), opening range,
  full performance statistics, a multi-factor replay score, blind-mode
  predictions, tagged historical scenarios and a CSV trade journal.
- **Future order-flow interfaces** (`src/market/types.ts`, `src/market/feed.ts`) — `Tick`,
  `Trade`, `Quote`, `OrderBookSnapshot` and `TickDataSource` are declared but intentionally
  unimplemented, so a real tick / Level-2 source can be added without redesigning the UI.
- **Flow Lab** (`src/flow`) — vendor-neutral `MarketDataFeed` interface + a deterministic
  `SyntheticMarketDataFeed` (seeded regime phases: trending, rotation, volatility, aggression,
  liquidity pulls/replenishments, absorption, sweeps, delta divergence, breakouts), feeding an
  `OrderFlowEngine` (tape, delta, CVD, volume-at-price, spread, microprice, velocity, aggression)
  and a separate `DOMEngine` (top-10 book, imbalance, stacking, pulling, depletion, sweeps).
  A scenario engine generates five blind-training patterns (Spring, Upthrust, Absorption,
  Initiative Break, Responsive Fade) with a hidden `ScenarioTruth` exposed only by
  “Reveal what it was”. Same seed ⇒ identical events; swapping in a real feed later touches
  nothing below the interface.

## Datasets

Real files are optional: Tape Lab seeds a clearly-labelled **synthetic demo dataset** so the
terminal works immediately. Import genuine 5-minute NQ/ES CSVs on the **Data** page — they
are parsed in the browser and stored in IndexedDB. The course lives at `/academy.html`.

## Licence

**All rights reserved.** This repository is public so the work can be read and learned from;
public availability is not a licence. No right to copy, modify, redistribute or reuse is
granted. See `LICENSE` for the full terms, including the restrictions on the bundled market
data recordings. A permissive licence can be granted later; this notice can be relaxed but
never retroactively tightened.

Bundled third-party code, its licences and the font attributions: `THIRD-PARTY-NOTICES.md`.

Risk, data-provenance, privacy and terms of use: `public/legal.html`, served at `/legal.html`.

## Deployment

Vercel (or any static host) builds with `bun run build`; output directory `dist`.
`academy.html` is copied to the site root by Vite's `public/` directory.
