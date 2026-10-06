/**
 * Replay engine.
 *
 * Owns a session's bars and the replay cursor. It has NO dependency on React,
 * the chart, or the trading panels — it emits events and the UI reacts. The
 * order of revealed bars is the single source of truth for what may be shown or
 * traded: nothing downstream is ever given a bar the engine has not revealed.
 */

import type { Bar, BarSeries } from "../market/types";
import type { SessionMeta } from "../data/types";

export const REPLAY_SPEEDS = [0.5, 1, 2, 5, 10, 20, 50, 100] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Milliseconds per bar at 1x. */
const BASE_MS_PER_BAR = 900;
const MIN_TICK_MS = 12;

export type ReplayEvent =
  | { type: "bar"; index: number; bar: Bar }
  | { type: "seek"; index: number }
  | { type: "state" };

export type ReplayListener = (event: ReplayEvent) => void;

export interface ReplaySnapshot {
  sessionId: string;
  cursor: number;
  length: number;
  playing: boolean;
  speed: ReplaySpeed;
  atStart: boolean;
  atEnd: boolean;
  barsElapsed: number;
  barsRemaining: number;
  progressPct: number;
  replayTime: number;
}

export class ReplayEngine {
  readonly meta: SessionMeta;
  readonly bars: BarSeries;

  private cursorIndex = 0;
  private playing = false;
  private speed: ReplaySpeed = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<ReplayListener>();

  constructor(meta: SessionMeta, bars: BarSeries, startIndex = 0) {
    this.meta = meta;
    this.bars = bars;
    this.cursorIndex = Math.max(0, Math.min(startIndex, Math.max(0, bars.length - 1)));
  }

  /* ------------------------------ events ------------------------------ */

  subscribe(fn: ReplayListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: ReplayEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /* ------------------------------ getters ------------------------------ */

  get state(): ReplaySnapshot {
    const length = this.bars.length;
    const cursor = this.cursorIndex;
    return {
      sessionId: this.meta.id,
      cursor,
      length,
      playing: this.playing,
      speed: this.speed,
      atStart: cursor <= 0,
      atEnd: cursor >= length - 1,
      barsElapsed: cursor + 1,
      barsRemaining: Math.max(0, length - 1 - cursor),
      progressPct: length > 0 ? ((cursor + 1) / length) * 100 : 0,
      replayTime: this.bars.t[cursor] ?? 0,
    };
  }

  get currentBar(): Bar {
    const i = this.cursorIndex;
    return {
      t: this.bars.t[i],
      o: this.bars.o[i],
      h: this.bars.h[i],
      l: this.bars.l[i],
      c: this.bars.c[i],
      v: this.bars.v[i],
    };
  }

  /** Bars revealed so far. Always a view of 0..cursor — never the future. */
  revealed(): BarSeries {
    const end = this.cursorIndex + 1;
    return {
      t: this.bars.t.subarray(0, end),
      o: this.bars.o.subarray(0, end),
      h: this.bars.h.subarray(0, end),
      l: this.bars.l.subarray(0, end),
      c: this.bars.c.subarray(0, end),
      v: this.bars.v.subarray(0, end),
      length: end,
    };
  }

  barAt(index: number): Bar {
    const i = Math.max(0, Math.min(index, this.bars.length - 1));
    return {
      t: this.bars.t[i],
      o: this.bars.o[i],
      h: this.bars.h[i],
      l: this.bars.l[i],
      c: this.bars.c[i],
      v: this.bars.v[i],
    };
  }

  /* ------------------------------ transport ------------------------------ */

  play(): void {
    if (this.playing) return;
    if (this.state.atEnd) return;
    this.playing = true;
    this.emit({ type: "state" });
    this.schedule();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.clearTimer();
    this.emit({ type: "state" });
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  setSpeed(speed: ReplaySpeed): void {
    this.speed = speed;
    if (this.playing) {
      this.clearTimer();
      this.schedule();
    }
    this.emit({ type: "state" });
  }

  stepForward(): boolean {
    this.pause();
    return this.advanceTo(this.cursorIndex + 1, true);
  }

  stepBack(): boolean {
    this.pause();
    return this.advanceTo(this.cursorIndex - 1, true);
  }

  /** Reveal the next `n` bars (used by Blind Mode's reveal step). */
  reveal(n: number): boolean {
    this.pause();
    return this.advanceTo(this.cursorIndex + n, true);
  }

  reset(): void {
    this.pause();
    this.advanceTo(0, false);
  }

  seek(index: number): boolean {
    this.pause();
    return this.advanceTo(index, false);
  }

  private advanceTo(index: number, emitBar: boolean): boolean {
    const clamped = Math.max(0, Math.min(index, Math.max(0, this.bars.length - 1)));
    if (clamped === this.cursorIndex) {
      this.emit({ type: "state" });
      return false;
    }
    const forward = clamped > this.cursorIndex;
    this.cursorIndex = clamped;
    if (forward && emitBar) {
      this.emit({ type: "bar", index: clamped, bar: this.barAt(clamped) });
    } else {
      this.emit({ type: "seek", index: clamped });
    }
    this.emit({ type: "state" });
    return true;
  }

  private schedule(): void {
    const delay = Math.max(MIN_TICK_MS, BASE_MS_PER_BAR / this.speed);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.playing) return;
      if (this.state.atEnd) {
        this.pause();
        return;
      }
      this.advanceTo(this.cursorIndex + 1, true);
      // `advanceTo` may have paused us if the UI reacted to end-of-session.
      if (this.playing) this.schedule();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.clearTimer();
    this.listeners.clear();
  }
}
