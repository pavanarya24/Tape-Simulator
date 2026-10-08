/**
 * FlowTrainingSession — the Flow Lab orchestration layer.
 *
 * Architecture (Phase 7A):
 *
 *   MarketDataFeed
 *        ↓
 *   OrderFlowEngine + DOMEngine
 *        ↓
 *   TrainingEngine  (owns ScenarioTruth privately)
 *        ↓
 *   FlowTrainingSession
 *     ├─ FlowExecutionEngine  (simulated BUY/SELL/FLATTEN — no truth, ever)
 *     ├─ decision capture + order quantity + risk/cost settings
 *     ├─ journal records (hidden pattern stamped ONLY here, post-hoc)
 *     └─ scoring (only reachable after markRevealed())
 *        ↓
 *   Flow Lab UI
 *
 * Replay synchronisation: every clock advance (`step`, `seekTo`, `reset`,
 * …) pushes the SAME snapshot the tape/DOM/CVD/profile render from into the
 * execution engine, so fills and P&L always use the current revealed event
 * and never a future one. Same seed ⇒ same events ⇒ identical results.
 */

import type { ContractSpec } from "../market/types";
import { CONTRACTS } from "../market/instruments";
import type { MarketDataFeed } from "./feed";
import type { FlowDifficulty, ScenarioTruth } from "./scenarios";
import { TIME_STEP_MS, type FlowStepUnit } from "./replay";
import { TrainingEngine, type TrainingSnapshot, type SeekMetrics } from "./training";
import type { CheckpointManager } from "./checkpointManager";
import {
  DEFAULT_FLOW_COSTS,
  DEFAULT_FLOW_DECISION,
  DEFAULT_FLOW_RISK,
  FlowExecutionEngine,
  type FlowCosts,
  type FlowDecision,
  type FlowExecResult,
  type FlowPosition,
  type FlowRisk,
} from "./execution";
import { tradeView, type FlowTradeRecord, type FlowTradeView } from "./journal";
import { computeAma } from "./indicators/ama";
import { scoreFlowSession, type FlowSessionResults } from "./scoring";
import {
  flowEvidenceLabel,
  recognizeFlow,
  RECOGNITION_MIN_POINTS,
  type FlowAnnotation,
  type FlowAnnotationType,
  type FlowEvidence,
  type FlowRecognition,
  type FlowTimelineEntry,
} from "./recognition";

export interface FlowSessionOptions {
  /** Neutral session instance id (seed hex) — never encodes the pattern. */
  sessionId?: string;
  costs?: FlowCosts;
  risk?: FlowRisk;
  contract?: ContractSpec;
  /** Difficulty the scenario was generated at (Phase 8C breakdown metric). */
  difficulty?: FlowDifficulty;
  /** Checkpoint cadence in event count (default 10,000). */
  checkpointInterval?: number;
}

export interface FlowNotice {
  ok: boolean;
  text: string;
}

/** Everything the Flow Lab UI renders, assembled from one snapshot. */
export interface FlowSessionSnapshot {
  source: string;
  isRealData: boolean;
  eventIndex: number;
  totalEvents: number;
  atEnd: boolean;
  atStart: boolean;
  timestamp: number | null;
  sequence: number;
  orderFlow: TrainingSnapshot["orderFlow"];
  dom: TrainingSnapshot["dom"];
  book: TrainingSnapshot["book"];
  priceSeries: TrainingSnapshot["priceSeries"];
  position: FlowPosition;
  orderQty: number;
  decision: FlowDecision;
  costs: FlowCosts;
  risk: FlowRisk;
  notice: FlowNotice | null;
  /** Trader-facing trade history; hiddenPattern is null until reveal. */
  trades: FlowTradeView[];
  /* --- Phase 7B recognition (observable-only; engine answer gated) --- */
  /** Objective current-state observations — safe to show while blind. */
  evidence: FlowEvidence[];
  /** Objective chart markers (timestamp/sequence mapped) — safe pre-reveal. */
  annotations: FlowAnnotation[];
  /** Observable evidence timeline — EMPTY until reveal (spec §8). */
  timeline: FlowTimelineEntry[];
  /** Engine classification — NULL until reveal (blind-mode guarantee). */
  recognition: FlowRecognition | null;
  /* --- Adaptive Moving Average (objective indicator — safe while blind) --- */
  /** One AMA value per revealed print, aligned with priceSeries. */
  amaSeries: Array<{ t: number; value: number }>;
  /** Current AMA (latest revealed print) — null before any trade. */
  ama: number | null;
}

