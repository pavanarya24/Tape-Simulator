/**
 * Tape Lab application controller.
 *
 * Owns the data repository, replay engine, execution simulator, journal and
 * scoring. React never touches those directly — it reads an immutable snapshot
 * from this controller and calls the methods below. The replay engine and
 * ExecutionSimulator remain completely unaware of the UI.
 */

import type { Bar, RootSymbol } from "../market/types";
import { CONTRACTS } from "../market/instruments";
import type { SessionBars, SessionMeta, SessionType } from "../data/types";
import { barAt, sliceBarSeries } from "../data/types";
import { DataRepository } from "../data/repository";
import type { DatasetSummary } from "../data/db";
import type { IngestProgress } from "../data/types";
import { computeIndicators, type IndicatorSeries } from "../indicators/indicators";
import { ReplayEngine, type ReplaySnapshot } from "../replay/ReplayEngine";
import { ExecutionSimulator } from "../execution/ExecutionSimulator";
import {
  DEFAULT_EXECUTION_CONFIG,
  type AmbiguityRule,
  type ClosedTrade,
  type ExecutionConfig,
  type JournalNotes,
  type PositionSnapshot,
  type RuleViolation,
} from "../execution/types";
import type { Fill, Order, OrderRequest } from "../orders/types";
import { computePerformance, computeSessionStats, type PerformanceStats, type SessionStats } from "../scoring/performance";
import { computeScore, type ReplayScore } from "../scoring/scoring";
import {
  DEFAULT_PREDICTION_RULES,
  evaluatePrediction,
  type PredictionChoice,
  type PredictionRecord,
} from "../scoring/predictions";
import {
  SCENARIOS,
  classifySession,
  type ScenarioId,
  type SessionClassification,
} from "../scenarios/scenarios";
import { loadSettings, saveSettings, type Settings } from "./settings";

/** Opening ranges are defined against the 09:30 America/New_York cash open. */
const OR_ANCHOR_TZ = "America/New_York";

export type Page = "terminal" | "blind" | "scenarios" | "data" | "journal" | "score";

export interface BlindState {
  active: boolean;
  startIndex: number;
  awaitingReveal: boolean;
}

export interface PendingPrediction {
  choice: PredictionChoice;
  reasoning: string;
  index: number;
  time: number;
  startPrice: number;
}

export interface AppState {
  ready: boolean;
  page: Page;
  settings: Settings;
  instruments: RootSymbol[];
  sessions: SessionMeta[];
  session: SessionMeta | null;
  engine: ReplaySnapshot | null;
  position: PositionSnapshot;
  orders: Order[];
  fills: Fill[];
  trades: ClosedTrade[];
  stats: PerformanceStats;
  sessionStats: SessionStats;
  violations: RuleViolation[];
  score: ReplayScore;
  predictions: PredictionRecord[];
  pendingPrediction: PendingPrediction | null;
  blind: BlindState;
  indicators: IndicatorSeries | null;
  datasets: DatasetSummary[];
  ingest: IngestProgress | null;
  message: string | null;
  scenarioMatches: Array<{ scenario: ScenarioId; sessions: Array<{ meta: SessionMeta; score: number }> }>;
  classifying: boolean;
  currentClassification: SessionClassification | null;
}

interface ActionEntry {
  index: number;
  op: (sim: ExecutionSimulator, time: number, index: number) => void;
}

function tradeKey(t: ClosedTrade): string {
  return `${t.instrument}|${t.sessionId}|${t.entryTime}|${t.entryIndex}|${t.direction}|${t.entryPrice}`;
}

export class TapeLabController {
  readonly repo = new DataRepository();
  settings: Settings = loadSettings();
  page: Page = "terminal";

  sessions: SessionMeta[] = [];
  session: SessionBars | null = null;
  indicators: IndicatorSeries | null = null;
  engine: ReplayEngine | null = null;
  sim: ExecutionSimulator | null = null;
  predictions: PredictionRecord[] = [];
  pendingPrediction: PendingPrediction | null = null;
  blind: BlindState = { active: false, startIndex: 0, awaitingReveal: false };
  ingest: IngestProgress | null = null;
  message: string | null = null;
  ready = false;
  scenarioMatches: AppState["scenarioMatches"] = [];
  classifying = false;
  currentClassification: SessionClassification | null = null;

  private actions: ActionEntry[] = [];
  private notesByKey = new Map<string, JournalNotes>();
  private listeners = new Set<() => void>();
  private rafHandle: number | null = null;
  private cache: AppState | null = null;
  private cacheVersion = -1;
  private version = 0;
  private lastIndex = 0;
  private settled = false;
  private initPromise: Promise<void> | null = null;

