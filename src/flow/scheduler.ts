/**
 * Phase 9-B.5 — Snapshot Publication Scheduler
 *
 * Decouples the high-frequency market replay engine clock from the UI publication
 * and React rendering pipeline. Coalesces rapid batches of engine events into
 * 15–30 Hz or requestAnimationFrame publication frames, while maintaining strict
 * immediate synchronicity for user navigation (seek, stepBack, reset).
 *
 * Invariants:
 * - Engine processing is NEVER throttled or mutated.
 * - Observable session state is NEVER altered by scheduling.
 * - Stale queued frames can NEVER overwrite newer state (generation token guard).
 * - Synchronous operations (seek, stepBack, reset) flush immediately.
 * - Testable in headless Bun/Node environments without wall-clock dependencies.
 */

export interface SchedulerOptions {
  /** Target publication frequency in Hz (default 25 Hz = 40ms interval). */
  fps?: number;
  /** Whether to prefer requestAnimationFrame when available (default true in browser). */
  useRaf?: boolean;
  /** Custom scheduler provider for deterministic testing. */
  timerProvider?: {
    schedule: (cb: () => void, delayMs: number) => () => void;
  };
}

export interface SchedulerMetrics {
  /** Total high-frequency engine events processed. */
  eventsProcessed: number;
  /** Total scheduler invalidation requests (requestPublication + flush). */
  invalidationsCount: number;
  /** Invalidation requests coalesced into already-scheduled pending frames. */
  coalescedInvalidationsCount: number;
  /** Total publications dispatched to subscribers. */
  publicationsCount: number;
  /** Events that were coalesced within pending publication windows. */
  coalescedCount: number;
  /** Immediate synchronous flush operations executed. */
  flushCount: number;
  /** Chart updates performed (incremental or full). */
  chartUpdatesCount: number;
  /** Full chart setData() calls performed. */
  chartSetDataCount: number;
}

export class SnapshotPublicationScheduler {
  private readonly intervalMs: number;
  private readonly useRaf: boolean;
  private readonly timerProvider?: SchedulerOptions["timerProvider"];

  private onPublish: ((generation: number) => void) | null = null;
  private pendingCancel: (() => void) | null = null;
  private isRunning = false;
  private currentGeneration = 0;
  private activePendingGeneration = 0;

  private _metrics: SchedulerMetrics = {
    eventsProcessed: 0,
    invalidationsCount: 0,
    coalescedInvalidationsCount: 0,
    publicationsCount: 0,
    coalescedCount: 0,
    flushCount: 0,
    chartUpdatesCount: 0,
    chartSetDataCount: 0,
  };

  constructor(opts: SchedulerOptions = {}) {
    const fps = opts.fps ?? 25;
    this.intervalMs = Math.max(1, Math.round(1000 / fps));
    const isBrowser = typeof window !== "undefined" && typeof requestAnimationFrame === "function";
    this.useRaf = opts.useRaf ?? isBrowser;
    this.timerProvider = opts.timerProvider;
  }

  get running(): boolean {
    return this.isRunning;
  }

  setPublishCallback(cb: (generation: number) => void): void {
    this.onPublish = cb;
  }

  get metrics(): Readonly<SchedulerMetrics> {
    return { ...this._metrics };
  }

  get coalescingRatio(): number {
    return this._metrics.eventsProcessed > 0
      ? this._metrics.coalescedCount / this._metrics.eventsProcessed
      : 0;
  }

  /**
   * Actual reduction percentage in UI publications compared to engine events:
   * (1 - publicationsCount / eventsProcessed) * 100%
   */
  get reductionPercentage(): number {
    return this._metrics.eventsProcessed > 0
      ? (1 - this._metrics.publicationsCount / this._metrics.eventsProcessed) * 100
      : 0;
  }

  resetMetrics(): void {
    this._metrics = {
      eventsProcessed: 0,
      invalidationsCount: 0,
      coalescedInvalidationsCount: 0,
      publicationsCount: 0,
      coalescedCount: 0,
      flushCount: 0,
      chartUpdatesCount: 0,
      chartSetDataCount: 0,
    };
  }

  recordChartUpdate(isFullSetData = false): void {
    this._metrics.chartUpdatesCount++;
    if (isFullSetData) {
      this._metrics.chartSetDataCount++;
    }
  }

  /**
   * Request a throttled publication frame.
   * Multiple calls before the timer fires are coalesced into a single publication.
   */
  requestPublication(eventCount = 1): void {
    this._metrics.eventsProcessed += eventCount;
    this._metrics.invalidationsCount++;
    this.currentGeneration++;
    const targetGen = this.currentGeneration;

    if (this.pendingCancel !== null) {
      // Already scheduled: coalesce this event into the upcoming frame
      this._metrics.coalescedCount += eventCount;
      this._metrics.coalescedInvalidationsCount++;
      return;
    }

    this.activePendingGeneration = targetGen;
    this.scheduleFrame(() => {
      this.pendingCancel = null;
      // Stale token guard: ensure we only publish if this generation hasn't been superseded
      const latestGen = this.currentGeneration;
      if (latestGen >= this.activePendingGeneration) {
        this.executePublish(latestGen);
      }
    });
  }

  /**
   * Immediately publish the latest state synchronously.
   * Cancels any pending scheduled timer to prevent redundant or stale notifications.
   */
  flush(eventCount = 0): void {
    this.cancelScheduled();
    this._metrics.invalidationsCount++;
    if (eventCount > 0) {
      this._metrics.eventsProcessed += eventCount;
    }
    this.currentGeneration++;
    const gen = this.currentGeneration;
    this.activePendingGeneration = gen;
    this._metrics.flushCount++;
    this.executePublish(gen);
  }

  /** Start continuous publication mode (if continuous replay is active). */
  start(): void {
    this.isRunning = true;
  }

  /** Stop continuous playback; cancels any pending uncommitted frame. */
  stop(): void {
    this.isRunning = false;
    this.cancelScheduled();
  }

  /** Reset scheduler state and cancel pending notifications. */
  reset(): void {
    this.cancelScheduled();
    this.currentGeneration++;
    this.activePendingGeneration = this.currentGeneration;
  }

  /** Complete cleanup (e.g. on component unmount). */
  dispose(): void {
    this.stop();
    this.onPublish = null;
  }

  private scheduleFrame(callback: () => void): void {
    if (this.timerProvider) {
      this.pendingCancel = this.timerProvider.schedule(callback, this.intervalMs);
      return;
    }

    if (this.useRaf && typeof requestAnimationFrame === "function") {
      const handle = requestAnimationFrame(() => callback());
      this.pendingCancel = () => cancelAnimationFrame(handle);
      return;
    }

    const timer = setTimeout(callback, this.intervalMs);
    this.pendingCancel = () => clearTimeout(timer);
  }

  private cancelScheduled(): void {
    if (this.pendingCancel) {
      this.pendingCancel();
      this.pendingCancel = null;
    }
  }

  private executePublish(generation: number): void {
    this._metrics.publicationsCount++;
    if (this.onPublish) {
      this.onPublish(generation);
    }
  }
}
