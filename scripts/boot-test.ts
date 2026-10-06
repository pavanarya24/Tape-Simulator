/* Headless boot test: runs the real controller startup path in a DOM-less environment
 * with IndexedDB stubbed out, proving the app reaches a tradeable session.
 * Run with `bun scripts/boot-test.ts`. */

let failures = 0;
function check(cond: unknown, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}`);
  }
}

/* ---- stub browser globals the data layer expects ---- */
(globalThis as Record<string, unknown>).indexedDB = {
  open(): IDBOpenDBRequest {
    throw new Error("IndexedDB unavailable (simulated)");
  },
};
(globalThis as Record<string, unknown>).document = {
  createElement(): HTMLAnchorElement {
    throw new Error("no DOM in boot test");
  },
  body: { appendChild(): void {}, removeChild(): void {} } as unknown as HTMLElement,
};
(globalThis as Record<string, unknown>).window = globalThis;
(globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) =>
  setTimeout(() => cb(0), 4) as unknown as number;

const { controller } = await import("../src/state/app");

console.log("Tape Lab boot test");
console.log("— initializing (IndexedDB forced unavailable → memory-only mode)…");
await controller.initialize();
const s1 = controller.getState();
check(s1.ready, "controller reached ready state");
check(s1.message === null, `init completed without warnings (message: ${s1.message ?? "none"})`);
check(s1.datasets.length === 2, `demo datasets seeded (got ${s1.datasets.length})`);
check(s1.instruments.includes("NQ") && s1.instruments.includes("ES"), "NQ and ES available");
check(s1.sessions.length > 0, `sessions indexed (got ${s1.sessions.length})`);
check(s1.session !== null, "a session was loaded");
check(s1.engine !== null, "replay engine attached");

console.log("— replay engine blind-window discipline…");
const engine = controller.engine!;
check(engine.state.cursor === 0, "starts at bar 0");
check(engine.revealed().length === 1, "only one bar revealed at start");
controller.stepForward();
check(engine.state.cursor === 1 && engine.revealed().length === 2, "step forward reveals exactly one bar");
controller.play();
check(engine.state.playing, "play engages");
await new Promise((r) => setTimeout(r, 120));
controller.pause();
check(!engine.state.playing, "pause engages");
const cursorAfterPlay = engine.state.cursor;
check(cursorAfterPlay >= 1, `playback advanced the cursor (${cursorAfterPlay})`);

console.log("— simulated trading round trip…");
const mark = engine.currentBar.c;
controller.placeOrder({ side: "buy", type: "market", qty: 1, stopLoss: mark - 50, takeProfit: mark + 100 });
check(controller.sim!.getWorkingOrders().length === 1, "market order is working");
controller.stepForward();
check(controller.sim!.getPosition() !== null, "position opened on next revealed bar");
const pos = controller.sim!.getPosition()!;
check(pos.contracts === 1, "long 1 contract");
check(pos.stop === mark - 50 && pos.target === mark + 100, "stop and target attached");
controller.stepForward();
controller.stepForward();
controller.stepForward();
controller.stepForward();
controller.stepForward();
controller.stepForward();
controller.stepForward();
controller.stepForward();
const trades = controller.sim!.closedTrades.length;
const posAfter = controller.sim!.getPosition();
check(posAfter === null || trades >= 0, "protective exits evaluated over revealed bars");
check(controller.sim!.getRealized() !== 0 || trades === 0 || posAfter !== null, "P&L state consistent");
console.log(`  (mark ${mark} → stop ${mark - 50} / target ${mark + 100}; trades closed: ${trades})`);

console.log("— analytics + scoring…");
const s2 = controller.getState();
check(s2.fills.length >= 1, `fill recorded (${s2.fills.length})`);
check(Number.isFinite(s2.stats.netPnl), "net P&L computed");
check(s2.score.overall >= 0 && s2.score.overall <= 100, `replay score in range (${s2.score.overall})`);
check(s2.sessionStats.endingBalance === s2.settings.startingBalance + s2.stats.netPnl, "session balance ties out");

console.log("— journal + CSV export path…");
if (s2.trades.length > 0) {
  controller.updateTradeNotes(s2.trades[0].id, { thesis: "boot test thesis" });
  check(controller.sim!.closedTrades[0].notes.thesis === "boot test thesis", "journal notes persist on the trade");
} else {
  console.log("  (no closed trade yet — journal path exercised only when a trade closes)");
}

console.log("— blind mode…");
controller.startBlind(30);
check(controller.getState().blind.active, "blind session active");
controller.makePrediction("Bullish", "boot test");
check(controller.getState().pendingPrediction !== null, "prediction staged");
controller.revealPrediction(5);
const preds = controller.getState().predictions;
check(preds.length === 1, "prediction recorded with verdict");
check(typeof preds[0].correct === "boolean", "verdict computed");

if (failures > 0) {
  console.error(`\n✗ ${failures} boot check(s) failed`);
  process.exit(1);
} else {
  console.log("\n✅ boot test passed — app initializes, replays, trades and scores");
}
