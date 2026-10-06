import { useEffect, useMemo, useRef, useState } from "react";

const EMA_DEFAULTS: Record<number, string> = { 21: "#e6a93c", 50: "#a78bfa", 200: "#c8d2dc" };
const DEFAULT_VWAP_COLOR = "#4d8ff0";
import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { clockTime } from "../data/timezone";
import { price as fmtPrice, compact } from "../util/format";

const COL = {
  bg: "#06070a",
  grid: "#151a20",
  axis: "#2a333d",
  text: "#7c8894",
  textBright: "#d8e0e8",
  up: "#2fbf71",
  down: "#e5484d",
  upFill: "#2fbf71",
  downFill: "#e5484d",
  vwap: "#4d8ff0",
  ema21: "#e6a93c",
  ema50: "#a78bfa",
  ema200: "#c8d2dc",
  or: "#8b96a3",
  entry: "#e6a93c",
  stop: "#e5484d",
  target: "#2fbf71",
  cross: "#4a5560",
};

interface Hover {
  x: number;
  y: number;
  index: number;
}

export function Chart({ state }: { state: AppState }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [viewCount, setViewCount] = useState(160);
  // Hover is kept in a ref (not state) so mouse movement triggers a redraw
  // without tearing down the render effect / ResizeObserver on every move.
  const hoverRef = useRef<Hover | null>(null);
  const [, bumpDraw] = useState(0);
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  const [emaLengths, setEmaLengths] = useState<number[]>([21]);
  const [emaColors, setEmaColors] = useState<Record<number, string>>({ ...EMA_DEFAULTS });
  const [vwapColor, setVwapColor] = useState(DEFAULT_VWAP_COLOR);

  const bars = controller.session?.bars ?? null;
  const { engine, indicators, settings, position } = state;

  const fills = state.fills;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let frame = 0;
    const render = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w < 10 || h < 10) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, w, h);
    };

    const draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = COL.bg;
      ctx.fillRect(0, 0, w, h);

      if (!bars || !engine || bars.length === 0) {
        ctx.fillStyle = COL.text;
        ctx.font = "12px 'IBM Plex Mono', monospace";
        ctx.fillText("No session loaded.", 16, 24);
        return;
      }

      const padRight = 74;
      const padBottom = 20;
      const padTop = 6;
      const gap = 10;
      const plotW = Math.max(10, w - padRight - 4);
      const totalH = h - padTop - padBottom;
      const volH = Math.max(36, totalH * 0.22);
      const priceH = totalH - volH - gap;

      const cursor = engine.cursor;
      const end = Math.min(cursor, bars.length - 1);
      const count = Math.max(12, Math.min(viewCount, end + 1));
      const start = Math.max(0, end - count + 1);
      const n = end - start + 1;
      if (n <= 0) return;

      const slot = plotW / n;

      // ---- price scale -------------------------------------------------
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = start; i <= end; i++) {
        hi = Math.max(hi, bars.h[i]);
        lo = Math.min(lo, bars.l[i]);
      }
      if (indicators?.openingRange.ready && indicators.openingRange.endIndex >= start) {
        hi = Math.max(hi, indicators.openingRange.high);
        lo = Math.min(lo, indicators.openingRange.low);
      }
      if (position.direction !== "flat") {
        if (Number.isFinite(position.stop ?? NaN)) {
          hi = Math.max(hi, position.stop as number);
          lo = Math.min(lo, position.stop as number);
        }
        if (Number.isFinite(position.target ?? NaN)) {
          hi = Math.max(hi, position.target as number);
          lo = Math.min(lo, position.target as number);
        }
      }
      const pad = (hi - lo) * 0.08 || 1;
      hi += pad;
      lo -= pad;
      const yOf = (p: number) => padTop + priceH - ((p - lo) / (hi - lo)) * priceH;
      const xOf = (i: number) => (i - start) * slot + slot / 2;

      // ---- grid + price axis ------------------------------------------
      ctx.font = "10px 'IBM Plex Mono', monospace";
      ctx.textBaseline = "middle";
      const ticks = 5;
      for (let t = 0; t <= ticks; t++) {
        const p = lo + ((hi - lo) * t) / ticks;
        const y = yOf(p);
        ctx.strokeStyle = COL.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(plotW, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillStyle = COL.text;
        ctx.textAlign = "left";
        ctx.fillText(fmtPrice(p), plotW + 8, y);
      }

      // ---- opening range shading --------------------------------------
      const or = indicators?.openingRange;
      if (settings.indicators.openingRange && or && or.ready && or.endIndex >= start) {
        const x1 = xOf(Math.max(or.endIndex, start));
        const y1 = yOf(or.high);
        const y2 = yOf(or.low);
        ctx.fillStyle = "rgba(139,150,163,0.07)";
        ctx.fillRect(x1, Math.min(y1, y2), plotW - x1, Math.abs(y2 - y1));
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = COL.or;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(plotW, y1);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x1, y2);
        ctx.lineTo(plotW, y2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = COL.or;
        ctx.textAlign = "left";
        ctx.fillText(`ORH ${fmtPrice(or.high)}`, x1 + 4, y1 - 8);
        ctx.fillText(`ORL ${fmtPrice(or.low)}`, x1 + 4, y2 + 10);
      }

      // ---- volume pane -------------------------------------------------
      const volTop = padTop + priceH + gap;
      let maxVol = 1;
      for (let i = start; i <= end; i++) maxVol = Math.max(maxVol, bars.v[i]);
      for (let i = start; i <= end; i++) {
        const x = xOf(i);
        const vh = (bars.v[i] / maxVol) * (volH - 6);
        ctx.fillStyle = bars.c[i] >= bars.o[i] ? "rgba(47,191,113,0.45)" : "rgba(229,72,77,0.45)";
        ctx.fillRect(x - slot * 0.32, volTop + (volH - vh), Math.max(1, slot * 0.64), vh);
      }
      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.moveTo(0, volTop - gap / 2);
      ctx.lineTo(plotW, volTop - gap / 2);
      ctx.stroke();
      ctx.fillStyle = COL.text;
      ctx.textAlign = "left";
      ctx.fillText(`VOL ${compact(maxVol)}`, 4, volTop + 8);

      // ---- candles -----------------------------------------------------
      for (let i = start; i <= end; i++) {
        const x = xOf(i);
        const up = bars.c[i] >= bars.o[i];
        const col = up ? COL.up : COL.down;
        const bodyW = Math.max(1, Math.min(14, slot * 0.62));
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, yOf(bars.h[i]));
        ctx.lineTo(Math.round(x) + 0.5, yOf(bars.l[i]));
        ctx.stroke();
        const yo = yOf(bars.o[i]);
        const yc = yOf(bars.c[i]);
        const top = Math.min(yo, yc);
        const bh = Math.max(1, Math.abs(yc - yo));
        ctx.fillStyle = up ? COL.upFill : COL.downFill;
        ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
      }

      // ---- overlays ----------------------------------------------------
      const line = (values: Float64Array, color: string, width = 1.2) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        let started = false;
        for (let i = start; i <= end; i++) {
          const v = values[i];
          if (!Number.isFinite(v)) {
            started = false;
            continue;
          }
          const x = xOf(i);
          const y = yOf(v);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      };

      if (indicators && settings.indicators.vwap) line(indicators.vwap, vwapColor, 1.4);
      if (indicators && settings.indicators.ema21) line(indicators.ema21, emaColors[21] ?? COL.ema21);
      if (indicators && settings.indicators.ema50) line(indicators.ema50, emaColors[50] ?? COL.ema50);
      if (indicators && settings.indicators.ema200) line(indicators.ema200, emaColors[200] ?? COL.ema200);

      // ---- position lines ---------------------------------------------
      const hline = (p: number, color: string, label: string) => {
        const y = yOf(p);
        ctx.setLineDash([5, 3]);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.textAlign = "right";
        ctx.fillText(label, plotW - 4, y - 7);
      };
      if (position.direction !== "flat") {
        hline(position.avgEntry, COL.entry, `ENTRY ${fmtPrice(position.avgEntry)}`);
        if (position.stop !== undefined) hline(position.stop, COL.stop, `STOP ${fmtPrice(position.stop)}`);
        if (position.target !== undefined) hline(position.target, COL.target, `TGT ${fmtPrice(position.target)}`);
      }

      // ---- trade + fill markers ---------------------------------------
      for (const f of fills) {
        if (f.index < start || f.index > end) continue;
        const x = xOf(f.index);
        const y = yOf(f.price);
        ctx.fillStyle = f.side === "buy" ? COL.up : COL.down;
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.lineTo(x - 4, y - 12);
        ctx.lineTo(x + 4, y - 12);
        ctx.closePath();
        ctx.fill();
      }

      // ---- time axis ---------------------------------------------------
      ctx.fillStyle = COL.text;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const step = Math.max(1, Math.ceil(n / 8));
      for (let i = start; i <= end; i += step) {
        const x = xOf(i);
        ctx.fillText(clockTime(bars.t[i], settings.timezone.displayTimeZone), x, h - padBottom + 5);
      }

      // ---- crosshair ---------------------------------------------------
      const hover = hoverRef.current;
      if (hover && hover.x <= plotW) {
        const idx = Math.max(start, Math.min(end, start + Math.floor(hover.x / slot)));
        const cx = xOf(idx);
        ctx.strokeStyle = COL.cross;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, padTop);
        ctx.lineTo(cx, padTop + priceH);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, hover.y);
        ctx.lineTo(plotW, hover.y);
        ctx.stroke();
        ctx.setLineDash([]);

        const bar = {
          o: bars.o[idx],
          h: bars.h[idx],
          l: bars.l[idx],
          c: bars.c[idx],
          v: bars.v[idx],
          t: bars.t[idx],
        };
        const lines = [
          `${clockTime(bar.t, settings.timezone.displayTimeZone)}`,
          `O ${fmtPrice(bar.o)}  H ${fmtPrice(bar.h)}`,
          `L ${fmtPrice(bar.l)}  C ${fmtPrice(bar.c)}`,
          `V ${compact(bar.v)}`,
        ];
        const boxW = 156;
        const boxH = 62;
        let bx = cx + 10;
        if (bx + boxW > plotW) bx = cx - boxW - 10;
        ctx.fillStyle = "rgba(10,13,16,0.94)";
        ctx.strokeStyle = COL.axis;
        ctx.fillRect(bx, padTop + 6, boxW, boxH);
        ctx.strokeRect(bx + 0.5, padTop + 6.5, boxW, boxH);
        ctx.fillStyle = COL.textBright;
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        lines.forEach((l, i2) => ctx.fillText(l, bx + 8, padTop + 13 + i2 * 13));
      }
    };

    render();
    const onResize = () => render();
    window.addEventListener("resize", onResize);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => render()) : null;
    if (ro) ro.observe(wrap);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [bars, engine, indicators, settings, position, viewCount, fills]);

  const toggleEma = (len: number) => {
    setEmaLengths((prev) => (prev.includes(len) ? prev.filter((l) => l !== len) : [...prev, len].sort((a, b) => a - b)));
    controller.updateSettings({
      indicators: {
        ...settings.indicators,
        ema21: emaLengths.includes(21) !== (len === 21) ? !settings.indicators.ema21 : settings.indicators.ema21,
        ema50: emaLengths.includes(50) !== (len === 50) ? !settings.indicators.ema50 : settings.indicators.ema50,
        ema200: emaLengths.includes(200) !== (len === 200) ? !settings.indicators.ema200 : settings.indicators.ema200,
      },
    });
  };

  const legend = useMemo(() => {
    if (!bars || !engine) return null;
    const i = Math.min(engine.cursor, bars.length - 1);
    const change = bars.c[i] - bars.o[i];
    return (
      <div className="legend">
        <span>
          O <i style={{ color: COL.textBright }}>{fmtPrice(bars.o[i])}</i>
        </span>
        <span>
          H <i style={{ color: COL.up }}>{fmtPrice(bars.h[i])}</i>
        </span>
        <span>
          L <i style={{ color: COL.down }}>{fmtPrice(bars.l[i])}</i>
        </span>
        <span>
          C <i style={{ color: change >= 0 ? COL.up : COL.down }}>{fmtPrice(bars.c[i])}</i>
        </span>
        <span>
          V <i style={{ color: COL.textBright }}>{compact(bars.v[i])}</i>
        </span>
        <span style={{ marginLeft: "auto" }}>
          bar {i + 1} / {bars.length}
        </span>
      </div>
    );
  }, [bars, engine]);

  return (
    <>
      <div className="chart-toolbar">
        <span className="tb-label">Overlays</span>
        <button
          className={`ind-toggle ${settings.indicators.vwap ? "on" : ""}`}
          onClick={() => controller.toggleIndicator("vwap")}
        >
          VWAP
        </button>
        <span className="tb-label" style={{ opacity: 0.5 }}>·</span>
        <button
          className={`ind-toggle ${settings.indicators.openingRange ? "on" : ""}`}
          onClick={() => controller.toggleIndicator("openingRange")}
        >
          Open Range
        </button>
        <select
          value={settings.openingRangeMinutes}
          onChange={(e) => controller.setOpeningRange(Number(e.target.value))}
          style={{ padding: "3px 6px", fontSize: 10, width: "auto" }}
          title="Opening range length (anchored at 09:30 New York)"
        >
          <option value={5}>5m</option>
          <option value={15}>15m</option>
          <option value={30}>30m</option>
        </select>
        <span className="tb-label" style={{ opacity: 0.5 }}>·</span>
        <button className="btn sm" onClick={() => setViewCount((c) => Math.max(40, Math.round(c * 1.3)))} title="Zoom out">
          −
        </button>
        <button className="btn sm" onClick={() => setViewCount((c) => Math.min(1200, Math.round(c / 1.3)))} title="Zoom in">
          +
        </button>
        <button
          className="btn sm"
          onClick={() => setOverlaysOpen((o) => !o)}
          title="EMA lengths, colors and defaults"
        >
          ⚙ EMA settings
        </button>
        <span className="tb-label" style={{ marginLeft: "auto" }}>
          {settings.timezone.displayTimeZone}
        </span>
      </div>
      {overlaysOpen && (
        <div className="overlay-panel">
          <div className="overlay-row">
            <span className="tb-label">EMA lengths</span>
            <div className="chips">
              {[21, 50, 200].map((len) => (
                <button
                  key={len}
                  className={`chip ${emaLengths.includes(len) ? "on" : ""}`}
                  onClick={() => toggleEma(len)}
                >
                  EMA {len}
                </button>
              ))}
            </div>
          </div>
          <div className="overlay-row">
            <span className="tb-label">Colors</span>
            <div className="chips">
              {emaLengths.map((len) => (
                <label key={len} className="overlay-color">
                  <input
                    type="color"
                    value={emaColors[len] ?? EMA_DEFAULTS[len]}
                    onChange={(e) => setEmaColors({ ...emaColors, [len]: e.target.value })}
                  />
                  <span className="mono">EMA {len}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="overlay-row">
            <span className="tb-label">VWAP</span>
            <div className="chips">
              <button
                className={`chip ${settings.indicators.vwap ? "on" : ""}`}
                onClick={() => controller.toggleIndicator("vwap")}
              >
                {settings.indicators.vwap ? "Shown" : "Hidden"}
              </button>
              <label className="overlay-color">
                <input
                  type="color"
                  value={vwapColor}
                  onChange={(e) => setVwapColor(e.target.value)}
                />
                <span className="mono">VWAP</span>
              </label>
            </div>
          </div>
          <div className="overlay-row">
            <span className="tb-label">Defaults</span>
            <div className="chips">
              <button className="chip" onClick={() => setEmaLengths([21])}>
                EMA 21 only
              </button>
              <button className="chip" onClick={() => setEmaLengths([21, 50])}>
                21 + 50
              </button>
              <button
                className="chip"
                onClick={() => {
                  setEmaLengths([21]);
                  setEmaColors({ ...EMA_DEFAULTS });
                  setVwapColor(DEFAULT_VWAP_COLOR);
                  controller.updateSettings({ indicators: { ...settings.indicators, ema50: false, ema200: false } });
                }}
              >
                Reset all
              </button>
            </div>
          </div>
          <p className="dim" style={{ fontSize: 10.5, margin: 0 }}>
            VWAP is session-anchored from the first bar; opening range is anchored at 09:30 New York.
          </p>
        </div>
      )}
      {legend}
      <div
        className="chart-wrap"
        ref={wrapRef}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          hoverRef.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            index: engine?.cursor ?? 0,
          };
          bumpDraw((n) => n + 1);
        }}
        onMouseLeave={() => {
          hoverRef.current = null;
          bumpDraw((n) => n + 1);
        }}
        onWheel={(e) => {
          // Zoom only; the pane never scrolls so no preventDefault is needed
          // (React registers wheel listeners as passive).
          setViewCount((c) => Math.max(40, Math.min(1200, Math.round(c * (e.deltaY > 0 ? 1.12 : 0.89)))));
        }}
      >
        <canvas className="chart-canvas" ref={canvasRef} />
      </div>
    </>
  );
}