  /* ------------------------------ lifecycle ------------------------------ */

  initialize(): Promise<void> {
    // Safe against React StrictMode double-invocation and repeated calls.
    if (!this.initPromise) this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    try {
      await this.repo.init();
      this.repo.subscribe(() => {
        this.applySessions();
        this.notify();
      });
      this.applySessions();
      const latest = this.sessions[this.sessions.length - 1];
      if (latest) await this.loadSession(latest.id);
    } catch (err) {
      // Startup must never die silently: surface the cause and keep going in
      // whatever degraded mode we can (e.g. memory-only dataset store).
      this.message =
        err instanceof Error
          ? `Startup warning: ${err.message}`
          : "Startup warning: initialization failed.";
    } finally {
      this.ready = true;
      this.notify();
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private scheduleNotify(): void {
    if (this.rafHandle !== null) return;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16);
    this.rafHandle = raf(() => {
      this.rafHandle = null;
      this.notify();
    }) as unknown as number;
  }

  /* ------------------------------- state ------------------------------- */

  getState(): AppState {
    if (this.cache && this.cacheVersion === this.version) return this.cache;
    const trades = this.sim?.closedTrades ?? [];
    const stats = computePerformance(trades);
    this.cache = {
      ready: this.ready,
      page: this.page,
      settings: this.settings,
      instruments: (["NQ", "ES"] as RootSymbol[]).filter((i) => this.repo.has(i)),
      sessions: this.sessions,
      session: this.session?.meta ?? null,
      engine: this.engine ? this.engine.state : null,
      position:
        this.sim?.snapshot() ?? {
          direction: "flat",
          contracts: 0,
          avgEntry: 0,
          mark: 0,
          unrealized: 0,
          realized: 0,
        },
      orders: this.sim ? [...this.sim.orders].reverse() : [],
      fills: this.sim ? [...this.sim.fills].reverse() : [],
      trades,
      stats,
      sessionStats: computeSessionStats(this.settings.startingBalance, stats),
      violations: this.sim?.violations ?? [],
      score: computeScore({
        stats,
        startingBalance: this.settings.startingBalance,
        violations: this.sim?.violations ?? [],
        predictions: this.predictions,
        maxContracts: this.settings.maxContracts,
      }),
      predictions: this.predictions,
      pendingPrediction: this.pendingPrediction,
      blind: this.blind,
      indicators: this.indicators,
      datasets: this.repo.summaries(),
      ingest: this.ingest,
      message: this.message,
      scenarioMatches: this.scenarioMatches,
      classifying: this.classifying,
      currentClassification: this.currentClassification,
    };
    this.cacheVersion = this.version;
    return this.cache;
  }

  setPage(page: Page): void {
    this.page = page;
    this.notify();
  }

  clearMessage(): void {
    this.message = null;
    this.notify();
  }

  /* ----------------------------- selection ----------------------------- */

  private applySessions(): void {
    this.sessions = this.repo.listSessions(this.settings.instrument, this.settings.sessionType);
  }

  async selectInstrument(instrument: RootSymbol): Promise<void> {
    if (instrument === this.settings.instrument) return;
    this.settings = { ...this.settings, instrument, contract: instrument === "ES" ? "ES" : "NQ" };
    this.persist();
    this.applySessions();
    const latest = this.sessions[this.sessions.length - 1];
    if (latest) await this.loadSession(latest.id);
    else {
      this.session = null;
      this.engine = null;
      this.sim = null;
      this.notify();
    }
  }

  async selectSessionType(type: SessionType): Promise<void> {
    if (type === this.settings.sessionType) return;
    this.settings = { ...this.settings, sessionType: type };
    this.persist();
    this.applySessions();
    const latest = this.sessions[this.sessions.length - 1];
    if (latest) await this.loadSession(latest.id);
  }

  async selectSession(id: string): Promise<void> {
    await this.loadSession(id);
  }

  async loadSession(id: string): Promise<void> {
    const sb = await this.repo.loadSession(this.settings.instrument, this.settings.sessionType, id);
    if (!sb) {
      this.message = "That session is not available in the loaded dataset.";
      this.notify();
      return;
    }
    this.session = sb;
    this.indicators = computeIndicators(
      sb.bars,
      this.settings.openingRangeMinutes,
      OR_ANCHOR_TZ,
    );
    this.currentClassification = classifySession(
      sb.bars,
      OR_ANCHOR_TZ,
      this.settings.openingRangeMinutes,
    );

    this.engine?.dispose();
    this.actions = [];
    this.predictions = [];
    this.pendingPrediction = null;
    this.settled = false;
    this.lastIndex = 0;
    this.blind = { active: false, startIndex: 0, awaitingReveal: false };

    this.engine = new ReplayEngine(sb.meta, sb.bars, 0);
    this.engine.subscribe((ev) => this.onReplayEvent(ev));
    this.sim = new ExecutionSimulator(this.execConfig(), this.execCtx());
    this.sim.onBar(barAt(sb.bars, 0), 0);
    this.notify();
  }

  async randomSession(): Promise<void> {
    if (this.sessions.length === 0) return;
    const pick = this.sessions[Math.floor(Math.random() * this.sessions.length)];
    await this.selectSession(pick.id);
  }

  async stepSession(delta: number): Promise<void> {
    const current = this.session?.meta.id;
    const idx = this.sessions.findIndex((s) => s.id === current);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= this.sessions.length) return;
    await this.selectSession(this.sessions[next].id);
  }