/** Metrics whose state changes tell a timeline story (noisy ones excluded). */
const TIMELINE_METRICS = new Set([
  "sellAggression",
  "buyAggression",
  "priceResponse",
  "liquidityReplenishment",
  "cvd",
  "sweepEvents",
  "volumeConcentration",
  "cvdDivergence",
  "lowReclaim",
  "highRejection",
]);

/** One-shot / high-impact observations get flagged in the timeline. */
const IMPORTANT_METRICS = new Set([
  "cvdDivergence",
  "lowReclaim",
  "highRejection",
  "sweepEvents",
  "liquidityReplenishment",
]);

/** Which chart marker a metric change draws (null = no marker). */
function annotationTypeFor(metric: string, interpretation: string): FlowAnnotationType | null {
  switch (metric) {
    case "sellAggression":
    case "buyAggression":
      return interpretation === "HIGH" ? "aggression" : null;
    case "volumeConcentration":
      return interpretation === "HIGH" ? "concentration" : null;
    case "sweepEvents":
      return "sweep";
    case "cvdDivergence":
      return "divergence";
    case "lowReclaim":
    case "highRejection":
      return "rejection";
    case "liquidityReplenishment":
      return interpretation === "HIGH" ? "replenishment" : null;
    case "priceResponse":
      return interpretation === "WEAK" ? "concentration" : null;
    default:
      return null;
  }
}

/** Minimum events between two timeline entries for the SAME metric — kills
 *  threshold flicker while staying fully deterministic (index arithmetic). */
const TIMELINE_COOLDOWN = 30;

