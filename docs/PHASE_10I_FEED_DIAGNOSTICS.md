# Phase 10-I — Feed Integrity Diagnostics

## Scope

Surface existing adapter validation evidence for the currently selected recorded market-data capture. This is a diagnostic summary, not a live connection monitor, a guarantee of feed completeness, or exchange/vendor certification.

## Delivered

- Added `summarizeFeedIntegrity()` to convert an `IngestionValidationReport` into a compact status and counts.
- Added explicit states for unavailable diagnostics, invalid/empty normalized feeds, sequence gaps, rejected records, and no defects reported by adapter validation.
- Labels the validator's `recordCount` as validation checks in the UI; it is not presented as a count of every raw wire message.
- Preserves capability claims exactly as reported; does not infer MBO, order counts, nanosecond timestamps, receive timestamps, or match IDs.
- Aggregates rejection reasons while retaining the original rejected-record count, duplicate count, and sequence-gap count.
- Exposes the recorded feed's validation report through Flow Lab state and adds a Feed integrity panel for real-data captures only. Synthetic scenarios do not get a fabricated report.
- Adds unit tests for status precedence, capability honesty, missing reports, and rejection aggregation.

## Evidence boundary

The panel reports the adapter's batch-validation results for the loaded capture. It does not poll a live exchange, establish that the capture is complete, measure packet latency, or imply that an instrument profile is certified for production. A zero-gap report applies only to the records that were examined.

## Verification

- Focused tests: Phase 10-I diagnostics + Phase 10-F/10-G + Binance ingestion.
- TypeScript project build.
- Vite production build.
- Browser check required for synthetic and each genuine capture, verifying panel visibility, counts, capability labels, and honest trade-only behavior.

## Next

Before calling the phase complete, run the full test suite and the browser audit. Do not commit or push without explicit authorization.
