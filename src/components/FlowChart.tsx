import { useEffect, useRef } from "react";
import type { VolumeAtPrice } from "../flow/orderFlow";

interface FlowChartProps {
  priceSeries: Array<{ t: number; price: number }>;
  cvdSeries: number[];
  profile: VolumeAtPrice[];
  showCvd: boolean;
  showProfile: boolean;
  vwap: number | null;
}

/* Canvas-drawn chart for the Flow Lab: traded-price path, CVD band and a
   volume-at-price profile. Colours mirror the terminal's CSS tokens. */

const C = {
  bg: "#0a0d10",
  grid: "#161b21",
  line: "#e6a93c",
  vwap: "#4d8ff0",
  cvd: "#a78bfa",
  up: "#2fbf71",
  down: "#e5484d",
  dim: "#55606b",
  text: "#7c8894",
};

export function FlowChart({ priceSeries, cvdSeries, profile, showCvd, showProfile, vwap }: FlowChartProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const width = wrap.clientWidth || 800;
      const height = wrap.clientHeight || 420;
      const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, width, height);

      const profileWidth = showProfile && profile.length > 0 ? Math.min(130, Math.max(70, width * 0.14)) : 0;
      const mainW = width - profileWidth - 46;
      const priceH = showCvd ? height * 0.68 : height - 22;
      const cvdTop = priceH + 12;
      const cvdH = height - cvdTop - 18;

      const prices = priceSeries.map((p) => p.price);
      const allPrices = vwap !== null ? [...prices, vwap] : prices;
      if (allPrices.length === 0) {
        ctx.fillStyle = C.dim;
        ctx.font = "12px IBM Plex Mono, monospace";
        ctx.fillText("Generate a scenario, then step or play to reveal the tape.", 16, height / 2);
        return;
      }
      let lo = Math.min(...allPrices);
      let hi = Math.max(...allPrices);
      const pad = Math.max((hi - lo) * 0.08, 0.75);
      lo -= pad;
      hi += pad;
      const px = (i: number) => (mainW * i) / Math.max(1, priceSeries.length - 1);
      const py = (p: number) => 10 + (priceH - 20) * (1 - (p - lo) / (hi - lo));

      // gridlines
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.font = "10px IBM Plex Mono, monospace";
      for (let g = 0; g <= 4; g++) {
        const y = 10 + ((priceH - 20) * g) / 4;
        ctx.beginPath();
        ctx.moveTo(40, y);
        ctx.lineTo(40 + mainW, y);
        ctx.stroke();
        const val = hi - ((hi - lo) * g) / 4;
        ctx.fillStyle = C.dim;
        ctx.fillText(val.toFixed(2), 4, y + 3);
      }

      // VWAP
      if (vwap !== null) {
        ctx.strokeStyle = C.vwap;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(40, py(vwap));
        ctx.lineTo(40 + mainW, py(vwap));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // price path
      if (priceSeries.length > 1) {
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        priceSeries.forEach((p, i) => {
          const x = 40 + px(i);
          if (i === 0) ctx.moveTo(x, py(p.price));
          else ctx.lineTo(x, py(p.price));
        });
        ctx.stroke();
        // last price marker
        const last = priceSeries[priceSeries.length - 1];
        ctx.fillStyle = C.line;
        ctx.beginPath();
        ctx.arc(40 + px(priceSeries.length - 1), py(last.price), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // CVD band
      if (showCvd && cvdSeries.length > 1 && cvdH > 24) {
        let cLo = Math.min(...cvdSeries);
        let cHi = Math.max(...cvdSeries);
        if (cHi - cLo < 1) {
          cHi += 1;
          cLo -= 1;
        }
        ctx.strokeStyle = "#1c232b";
        ctx.beginPath();
        ctx.moveTo(40, cvdTop + cvdH / 2);
        ctx.lineTo(40 + mainW, cvdTop + cvdH / 2);
        ctx.stroke();
        ctx.strokeStyle = C.cvd;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        cvdSeries.forEach((v, i) => {
          const x = 40 + (mainW * i) / (cvdSeries.length - 1);
          const y = cvdTop + cvdH * (1 - (v - cLo) / (cHi - cLo));
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.fillStyle = C.dim;
        ctx.fillText("CVD", 44, cvdTop + 10);
      }

      // volume profile
      if (showProfile && profile.length > 0 && profileWidth > 0) {
        const maxTotal = Math.max(...profile.map((p) => p.total)) || 1;
        const barH = Math.max(2, (priceH - 20) / profile.length);
        for (const p of profile) {
          const y = py(p.price) - barH / 2;
          const w = (p.total / maxTotal) * (profileWidth - 8);
          const total = p.total || 1;
          const buyW = (p.buy / total) * w;
          ctx.fillStyle = C.down;
          ctx.fillRect(40 + mainW + 6, y, w - buyW, barH - 1);
          ctx.fillStyle = C.up;
          ctx.fillRect(40 + mainW + 6 + w - buyW, y, buyW, barH - 1);
        }
        ctx.fillStyle = C.dim;
        ctx.fillText("PROFILE", 40 + mainW + 6, 12);
      }
    };

    draw();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [priceSeries, cvdSeries, profile, showCvd, showProfile, vwap]);

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", minHeight: 320 }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