function signed(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export class FlowTrainingSession {
  private readonly training: TrainingEngine;
  private readonly truth: ScenarioTruth | null;
  private readonly exec: FlowExecutionEngine;
  private readonly sessionId: string;
  private readonly difficulty: FlowDifficulty;
  private decision: FlowDecision = { ...DEFAULT_FLOW_DECISION };
  private orderQty = 1;
  private revealed = false;
  private notice: FlowNotice | null = null;
  /* --- Phase 7B: recognition runs on the event clock, cached by index --- */
  private recognition: FlowRecognition | null = null;
  private recognitionIndex = -1;
  /** AMA also rides the event clock: recomputed only when the clock moves. */
  private amaCache: {
    eventIndex: number;
    series: Array<{ t: number; value: number }>;
    current: number | null;
  } | null = null;
  /** Deterministic evidence timeline: diffs of observable signatures. */
  private timelineCache: {
    maxIndex: number;
    signature: Map<string, string>;
    entries: FlowTimelineEntry[];
    /** Last event index an entry was recorded for each metric (cooldown). */
    lastAt: Map<string, number>;
  } | null = null;

  constructor(feed: MarketDataFeed, truth: ScenarioTruth | null = null, opts: FlowSessionOptions = {}) {
    this.training = new TrainingEngine(feed, truth, { checkpointInterval: opts.checkpointInterval });
    this.truth = truth;
    this.sessionId = opts.sessionId ?? "flow-session";
    this.difficulty = opts.difficulty ?? "INTERMEDIATE";
    this.exec = new FlowExecutionEngine({
      contract: opts.contract ?? CONTRACTS.NQ,
      costs: opts.costs ?? DEFAULT_FLOW_COSTS,
      risk: opts.risk ?? DEFAULT_FLOW_RISK,
    });
  }

  /* ----------------------------- event clock ----------------------------- */

  get eventIndex(): number {
    return this.training.eventIndex;
  }

  get totalEvents(): number {
    return this.training.totalEvents;
  }

  get lastSeekMetrics(): SeekMetrics | null {
    return this.training.lastSeekMetrics;
  }

  get checkpointManager(): CheckpointManager {
    return this.training.checkpointManager;
  }

  /** Reveal initial context without moving past it (generate/restart). */
  warmup(n: number): void {
    this.training.stepForward(n);
    this.sync();
  }

  /** Advance the whole session (tape, DOM, CVD … and execution) together. */
  step(n = 1): number {
    const taken = this.training.stepForward(n);
    this.sync();
    return taken;
  }

  /** Alias for step(n) maintaining parity with TrainingEngine. */
  stepForward(n = 1): number {
    return this.step(n);
  }

  stepBack(): void {
    const prev = this.training.eventIndex;
    this.training.stepBack();
    if (this.training.eventIndex < prev) {
      this.handleBackwardSeek(this.training.eventIndex);
    }
    this.sync();
  }

  /**
   * Advance one step of the chosen unit (spec §8A.1), always in WHOLE events on
   * the single event clock — the same clock that drives tape, DOM, CVD, profile,
   * AMA, VWAP, evidence, recognition and execution:
   *
   *   EVENT  exactly `amount` events
   *   TRADE  until `amount` more prints have been crossed
   *   TIME   until the tape clock has advanced by `amount × TIME_STEP_MS`
   *
   * Every intermediate event is applied and synced, so the resulting state is
   * byte-identical to stepping manually. Never reads past the clock.
   */
  stepByUnit(unit: FlowStepUnit, amount = 1): number {
    if (unit === "EVENT") return this.step(amount);
    let taken = 0;
    if (unit === "TRADE") {
      let crossed = 0;
      while (crossed < amount) {
        const before = this.training.snapshot().orderFlow.tradeCount;
        const n = this.step(1);
        if (n === 0) break;
        taken += n;
        if (this.training.snapshot().orderFlow.tradeCount > before) crossed++;
      }
      return taken;
    }
    // TIME
    const targetMs = amount * TIME_STEP_MS;
    let base: number | null = this.training.snapshot().timestamp;
    for (;;) {
      const n = this.step(1);
      if (n === 0) break;
      taken += n;
      const ts = this.training.snapshot().timestamp;
      if (ts === null) continue;
      if (base === null) base = ts;
      if (ts - base >= targetMs) break;
    }
    return taken;
  }

  seekTo(index: number): void {
    const prev = this.training.eventIndex;
    this.training.seekTo(index);
    if (this.training.eventIndex < prev) {
      this.handleBackwardSeek(this.training.eventIndex);
    }
    this.sync();
  }

  /** Alias for seekTo(index). */
  seek(index: number): void {
    this.seekTo(index);
  }

  /** ⟲ RESET: rewind to event 0 and clear all trading state. */
  reset(): void {
    this.training.reset();
    this.exec.reset();
    this.notice = null;
    this.timelineCache = null;
    this.recognition = null;
    this.recognitionIndex = -1;
    this.amaCache = null;
    this.sync();
  }

  /**
   * RESTART SCENARIO: replay the SAME seed/scenario (never regenerated) from
   * the warm-up point with a clean position and journal. The trader's decision
   * and reveal state are kept — same scenario, new attempt.
   */
  restart(warmupEvents: number): void {
    this.exec.reset();
    this.orderQty = 1;
    this.notice = null;
    this.timelineCache = null;
    this.recognition = null;
    this.recognitionIndex = -1;
    this.amaCache = null;
    this.training.seekTo(warmupEvents);
    this.sync();
  }

  /**
   * REPLAY FROM START: rewind the tape to the first event, keeping journal,
   * decision and reveal state. Refused while a position is open so an entry
   * can never be replayed against a rewound clock.
   */
  replayFromStart(): boolean {
    if (this.exec.positionView().side !== "FLAT") {
      this.notice = { ok: false, text: "FLATTEN THE OPEN POSITION BEFORE REPLAYING" };
      return false;
    }
    this.timelineCache = null;
    this.recognition = null;
    this.recognitionIndex = -1;
    this.amaCache = null;
    this.training.seekTo(0);
    this.notice = null;
    this.sync();
    return true;
  }

  /**
   * Invalidate derived caches upon backward seek so no future information leaks.
   * Core state is restored by TrainingEngine; derived state (recognition, AMA, timeline)
   * is invalidated or truncated to target.
   */
  private handleBackwardSeek(target: number): void {
    this.recognition = null;
    this.recognitionIndex = -1;
    this.amaCache = null;

    if (target === 0 && this.exec.positionView().side === "FLAT") {
      this.exec.reset();
    }

    if (this.timelineCache) {
      const remainingEntries = this.timelineCache.entries.filter((e) => e.index <= target);
      if (remainingEntries.length === 0) {
        this.timelineCache = null;
      } else {
        const remainingLastAt = new Map<string, number>();
        for (const e of remainingEntries) {
          remainingLastAt.set(e.metric, e.index);
        }
        this.timelineCache = {
          maxIndex: target,
          signature: FlowTrainingSession.signatureOf(recognizeFlow(this.training.snapshot())),
          entries: remainingEntries,
          lastAt: remainingLastAt,
        };
      }
    }
  }

  /**
   * Recognition on the event clock: computed exactly when the clock moves and
   * cached by event index, so getState()/snapshot() never recalculate it and
   * seek/replay reproduce byte-identical results (spec §15).
   */
  private ensureRecognition(snap: TrainingSnapshot): FlowRecognition {
    if (!this.recognition || this.recognitionIndex !== snap.eventIndex) {
      this.recognition = recognizeFlow(snap);
      this.recognitionIndex = snap.eventIndex;
    }
    return this.recognition;
  }

  /**
   * AMA on the event clock: a pure function of the revealed price series,
   * cached by event index so state reads never recalculate it and any
   * navigation path (step, seek, restart, replay) reproduces it exactly.
   * Objective indicator — exposed while blind, never gated by reveal.
   */
  private ensureAma(snap: TrainingSnapshot): {
    series: Array<{ t: number; value: number }>;
    current: number | null;
  } {
    if (!this.amaCache || this.amaCache.eventIndex !== snap.eventIndex) {
      const values = computeAma(snap.priceSeries.map((p) => p.price));
      const series = snap.priceSeries.map((p, i) => ({ t: p.t, value: values[i] }));
      this.amaCache = {
        eventIndex: snap.eventIndex,
        series,
        current: series.length > 0 ? series[series.length - 1].value : null,
      };
    }
    return this.amaCache;
  }

  private static signatureOf(rec: FlowRecognition): Map<string, string> {
    const sig = new Map<string, string>();
    for (const ev of rec.evidence) sig.set(ev.metric, `${ev.interpretation}|${String(ev.value)}`);
    return sig;
  }

  /**
   * Extend the evidence timeline up to the current event index by walking the
   * event clock lazily from the nearest covered checkpoint or last covered point.
   * Deterministic: the signature at index i depends only on events 0..i.
   */
  private ensureTimeline(): void {
    const target = this.training.eventIndex;
    if (this.timelineCache && this.timelineCache.maxIndex >= target) return;

    let index: number;
    let signature: Map<string, string>;
    let entries: FlowTimelineEntry[];
    let lastAt: Map<string, number>;

    if (this.timelineCache) {
      const nearest = this.training.checkpointManager.findNearest(target);
      const cpIndex = nearest ? nearest.eventIndex : 0;
      if (this.timelineCache.maxIndex < cpIndex) {
        index = cpIndex;
        entries = this.timelineCache.entries;
        lastAt = this.timelineCache.lastAt;
        this.training.seekTo(cpIndex);
        signature = FlowTrainingSession.signatureOf(recognizeFlow(this.training.snapshot()));
      } else {
        index = this.timelineCache.maxIndex;
        signature = this.timelineCache.signature;
        entries = this.timelineCache.entries;
        lastAt = this.timelineCache.lastAt;
        this.training.seekTo(index);
      }
    } else {
      const nearest = this.training.checkpointManager.findNearest(target);
      const cpIndex = nearest ? nearest.eventIndex : 0;
      index = cpIndex;
      signature = new Map<string, string>();
      entries = [];
      lastAt = new Map<string, number>();
      this.training.seekTo(cpIndex);
      signature = FlowTrainingSession.signatureOf(recognizeFlow(this.training.snapshot()));
    }

    while (index < target) {
      this.training.stepForward(1);
      index++;
      const snap = this.training.snapshot();
      const rec = recognizeFlow(snap);
      const next = FlowTrainingSession.signatureOf(rec);
      // No timeline before the recogniser has enough data — early-session
      // readings are noise, not a story (deterministic: priceSeries length).
      const eligible = snap.priceSeries.length >= RECOGNITION_MIN_POINTS;
      for (const ev of rec.evidence) {
        if (!TIMELINE_METRICS.has(ev.metric)) continue;
        const key = `${ev.interpretation}|${String(ev.value)}`;
        if (signature.get(ev.metric) === key) continue;
        const first = !signature.has(ev.metric);
        signature.set(ev.metric, key);
        if (!eligible) continue;
        // A metric's first appearance with nothing to report is not an event.
        if (first && ev.interpretation === "NONE") continue;
        const prev = lastAt.get(ev.metric);
        if (prev !== undefined && index - prev < TIMELINE_COOLDOWN) continue;
        lastAt.set(ev.metric, index);
        entries.push({
          index,
          sequence: ev.sequence,
          timestamp: ev.timestamp,
          metric: ev.metric,
          label: flowEvidenceLabel(ev.metric),
          interpretation: ev.interpretation,
          important: IMPORTANT_METRICS.has(ev.metric) || ev.interpretation === "DETECTED",
        });
      }
      // Metrics that vanished (e.g. divergence resolved) update silently so a
      // later reappearance registers as a fresh event.
      for (const metric of signature.keys()) {
        if (!next.has(metric)) signature.set(metric, "—");
      }
    }

    this.timelineCache = { maxIndex: index, signature, entries, lastAt };
    // Walk finished at `target`, which is where the clock already was.
  }

  /** Push the current revealed snapshot into the execution engine. */
  private sync(): void {
    const snap = this.training.snapshot();
    this.ensureRecognition(snap);
    const auto = this.exec.onMarket({
      bid: snap.dom.bestBid,
      ask: snap.dom.bestAsk,
      lastPrice: snap.orderFlow.tradeCount > 0 ? snap.orderFlow.lastPrice : null,
      timestamp: snap.timestamp ?? 0,
      sequence: snap.sequence,
    });
    if (auto && auto.ok && auto.closed) {
      const t = auto.closed;
      this.notice = {
        ok: true,
        text: `${t.exitReason} — ${t.side} ${t.quantity} closed @ ${t.exitPrice} · NET ${signed(t.netPnL)}`,
      };
    }
  }

  /* ------------------------------- trading ------------------------------- */

  buy(): FlowExecResult {
    this.sync();
    const result = this.exec.buy(this.orderQty, this.decision);
    this.notice = describeResult(result, "BUY");
    return result;
  }

  sell(): FlowExecResult {
    this.sync();
    const result = this.exec.sell(this.orderQty, this.decision);
    this.notice = describeResult(result, "SELL");
    return result;
  }

  flatten(): FlowExecResult {
    this.sync();
    const result = this.exec.flatten();
    this.notice = describeResult(result, "FLATTEN");
    return result;
  }

  setOrderQty(qty: number): void {
    this.orderQty = Math.max(1, Math.floor(qty));
  }

  setDecision(patch: Partial<FlowDecision>): void {
    const next: FlowDecision = { ...this.decision, ...patch };
    next.level = Math.min(5, Math.max(1, Math.round(next.level)));
    this.decision = next;
  }

  setCosts(patch: Partial<FlowCosts>): void {
    this.exec.setCosts({ ...this.exec.costsConfig, ...patch });
  }

  setRisk(patch: Partial<FlowRisk>): void {
    this.exec.setRisk({ ...this.exec.riskConfig, ...patch });
  }

  setNotice(ok: boolean, text: string): void {
    this.notice = { ok, text };
  }

  /* ------------------------------ reveal/score ------------------------------ */

  /** The reveal gate: results become computable only after this is called. */
  markRevealed(): void {
    this.revealed = true;
  }

  get isRevealed(): boolean {
    return this.revealed;
  }

  /** Internal journal (includes the hidden pattern) — scoring/reveal only. */
  records(): FlowTradeRecord[] {
    return this.exec.closedTrades().map((t) => ({
      ...t,
      scenarioId: this.sessionId,
      hiddenPattern: this.truth ? this.truth.pattern : null,
    }));
  }

  /** POST-REVEAL results. Returns null until markRevealed() has been called. */
  results(): FlowSessionResults | null {
    if (!this.revealed || !this.truth) return null;
    const snap = this.training.snapshot();
    return scoreFlowSession({
      truth: this.truth,
      records: this.records(),
      decision: this.decision,
      risk: this.exec.riskConfig,
      contract: this.exec.contract,
      orderFlow: snap.orderFlow,
      dom: snap.dom,
      // Engine recognition rides the same reveal gate as the truth itself.
      recognition: this.ensureRecognition(snap),
      difficulty: this.difficulty,
    });
  }

  /* -------------------------------- views -------------------------------- */

  snapshot(): FlowSessionSnapshot {
    const snap = this.training.snapshot();
    const recognition = this.ensureRecognition(snap);
    const ama = this.ensureAma(snap);
    // Objective timeline/annotations: observable events only — safe while
    // blind. The engine's pattern answer stays behind `this.revealed`.
    this.ensureTimeline();
    const current = this.training.eventIndex;
    const visible = (this.timelineCache?.entries ?? []).filter((e) => e.index <= current);
    const annotations: FlowAnnotation[] = [];
    for (const e of visible) {
      const type = annotationTypeFor(e.metric, e.interpretation);
      if (!type) continue;
      annotations.push({
        t: e.timestamp,
        seq: e.sequence,
        type,
        label: `${e.label} ${e.interpretation}`,
        interpretive: false,
      });
    }
    return {
      source: snap.source,
      isRealData: snap.isRealData,
      eventIndex: snap.eventIndex,
      totalEvents: snap.totalEvents,
      atEnd: snap.atEnd,
      atStart: snap.atStart,
      timestamp: snap.timestamp,
      sequence: snap.sequence,
      orderFlow: snap.orderFlow,
      dom: snap.dom,
      book: snap.book,
      priceSeries: snap.priceSeries,
      position: this.exec.positionView(),
      orderQty: this.orderQty,
      decision: { ...this.decision },
      costs: this.exec.costsConfig,
      risk: this.exec.riskConfig,
      notice: this.notice,
      trades: this.records().map((r) => tradeView(r, this.revealed)),
      evidence: recognition.evidence,
      annotations,
      timeline: this.revealed ? visible : [],
      recognition: this.revealed ? recognition : null,
      amaSeries: ama.series,
      ama: ama.current,
    };
  }
}

function describeResult(result: FlowExecResult, action: string): FlowNotice {
  if (!result.ok) return { ok: false, text: `REJECTED — ${result.reason}` };
  const fill = result.fills[result.fills.length - 1];
  if (result.reversed && result.closed && fill) {
    return {
      ok: true,
      text: `REVERSED — closed ${result.closed.side} @ ${result.closed.exitPrice}, opened ${action} ${fill.quantity} @ ${fill.price} · SEQ ${fill.sequence}`,
    };
  }
  if (result.closed && fill) {
    return {
      ok: true,
      text: `FLATTENED ${result.closed.side} ${result.closed.quantity} @ ${result.closed.exitPrice} · NET ${signed(result.closed.netPnL)} · SEQ ${fill.sequence}`,
    };
  }
  if (!fill) return { ok: true, text: `${action} FILLED` };
  return { ok: true, text: `${action} ${fill.quantity} @ ${fill.price} · SEQ ${fill.sequence}` };
}
