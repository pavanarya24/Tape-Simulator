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
import {
  computeIndicators,
  normalizeEmaLengths,
  MAX_EMA_COUNT,
  type IndicatorSeries,
} from "../indicators/indicators";
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
import {
  DEFAULT_EMA_COLORS,
  DEFAULT_EMA_LENGTHS,
  DEFAULT_SETTINGS,
  DEFAULT_VWAP_COLOR,
  EMA_PALETTE,
  loadSettings,
  saveSettings,
  type Settings,
} from "./settings";
import type { DOMSnapshot, Level } from "../flow/dom";
import type { OrderFlowSnapshot } from "../flow/orderFlow";
import {
  generateScenario,
  pickScenarioId,
  type FlowDifficulty,
  type FlowScenarioId,
  type ScenarioTruth,
} from "../flow/scenarios";
import type {
  FlowAnnotation,
  FlowEvidence,
  FlowRecognition,
  FlowTimelineEntry,
} from "../flow/recognition";
import { FlowTrainingSession, type FlowNotice } from "../flow/session";
import {
  DEFAULT_FLOW_COSTS,
  DEFAULT_FLOW_DECISION,
  DEFAULT_FLOW_RISK,
  type FlowCosts,
  type FlowDecision,
  type FlowPosition,
  type FlowRisk,
} from "../flow/execution";
import type { FlowTradeView } from "../flow/journal";
import {
  computeFlowTrainingStats,
  type FlowSessionResults,
  type FlowTrainingStats,
} from "../flow/scoring";

/** Opening ranges are defined against the 09:30 America/New_York cash open. */
const OR_ANCHOR_TZ = "America/New_York";

export type Page = "terminal" | "blind" | "flow" | "scenarios" | "data" | "journal" | "score";

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

/**
 * Blind-safe order-flow training state.
 *
 * Contains everything the trader may see (tape, CVD, profile, DOM, stats) and
 * the feed's honest source label. `revealed` stays NULL until the user clicks
 * "Reveal what it was" — before that, no pattern name, ScenarioTruth,
 * confidence or scenario id ever enters UI state.
 */
export interface FlowState {
  active: boolean;
  source: string;
  isRealData: boolean;
  eventIndex: number;
  totalEvents: number;
  atEnd: boolean;
  orderFlow: OrderFlowSnapshot | null;
  dom: DOMSnapshot | null;
  book: { bids: Level[]; asks: Level[] } | null;
  priceSeries: Array<{ t: number; price: number }>;
  /** Null until the reveal button is pressed — the ONLY exposure mechanism. */
  revealed: ScenarioTruth | null;
  /** Post-reveal hold: results are on screen until Continue/Restart. */
  held: boolean;
  /* --- Phase 7A simulated trading (no truth ever enters these fields) --- */
  orderQty: number;
  position: FlowPosition;
  decision: FlowDecision;
  costs: FlowCosts;
  risk: FlowRisk;
  notice: FlowNotice | null;
  /** Trade history; hiddenPattern is null in every record until reveal. */
  trades: FlowTradeView[];
  /** Post-reveal ONLY — null before reveal (blind-mode guarantee). */
  results: FlowSessionResults | null;
  /* --- Phase 7B recognition & training intelligence --- */
  /** Scenario difficulty used by the generator (never encodes the pattern). */
  difficulty: FlowDifficulty;
  /** Objective observations — safe to show while blind (spec §5/§6). */
  evidence: FlowEvidence[];
  /** Objective chart markers mapped by timestamp/sequence (spec §9). */
  annotations: FlowAnnotation[];
  /** Evidence timeline — empty until reveal (spec §8). */
  timeline: FlowTimelineEntry[];
  /** ENGINE'S CLASSIFICATION — null until reveal (blind rule §14). */
  recognition: FlowRecognition | null;
  /** Raw cross-scenario training metrics — null until the first reveal. */
  trainingStats: FlowTrainingStats | null;
}