  /* ------------------------------ replay ------------------------------ */

  private onReplayEvent(ev: { type: string; index?: number; bar?: Bar }): void {
    if (!this.engine || !this.sim || !this.session) return;
    if (ev.type === "bar" && ev.bar && ev.index !== undefined) {
      if (ev.index === this.lastIndex + 1) {
        this.sim.onBar(ev.bar, ev.index);
        this.lastIndex = ev.index;
        if (ev.index === this.engine.bars.length - 1 && !this.settled) {
          this.settled = true;
          this.sim.onSessionEnd(ev.bar, ev.index);
        }
      } else {
        this.rebuildTo(ev.index);
      }
    } else if (ev.type === "seek" && ev.index !== undefined) {
      this.rebuildTo(ev.index);
    }
    this.scheduleNotify();
  }

  private rebuildTo(index: number): void {
    const session = this.session;
    if (!session) return;
    const sim = new ExecutionSimulator(this.execConfig(), this.execCtx());
    const ordered = [...this.actions].sort((a, b) => a.index - b.index);
    let ai = 0;
    const last = session.bars.length - 1;
    for (let i = 0; i <= index; i++) {
      const bar = barAt(session.bars, i);
      sim.onBar(bar, i);
      while (ai < ordered.length && ordered[ai].index === i) {
        ordered[ai].op(sim, bar.t, i);
        ai++;
      }
    }
    this.settled = false;
    if (index >= last) {
      this.settled = true;
      sim.onSessionEnd(barAt(session.bars, last), last);
    }
    // Re-attach any journal notes the user wrote before a rebuild.
    for (const t of sim.closedTrades) {
      const saved = this.notesByKey.get(tradeKey(t));
      if (saved) t.notes = { ...saved };
    }
    this.sim = sim;
    this.lastIndex = index;
  }

  play(): void {
    this.engine?.play();
  }
  pause(): void {
    this.engine?.pause();
  }
  togglePlay(): void {
    this.engine?.toggle();
  }
  stepForward(): void {
    this.engine?.stepForward();
  }
  stepBack(): void {
    this.engine?.stepBack();
  }
  resetReplay(): void {
    if (!this.engine) return;
    // A reset means "start this session over": drop the recorded user actions
    // too, otherwise a later scrub forward would replay orders the user already
    // cleared.
    this.actions = [];
    this.engine.reset();
    this.rebuildTo(0);
    this.notify();
  }
  setSpeed(speed: Parameters<ReplayEngine["setSpeed"]>[0]): void {
    this.engine?.setSpeed(speed);
  }
  seek(index: number): void {
    if (!this.engine) return;
    // Blind Mode never allows scrubbing into unrevealed history.
    const target = this.blind.active ? Math.min(index, this.engine.state.cursor) : index;
    this.engine.seek(target);
  }

  /* ------------------------------ trading ------------------------------ */

  private execConfig(): ExecutionConfig {
    const s = this.settings;
    return {
      contract: CONTRACTS[s.contract],
      ambiguityRule: s.ambiguityRule,
      slippageTicks: s.slippageTicks,
      commissionPerContractRoundTurn: s.commissionPerContractRoundTurn,
      requireStop: s.requireStop,
      maxContracts: s.maxContracts,
      maxTradesPerSession: s.maxTradesPerSession,
      dailyLossLimit: s.dailyLossLimit,
    };
  }

