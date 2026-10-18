# Phase 10-H — Open-Source Parity & Feed Integrity

## Status

Implementation started locally. No upstream code is vendored, no runtime dependency is added, and no Git commit or push is part of this phase.

## Why these projects are references rather than drop-in dependencies

### FlowMap

Repository: https://github.com/nazmiefearmutcu/flowmap

Use as an architecture and testing reference for normalized event streams, distinctions between genuine L2, L1, and synthetic data, and recorded replay. FlowMap has a separate Python server and its own client architecture; importing the project wholesale would add a second application/runtime boundary to Tape Lab without a demonstrated need. Tape Lab retains its existing React/TypeScript architecture and normalized event contract.

### border

Repository: https://github.com/ArshAnan/border

Use as an algorithm reference for snapshot-anchored order books, stale update rejection, sequence validation, and requiring a fresh snapshot after a gap. It is not adopted as a runtime dependency: the repository's test coverage was too limited to justify treating it as production-ready code. The parity requirement is implemented and tested in Tape Lab's own Binance adapter.

### Databento Python client

Repository: https://github.com/databento/databento-python

Use as a schema/semantics reference for CME/Databento data. Tape Lab currently normalizes captured Databento records in TypeScript; adding the Python client to the browser application would not improve that path. A Python bridge or server should only be considered if a concrete live-ingestion requirement needs it, with a separate interface and operational tests.

## Phase 10-H acceptance criteria

- Binance Spot diff-depth continuity continues to use the documented `U/u` overlap rule.
- Binance USDⓈ-M Futures diff-depth continuity requires `pu === lastUpdateId`; missing `pu` is a discontinuity, not permission to fall back to the Spot rule.
- Stale duplicate depth updates are ignored without falsely incrementing the gap count.
- A detected gap invalidates the local book; subsequent deltas are not trusted until a new snapshot anchors the book.
- No MBO, queue position, match ID, order count, or missing timestamp is fabricated.
- Existing normalized events, replay, DOM, and training engine contracts remain unchanged.
- Existing uncommitted Phase 10-F/10-G changes are preserved.

## Changes in this phase

- Tightened `src/flow/ingest/binance.ts`: when `market: "usdm"`, a depth update is accepted only when `pu` is present and matches the current update ID. Spot keeps the `U/u` rule.
- Added regressions in `tests/phase9crypto-binance.test.ts` for Futures frames missing `pu` and stale duplicate Spot updates.

## Verification required before release

Run the focused Binance suite, Phase 10-F/10-G suites, the full test suite, typecheck, and production build. Then re-run the browser source-switch/replay audit and inspect the full working-tree diff. Passing unit tests alone is not browser or live-feed certification.

## Attribution and licensing

These repositories informed design review only; no source files have been copied into Tape Lab. Before any future code reuse or dependency adoption, inspect the exact upstream license and pin the reviewed revision. Do not describe an architecture reference as an integrated tool or a historical capture as a live feed.