const FLOW_IDLE_POSITION: FlowPosition = {
  side: "FLAT",
  quantity: 0,
  averageEntryPrice: null,
  currentPrice: null,
  realizedPnL: 0,
  unrealizedPnL: 0,
  totalPnL: 0,
  entryTimestamp: null,
  exitTimestamp: null,
  maxFavorableExcursion: 0,
  maxAdverseExcursion: 0,
  costsAccrued: 0,
};

const FLOW_IDLE: FlowState = {
  active: false,
  source: "Synthetic Training Data",
  isRealData: false,
  eventIndex: 0,
  totalEvents: 0,
  atEnd: true,
  orderFlow: null,
  dom: null,
  book: null,
  priceSeries: [],
  revealed: null,
  held: false,
  orderQty: 1,
  position: FLOW_IDLE_POSITION,
  decision: { ...DEFAULT_FLOW_DECISION },
  costs: { ...DEFAULT_FLOW_COSTS },
  risk: { ...DEFAULT_FLOW_RISK },
  notice: null,
  trades: [],
  results: null,
  difficulty: "INTERMEDIATE",
  evidence: [],
  annotations: [],
  timeline: [],
  recognition: null,
  trainingStats: null,
};

/** Events auto-revealed when a scenario is generated, so the tape has context. */
const FLOW_WARMUP = 60;

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
  flow: FlowState;
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

  private flowSession: FlowTrainingSession | null = null;
  private flowTruth: ScenarioTruth | null = null;
  private flowRevealed = false;
  private flowHeld = false;
  /** Simulated cost/risk settings persist across scenario generations. */
  private flowCosts: FlowCosts = { ...DEFAULT_FLOW_COSTS };
  private flowRisk: FlowRisk = { ...DEFAULT_FLOW_RISK };
  /** Monotonic scenario-instance counter — journal ids carry NO seed/pattern. */
  private flowScenarioSeq = 0;
  /** Difficulty handed to the generator — affects structure, not labels. */
  private flowDifficulty: FlowDifficulty = "INTERMEDIATE";
  /** Every revealed scenario's results — the raw material for training stats. */
  private flowHistory: FlowSessionResults[] = [];
  private flowStats: FlowTrainingStats | null = null;

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
      flow: this.flowState(),
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
      this.settings.indicators.emaLengths,
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

  /** The only overlay toggles left: everything else is a length or a colour. */
  toggleIndicator(key: "vwap" | "openingRange"): void {
    this.updateSettings({
      indicators: { ...this.settings.indicators, [key]: !this.settings.indicators[key] },
    });
  }

  setOpeningRange(minutes: number): void {
    this.settings = { ...this.settings, openingRangeMinutes: minutes };
    this.persist();
    if (this.session) {
      this.indicators = computeIndicators(
        this.session.bars,
        minutes,
        OR_ANCHOR_TZ,
        this.settings.indicators.emaLengths,
      );
      this.currentClassification = classifySession(this.session.bars, OR_ANCHOR_TZ, minutes);
    }
    this.notify();
  }

  /* ------------------------------ overlays ------------------------------ */

  /**
   * Replace the user's EMA length list. Lengths are rounded, bounds-checked,
   * de-duplicated and sorted; the list is capped at `MAX_EMA_COUNT`. Newly
   * added periods get the next colour from the palette so they are always
   * distinguishable on the chart.
   */
  setEmaLengths(lengths: readonly number[]): void {
    const clean = normalizeEmaLengths(lengths).slice(0, MAX_EMA_COUNT);
    const emaColors = { ...this.settings.indicators.emaColors };
    clean.forEach((len, i) => {
      if (!emaColors[String(len)]) emaColors[String(len)] = EMA_PALETTE[i % EMA_PALETTE.length];
    });
    this.settings = {
      ...this.settings,
      indicators: { ...this.settings.indicators, emaLengths: clean, emaColors },
    };
    this.persist();
    this.recomputeIndicators();
    this.notify();
  }

  /** Colour for one EMA period (persisted). */
  setEmaColor(length: number, color: string): void {
    this.updateSettings({
      indicators: {
        ...this.settings.indicators,
        emaColors: { ...this.settings.indicators.emaColors, [String(length)]: color },
      },
    });
  }

  setVwapColor(color: string): void {
    this.updateSettings({
      indicators: { ...this.settings.indicators, vwapColor: color },
    });
  }

  /** Restore the stock overlay configuration (EMA 21 only, default colours). */
  resetOverlayDefaults(): void {
    this.settings = {
      ...this.settings,
      indicators: {
        ...DEFAULT_SETTINGS.indicators,
        emaLengths: [...DEFAULT_EMA_LENGTHS],
        emaColors: { ...DEFAULT_EMA_COLORS },
        vwapColor: DEFAULT_VWAP_COLOR,
      },
    };
    this.persist();
    this.recomputeIndicators();
    this.notify();
  }

  private recomputeIndicators(): void {
    if (!this.session) return;
    this.indicators = computeIndicators(
      this.session.bars,
      this.settings.openingRangeMinutes,
      OR_ANCHOR_TZ,
      this.settings.indicators.emaLengths,
    );
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

  /* ------------------------- order-flow training ------------------------- */

  private flowState(): FlowState {
    const session = this.flowSession;
    if (!session) return FLOW_IDLE;
    const snap = session.snapshot();
    return {
      active: true,
      source: snap.source,
      isRealData: snap.isRealData,
      eventIndex: snap.eventIndex,
      totalEvents: snap.totalEvents,
      atEnd: snap.atEnd,
      orderFlow: snap.orderFlow,
      dom: snap.dom,
      book: snap.book,
      priceSeries: snap.priceSeries,
      revealed: this.flowRevealed ? this.flowTruth : null,
      held: this.flowHeld,
      orderQty: snap.orderQty,
      position: snap.position,
      decision: snap.decision,
      costs: snap.costs,
      risk: snap.risk,
      notice: snap.notice,
      trades: snap.trades,
      // Double-gated: scoring only runs after reveal AND inside the session.
      results: this.flowRevealed ? session.results() : null,
      difficulty: this.flowDifficulty,
      evidence: snap.evidence,
      annotations: snap.annotations,
      timeline: snap.timeline,
      recognition: snap.recognition,
      // Training stats reference past reveals (incl. confidence) — while
      // blind on a fresh scenario they stay out of trader-facing state.
      trainingStats: this.flowRevealed ? this.flowStats : null,
    };
  }

  /**
   * Generate a fresh deterministic order-flow scenario. `"any"` picks a random
   * pattern; a specific id generates exactly that pattern. The seed is drawn
   * from wall-clock entropy, but once generated the session is fully
   * deterministic (same id + seed ⇒ identical events and truth).
   */
  generateFlowScenario(pattern: FlowScenarioId | "any"): void {
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const id = pattern === "any" ? pickScenarioId(seed ^ 0x51ed270b) : pattern;
    const generated = generateScenario(id, seed, { difficulty: this.flowDifficulty });
    this.flowScenarioSeq++;
    this.flowSession = new FlowTrainingSession(generated.feed, generated.truth, {
      // Neutral instance id: never derived from the seed, so pre-reveal state
      // exposes no generator metadata (spec §11).
      sessionId: `flow-${this.flowScenarioSeq}`,
      costs: this.flowCosts,
      risk: this.flowRisk,
      contract: CONTRACTS.NQ,
    });
    this.flowTruth = generated.truth;
    this.flowRevealed = false;
    this.flowHeld = false;
    this.flowSession.warmup(FLOW_WARMUP);
    this.notify();
  }

  /** Advance the flow session; returns false when nothing was revealed
   *  (or while the post-reveal hold is active). */
  stepFlow(n = 1): boolean {
    const session = this.flowSession;
    if (!session) return false;
    if (this.flowRevealed && this.flowHeld) return false;
    const taken = session.step(n);
    this.notify();
    return taken > 0;
  }

  stepFlowBack(): void {
    const session = this.flowSession;
    if (!session) return;
    if (this.flowRevealed && this.flowHeld) return;
    session.stepBack();
    this.notify();
  }

  /** ⟲ RESET — rewind the tape to event 0 and clear all trading state. */
  resetFlow(): void {
    const session = this.flowSession;
    if (!session) return;
    session.reset();
    this.flowHeld = false;
    this.notify();
  }

  /** "Reveal what it was" — the only mechanism that exposes the truth to UI.
   *  Revealing holds the session: step/stepBack/trading pause until
   *  continueFlowAfterReveal() or restartFlowScenario(). */
  revealFlow(): void {
    const session = this.flowSession;
    if (!session) return;
    const firstReveal = !this.flowRevealed;
    this.flowRevealed = true;
    this.flowHeld = true;
    session.markRevealed();
    // Record this scenario's result once — training stats accumulate across
    // the whole training run from these raw results.
    if (firstReveal) {
      const results = session.results();
      if (results) {
        this.flowHistory = [...this.flowHistory, results];
        this.flowStats = computeFlowTrainingStats(this.flowHistory);
      }
    }
    this.notify();
  }

  /** Difficulty selector — passed to the generator on the next GENERATE. */
  setFlowDifficulty(difficulty: FlowDifficulty): void {
    this.flowDifficulty = difficulty;
    this.notify();
  }

  /** CONTINUE AFTER REVEAL — release the hold and keep trading the tape. */
  continueFlowAfterReveal(): boolean {
    if (!this.flowRevealed) return false;
    this.flowHeld = false;
    this.notify();
    return true;
  }

  /** RESTART SCENARIO — same seed/scenario (never regenerated), identical
   *  events, clean position and journal. Decision and reveal are kept. */
  restartFlowScenario(): void {
    const session = this.flowSession;
    if (!session) return;
    session.restart(FLOW_WARMUP);
    this.flowHeld = false;
    this.notify();
  }

  /** REPLAY FROM START — rewind the tape to the first event, keeping journal,
   *  decision and reveal. Refused while a position is open. */
  replayFlowFromStart(): boolean {
    const session = this.flowSession;
    if (!session) return false;
    const ok = session.replayFromStart();
    this.notify();
    return ok;
  }

  /* ------------------------- flow trading (Phase 7A) ------------------------- */

  /** MARKET BUY with the current order quantity, at the revealed ask. */
  flowBuy(): void {
    const session = this.flowSession;
    if (!session) return;
    if (this.flowRevealed && this.flowHeld) {
      session.setNotice(false, "SESSION PAUSED AFTER REVEAL — CONTINUE OR RESTART");
    } else {
      session.buy();
    }
    this.notify();
  }

  /** MARKET SELL with the current order quantity, at the revealed bid. */
  flowSell(): void {
    const session = this.flowSession;
    if (!session) return;
    if (this.flowRevealed && this.flowHeld) {
      session.setNotice(false, "SESSION PAUSED AFTER REVEAL — CONTINUE OR RESTART");
    } else {
      session.sell();
    }
    this.notify();
  }

  /** FLATTEN — close the whole position (LONG at bid, SHORT at ask). */
  flowFlatten(): void {
    const session = this.flowSession;
    if (!session) return;
    if (this.flowRevealed && this.flowHeld) {
      session.setNotice(false, "SESSION PAUSED AFTER REVEAL — CONTINUE OR RESTART");
    } else {
      session.flatten();
    }
    this.notify();
  }

  setFlowQty(qty: number): void {
    const session = this.flowSession;
    if (!session) return;
    session.setOrderQty(qty);
    this.notify();
  }

  setFlowDecision(patch: Partial<FlowDecision>): void {
    const session = this.flowSession;
    if (!session) return;
    session.setDecision(patch);
    this.notify();
  }

  setFlowCosts(patch: Partial<FlowCosts>): void {
    const session = this.flowSession;
    if (!session) return;
    session.setCosts(patch);
    this.flowCosts = { ...this.flowCosts, ...patch };
    this.notify();
  }

  setFlowRisk(patch: Partial<FlowRisk>): void {
    const session = this.flowSession;
    if (!session) return;
    session.setRisk(patch);
    this.flowRisk = { ...this.flowRisk, ...patch };
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
