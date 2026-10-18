# Phase 10-J — Replay Quality Certification

## Purpose

Turn existing adapter and replay guarantees into repeatable certification checks for the checked-in captures. This phase is deliberately limited to recorded evidence; it does not claim a live exchange connection, reconnecting socket supervisor, exchange certification, or full L2 replay.

## Checks added

- Repeated Binance Spot depth gaps discard the local book and require a new snapshot before depth updates can be accepted.
- Updates received while the book is unanchored are not allowed to leak into normalized depth events.
- Fixed raw capture input normalizes deterministically: event sequences and validation report are equal across repeated runs.
- The three checked-in capture loaders expose validation reports consistent with their normalized event counts.
- Trade-only Binance historical data remains explicitly without L2 depth and quotes; it is not certified as a depth replay source.

## QuantTick evaluation (architecture decision)

Repository reviewed: https://github.com/milocaetano/quantick

QuantTick is a Rust/egui native desktop application with a Rust bar engine, recorded trade replay, alternative bars, and a Bookmap-inspired L2 visualization. It is not a drop-in React chart package for this Vite/React application. Integrating the desktop app would introduce a separate native runtime and an inter-process/data-contract boundary; embedding its engine would require a deliberate Rust-to-TypeScript/WASM or service integration design. Its documented replay currently plays trades, while depth replay is listed as an open item.

Decision: do not replace Lightweight Charts or Flow Lab replay in this phase. Keep QuantTick as a reference for deterministic bar aggregation, honest data-coverage labels, and future alternative-bar research. Before any integration, prove a narrow prototype with identical source trades producing identical bars, and measure chart/replay behavior against the existing Flow Lab path.

## Evidence limits

- These tests use checked-in captures and deterministic test records. They do not prove current live feed health.
- A sequence-gap count certifies detection in the adapter's input, not automatic network reconnection.
- A recorded trade stream does not reconstruct historical L2.
- Existing full-suite replay timeout flakes remain a release-gate issue until a full-suite run passes cleanly or the timeout policy is addressed with evidence.

## Verification

Run the focused tests:

```powershell
bun test tests/phase10j-replay-quality-certification.test.ts tests/phase9crypto-binance.test.ts tests/phase10i-feed-diagnostics.test.ts
```

Then run typecheck, production build, and the full suite. Do not commit or push until explicitly authorized and the release gate is clean.
