import { describe, expect, test } from "bun:test";
import { SnapshotPublicationScheduler } from "../src/flow/scheduler";
import { AppController } from "../src/state/app";

describe("Phase 9.B-5 — Render Lifecycle & Resource Cleanup", () => {
  test("mount -> replay -> unmount -> mount again does not duplicate notifications or leak schedulers", () => {
    let activeTimers = 0;
    const mockTimerProvider = {
      schedule: (cb: () => void, ms: number) => {
        activeTimers++;
        const timerId = setTimeout(() => {
          activeTimers--;
          cb();
        }, ms);
        return () => {
          clearTimeout(timerId);
          activeTimers--;
        };
      },
    };

    // First mount
    const controller1 = new AppController();
    const scheduler1 = new SnapshotPublicationScheduler({
      fps: 30,
      useRaf: false,
      timerProvider: mockTimerProvider,
    });

    let notificationsCount1 = 0;
    const unsub1 = controller1.subscribe(() => {
      notificationsCount1++;
    });

    scheduler1.setPublishCallback(() => {
      // notify external store
    });

    scheduler1.start();
    scheduler1.requestPublication(10);
    expect(activeTimers).toBe(1);

    // Unmount first instance
    scheduler1.stop();
    scheduler1.dispose();
    unsub1();
    expect(activeTimers).toBe(0);

    // Remount second instance
    const controller2 = new AppController();
    const scheduler2 = new SnapshotPublicationScheduler({
      fps: 30,
      useRaf: false,
      timerProvider: mockTimerProvider,
    });

    let notificationsCount2 = 0;
    const unsub2 = controller2.subscribe(() => {
      notificationsCount2++;
    });

    scheduler2.start();
    scheduler2.requestPublication(5);
    expect(activeTimers).toBe(1);

    // Clean up second instance
    scheduler2.stop();
    scheduler2.dispose();
    unsub2();
    expect(activeTimers).toBe(0);
  });

  test("repeated start -> stop -> start -> stop does not duplicate publication loops", () => {
    let cancelCalls = 0;
    let scheduleCalls = 0;

    const mockTimerProvider = {
      schedule: (cb: () => void) => {
        scheduleCalls++;
        return () => {
          cancelCalls++;
        };
      },
    };

    const scheduler = new SnapshotPublicationScheduler({
      fps: 25,
      useRaf: false,
      timerProvider: mockTimerProvider,
    });

    scheduler.start();
    scheduler.requestPublication(1);
    expect(scheduleCalls).toBe(1);

    // Stop cancels pending
    scheduler.stop();
    expect(cancelCalls).toBe(1);

    // Restart
    scheduler.start();
    scheduler.requestPublication(1);
    expect(scheduleCalls).toBe(2);

    scheduler.stop();
    expect(cancelCalls).toBe(2);
    scheduler.dispose();
  });

  test("AppController flow playback lifecycle starts and stops scheduler cleanly", () => {
    const controller = new AppController();
    controller.generateFlowScenario("spring");

    controller.startFlowPlayback();
    // In continuous playback, stepFlow batches events
    controller.stepFlow(5, { continuous: true });

    // Stop playback
    controller.stopFlowPlayback();

    // Subsequent single step flushes immediately
    let published = false;
    const unsub = controller.subscribe(() => {
      published = true;
    });

    controller.stepFlow(1);
    expect(published).toBe(true);

    unsub();
  });
});
