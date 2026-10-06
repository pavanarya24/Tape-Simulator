/**
 * §1 Historical replay — blindness, start timestamp, transport, reset,
 * speed invariance and run-to-run determinism.
 */

import { describe, expect, test } from "bun:test";
import { ReplayEngine, REPLAY_SPEEDS } from "../src/replay/ReplayEngine";
import { ExecutionSimulator } from "../src/execution/ExecutionSimulator";
import { barAt } from "../src/data/types";
import type { BarSeries } from "../src/market/types";
import { cfg, CTX, metaFor, series, trend } from "./helpers";

const BAR_MS = 5 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 2, 14, 30); // 09:30 America/New_York

function fresh(bars: BarSeries, startIndex = 0) {
  const meta = metaFor(bars);
  const engine = new ReplayEngine(meta, bars, startIndex);
  return { engine, meta };
}

describe("replay engine — blind window", () => {
  const bars = trend(20_000, 78, BAR_MS, 2, T0);
  const meta = metaFor(bars);

  test("starts with exactly one revealed bar and no future leakage", () => {
    const engine = new ReplayEngine(meta, bars, 0);
    expect(engine.state.cursor).toBe(0);
    expect(engine.state.barsElapsed).toBe(1);
    expect(engine.state.barsRemaining).toBe(77);
    expect(engine.revealed().length).toBe(1);
    engine.dispose();
  });

  test("revealed() is a 0..cursor window at every cursor position", () => {
    const engine = new ReplayEngine(meta, bars, 0);
    for (let i = 0; i < bars.length; i++) {
      const r = engine.revealed();
      expect(engine.state.cursor).toBe(i);
      expect(r.length).toBe(i + 1);
      // every revealed value must equal the source bar it claims to be
      for (const j of [0, Math.floor(i / 2), i]) {
        expect(r.t[j]).toBe(bars.t[j]);
        expect(r.o[j]).toBe(bars.o[j]);
        expect(r.h[j]).toBe(bars.h[j]);
        expect(r.l[j]).toBe(bars.l[j]);
        expect(r.c[j]).toBe(bars.c[j]);
      }
      engine.stepForward();
    }
    engine.dispose();
  });

  test("stepping past the last bar cannot reveal a bar that does not exist", () => {
    const engine = new ReplayEngine(meta, bars, 0);
    for (let i = 0; i < 200; i++) engine.stepForward();
    expect(engine.state.cursor).toBe(77);
    expect(engine.state.atEnd).toBe(true);
    expect(engine.revealed().length).toBe(78);
    expect(engine.state.barsRemaining).toBe(0);
    engine.dispose();
  });

  test("replay starts at the session's first timestamp and reports live time", () => {
    const engine = new ReplayEngine(meta, bars, 0);
    expect(engine.state.replayTime).toBe(bars.t[0]);
    expect(engine.state.replayTime).toBe(meta.firstTime);
    engine.stepForward();
    expect(engine.state.replayTime).toBe(bars.t[1]);
    expect(engine.state.replayTime).toBe(meta.firstTime + BAR_MS);
    engine.dispose();
  });

  test("startIndex is clamped into range", () => {
    expect(new ReplayEngine(meta, bars, -5).state.cursor).toBe(0);
    expect(new ReplayEngine(meta, bars, 9_999).state.cursor).toBe(77);
  });
});

