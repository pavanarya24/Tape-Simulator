/**
 * §7 Session behaviour — start/end, date switching, previous/next/random.
 * §8 UI/state synchronization — chart price, clock, position, orders, P&L,
 *    trade history and balance all move together.
 * §1 Reset semantics used by the transport controls.
 *
 * The controller is a module-level singleton, so the browser globals it touches
 * are stubbed before the module is imported.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import type { AppState, TapeLabController } from "../src/state/app";
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from "../src/state/settings";
import { tradesToCsv } from "../src/journal/journal";

let controller: TapeLabController;

function settle(ms = 40): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function state(): AppState {
  return controller.getState();
}

beforeAll(async () => {
  // No IndexedDB → the repository runs in memory-only mode (as in a sandboxed
  // iframe that blocks storage). A localStorage shim exercises settings
  // persistence.
  (globalThis as Record<string, unknown>).indexedDB = {
    open() {
      throw new Error("IndexedDB unavailable (simulated)");
    },
  };
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  const mod = await import("../src/state/app");
  controller = mod.controller;
  await controller.initialize();
});

describe("startup", () => {
  test("reaches a tradeable session with both instruments available", () => {
    const s = state();
    expect(s.ready).toBe(true);
    expect(s.instruments).toEqual(["NQ", "ES"]);
    expect(s.datasets.length).toBe(2);
    expect(s.sessions.length).toBeGreaterThan(0);
    expect(s.session).not.toBeNull();
    expect(s.engine).not.toBeNull();
    expect(s.engine!.cursor).toBe(0);
    expect(s.position.direction).toBe("flat");
    expect(s.stats.trades).toBe(0);
  });
});

describe("replay starts from the correct timestamp", () => {
  test("cursor, replay clock and chart price all start at bar 0", async () => {
    controller.resetReplay();
    await settle();
    const s = state();
    const bars = controller.session!.bars;
    expect(s.engine!.cursor).toBe(0);
    expect(s.engine!.replayTime).toBe(bars.t[0]);
    expect(s.engine!.replayTime).toBe(controller.session!.meta.firstTime);
    expect(s.position.mark).toBe(bars.c[0]);
  });

  test("stepping advances the clock and the mark together", async () => {
    controller.resetReplay();
    await settle();
    for (let i = 0; i < 5; i++) controller.stepForward();
    await settle();
    const s = state();
    const bars = controller.session!.bars;
    expect(s.engine!.cursor).toBe(5);
    expect(s.engine!.replayTime).toBe(bars.t[5]);
    expect(s.position.mark).toBe(bars.c[5]);
    expect(s.engine!.barsElapsed).toBe(6);
    expect(s.engine!.progressPct).toBeCloseTo((6 / bars.length) * 100, 6);
    expect(s.engine!.barsRemaining).toBe(bars.length - 6);
  });

  test("the app state never carries a price from a future bar", async () => {
    controller.resetReplay();
    await settle();
    const bars = controller.session!.bars;
    for (let cursor = 0; cursor < 12; cursor++) {
      const s = state();
      expect(s.engine!.cursor).toBe(cursor);
      expect(s.position.mark).toBe(bars.c[cursor]);
      expect(s.engine!.replayTime).toBe(bars.t[cursor]);
      for (const f of s.fills) expect(f.index).toBeLessThanOrEqual(cursor);
      for (const t of s.trades) expect(t.exitIndex).toBeLessThanOrEqual(cursor);
      controller.stepForward();
      await settle();
    }
  });
});

describe("transport and reset", () => {
  test("play/pause through the controller toggles the engine state", async () => {
    controller.resetReplay();
    await settle();
    controller.setSpeed(100);
    controller.play();
    await settle(20);
    expect(state().engine!.playing).toBe(true);
    controller.pause();
    await settle();
    expect(state().engine!.playing).toBe(false);
  });

  test("reset returns the session to its original state", async () => {
    controller.resetReplay();
    await settle();
    for (let i = 0; i < 6; i++) controller.stepForward();
    controller.placeOrder({ side: "buy", type: "market", qty: 2 });
    for (let i = 0; i < 3; i++) controller.stepForward();
    await settle();
    expect(state().position.direction).toBe("long");

    controller.resetReplay();
    await settle();
    const s = state();
    expect(s.engine!.cursor).toBe(0);
    expect(s.engine!.playing).toBe(false);
    expect(s.position.direction).toBe("flat");
    expect(s.position.contracts).toBe(0);
    expect(s.position.realized).toBe(0);
    expect(s.orders.length).toBe(0);
    expect(s.fills.length).toBe(0);
    expect(s.trades.length).toBe(0);
    expect(s.stats.netPnl).toBe(0);
  });

  test("regression: after a reset, scrubbing forward cannot resurrect cleared orders", async () => {
    controller.resetReplay();
    await settle();
    for (let i = 0; i < 10; i++) controller.stepForward();
    controller.placeOrder({ side: "buy", type: "market", qty: 1 });
    await settle();
    expect(state().orders.length).toBe(1);

    controller.resetReplay();
    await settle();
    expect(state().orders.length).toBe(0);

    controller.seek(20);
    await settle();
    const s = state();
    expect(s.engine!.cursor).toBe(20);
    expect(s.orders.length).toBe(0);
    expect(s.position.direction).toBe("flat");
    expect(s.trades.length).toBe(0);
  });
});

describe("simulated trading synchronizes every panel", () => {
  test("order → fill → position → P&L → balance stay consistent", async () => {
    controller.resetReplay();
    await settle();
    const bars = controller.session!.bars;
    const sim = controller.sim!;

    for (let i = 0; i < 4; i++) controller.stepForward();
    controller.placeOrder({ side: "buy", type: "market", qty: 2 });
    await settle();
    let s = state();
    expect(s.orders.length).toBe(1);
    expect(s.orders[0].status).toBe("working");

    controller.stepForward();
    await settle();
    s = state();
    expect(s.fills.length).toBe(1);
    expect(s.orders[0].status).toBe("filled");
    expect(s.position.direction).toBe("long");
    expect(s.position.contracts).toBe(2);
    expect(s.position.avgEntry).toBeCloseTo(bars.o[5] + 0.25, 8);

    // Mark, unrealized P&L and balance are all derived from the same cursor bar.
    const cursor = s.engine!.cursor;
    expect(s.position.mark).toBe(bars.c[cursor]);
    const expectedUnrealized = (bars.c[cursor] - s.position.avgEntry) * 20 * 2;
    expect(s.position.unrealized).toBeCloseTo(expectedUnrealized, 6);
    expect(s.sessionStats.startingBalance).toBe(s.settings.startingBalance);
    expect(s.sessionStats.endingBalance).toBe(s.settings.startingBalance + s.stats.netPnl);
    expect(sim.getRealized()).toBe(0);

    // Close it out and re-check the realized accounting.
    controller.flatten();
    controller.stepForward();
    controller.stepForward();
    await settle();
    s = state();
    expect(s.position.direction).toBe("flat");
    expect(s.trades.length).toBe(1);
    expect(s.trades).toEqual(sim.closedTrades);
    expect(s.stats.netPnl).toBeCloseTo(sim.getRealized(), 6);
    expect(s.sessionStats.sessionPnl).toBe(s.stats.netPnl);
    expect(s.sessionStats.endingBalance).toBeCloseTo(s.settings.startingBalance + sim.getRealized(), 6);
    expect(s.stats.winRate).toBeGreaterThanOrEqual(0);
    expect(s.score.overall).toBeGreaterThanOrEqual(0);
    expect(s.score.overall).toBeLessThanOrEqual(100);
  });

  test("reversing flips direction and order/fill history is newest-first", async () => {
    controller.resetReplay();
    await settle();
    for (let i = 0; i < 4; i++) controller.stepForward();
    controller.placeOrder({ side: "buy", type: "market", qty: 1 });
    controller.stepForward();
    controller.reverse();
    controller.stepForward();
    controller.stepForward();
    await settle();
    const s = state();
    expect(s.position.direction).toBe("short");
    expect(s.position.contracts).toBe(1);
    expect(s.trades.length).toBe(1);
    expect(s.trades[0].exitReason).toBe("reverse");
    // Newest first in the UI lists.
    const sim = controller.sim!;
    expect(s.orders[0]).toEqual(sim.orders[sim.orders.length - 1]);
    expect(s.fills[0]).toEqual(sim.fills[sim.fills.length - 1]);
  });

  test("orders cannot be placed once the session has settled", async () => {
    controller.resetReplay();
    await settle();
    controller.seek(controller.session!.bars.length - 1);
    await settle();
    const before = state().orders.length;
    controller.placeOrder({ side: "buy", type: "market", qty: 1 });
    await settle();
    expect(state().orders.length).toBe(before);
  });
});

describe("determinism through the full application stack", () => {
  async function scriptedRun(): Promise<string[]> {
    controller.resetReplay();
    await settle();
    for (let i = 0; i < 6; i++) controller.stepForward();
    controller.placeOrder({ side: "buy", type: "market", qty: 2, stopLoss: 0 });
    for (let i = 0; i < 5; i++) controller.stepForward();
    controller.flatten();
    for (let i = 0; i < 5; i++) controller.stepForward();
    await settle();
    return state().trades.map((t) => JSON.stringify(t));
  }

  test("replaying the same session twice yields identical trades", async () => {
    const a = await scriptedRun();
    const b = await scriptedRun();
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});

describe("session selection", () => {
  test("previous/next move chronologically and clamp at the ends", async () => {
    const first = controller.sessions[0].id;
    await controller.selectSession(first);
    await settle();
    expect(state().session!.id).toBe(first);
    await controller.stepSession(-1); // already first
    await settle();
    expect(state().session!.id).toBe(first);

    const next = controller.sessions[1].id;
    await controller.stepSession(1);
    await settle();
    expect(state().session!.id).toBe(next);
    await controller.stepSession(-1);
    await settle();
    expect(state().session!.id).toBe(first);

    const last = controller.sessions[controller.sessions.length - 1].id;
    await controller.selectSession(last);
    await settle();
    await controller.stepSession(1); // already last
    await settle();
    expect(state().session!.id).toBe(last);
  });

  test("random session stays inside the available set and resets the replay", async () => {
    for (let i = 0; i < 5; i++) {
      await controller.randomSession();
      await settle(10);
      const s = state();
      expect(controller.sessions.map((x) => x.id)).toContain(s.session!.id);
      expect(s.engine!.cursor).toBe(0);
      expect(s.position.direction).toBe("flat");
    }
  });

  test("date switching does not leak the previous session's trading state", async () => {
    await controller.selectSession(controller.sessions[0].id);
    await settle();
    for (let i = 0; i < 4; i++) controller.stepForward();
    controller.placeOrder({ side: "buy", type: "market", qty: 1 });
    controller.stepForward();
    await settle();
    expect(state().position.direction).toBe("long");

    await controller.selectSession(controller.sessions[1].id);
    await settle();
    const s = state();
    expect(s.session!.id).toBe(controller.sessions[1].id);
    expect(s.position.direction).toBe("flat");
    expect(s.trades.length).toBe(0);
    expect(s.orders.length).toBe(0);
    expect(s.stats.netPnl).toBe(0);
  });

  test("switching instrument loads that instrument's session and contract", async () => {
    await controller.selectInstrument("ES");
    await settle(20);
    let s = state();
    expect(s.settings.instrument).toBe("ES");
    expect(s.settings.contract).toBe("ES");
    expect(s.session!.instrument).toBe("ES");
    expect(s.session!.id.startsWith("ES:")).toBe(true);
    expect(s.position.direction).toBe("flat");

    // An ES trade is stamped as ES, never as NQ.
    for (let i = 0; i < 3; i++) controller.stepForward();
    controller.placeOrder({ side: "buy", type: "market", qty: 1 });
    controller.stepForward();
    controller.flatten();
    controller.stepForward();
    controller.stepForward();
    await settle();
    s = state();
    expect(s.trades.length).toBe(1);
    expect(s.trades[0].instrument).toBe("ES");
    expect(s.trades[0].sessionId.startsWith("ES:")).toBe(true);

    await controller.selectInstrument("NQ");
    await settle(20);
    expect(state().session!.instrument).toBe("NQ");
    expect(state().trades.length).toBe(0);
  });

  test("session type switching selects the right session family", async () => {
    await controller.selectSessionType("ETH");
    await settle(20);
    const eth = state();
    expect(eth.settings.sessionType).toBe("ETH");
    expect(eth.session!.type).toBe("ETH");
    expect(eth.session!.id.startsWith("NQ:ETH:")).toBe(true);
    expect(eth.session!.bars).toBe(275);

    await controller.selectSessionType("RTH");
    await settle(20);
    const rth = state();
    expect(rth.session!.type).toBe("RTH");
    expect(rth.session!.bars).toBe(78);
  });
});

describe("blind mode", () => {
  test("starting blind mode seeks to the chosen bar and hides the future", async () => {
    await controller.selectSessionType("RTH");
    await settle(20);
    controller.startBlind(20);
    await settle();
    const s = state();
    expect(s.blind.active).toBe(true);
    expect(s.engine!.cursor).toBe(20);
    expect(s.engine!.barsElapsed).toBe(21);
  });

  test("the timeline cannot be scrubbed into unrevealed bars while blind", async () => {
    controller.startBlind(20);
    await settle();
    controller.seek(60);
    await settle();
    expect(state().engine!.cursor).toBe(20); // clamped to what has been revealed
    controller.seek(5);
    await settle();
    expect(state().engine!.cursor).toBe(5); // rewind is allowed
  });

  test("a prediction is graded over the revealed horizon and stored", async () => {
    controller.startBlind(20);
    await settle();
    controller.makePrediction("Bullish", "higher lows into the open range high");
    let s = state();
    expect(s.pendingPrediction).not.toBeNull();
    expect(s.pendingPrediction!.index).toBe(20);
    expect(s.blind.awaitingReveal).toBe(true);

    controller.revealPrediction(5);
    await settle();
    s = state();
    expect(s.predictions.length).toBe(1);
    const p = s.predictions[0];
    expect(p.choice).toBe("Bullish");
    expect(p.reasoning).toContain("higher lows");
    expect(p.horizon).toBe(5);
    expect(p.endIndex).toBe(25);
    expect(typeof p.correct).toBe("boolean");
    expect(p.detail.length).toBeGreaterThan(0);
    expect(s.engine!.cursor).toBe(25);
    expect(s.pendingPrediction).toBeNull();
    expect(s.blind.awaitingReveal).toBe(false);
  });

  test("predictions feed the scoring sub-score", async () => {
    const s = state();
    expect(s.score.prediction).toBeGreaterThanOrEqual(0);
    expect(s.score.prediction).toBeLessThanOrEqual(100);
    expect(s.score.discipline).toBeGreaterThanOrEqual(0);
    expect(typeof s.score.overall).toBe("number");
  });

  test("exiting blind mode clears the pending prediction", async () => {
    controller.startBlind(20);
    controller.makePrediction("Range", "");
    controller.exitBlind();
    await settle();
    expect(state().blind.active).toBe(false);
    expect(state().pendingPrediction).toBeNull();
  });
});

describe("settings persistence", () => {
  test("settings round-trip through storage and merge with defaults", () => {
    const custom = { ...DEFAULT_SETTINGS, startingBalance: 50_000, ambiguityRule: "favorable-first" as const };
    saveSettings(custom);
    const loaded = loadSettings();
    expect(loaded.startingBalance).toBe(50_000);
    expect(loaded.ambiguityRule).toBe("favorable-first");
    expect(loaded.indicators).toEqual(DEFAULT_SETTINGS.indicators);
    expect(loaded.timezone.sourceTimeZone).toBe("America/New_York");
  });

  test("partially written settings fall back to the defaults", () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem("tapelab_settings_v1", JSON.stringify({ instrument: "ES" }));
    const loaded = loadSettings();
    expect(loaded.instrument).toBe("ES");
    expect(loaded.sessionType).toBe(DEFAULT_SETTINGS.sessionType);
    expect(loaded.indicators.vwap).toBe(DEFAULT_SETTINGS.indicators.vwap);
  });

  test("corrupt settings do not throw and reset to defaults", () => {
    (globalThis as { localStorage: Storage }).localStorage.setItem("tapelab_settings_v1", "{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
  });

  test("instrument/contract selection is persisted", async () => {
    await controller.selectInstrument("ES");
    await settle(20);
    expect(loadSettings().instrument).toBe("ES");
    await controller.selectInstrument("NQ");
    await settle(20);
    expect(loadSettings().instrument).toBe("NQ");
  });
});

describe("journal export", () => {
  test("CSV export carries every required column and escapes user text", async () => {
    await controller.selectSessionType("RTH");
    await settle(20);
    controller.resetReplay();
    await settle();
    for (let i = 0; i < 3; i++) controller.stepForward();
    controller.placeOrder({ side: "buy", type: "market", qty: 1 });
    controller.stepForward();
    controller.flatten();
    controller.stepForward();
    await settle();
    const trade = state().trades[0];
    expect(trade).toBeDefined();
    controller.updateTradeNotes(trade.id, { thesis: 'he said "hold", then left' });

    const csv = tradesToCsv(controller.sim!.closedTrades, "America/New_York");
    const header = csv.split("\n")[0];
    for (const col of [
      "Instrument",
      "Session Date",
      "Direction",
      "Contracts",
      "Entry Price",
      "Exit Price",
      "Gross P&L",
      "Net P&L",
      "R Multiple",
      "Holding Time",
      "Thesis",
    ]) {
      expect(header).toContain(col);
    }
    expect(csv).toContain('"he said ""hold"", then left"');
    expect(csv.split("\n").length).toBe(2); // header + one trade

    // notes survive on the trade object itself
    expect(controller.sim!.closedTrades[0].notes.thesis).toBe('he said "hold", then left');
  });
});
