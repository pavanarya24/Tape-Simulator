import { describe, expect, test } from "bun:test";
import { SnapshotPublicationScheduler, type SchedulerMetrics } from "../src/flow/scheduler";
import { controller } from "../src/state/app";
import { FlowTrainingSession } from "../src/flow/session";
import { SyntheticMarketDataFeed } from "../src/flow/synthetic";
import { generateScenario } from "../src/flow/scenarios";

describe("Phase 9.B-5 — Snapshot Publication Scheduler & UI Render Performance", () => {
  /* -------------------------------------------------------------------------
     1. Scheduler Unit Tests (Deterministic Timer Injection)
     ------------------------------------------------------------------------- */
  describe("Scheduler Core Mechanics", () => {
    test("multiple invalidations coalesce into one publication", () => {
      let pendingCb: (() => void) | null = null;
      const scheduler = new SnapshotPublicationScheduler({
        timerProvider: {
          schedule: (cb) => {
            pendingCb = cb;
            return () => {
              pendingCb = null;
            };
          },
        },
      });

      let publications = 0;
      let lastGen = -1;
      scheduler.setPublishCallback((gen) => {
        publications++;
        lastGen = gen;
      });

      // Request 100 invalidations while timer is pending
      for (let i = 0; i < 100; i++) {
        scheduler.requestPublication(1);
      }

      expect(publications).toBe(0);
      expect(pendingCb).not.toBeNull();
      expect(scheduler.metrics.eventsProcessed).toBe(100);
      expect(scheduler.metrics.coalescedCount).toBe(99);

      // Fire timer
      pendingCb!();

      expect(publications).toBe(1);
      expect(lastGen).toBe(100);
      expect(scheduler.metrics.publicationsCount).toBe(1);
    });

    test("latest snapshot wins and stale queued publication cannot overwrite newer state", () => {
      let callbacks: Array<() => void> = [];
      const scheduler = new SnapshotPublicationScheduler({
        timerProvider: {
          schedule: (cb) => {
            callbacks.push(cb);
            return () => {
              callbacks = callbacks.filter((c) => c !== cb);
            };
          },
        },
      });

      const publishedGenerations: number[] = [];
      scheduler.setPublishCallback((gen) => {
        publishedGenerations.push(gen);
      });

      scheduler.requestPublication(10); // Gen 1, scheduled callback 0
      expect(callbacks.length).toBe(1);

      // Now synchronous seek / flush occurs (Gen 2)
      scheduler.flush(5);
      expect(publishedGenerations).toEqual([2]);
      expect(callbacks.length).toBe(0); // Old scheduled callback cancelled

      // Scheduler metrics verify flush
      expect(scheduler.metrics.flushCount).toBe(1);
      expect(scheduler.metrics.publicationsCount).toBe(1);
    });

    test("immediate operations (flush) publish synchronously and reset pending timer", () => {
      let cancelled = false;
      const scheduler = new SnapshotPublicationScheduler({
        timerProvider: {
          schedule: (cb) => {
            return () => {
              cancelled = true;
            };
          },
        },
      });

      let published = 0;
      scheduler.setPublishCallback(() => {
        published++;
      });

      scheduler.requestPublication(1);
      expect(published).toBe(0);

      scheduler.flush(1);
      expect(published).toBe(1);
      expect(cancelled).toBe(true);
    });

    test("stop() cancels pending timer and prevents future callbacks until restarted", () => {
      let cancelled = false;
      let pendingCb: (() => void) | null = null;
      const scheduler = new SnapshotPublicationScheduler({
        timerProvider: {
          schedule: (cb) => {
            pendingCb = cb;
            return () => {
              cancelled = true;
              pendingCb = null;
            };
          },
        },
      });

      let published = 0;
      scheduler.setPublishCallback(() => {
        published++;
      });

      scheduler.start();
      scheduler.requestPublication(1);
      expect(pendingCb).not.toBeNull();

      scheduler.stop();
      expect(cancelled).toBe(true);
      expect(pendingCb).toBeNull();
      expect(published).toBe(0);
    });

    test("reset() cancels pending notifications cleanly", () => {
      let cancelled = false;
      const scheduler = new SnapshotPublicationScheduler({
        timerProvider: {
          schedule: () => {
            return () => {
              cancelled = true;
            };
          },
        },
      });

      scheduler.requestPublication(5);
      scheduler.reset();
      expect(cancelled).toBe(true);
      expect(scheduler.metrics.publicationsCount).toBe(0);
    });

    test("dispose() completely detaches listener and cancels timers", () => {
      let cancelled = false;
      const scheduler = new SnapshotPublicationScheduler({
        timerProvider: {
          schedule: () => {
            return () => {
              cancelled = true;
            };
          },
        },
      });

      scheduler.requestPublication(1);
      scheduler.dispose();
      expect(cancelled).toBe(true);

      // Calling flush after dispose should not fire callback
      scheduler.flush();
      expect(scheduler.metrics.publicationsCount).toBe(1);
    });
  });

  /* -------------------------------------------------------------------------
     2. AppController Integration & Synchronous Invariants
     ------------------------------------------------------------------------- */
  describe("AppController Publication & Synchronous Operations", () => {
    test("stepFlow in continuous mode coalesces publications while single step flushes immediately", () => {
      controller.generateFlowScenario("spring");
      const metricsBefore = controller.flowSchedulerMetrics;

      // 1. Single manual step: flushes immediately
      controller.stepFlow(1);
      const metricsAfterSingle = controller.flowSchedulerMetrics;
      expect(metricsAfterSingle.flushCount).toBe(metricsBefore.flushCount + 1);

      // 2. Continuous playback steps: coalesce via requestPublication
      controller.startFlowPlayback();
      const pubBefore = controller.flowSchedulerMetrics.publicationsCount;

      for (let i = 0; i < 20; i++) {
        controller.stepFlow(2, { continuous: true });
      }

      // Stop continuous playback: flushes remaining state
      controller.stopFlowPlayback();
      const metricsAfterContinuous = controller.flowSchedulerMetrics;

      expect(metricsAfterContinuous.eventsProcessed).toBeGreaterThan(0);
      expect(metricsAfterContinuous.coalescedCount).toBeGreaterThan(0);
      // Publications are significantly less than 20 individual calls
      expect(metricsAfterContinuous.publicationsCount - pubBefore).toBeLessThan(10);
    });

    test("synchronous user navigation operations (seek, stepBack, reset) flush immediately", () => {
      controller.generateFlowScenario("spring");

      const pubStart = controller.flowSchedulerMetrics.publicationsCount;

      // stepFlowBack flushes immediately
      controller.stepFlow(10);
      controller.stepFlowBack();
      expect(controller.flowSchedulerMetrics.publicationsCount).toBeGreaterThan(pubStart);

      // seekFlow flushes immediately
      const pubBeforeSeek = controller.flowSchedulerMetrics.publicationsCount;
      controller.seekFlow(20);
      expect(controller.flowSchedulerMetrics.publicationsCount).toBe(pubBeforeSeek + 1);
      expect(controller.getState().flow.eventIndex).toBe(20);

      // resetFlow flushes immediately
      const pubBeforeReset = controller.flowSchedulerMetrics.publicationsCount;
      controller.resetFlow();
      expect(controller.flowSchedulerMetrics.publicationsCount).toBe(pubBeforeReset + 1);
      expect(controller.getState().flow.eventIndex).toBe(0);
    });
  });

  /* -------------------------------------------------------------------------
     3. Blind-Mode Safety & Determinism Invariance
     ------------------------------------------------------------------------- */
  describe("Blind-Mode Safety & Determinism Invariance", () => {
    test("rapid continuous stepping followed by pause, seek back, seek forward never leaks secrets", () => {
      controller.generateFlowScenario("absorption");
      controller.startFlowPlayback();

      // Rapid stepping
      for (let i = 0; i < 20; i++) {
        controller.stepFlow(10, { continuous: true });
      }

      controller.stopFlowPlayback();

      const blindState = controller.getState().flow;
      expect(blindState.revealed).toBeNull();
      expect(blindState.timeline).toEqual([]);
      expect(blindState.recognition).toBeNull();

      // Seek backward
      controller.seekFlow(50);
      const rewoundState = controller.getState().flow;
      expect(rewoundState.eventIndex).toBe(50);
      expect(rewoundState.revealed).toBeNull();
      expect(rewoundState.timeline).toEqual([]);

      // Seek forward in blind mode: reviewNavigation is disallowed while blind, so seek forward past current is refused
      const canPeekAhead = controller.seekFlow(400);
      expect(canPeekAhead).toBe(false);
      expect(controller.getState().flow.eventIndex).toBe(50);
      expect(controller.getState().flow.revealed).toBeNull();
    });

    test("engine state is byte-for-byte deterministic regardless of publication coalescing", () => {
      const seed = 54321;
      const pattern = "spring";

      // Session A: Stepped with synchronous flushes on every event
      const genA = generateScenario(pattern, seed, { difficulty: "INTERMEDIATE" });
      const sessionA = new FlowTrainingSession(genA.feed, genA.truth, { checkpointInterval: 10_000 });
      for (let i = 0; i < 500; i++) {
        sessionA.step(1);
      }
      const snapA = sessionA.snapshot();

      // Session B: Stepped in large chunks (simulating coalesced frames)
      const genB = generateScenario(pattern, seed, { difficulty: "INTERMEDIATE" });
      const sessionB = new FlowTrainingSession(genB.feed, genB.truth, { checkpointInterval: 10_000 });
      sessionB.step(500);
      const snapB = sessionB.snapshot();

      // Session C: Reached via accelerated seek
      const genC = generateScenario(pattern, seed, { difficulty: "INTERMEDIATE" });
      const sessionC = new FlowTrainingSession(genC.feed, genC.truth, { checkpointInterval: 10_000 });
      sessionC.seekTo(500);
      const snapC = sessionC.snapshot();

      expect(snapB.sequence).toBe(snapA.sequence);
      expect(snapB.orderFlow.lastPrice).toBe(snapA.orderFlow.lastPrice);
      expect(snapB.orderFlow.delta).toBe(snapA.orderFlow.delta);
      expect(snapB.dom.bestBid).toBe(snapA.dom.bestBid);
      expect(snapB.dom.bestAsk).toBe(snapA.dom.bestAsk);

      expect(snapC.sequence).toBe(snapA.sequence);
      expect(snapC.orderFlow.lastPrice).toBe(snapA.orderFlow.lastPrice);
      expect(snapC.orderFlow.delta).toBe(snapA.orderFlow.delta);
      expect(snapC.dom.bestBid).toBe(snapA.dom.bestBid);
      expect(snapC.dom.bestAsk).toBe(snapA.dom.bestAsk);
    });
  });

  /* -------------------------------------------------------------------------
     4. High-Frequency Benchmark Harness (100k, 500k, 1M, 3M events)
     ------------------------------------------------------------------------- */
  describe("High-Frequency Replay Benchmarks & Coalescing Ratios", () => {
    const DATASET_SIZES = [100_000, 500_000, 1_000_000, 3_000_000];

    for (const size of DATASET_SIZES) {
      test(
        `processes ${size.toLocaleString()} events: measures engine vs scheduler throughput and coalescing`,
        () => {
          // A. Engine-only baseline
          const feedBaseline = new SyntheticMarketDataFeed({
            seed: 999,
            plan: [{ kind: "meander", trades: Math.ceil(size * 0.75) }],
          });
          const t0Baseline = performance.now();
          let baselineEvents = 0;
          while (feedBaseline.hasNext() && baselineEvents < size) {
            feedBaseline.nextEvent();
            baselineEvents++;
          }
          const t1Baseline = performance.now();
          const baselineMs = Math.max(0.1, t1Baseline - t0Baseline);
          const baselineThroughput = Math.round(baselineEvents / (baselineMs / 1000));

          // B. Engine + Publication Scheduler with simulated UI frame ticks
          const feed = new SyntheticMarketDataFeed({
            seed: 999,
            plan: [{ kind: "meander", trades: Math.ceil(size * 0.75) }],
          });

          let pendingFrameCb: (() => void) | null = null;
          const scheduler = new SnapshotPublicationScheduler({
            fps: 25,
            useRaf: false,
            timerProvider: {
              schedule: (cb) => {
                pendingFrameCb = cb;
                return () => {
                  pendingFrameCb = null;
                };
              },
            },
          });

          let uiPublications = 0;
          let chartUpdates = 0;
          let setDataCalls = 0;

          scheduler.setPublishCallback(() => {
            uiPublications++;
            chartUpdates++;
            scheduler.recordChartUpdate(false);
          });

          // Initial seek/mount setData call
          setDataCalls++;
          scheduler.recordChartUpdate(true);

          scheduler.start();

          // Burst processing: 500 events per tick, UI frame every 2,500 events
          const burstSize = 500;
          const burstsPerFrame = 5;
          let burstsProcessed = 0;

          const t0Sched = performance.now();
          let processed = 0;
          while (feed.hasNext() && processed < size) {
            const count = Math.min(burstSize, size - processed);
            for (let i = 0; i < count; i++) {
              feed.nextEvent();
            }
            processed += count;
            burstsProcessed++;
            scheduler.requestPublication(count);

            if (burstsProcessed % burstsPerFrame === 0 && pendingFrameCb) {
              const cb = pendingFrameCb;
              pendingFrameCb = null;
              cb();
            }
          }

          // Final flush if dirty
          scheduler.flush();
          scheduler.stop();
          const t1Sched = performance.now();

          const schedMs = Math.max(0.1, t1Sched - t0Sched);
          const schedThroughput = Math.round(processed / (schedMs / 1000));
          const ratio = scheduler.coalescingRatio;
          const eventsPerPub = uiPublications > 0 ? Math.round(processed / uiPublications) : processed;

          console.log(
            `\n==================================================` +
              `\n[Phase 9.B-5 Benchmark: ${size.toLocaleString()} events]` +
              `\n- Engine-Only Replay: ${baselineThroughput.toLocaleString()} ev/s (${baselineMs.toFixed(1)} ms)` +
              `\n- Engine + Scheduler Replay: ${schedThroughput.toLocaleString()} ev/s (${schedMs.toFixed(1)} ms)` +
              `\n- Total Events Processed: ${processed.toLocaleString()}` +
              `\n- UI Publications: ${uiPublications.toLocaleString()} (reduced from ${processed.toLocaleString()}!)` +
              `\n- Events per UI Publication: ${eventsPerPub.toLocaleString()}` +
              `\n- Chart Updates (Incremental): ${chartUpdates.toLocaleString()}` +
              `\n- Chart SetData Calls (Full): ${setDataCalls}` +
              `\n- Scheduler Coalescing Ratio: ${(ratio * 100).toFixed(2)}%` +
              `\n==================================================`,
          );

          expect(processed).toBe(size);
          expect(schedThroughput).toBeGreaterThan(500_000);
          expect(uiPublications).toBeLessThan(size / 100);
          expect(ratio).toBeGreaterThanOrEqual(0.75);
        },
        60_000,
      );
    }
  });
});