describe("replay engine — transport", () => {
  const bars = trend(20_000, 40, BAR_MS, 1, T0);
  const meta = metaFor(bars);

  test("play advances the cursor and pause freezes it", async () => {
    const engine = new ReplayEngine(meta, bars, 0);
    engine.setSpeed(100);
    engine.play();
    expect(engine.state.playing).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    const during = engine.state.cursor;
    expect(during).toBeGreaterThan(1);

    engine.pause();
    expect(engine.state.playing).toBe(false);
    const atPause = engine.state.cursor;
    await new Promise((r) => setTimeout(r, 80));
    expect(engine.state.cursor).toBe(atPause);
    engine.dispose();
  });

  test("play is a no-op at the end of the session", () => {
    const engine = new ReplayEngine(meta, bars, 0);
    engine.seek(bars.length - 1);
    engine.play();
    expect(engine.state.playing).toBe(false);
    expect(engine.state.atEnd).toBe(true);
    engine.dispose();
  });

  test("step forward/backward moves exactly one bar and clamps at both ends", () => {
    const engine = new ReplayEngine(meta, bars, 0);
    expect(engine.stepBack()).toBe(false); // already at 0
    expect(engine.state.cursor).toBe(0);
    expect(engine.stepForward()).toBe(true);
    expect(engine.state.cursor).toBe(1);
    expect(engine.stepForward()).toBe(true);
    expect(engine.state.cursor).toBe(2);
    expect(engine.stepBack()).toBe(true);
    expect(engine.state.cursor).toBe(1);
    expect(engine.seek(0)).toBe(true);
    expect(engine.seek(0)).toBe(false); // no movement
    expect(engine.state.atStart).toBe(true);
    engine.dispose();
  });

  test("stepping pauses playback", () => {
    const engine = new ReplayEngine(meta, bars, 0);
    engine.play();
    engine.stepForward();
    expect(engine.state.playing).toBe(false);
    engine.dispose();
  });

  test("reveal(5/10/20) advances by exactly that many bars", () => {
    const engine = new ReplayEngine(meta, bars, 0);
    engine.reveal(5);
    expect(engine.state.cursor).toBe(5);
    engine.reveal(10);
    expect(engine.state.cursor).toBe(15);
    engine.reveal(20);
    expect(engine.state.cursor).toBe(35);
    engine.dispose();
  });

  test("reset returns the engine to the original starting state", () => {
    const engine = new ReplayEngine(meta, bars, 0);
    const initial = { ...engine.state };
    engine.setSpeed(10);
    engine.reveal(25);
    engine.play();
    engine.reset();
    const after = engine.state;
    expect(after.cursor).toBe(0);
    expect(after.playing).toBe(false);
    expect(after.barsElapsed).toBe(initial.barsElapsed);
    expect(after.barsRemaining).toBe(initial.barsRemaining);
    expect(after.progressPct).toBe(initial.progressPct);
    expect(after.replayTime).toBe(initial.replayTime);
    expect(engine.revealed().length).toBe(1);
    engine.dispose();
  });

  test("every declared replay speed is accepted and preserves bar ordering", async () => {
    expect([...REPLAY_SPEEDS]).toEqual([0.5, 1, 2, 5, 10, 20, 50, 100]);
    for (const speed of REPLAY_SPEEDS) {
      const engine = new ReplayEngine(meta, bars, 0);
      engine.setSpeed(speed);
      let last = 0; // the cursor starts at bar 0, so the first emitted bar is 1
      const unsub = engine.subscribe((ev) => {
        if (ev.type === "bar" && ev.index !== undefined) {
          expect(ev.index).toBe(last + 1);
          last = ev.index;
        }
      });
      engine.play();
      await new Promise((r) => setTimeout(r, speed >= 50 ? 60 : 20));
      engine.pause();
      unsub();
      expect(engine.state.speed).toBe(speed);
      engine.dispose();
    }
  });
});

describe("replay determinism and speed invariance", () => {
  const bars = trend(20_000, 60, BAR_MS, 1.5, T0);
  const meta = metaFor(bars);

  /** Drive a session at a given speed, trading at a fixed script of bars. */
  async function runSession(
    speed: number,
    useTimers: boolean,
  ): Promise<{ trades: string[]; finalCursor: number }> {
    const engine = new ReplayEngine(meta, bars, 0);
    const sim = new ExecutionSimulator(cfg({ commissionPerContractRoundTurn: 4.5 }), CTX);
    sim.onBar(barAt(bars, 0), 0);
    const script = [3, 11, 20, 33, 44];

    engine.subscribe((ev) => {
      if (ev.type !== "bar" || ev.bar === undefined || ev.index === undefined) return;
      sim.onBar(ev.bar, ev.index);
      if (script.includes(ev.index)) {
        const last = sim.getLastBar()!;
        sim.submit(
          { side: "buy", type: "market", qty: 1, stopLoss: last.l - 1, takeProfit: last.h + 2 },
          last.t,
          ev.index,
        );
      }
    });

    if (useTimers) {
      engine.setSpeed(speed);
      engine.play();
      const deadline = Date.now() + 30_000; // ~1s expected; generous against CI contention
      while (!engine.state.atEnd && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15));
      }
    } else {
      while (!engine.state.atEnd) engine.stepForward();
    }
    // Settle anything still open, exactly as the controller does at session end.
    sim.onSessionEnd(barAt(bars, bars.length - 1), bars.length - 1);
    const trades = sim.closedTrades.map((t) => JSON.stringify(t));
    const finalCursor = engine.state.cursor;
    engine.dispose();
    return { trades, finalCursor };
  }

  test("replaying the same session twice produces identical results", async () => {
    const a = await runSession(1, false);
    const b = await runSession(1, false);
    expect(a.finalCursor).toBe(b.finalCursor);
    expect(a.trades).toEqual(b.trades);
    expect(a.trades.length).toBeGreaterThan(0);
  });

  test("replay speed does not alter market-state results", async () => {
    const slow = await runSession(0.5, false);
    const fast = await runSession(100, false);
    expect(slow.trades).toEqual(fast.trades);
    expect(slow.finalCursor).toBe(fast.finalCursor);
  });

  test("timer-driven playback reaches the same market state as manual stepping", async () => {
    const manual = await runSession(1, false);
    const timed = await runSession(100, true);
    expect(timed.finalCursor).toBe(bars.length - 1);
    expect(timed.trades).toEqual(manual.trades);
  });
});

