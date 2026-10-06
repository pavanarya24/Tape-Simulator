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
import type { ScenarioTruth } from "./scenarios";
import { TrainingEngine, type TrainingSnapshot } from "./training";
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
import { scoreFlowSession, type FlowSessionResults } from "./scoring";

export interface FlowSessionOptions {
  /** Neutral session instance id (seed hex) — never encodes the pattern. */
  sessionId?: string;
  costs?: FlowCosts;
  risk?: FlowRisk;
  contract?: ContractSpec;
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
}

function signed(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export class FlowTrainingSession {
  private readonly training: TrainingEngine;
  private readonly truth: ScenarioTruth | null;
  private readonly exec: FlowExecutionEngine;
  private readonly sessionId: string;
  private decision: FlowDecision = { ...DEFAULT_FLOW_DECISION };
  private orderQty = 1;
  private revealed = false;
  private notice: FlowNotice | null = null;

  constructor(feed: MarketDataFeed, truth: ScenarioTruth | null = null, opts: FlowSessionOptions = {}) {
    this.training = new TrainingEngine(feed, truth);
    this.truth = truth;
    this.sessionId = opts.sessionId ?? "flow-session";
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

  stepBack(): void {
    this.training.stepBack();
    this.sync();
  }

  seekTo(index: number): void {
    this.training.seekTo(index);
    this.sync();
  }

  /** ⟲ RESET: rewind to event 0 and clear all trading state. */
  reset(): void {
    this.training.reset();
    this.exec.reset();
    this.notice = null;
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
    this.training.seekTo(0);
    this.notice = null;
    this.sync();
    return true;
  }

  /** Push the current revealed snapshot into the execution engine. */
  private sync(): void {
    const snap = this.training.snapshot();
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
    });
  }

  /* -------------------------------- views -------------------------------- */

  snapshot(): FlowSessionSnapshot {
    const snap = this.training.snapshot();
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
