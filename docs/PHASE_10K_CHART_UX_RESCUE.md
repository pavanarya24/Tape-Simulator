# Phase 10-K — Chart UX Rescue

## Goal

Address the chart-quality blocker without porting a native desktop application into the React/Vite product or changing feed, recognition, or execution logic.

## Delivered

- Added visible candle interval controls: 1s, 5s, 15s, 1m, 5m, and Auto.
- Default is 5-second candles so candle semantics remain stable as the replay grows; Auto remains available for an overview based on the visible chart width and current capture span.
- Changing interval rebuilds candle aggregation from the currently revealed price series. It does not advance the replay clock or expose unrevealed data.
- Existing Lightweight Charts renderer, VWAP/AMA, CVD, volume profile, markers, and feed-provenance labels remain in place.
- Added compact workstation-style interval controls that fit in the chart header without replacing the chart library.

## Verification

- TypeScript project build/typecheck passed.
- Focused chart, replay-integrity, and Phase 10-J tests passed: 59 passed, 0 failed.
- Production Vite build passed. Existing warning: generated JavaScript bundle is approximately 750 kB minified and exceeds the 500 kB advisory threshold.
- Selenium/Firefox browser check on the local Vite app found all six interval controls, confirmed 5s selected by default, and verified clicking 1m changes the selected state.
- `git diff --check` passed; only Git LF/CRLF working-copy warnings were emitted.

## Limits / next

This is a local chart UX improvement, not a production deployment and not proof of a live exchange feed. The current chart still aggregates revealed trade prices into time buckets; trade-only captures do not gain historical Level 2 from this work. The next UI pass should assess a real chart screenshot and focus on viewport-follow behavior, price-scale ergonomics, candle spacing, and lower-pane layout. QuantTick remains a reference rather than a drop-in dependency because it is a separate native Rust desktop app.

No commit, push, merge, or tag was performed.