describe("blind-mode future-data disclosure", () => {
  test("the session selector masks whole-session high/low/volume while blind mode is active", async () => {
    const src = await Bun.file(new URL("../src/components/LeftColumn.tsx", import.meta.url)).text();
    const start = src.indexOf("blind.active ?");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf(") : (", start);
    expect(end).toBeGreaterThan(start);

    // The masked branch must not reference the whole-session aggregates.
    const masked = src.slice(start, end);
    expect(masked).toMatch(/hidden in blind mode/);
    expect(masked).not.toMatch(/session\.(high|low|volume)/);
    expect(masked).not.toMatch(/session \? fmtPrice/);

    // The normal (non-blind) branch still shows them, as the spec requires.
    const shown = src.slice(end, src.indexOf("} ;", end) === -1 ? end + 600 : src.indexOf("} ;", end));
    expect(shown).toMatch(/session\.high/);
    expect(shown).toMatch(/session\.low/);
    expect(shown).toMatch(/session\.volume/);
  });
});

describe("replay engine — event contract", () => {
  test("forward steps emit a bar event, backward steps emit a seek event", () => {
    const bars = trend(20_000, 10, BAR_MS, 1, T0);
    const engine = new ReplayEngine(metaFor(bars), bars, 0);
    const events: string[] = [];
    engine.subscribe((ev) => events.push(ev.type));
    engine.stepForward();
    expect(events).toContain("bar");
    events.length = 0;
    engine.stepBack();
    expect(events).toContain("seek");
    expect(events).not.toContain("bar");
    engine.dispose();
  });

  test("unsubscribe stops delivery", () => {
    const bars = trend(20_000, 10, BAR_MS, 1, T0);
    const engine = new ReplayEngine(metaFor(bars), bars, 0);
    let n = 0;
    const off = engine.subscribe(() => n++);
    engine.stepForward();
    const after = n;
    off();
    engine.stepForward();
    expect(n).toBe(after);
    engine.dispose();
  });
});

describe("replay engine — no dependency on the UI", () => {
  test("the module has no DOM or React imports", async () => {
    const src = await Bun.file(new URL("../src/replay/ReplayEngine.ts", import.meta.url)).text();
    expect(src).not.toMatch(/from\s+["']react["']/);
    expect(src).not.toMatch(/document\.|window\./);
    expect(src).not.toMatch(/from\s+["'].*components\//);
  });

  test("the execution simulator has no DOM, React or chart imports", async () => {
    const src = await Bun.file(new URL("../src/execution/ExecutionSimulator.ts", import.meta.url)).text();
    expect(src).not.toMatch(/from\s+["']react["']/);
    expect(src).not.toMatch(/document\.|window\./);
    expect(src).not.toMatch(/components\//);
  });
});

describe("series sanity", () => {
  test("fixture bar series is tightly packed", () => {
    const s = series([
      [1, 2, 3, 1, 2, 5],
      [2, 2, 3, 1, 2, 5],
    ]);
    expect(s.length).toBe(2);
    expect(s.t).toBeInstanceOf(Float64Array);
    expect(Array.from(s.c)).toEqual([2, 2]);
  });
});
