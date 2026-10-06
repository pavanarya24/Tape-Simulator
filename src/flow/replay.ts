/**
 * Phase 8A — replay modes, playback speeds and the gating policy that decides
 * what each mode may show.
 *
 * The replay clock (the event clock in TrainingEngine/FlowTrainingSession) is
 * the ONLY source of truth. Everything here is a pure *policy*: it chooses how
 * fast the UI advances whole events and which overlays are permitted — it never
 * holds market state and never advances anything itself, so any speed produces
 * the identical event sequence.
 */

export type FlowReplayMode = "LIVE" | "BLIND" | "BAR_CONTEXT" | "REVIEW";

export const FLOW_REPLAY_MODES: readonly FlowReplayMode[] = [
  "LIVE",
  "BLIND",
  "BAR_CONTEXT",
  "REVIEW",
];

export const FLOW_REPLAY_MODE_HINTS: Record<FlowReplayMode, string> = {
  LIVE: "event-by-event replay, no future events",
  BLIND: "strict blind training, objective markers only",
  BAR_CONTEXT: "blind replay with coarser price context",
  REVIEW: "post-reveal navigation of the completed scenario",
};

/** Selectable playback speeds (spec §8A.1). */
export const FLOW_REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 25, 50] as const;
export type FlowReplaySpeed = (typeof FLOW_REPLAY_SPEEDS)[number];
export const DEFAULT_FLOW_SPEED: FlowReplaySpeed = 1;

/** What a single step advances (spec §8A.1 — where practical). */
export type FlowStepUnit = "EVENT" | "TRADE" | "TIME";
export const FLOW_STEP_UNITS: readonly FlowStepUnit[] = ["EVENT", "TRADE", "TIME"];

/** Tape-time a TIME step advances before it stops (ms). */
export const TIME_STEP_MS = 1_000;

export const REPLAY_BASE_TICK_MS = 80;
export const REPLAY_MIN_TICK_MS = 16;
/** Events advanced per UI tick when playing at 1× (always whole events). */
export const REPLAY_EVENTS_PER_TICK = 1;
/** Coarse price bucket used by BAR_CONTEXT mode (30s of tape). */
export const CONTEXT_BUCKET_MS = 30_000;

export interface ReplayPolicy {
  /** Whether any event beyond the clock may ever be read (always false). */
  futureEvents: boolean;
  /** Entry/exit markers on the chart (review only — they carry outcomes). */
  tradeMarkers: boolean;
  /** Interpretive annotations (pattern window) — reveal-gated. */
  interpretiveMarkers: boolean;
  /** Coarser candle aggregation for "surrounding price context". */
  coarseContext: boolean;
  /** Seeking forward past the current event (review only). */
  forwardSeek: boolean;
  /** Unrestricted navigation of the completed scenario. */
  reviewNavigation: boolean;
}

/**
 * REVIEW only exists after the reveal gate has been passed; asking for it
 * while blind degrades to BLIND rather than exposing anything.
 */
export function resolveReplayMode(requested: FlowReplayMode, revealed: boolean): FlowReplayMode {
  if (requested === "REVIEW" && !revealed) return "BLIND";
  return requested;
}

export function replayPolicy(mode: FlowReplayMode, revealed: boolean): ReplayPolicy {
  if (mode === "REVIEW" && revealed) {
    return {
      futureEvents: false,
      tradeMarkers: true,
      interpretiveMarkers: true,
      coarseContext: false,
      forwardSeek: true,
      reviewNavigation: true,
    };
  }
  return {
    futureEvents: false,
    tradeMarkers: false,
    interpretiveMarkers: false,
    coarseContext: mode === "BAR_CONTEXT",
    forwardSeek: false,
    reviewNavigation: false,
  };
}

/**
 * Timing for one playback tick. Speed changes how many whole events advance
 * per tick and how often the tick fires — never the order or the content of
 * the sequence, so replay is speed-independent.
 */
export function playbackBatch(speed: FlowReplaySpeed): { intervalMs: number; eventsPerTick: number } {
  if (speed > 1) {
    return {
      intervalMs: Math.max(REPLAY_MIN_TICK_MS, Math.round(REPLAY_BASE_TICK_MS / 2)),
      eventsPerTick: Math.max(1, Math.round(speed)),
    };
  }
  return {
    intervalMs: Math.max(REPLAY_MIN_TICK_MS, Math.round(REPLAY_BASE_TICK_MS / speed)),
    eventsPerTick: REPLAY_EVENTS_PER_TICK,
  };
}

/** Percentage of the scenario revealed at `eventIndex` (0..100, rounded 1dp). */
export function replayProgressPct(eventIndex: number, totalEvents: number): number {
  if (totalEvents <= 0) return 0;
  const pct = (Math.min(eventIndex, totalEvents) / totalEvents) * 100;
  return Math.round(pct * 10) / 10;
}