  private execCtx() {
    const meta = this.session?.meta;
    return {
      instrument: this.settings.instrument,
      sessionId: meta?.id ?? "unknown",
      sessionDate: meta?.date ?? "----",
      sessionType: this.settings.sessionType,
    };
  }

  placeOrder(req: OrderRequest): void {
    const engine = this.engine;
    const sim = this.sim;
    if (!engine || !sim || this.settled) return;
    const index = engine.state.cursor;
    const time = engine.currentBar.t;
    this.actions.push({ index, op: (s, t, i) => s.submit(req, t, i) });
    sim.submit(req, time, index);
    this.notify();
  }

  flatten(): void {
    const engine = this.engine;
    const sim = this.sim;
    if (!engine || !sim || this.settled) return;
    const index = engine.state.cursor;
    const time = engine.currentBar.t;
    this.actions.push({ index, op: (s, t, i) => s.flatten(t, i) });
    sim.flatten(time, index);
    this.notify();
  }

  reverse(): void {
    const engine = this.engine;
    const sim = this.sim;
    if (!engine || !sim || this.settled) return;
    const index = engine.state.cursor;
    const time = engine.currentBar.t;
    this.actions.push({ index, op: (s, t, i) => s.reverse(t, i) });
    sim.reverse(time, index);
    this.notify();
  }

  cancelOrder(id: string): void {
    this.sim?.cancel(id);
    this.notify();
  }

  /* ------------------------------ settings ------------------------------ */

  private persist(): void {
    saveSettings(this.settings);
  }

  updateSettings(partial: Partial<Settings>): void {
    this.settings = { ...this.settings, ...partial };
    this.persist();
    this.notify();
  }

  setContract(contract: Settings["contract"]): void {
    this.updateSettings({ contract });
    this.refreshExecution();
  }

  setAmbiguityRule(rule: AmbiguityRule): void {
    this.updateSettings({ ambiguityRule: rule });
    this.refreshExecution();
  }

  toggleIndicator(key: keyof Settings["indicators"]): void {
    this.updateSettings({
      indicators: { ...this.settings.indicators, [key]: !this.settings.indicators[key] },
    });
  }

  setOpeningRange(minutes: number): void {
    this.settings = { ...this.settings, openingRangeMinutes: minutes };
    this.persist();
    if (this.session) {
      this.indicators = computeIndicators(this.session.bars, minutes, OR_ANCHOR_TZ);
      this.currentClassification = classifySession(this.session.bars, OR_ANCHOR_TZ, minutes);
    }
    this.notify();
  }

  /** Re-run the session deterministically after an execution-model change. */
  private refreshExecution(): void {
    if (!this.engine) return;
    this.rebuildTo(this.engine.state.cursor);
    this.notify();
  }

  async setSourceTimezone(tz: string): Promise<void> {
    const previousDate = this.session?.meta.date;
    this.settings = {
      ...this.settings,
      timezone: { ...this.settings.timezone, sourceTimeZone: tz },
    };
    this.persist();
    for (const instrument of ["NQ", "ES"] as RootSymbol[]) {
      if (this.repo.has(instrument)) await this.repo.reindex(instrument, tz);
    }
    this.applySessions();
    const match = this.sessions.find((s) => s.date === previousDate) ?? this.sessions[this.sessions.length - 1];
    if (match) await this.loadSession(match.id);
    this.notify();
  }

  setDisplayTimezone(tz: string): void {
    this.settings = {
      ...this.settings,
      timezone: { ...this.settings.timezone, displayTimeZone: tz },
    };
    this.persist();
    this.notify();
  }

  /* ----------------------------- data import ----------------------------- */

  async importCsv(instrument: RootSymbol, file: File): Promise<void> {
    this.ingest = {
      phase: "reading",
      bytesRead: 0,
      totalBytes: file.size,
      rowsParsed: 0,
      message: `Importing ${file.name}…`,
    };
    this.notify();
    try {
      await this.repo.importCsv({
        instrument,
        file,
        fileName: file.name,
        sourceTimeZone: this.settings.timezone.sourceTimeZone,
        displayTimeZone: this.settings.timezone.displayTimeZone,
        onProgress: (p) => {
          this.ingest = p;
          this.scheduleNotify();
        },
      });
      this.applySessions();
      if (this.settings.instrument === instrument) {
        await this.selectInstrumentForce(instrument);
      }
      this.message = `${instrument} dataset imported successfully.`;
    } catch (err) {
      this.message = err instanceof Error ? err.message : "Import failed.";
    } finally {
      this.ingest = null;
      this.notify();
    }
  }

  /** Reload the current instrument after its dataset was replaced. */
  private async selectInstrumentForce(instrument: RootSymbol): Promise<void> {
    this.settings = { ...this.settings, instrument };
    this.persist();
    this.applySessions();
    const latest = this.sessions[this.sessions.length - 1];
    if (latest) await this.loadSession(latest.id);
  }

  /* ------------------------------- blind ------------------------------- */

  startBlind(startIndex: number): void {
    const engine = this.engine;
    if (!engine) return;
    this.predictions = [];
    this.pendingPrediction = null;
    engine.seek(startIndex);
    this.blind = { active: true, startIndex, awaitingReveal: false };
    this.notify();
  }

  exitBlind(): void {
    this.blind = { active: false, startIndex: 0, awaitingReveal: false };
    this.pendingPrediction = null;
    this.notify();
  }

  makePrediction(choice: PredictionChoice, reasoning: string): void {
    const engine = this.engine;
    if (!engine) return;
    this.pendingPrediction = {
      choice,
      reasoning,
      index: engine.state.cursor,
      time: engine.currentBar.t,
      startPrice: engine.currentBar.c,
    };
    this.blind = { ...this.blind, awaitingReveal: true };
    this.notify();
  }

  revealPrediction(horizon: number): void {
    const engine = this.engine;
    const session = this.session;
    const pending = this.pendingPrediction;
    if (!engine || !session || !pending) return;

    engine.reveal(horizon);

    const result = evaluatePrediction(
      pending.choice,
      horizon,
      pending.index,
      session.bars,
      DEFAULT_PREDICTION_RULES,
    );
    this.predictions.push({
      id: `pred_${this.predictions.length + 1}`,
      time: pending.time,
      index: pending.index,
      choice: pending.choice,
      reasoning: pending.reasoning,
      horizon,
      startPrice: pending.startPrice,
      endIndex: result.endIndex,
      endPrice: result.endPrice,
      correct: result.correct,
      detail: result.detail,
    });
    this.pendingPrediction = null;
    this.blind = { ...this.blind, awaitingReveal: false };
    this.notify();
  }

  /* ----------------------------- scenarios ----------------------------- */

  classifyAllSessions(): void {
    const ds = this.repo.get(this.settings.instrument);
    if (!ds) return;
    this.classifying = true;
    this.notify();
    setTimeout(() => {
      const byScenario = new Map<ScenarioId, Array<{ meta: SessionMeta; score: number }>>();
      for (const s of SCENARIOS) byScenario.set(s.id, []);
      const list = this.settings.sessionType === "RTH" ? ds.index.rth : ds.index.eth;
      for (const meta of list) {
        const bars = sliceBarSeries(ds.series, meta.startIndex, meta.endIndex);
        const cls = classifySession(bars, OR_ANCHOR_TZ, this.settings.openingRangeMinutes);
        for (const match of cls.matches) {
          if (!match.matched) continue;
          byScenario.get(match.scenario)?.push({ meta, score: match.score });
        }
      }
      this.scenarioMatches = SCENARIOS.map((s) => ({
        scenario: s.id,
        sessions: (byScenario.get(s.id) ?? []).sort((a, b) => b.score - a.score).slice(0, 12),
      }));
      this.classifying = false;
      this.notify();
    }, 0);
  }

  /* ------------------------------ journal ------------------------------ */

  updateTradeNotes(tradeId: string, notes: Partial<JournalNotes>): void {
    const trade = this.sim?.closedTrades.find((t) => t.id === tradeId);
    if (!trade) return;
    trade.notes = { ...trade.notes, ...notes };
    this.notesByKey.set(tradeKey(trade), { ...trade.notes });
    this.notify();
  }

  /** Re-run the current session from the start with a clean account. */
  resetSession(): void {
    if (!this.session) return;
    const meta = this.session.meta;
    this.engine?.dispose();
    this.actions = [];
    this.predictions = [];
    this.pendingPrediction = null;
    this.settled = false;
    this.lastIndex = 0;
    this.blind = { active: false, startIndex: 0, awaitingReveal: false };
    this.engine = new ReplayEngine(meta, this.session.bars, 0);
    this.engine.subscribe((ev) => this.onReplayEvent(ev));
    this.sim = new ExecutionSimulator(this.execConfig(), this.execCtx());
    this.sim.onBar(barAt(this.session.bars, 0), 0);
    this.notify();
  }

  get defaultExecutionConfig(): Omit<ExecutionConfig, "contract"> {
    return DEFAULT_EXECUTION_CONFIG;
  }
}

export const controller = new TapeLabController();
