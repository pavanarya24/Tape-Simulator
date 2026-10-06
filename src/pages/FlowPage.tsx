import { useEffect, useMemo, useState } from "react";
import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { FlowChart, type FlowChartTrade } from "../components/FlowChart";
import { FLOW_DIFFICULTIES, FLOW_SCENARIOS, scenarioName, type FlowDifficulty, type FlowScenarioId } from "../flow/scenarios";
import { flowEvidenceLabel } from "../flow/recognition";
import type { FlowBias, FlowPrediction } from "../flow/execution";
import type { Level } from "../flow/dom";
import { money, pct, pnlClass, price as fmtPrice, signedMoney } from "../util/format";
/* --- Phase 8 modules --- */
import {
  FLOW_REPLAY_MODES,
  FLOW_REPLAY_MODE_HINTS,
  FLOW_REPLAY_SPEEDS,
  FLOW_STEP_UNITS,
  playbackBatch,
  type FlowReplayMode,
  type FlowReplaySpeed,
  type FlowStepUnit,
} from "../flow/replay";
import { buildTapeRows, summariseTape, TAPE_FILTERS, type TapeFilter, type TapeRow } from "../flow/tape";
import { BOOK_CHANGE_LABELS, countChanges, type BookChange } from "../flow/domDiff";
import { FLOW_SHORTCUT_KEYS, isTypingTarget, resolveFlowShortcut } from "../flow/keyboard";
import { INSUFFICIENT_SAMPLE_LABEL, type FlowAnalytics } from "../flow/analytics";
import type { FlowReview } from "../flow/review";

const ANCHOR_TZ = "America/New_York";

const PATTERN_OPTIONS: Array<{ id: FlowScenarioId | "any"; label: string }> = [
  { id: "any", label: "Any pattern" },
  ...FLOW_SCENARIOS.map((s) => ({ id: s.id, label: `${s.name} only` })),
];

const PREDICTION_OPTIONS: Array<{ id: FlowPrediction; label: string }> = [
  { id: "unknown", label: "Unknown" },
  ...FLOW_SCENARIOS.map((s) => ({ id: s.id, label: s.name })),
];

const BIAS_OPTIONS: FlowBias[] = ["LONG", "SHORT", "NEUTRAL"];
const CONFIDENCE_LEVELS = [1, 2, 3, 4, 5];

const DIFFICULTY_HINTS: Record<FlowDifficulty, string> = {
  BEGINNER: "clean signatures, fewer conflicting signals",
  INTERMEDIATE: "moderate signal strength with more tape noise",
  ADVANCED: "conflicting signals, weaker and delayed confirmation",
  EXPERT: "deceptive flow, competing signals and late confirmation",
};

const TAPE_FILTER_LABELS: Record<TapeFilter, string> = {
  ALL: "All",
  BUY: "Buy",
  SELL: "Sell",
  LARGE: "Large",
};

const REPLAY_MODE_LABELS: Record<FlowReplayMode, string> = {
  LIVE: "LIVE REPLAY",
  BLIND: "BLIND TRAINING",
  BAR_CONTEXT: "BAR CONTEXT",
  REVIEW: "REVIEW",
};

/** Parse a risk/cost input: empty string means "off" (null). */
function numVal(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const tapeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ANCHOR_TZ,
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function tapeTime(t: number): string {
  return tapeFmt.format(new Date(t));
}

/* ------------------------------- page ------------------------------- */

export function FlowPage({ state }: { state: AppState }) {
  const flow = state.flow;
  const [pattern, setPattern] = useState<FlowScenarioId | "any">("any");
  const [showCvd, setShowCvd] = useState(true);
  const [showProfile, setShowProfile] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showAma, setShowAma] = useState(true);
  const [showTradeMarkers, setShowTradeMarkers] = useState(true);
  const [tapeFilter, setTapeFilter] = useState<TapeFilter>("ALL");
  const [playing, setPlaying] = useState(false);

  /* ---- playback: speed changes whole-event batch size + tick rate only,
         never the order of the single event clock (spec §8A.1) ---- */
  useEffect(() => {
    if (!playing) return;
    const batch = playbackBatch(flow.speed);
    const id = setInterval(() => {
      if (!controller.stepFlow(batch.eventsPerTick)) setPlaying(false);
    }, batch.intervalMs);
    return () => clearInterval(id);
  }, [playing, flow.speed]);

  useEffect(() => {
    if (flow.atEnd && playing) setPlaying(false);
  }, [flow.atEnd, playing]);

  /* ---- keyboard shortcuts (spec §11) — never fire while typing ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el ? isTypingTarget(el.tagName, el.isContentEditable) : false;
      const action = resolveFlowShortcut(e.key, typing);
      if (!action) return;
      e.preventDefault();
      switch (action) {
        case "PLAY_PAUSE":
          setPlaying((p) => !p);
          break;
        case "STEP_FORWARD":
          controller.stepFlowUnit();
          break;
        case "STEP_BACK":
          controller.stepFlowBack();
          break;
        case "RESET":
          setPlaying(false);
          controller.resetFlow();
          break;
        case "BUY":
          controller.flowBuy();
          break;
        case "SELL":
          controller.flowSell();
          break;
        case "FLATTEN":
          controller.flowFlatten();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const of = flow.orderFlow;
  const dom = flow.dom;
  const maxLevelSize = flow.book
    ? Math.max(...flow.book.bids.map((l) => l.size), ...flow.book.asks.map((l) => l.size), 1)
    : 1;

  // The engine keeps the tape oldest-first — show the newest print at the top.
  const tapeRows = useMemo(
    () => buildTapeRows([...(of?.tape ?? [])].reverse(), tapeFilter),
    [of?.tape, tapeFilter],
  );
  const tapeSummary = useMemo(() => summariseTape(tapeRows), [tapeRows]);

  const changeByKey = useMemo(() => {
    const map = new Map<string, BookChange>();
    for (const c of flow.bookChanges) map.set(`${c.side}:${c.price}`, c);
    return map;
  }, [flow.bookChanges]);

  const chartTrades: FlowChartTrade[] | null =
    flow.policy.tradeMarkers && showTradeMarkers && flow.trades.length > 0
      ? flow.trades.map((t) => ({
          tradeId: t.tradeId,
          side: t.side,
          quantity: t.quantity,
          entryTimestamp: t.entryTimestamp,
          exitTimestamp: t.exitTimestamp,
          entryPrice: t.entryPrice,
          exitPrice: t.exitPrice,
          netPnL: t.netPnL,
          mfe: t.maxFavorableExcursion,
          mae: t.maxAdverseExcursion,
        }))
      : null;

  const status = !flow.active
    ? "NO SCENARIO"
    : playing
      ? "PLAYING"
      : flow.atEnd
        ? "AT END"
        : flow.held
          ? "REVEALED"
          : "PAUSED";

  return (
    <>
      <h2>Flow Lab — professional replay &amp; training</h2>
      <p className="lede">
        READ → DECIDE → EXECUTE → MANAGE → SCORE. One event clock drives every panel: price, Time
        &amp; Sales, DOM, CVD, profile, order flow, AMA, VWAP, evidence, recognition and P&amp;L all
        advance from the same event. Replay it, review it, and drill the patterns.
      </p>

      <div className="callout info flow-honesty">
        <span className="badge mono">SYNTHETIC TRAINING DATA</span>{" "}
        <span className="badge mono">SIMULATED TRADING — SYNTHETIC MARKET DATA</span>{" "}
        <span className="dim">
          Every event is generated for practice. No real CME/NQ data, no real liquidity, no real
          fills — the same architecture is ready for future real feeds (Databento / Rithmic) without
          changing the training layers.
        </span>
      </div>

      {/* ============================ 8B HEADER ============================ */}
      <div className="card flow-header">
        <div className="card-head">
          <h3>Flow Lab</h3>
          <span className={`right badge ${playing ? "ok" : ""}`}>{status}</span>
        </div>
        <div className="card-body">
          <div className="flow-header-grid">
            <div className="field">
              <label>Scenario</label>
              <select value={pattern} onChange={(e) => setPattern(e.target.value as FlowScenarioId | "any")}>
                {PATTERN_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Data source</label>
              <div className="flow-header-readonly">
                <span className="mono">{flow.source}</span>
                <span className={`badge ${flow.isRealData ? "warn" : "demo"}`}>
                  {flow.isRealData ? "REAL" : "SYNTHETIC"}
                </span>
              </div>
            </div>
            <div className="field">
              <label>Difficulty</label>
              <select
                value={flow.difficulty}
                title={DIFFICULTY_HINTS[flow.difficulty]}
                onChange={(e) => controller.setFlowDifficulty(e.target.value as FlowDifficulty)}
              >
                {FLOW_DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>{d[0] + d.slice(1).toLowerCase()}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Replay mode</label>
              <select
                value={flow.replayMode}
                onChange={(e) => controller.setFlowReplayMode(e.target.value as FlowReplayMode)}
                title={FLOW_REPLAY_MODE_HINTS[flow.replayMode]}
              >
                {FLOW_REPLAY_MODES.map((m) => (
                  <option key={m} value={m}>{REPLAY_MODE_LABELS[m]}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Status</label>
              <div className="flow-header-readonly">
                <span className="mono">{flow.eventIndex} / {flow.totalEvents}</span>
                <span className="dim mono">
                  {flow.timestamp !== null ? tapeTime(flow.timestamp) : "—"}
                </span>
              </div>
            </div>
          </div>
          <button
            className="btn primary"
            style={{ marginTop: 10 }}
            onClick={() => { setPlaying(false); controller.generateFlowScenario(pattern); }}
          >
            GENERATE SCENARIO
          </button>
        </div>
      </div>

      {/* ============================== CHART ============================== */}
      <div className="card">
        <div className="card-head">
          <h3>Price / Flow chart</h3>
          <div className="right chips">
            <button className={`chip ${showCvd ? "on" : ""}`} onClick={() => setShowCvd((v) => !v)} title="Cumulative volume delta pane">
              CVD
            </button>
            <button className={`chip ${showProfile ? "on" : ""}`} onClick={() => setShowProfile((v) => !v)} title="Volume-at-price profile gutter">
              Profile
            </button>
            <button
              className={`chip ${showMarkers ? "on" : ""}`}
              onClick={() => setShowMarkers((v) => !v)}
              title="Objective evidence markers — observable only, never a pattern call"
            >
              Evidence
            </button>
            <button className={`chip ${showAma ? "on" : ""}`} onClick={() => setShowAma((v) => !v)} title="Adaptive Moving Average">
              AMA
            </button>
            <button
              className={`chip ${showTradeMarkers && flow.policy.tradeMarkers ? "on" : ""}`}
              onClick={() => setShowTradeMarkers((v) => !v)}
              disabled={!flow.policy.tradeMarkers}
              title={flow.policy.tradeMarkers ? "Entry/exit markers (review)" : "Entry/exit markers unlock after Reveal"}
            >
              Trades
            </button>
            <span className="badge mono" title="Current Adaptive Moving Average">
              AMA {flow.ama !== null ? fmtPrice(flow.ama) : "—"}
            </span>
          </div>
        </div>
        <div style={{ height: 460 }}>
          <FlowChart
            priceSeries={flow.priceSeries}
            cvdSeries={of?.cvdSeries ?? []}
            tradeCount={of?.tradeCount ?? 0}
            profile={of?.volumeAtPrice ?? []}
            showCvd={showCvd}
            showProfile={showProfile}
            vwap={of && of.vwap > 0 ? of.vwap : null}
            ama={showAma ? flow.amaSeries : null}
            annotations={flow.annotations}
            showAnnotations={showMarkers}
            trades={chartTrades}
            showTradeMarkers={showTradeMarkers}
            coarseContext={flow.policy.coarseContext}
          />
        </div>
        <p className="dim" style={{ fontSize: 10, margin: "8px 0 0", lineHeight: 1.5 }}>
          Candles are time-bucketed OHLC aggregates of the revealed synthetic tape. Markers map by
          timestamp/sequence — never by array index — so a decimated price series stays aligned.
          {flow.policy.tradeMarkers
            ? " Entry/exit markers are review-only overlays."
            : " Pattern interpretation annotations stay hidden while blind."}
        </p>
      </div>

      {/* ====================== TAPE | DOM ====================== */}
      <div className="flow-grid">
        {/* ---- 8B.2 Time & Sales ---- */}
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Time &amp; Sales</span>
            <div className="right chips">
              {TAPE_FILTERS.map((f) => (
                <button key={f} className={`chip ${tapeFilter === f ? "on" : ""}`} onClick={() => setTapeFilter(f)}>
                  {TAPE_FILTER_LABELS[f]}
                </button>
              ))}
            </div>
          </div>
          <div className="panel-body flow-tape">
            <div className="flow-tape-summary mono">
              <span>{tapeSummary.prints} prints</span>
              <span className="up">{tapeSummary.buyVolume} buy</span>
              <span className="down">{tapeSummary.sellVolume} sell</span>
              <span>{tapeSummary.largePrints} large</span>
              <span>{tapeSummary.sweeps} sweep</span>
              <span>{tapeSummary.bursts} burst</span>
            </div>
            {tapeRows.length === 0 ? (
              <p className="dim" style={{ fontSize: 11, margin: "8px 0 0" }}>
                {flow.active ? "No prints match this filter yet." : "Generate a scenario to reveal the tape."}
              </p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th><th className="r">Price</th><th className="r">Size</th>
                    <th className="r">Rel</th><th className="r">Aggressor</th>
                  </tr>
                </thead>
                <tbody>
                  {tapeRows.map((r) => (
                    <TapeRowView key={r.sequence} row={r} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="dim" style={{ fontSize: 10, margin: "8px 0 0", lineHeight: 1.5 }}>
            Aggressor comes from the feed's <span className="mono">aggressorSide</span> — never inferred
            from candle direction. Filters change the view only; the replay engine still consumes every
            print.
          </p>
        </section>

        {/* ---- 8B.3 DOM ---- */}
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">DOM / Level 2</span>
            <span className="right badge">
              {dom?.hasBook ? `SPR ${fmtPrice(dom.spread ?? 0)}` : "NO BOOK"}
            </span>
          </div>
          <div className="panel-body">
            {dom && flow.book ? (
              <>
                <DOMSide levels={flow.book.asks} side="ask" maxSize={maxLevelSize} changes={changeByKey} />
                <div className="flow-mid mono">
                  {fmtPrice(dom.bestBid ?? 0)} × {fmtPrice(dom.bestAsk ?? 0)}
                </div>
                <DOMSide levels={flow.book.bids} side="bid" maxSize={maxLevelSize} changes={changeByKey} />
                <div className="flow-dom-changes">
                  {(["NEW", "ADDED", "PULLED", "REMOVED"] as const).map((k) => (
                    <span key={k} className={`badge flow-change-${k.toLowerCase()}`}>
                      {BOOK_CHANGE_LABELS[k]} {countChanges(flow.bookChanges, k)}
                    </span>
                  ))}
                </div>
                <div className="kv" style={{ marginTop: 10 }}>
                  <span className="k">Bid liquidity</span><span className="v up">{dom.totalBidLiquidity}</span>
                  <span className="k">Ask liquidity</span><span className="v down">{dom.totalAskLiquidity}</span>
                  <span className="k">Imbalance</span>
                  <span className="v">{dom.imbalance !== null ? `${(dom.imbalance * 100).toFixed(1)}%` : "—"}</span>
                  <span className="k">Stacking</span><span className="v">{dom.stackBidLevels}B / {dom.stackAskLevels}A</span>
                  <span className="k">Pulls</span><span className="v">{dom.pullBidCount}B / {dom.pullAskCount}A</span>
                  <span className="k">Replenished</span><span className="v">{dom.replenishCount}</span>
                  <span className="k">Sweeps</span><span className="v">{dom.sweepBuyCount} up / {dom.sweepSellCount} down</span>
                  <span className="k">Top-of-book chg</span><span className="v">{dom.topOfBookChanges}</span>
                </div>
              </>
            ) : (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>No book snapshot revealed yet.</p>
            )}
          </div>
          <p className="dim" style={{ fontSize: 10, margin: "8px 0 0", lineHeight: 1.5 }}>
            The DOM is the current event's book only. Level highlighting is a diff against the previous
            revealed event.
          </p>
        </section>
      </div>

      {/* ====================== ORDER FLOW | EXECUTION ====================== */}
      <div className="flow-grid">
        {/* ---- 8B.4 Order flow ---- */}
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Order flow</span>
            <span className="right badge">{of ? `SEQ ${of.sequence}` : "—"}</span>
          </div>
          <div className="panel-body">
            {of ? (
              <div className="kv">
                <span className="k">Delta</span>
                <span className={`v ${pnlClass(of.delta)}`}>{of.delta}</span>
                <span className="k">Cumulative delta</span>
                <span className={`v ${pnlClass(of.cumulativeDelta)}`}>{of.cumulativeDelta}</span>
                <span className="k">Buy volume</span><span className="v up">{of.totalBuyVolume}</span>
                <span className="k">Sell volume</span><span className="v down">{of.totalSellVolume}</span>
                <span className="k">Aggression</span>
                <span className="v">{of.buyAggressionPct.toFixed(1)}% buy · {of.sellAggressionPct.toFixed(1)}% sell</span>
                <span className="k">Trade velocity</span><span className="v">{of.velocityPerMin}/min</span>
                <span className="k">Last / VWAP</span>
                <span className="v mono">{fmtPrice(of.lastPrice)} / {fmtPrice(of.vwap)}</span>
                <span className="k">Bid/ask imbalance</span>
                <span className="v">{of.bidAskImbalance !== null ? `${(of.bidAskImbalance * 100).toFixed(1)}%` : "—"}</span>
                <span className="k">Volume at price</span>
                <span className="v">{of.volumeAtPrice.length} levels · busiest {of.volumeAtPrice.length > 0 ? fmtPrice(of.volumeAtPrice.reduce((a, b) => (b.total > a.total ? b : a)).price) : "—"}</span>
                <span className="k">Sweeps</span>
                <span className="v">{dom ? `${dom.sweepBuyCount} up / ${dom.sweepSellCount} down` : "—"}</span>
                <span className="k">Pulls</span>
                <span className="v">{dom ? `${dom.pullBidCount}B / ${dom.pullAskCount}A` : "—"}</span>
                <span className="k">Stacking</span>
                <span className="v">{dom ? `${dom.stackBidLevels}B / ${dom.stackAskLevels}A` : "—"}</span>
                <span className="k">Replenishment</span><span className="v">{dom ? dom.replenishCount : "—"}</span>
              </div>
            ) : (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>Generate a scenario to see order-flow statistics.</p>
            )}
          </div>
        </section>

        {/* ---- 8B.5 Execution ---- */}
        <section className="panel flow-execution">
          <div className="panel-head">
            <span className="panel-title">Position / Execution</span>
            <span className="right badge warn">SIMULATED TRADING — SYNTHETIC MARKET DATA</span>
          </div>
          <div className="panel-body">
            {!flow.active ? (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>
                Generate a scenario to trade the synthetic tape. Market orders fill at the current
                revealed bid/ask — never against future events.
              </p>
            ) : (
              <>
                <div className={`flow-pos-side ${flow.position.side === "LONG" ? "long" : flow.position.side === "SHORT" ? "short" : "flat"}`}>
                  {flow.position.side}
                  {flow.position.quantity > 0 && <span className="flow-pos-qty"> × {flow.position.quantity}</span>}
                </div>
                <div className="flow-qty-row">
                  <label htmlFor="flow-qty">Quantity</label>
                  <input
                    id="flow-qty"
                    type="number"
                    min={1}
                    max={flow.risk.maxPositionQty}
                    value={flow.orderQty}
                    onChange={(e) => controller.setFlowQty(Number(e.target.value))}
                  />
                </div>
                <div className="btn-row flow-trade-btns">
                  <button className="btn buy" onClick={() => controller.flowBuy()} disabled={flow.held}>BUY</button>
                  <button className="btn sell" onClick={() => controller.flowSell()} disabled={flow.held}>SELL</button>
                  <button className="btn flat" onClick={() => controller.flowFlatten()} disabled={flow.held || flow.position.side === "FLAT"}>
                    FLATTEN
                  </button>
                </div>
                <div className="kv flow-pos-kv">
                  <span className="k">Avg entry</span>
                  <span className="v mono">{flow.position.averageEntryPrice !== null ? fmtPrice(flow.position.averageEntryPrice) : "—"}</span>
                  <span className="k">Current</span>
                  <span className="v mono">{flow.position.currentPrice !== null ? fmtPrice(flow.position.currentPrice) : "—"}</span>
                  <span className="k">Unrealized</span>
                  <span className={`v mono ${pnlClass(flow.position.unrealizedPnL)}`}>{signedMoney(flow.position.unrealizedPnL)}</span>
                  <span className="k">Realized</span>
                  <span className={`v mono ${pnlClass(flow.position.realizedPnL)}`}>{signedMoney(flow.position.realizedPnL)}</span>
                  <span className="k">Net</span>
                  <span className={`v mono ${pnlClass(flow.position.totalPnL)}`}>{signedMoney(flow.position.totalPnL)}</span>
                  <span className="k">MFE</span>
                  <span className="v mono up">{flow.position.maxFavorableExcursion > 0 ? signedMoney(flow.position.maxFavorableExcursion) : "—"}</span>
                  <span className="k">MAE</span>
                  <span className="v mono down">{flow.position.maxAdverseExcursion > 0 ? signedMoney(flow.position.maxAdverseExcursion) : "—"}</span>
                  <span className="k">Costs accrued</span><span className="v mono dim">{money(flow.position.costsAccrued)}</span>
                </div>
                {flow.notice && <p className={`flow-notice ${flow.notice.ok ? "ok" : "bad"}`}>{flow.notice.text}</p>}
              </>
            )}
          </div>
        </section>
      </div>

      {/* ====================== DECISION / TRADING ====================== */}
      <div className="card">
        <div className="card-head">
          <h3>Decision / Trading</h3>
          <span className="right badge">CAPTURED WITH EACH ENTRY</span>
        </div>
        <div className="card-body">
          {!flow.active ? (
            <p className="dim" style={{ fontSize: 11, margin: 0 }}>Generate a scenario to record a read.</p>
          ) : (
            <div className="flow-decision-grid">
              <div className="flow-block">
                <p className="flow-block-title">READ</p>
                <div className="flow-decision-row">
                  <span className="flow-decision-label">Bias</span>
                  {BIAS_OPTIONS.map((b) => (
                    <button key={b} className={`chip ${flow.decision.bias === b ? "on" : ""}`} onClick={() => controller.setFlowDecision({ bias: b })}>
                      {b}
                    </button>
                  ))}
                </div>
                <div className="field">
                  <label>Pattern prediction</label>
                  <select value={flow.decision.expected} onChange={(e) => controller.setFlowDecision({ expected: e.target.value as FlowPrediction })}>
                    {PREDICTION_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flow-block">
                <p className="flow-block-title">CONVICTION</p>
                <div className="flow-decision-row">
                  <span className="flow-decision-label">Confidence</span>
                  {CONFIDENCE_LEVELS.map((n) => (
                    <button key={n} className={`chip ${flow.decision.level === n ? "on" : ""}`} onClick={() => controller.setFlowDecision({ level: n })}>
                      {n}
                    </button>
                  ))}
                </div>
                <div className="field wide">
                  <label>Reason</label>
                  <input
                    type="text"
                    placeholder="Why you are taking this trade…"
                    value={flow.decision.reason}
                    onChange={(e) => controller.setFlowDecision({ reason: e.target.value })}
                  />
                </div>
              </div>
              <div className="flow-block">
                <p className="flow-block-title">RISK &amp; COSTS</p>
                <div className="field">
                  <label>Max position</label>
                  <input type="number" min={1} value={flow.risk.maxPositionQty} onChange={(e) => controller.setFlowRisk({ maxPositionQty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
                </div>
                <div className="field">
                  <label>Stop (ticks)</label>
                  <input type="number" min={0} placeholder="off" value={flow.risk.stopLossTicks ?? ""} onChange={(e) => controller.setFlowRisk({ stopLossTicks: numVal(e.target.value) })} />
                </div>
                <div className="field">
                  <label>Target (ticks)</label>
                  <input type="number" min={0} placeholder="off" value={flow.risk.takeProfitTicks ?? ""} onChange={(e) => controller.setFlowRisk({ takeProfitTicks: numVal(e.target.value) })} />
                </div>
                <div className="field">
                  <label>Commission $</label>
                  <input type="number" min={0} step={0.25} value={flow.costs.commissionPerContract} onChange={(e) => controller.setFlowCosts({ commissionPerContract: Math.max(0, numVal(e.target.value) ?? 0) })} />
                </div>
                <div className="field">
                  <label>Slippage (ticks)</label>
                  <input type="number" min={0} value={flow.costs.slippageTicks} onChange={(e) => controller.setFlowCosts({ slippageTicks: Math.max(0, Math.floor(numVal(e.target.value) ?? 0)) })} />
                </div>
              </div>
              <div className="flow-block">
                <p className="flow-block-title">REVEAL</p>
                {flow.revealed ? (
                  <>
                    <div className="flow-truth-name" style={{ fontSize: 15 }}>
                      {scenarioName(flow.revealed.pattern)}
                      <span className={`badge ${flow.revealed.direction === "bullish" ? "ok" : "bad"}`}>
                        {flow.revealed.direction.toUpperCase()}
                      </span>
                    </div>
                    <p className="dim" style={{ fontSize: 10.5, margin: 0 }}>
                      Key window: events {flow.revealed.startEvent}–{flow.revealed.endEvent} · generator
                      confidence {pct(flow.revealed.confidence * 100)}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="dim" style={{ fontSize: 11, marginTop: 0 }}>
                      Commit to a read first. Revealing ends the exercise and unlocks REVIEW.
                    </p>
                    <button className="btn primary wide" onClick={() => { setPlaying(false); controller.revealFlow(); }}>
                      REVEAL WHAT IT WAS
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ====================== 8A REPLAY CONTROLS / TIMELINE ====================== */}
      <div className="card flow-replay-bar">
        <div className="card-head">
          <h3>Replay controls / timeline</h3>
          <span className="right badge mono">
            {flow.eventIndex} / {flow.totalEvents} events · {flow.progressPct}%
          </span>
        </div>
        <div className="card-body">
          <div className="flow-controls">
            <div className="field">
              <label>Step unit</label>
              <select value={flow.stepUnit} onChange={(e) => controller.setFlowStepUnit(e.target.value as FlowStepUnit)}>
                {FLOW_STEP_UNITS.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Speed</label>
              <select value={flow.speed} onChange={(e) => controller.setFlowSpeed(Number(e.target.value) as FlowReplaySpeed)}>
                {FLOW_REPLAY_SPEEDS.map((s) => (
                  <option key={s} value={s}>{s}×</option>
                ))}
              </select>
            </div>
            <button className="btn" onClick={() => { setPlaying(false); controller.stepFlowBack(); }} disabled={!flow.active || flow.held || flow.atStart}>
              ◀ STEP
            </button>
            <button className="btn" onClick={() => { setPlaying(false); controller.stepFlowUnit(); }} disabled={!flow.active || flow.held || flow.atEnd}>
              STEP ▶
            </button>
            <button
              className={playing ? "btn primary" : "btn"}
              onClick={() => setPlaying((p) => !p)}
              disabled={!flow.active || flow.held || flow.atEnd}
            >
              {playing ? "⏸ PAUSE" : "▶ PLAY"}
            </button>
            <button className="btn" onClick={() => { setPlaying(false); controller.resetFlow(); }} disabled={!flow.active}>
              ⟲ RESET
            </button>
            <button className="btn" onClick={() => { setPlaying(false); controller.restartFlowScenario(); }} disabled={!flow.active} title="Same seed, same events — clean position and journal">
              RESTART SCENARIO
            </button>
            <button
              className="btn"
              onClick={() => { setPlaying(false); controller.replayFlowFromStart(); }}
              disabled={!flow.active || flow.position.side !== "FLAT"}
              title={flow.position.side !== "FLAT" ? "Flatten first" : "Rewind the tape to the first event"}
            >
              REPLAY FROM START
            </button>
            {flow.revealed && flow.held && (
              <button className="btn primary" onClick={() => controller.continueFlowAfterReveal()}>
                CONTINUE AFTER REVEAL
              </button>
            )}
          </div>

          {/* timeline scrubber — seeking rebuilds deterministically */}
          <div className="flow-timeline-scrub">
            <span className="dim mono">START</span>
            <input
              type="range"
              min={0}
              max={Math.max(flow.totalEvents, 1)}
              value={flow.eventIndex}
              disabled={!flow.active}
              onChange={(e) => { setPlaying(false); controller.seekFlow(Number(e.target.value)); }}
              aria-label="Scenario timeline"
            />
            <span className="dim mono">END</span>
          </div>
          <div className="flow-progress" title={`${flow.progressPct}% revealed`}>
            <div style={{ width: `${flow.progressPct}%` }} />
          </div>
          <p className="dim" style={{ fontSize: 10, margin: "9px 0 0", lineHeight: 1.5 }}>
            {flow.policy.forwardSeek
              ? "Review mode: seek anywhere. Every jump rebuilds events 0..N deterministically, so the state is identical to reset → replay."
              : "Blind modes seek backward only — no future event is ever read. Seeking rebuilds events 0..N deterministically."}
            {" "}Single event clock: price, tape, DOM, CVD, profile, AMA, VWAP, evidence, recognition and P&L all advance together.
          </p>
          <div className="flow-kbd-legend">
            {(["PLAY_PAUSE", "STEP_FORWARD", "STEP_BACK", "RESET", "BUY", "SELL", "FLATTEN"] as const).map((s) => (
              <span key={s} className="flow-kbd">
                <kbd>{FLOW_SHORTCUT_KEYS[s]}</kbd>
                <span className="dim">{s.replace("_", " ").toLowerCase()}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ====================== ANSWER + RECOGNITION ====================== */}
      <div className="flow-grid">
        <section className="panel flow-reveal">
          <div className="panel-head">
            <span className="panel-title">Answer</span>
            <span className="right badge">{flow.revealed ? "REVEALED" : "HIDDEN"}</span>
          </div>
          <div className="panel-body">
            {!flow.active ? (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>Generate a scenario first. The pattern stays hidden while you read the tape.</p>
            ) : flow.revealed ? (
              <>
                <ul className="flow-truth-list">
                  {flow.revealed.characteristics.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                {flow.results && (
                  <div className="kv" style={{ marginTop: 10 }}>
                    <span className="k">Your prediction</span>
                    <span className={`v ${flow.results.patternResult === "CORRECT" ? "up" : flow.results.patternResult === "INCORRECT" ? "down" : ""}`}>
                      {flow.results.predictionName} · {flow.results.patternResult}
                    </span>
                    <span className="k">Engine recognition</span>
                    <span className={`v ${flow.results.recognitionResult === "CORRECT" ? "up" : flow.results.recognitionResult === "INCORRECT" ? "down" : "dim"}`}>
                      {flow.results.recognitionPattern === "unknown" ? "NO SIGNAL" : scenarioName(flow.results.recognitionPattern)} · {flow.results.recognitionResult}
                    </span>
                    <span className="k">Entry timing</span><span className="v">{flow.results.entryTiming}</span>
                    <span className="k">Net P&amp;L</span>
                    <span className={`v mono ${pnlClass(flow.results.netPnL)}`}>{signedMoney(flow.results.netPnL)}</span>
                  </div>
                )}
              </>
            ) : (
              <p className="dim" style={{ fontSize: 11, marginTop: 0 }}>
                Commit to a read from the tape, CVD and DOM first — then reveal.
              </p>
            )}
          </div>
        </section>

        <section className="panel flow-evidence">
          <div className="panel-head">
            <span className="panel-title">Flow evidence</span>
            <span className="right badge">{flow.revealed ? "OBSERVABLE DATA" : "OBSERVATIONS ONLY — NO PATTERN CALL"}</span>
          </div>
          <div className="panel-body">
            {flow.evidence.length === 0 ? (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>Objective measurements appear as the tape reveals events.</p>
            ) : (
              <div className="flow-evidence-list">
                {flow.evidence.map((ev) => {
                  const hot = ev.interpretation === "HIGH" || ev.interpretation === "DETECTED" || ev.interpretation === "STRONG";
                  return (
                    <div key={ev.metric} className="flow-evidence-row">
                      <span className="fe-metric">{flowEvidenceLabel(ev.metric)}</span>
                      <span className={`fe-strength ${hot ? "hot" : ""}`}>{ev.interpretation}</span>
                      <span className="fe-value mono">{String(ev.value)}</span>
                      <span className="fe-seq mono dim">SEQ {ev.sequence}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ====================== 8C TRAINING ANALYTICS ====================== */}
      {flow.revealed && flow.analytics ? (
        <AnalyticsDashboard analytics={flow.analytics} />
      ) : null}

      {/* ====================== 8D SESSION REVIEW ====================== */}
      {flow.revealed && flow.review ? (
        <ReviewPanel review={flow.review} timelineEmpty={flow.timeline.length === 0} onJump={(index) => { setPlaying(false); controller.seekFlow(index); }} />
      ) : null}

      {/* ====================== EVIDENCE TIMELINE ====================== */}
      {flow.revealed && (
        <div className="card">
          <div className="card-head">
            <h3>Evidence timeline</h3>
            <span className="right badge ok">POST-REVEAL</span>
          </div>
          <div className="card-body">
            {flow.timeline.length === 0 ? (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>No qualifying observable events before this point — step forward to record more.</p>
            ) : (
              <ul className="flow-timeline">
                {flow.timeline.map((e) => (
                  <li key={`${e.index}-${e.metric}`} className={e.important ? "imp" : ""}>
                    <button className="tl-jump" onClick={() => { setPlaying(false); controller.seekFlow(e.index); }} title="Jump to this event">
                      ⌖
                    </button>
                    <span className="tl-seq mono">SEQ {e.sequence}</span>
                    <span className="tl-label">{e.label} {e.interpretation}</span>
                    {e.important && <span className="tl-dot" aria-hidden />}
                  </li>
                ))}
              </ul>
            )}
            <p className="dim" style={{ fontSize: 10, margin: "9px 0 0", lineHeight: 1.5 }}>
              Built from observable metric changes on the event clock — never from the scenario truth.
            </p>
          </div>
        </div>
      )}

      {/* ====================== RAW TRAINING STATISTICS ====================== */}
      {flow.revealed && flow.trainingStats && (
        <div className="card">
          <div className="card-head">
            <h3>Training statistics (raw)</h3>
            <span className="right badge">RAW METRICS — {flow.trainingStats.scenarios} SCENARIO{flow.trainingStats.scenarios === 1 ? "" : "S"}</span>
          </div>
          <div className="card-body">
            <div className="flow-results-kvs">
              <div className="kv">
                <span className="k">Pattern accuracy (you)</span>
                <span className="v">{flow.trainingStats.traderCorrect}/{flow.trainingStats.traderPredictions}</span>
                <span className="k">Engine accuracy</span>
                <span className="v">{flow.trainingStats.engineCorrect}/{flow.trainingStats.engineCalls}</span>
                <span className="k">Trader ↔ engine agreement</span>
                <span className="v">{flow.trainingStats.agreeCount}/{flow.trainingStats.agreements}</span>
                <span className="k">Direction accuracy</span>
                <span className="v">{flow.trainingStats.directionCorrect}/{flow.trainingStats.directionCalls}</span>
                <span className="k">Win rate</span>
                <span className="v">{flow.trainingStats.winRatePct}% ({flow.trainingStats.wins}W / {flow.trainingStats.losses}L)</span>
                <span className="k">Net P&amp;L</span>
                <span className={`v mono ${pnlClass(flow.trainingStats.netPnL)}`}>{signedMoney(flow.trainingStats.netPnL)}</span>
              </div>
              <div className="kv">
                <span className="k">Avg confidence</span>
                <span className="v">{flow.trainingStats.avgConfidence !== null ? `${flow.trainingStats.avgConfidence}/5` : "—"}</span>
                <span className="k">Avg MFE capture</span>
                <span className="v">{flow.trainingStats.avgMfeCapturePct !== null ? `${flow.trainingStats.avgMfeCapturePct}%` : "—"}</span>
                <span className="k">Avg MAE</span>
                <span className="v mono">{money(flow.trainingStats.avgMae)}</span>
                <span className="k">Best / worst trade</span>
                <span className="v mono">
                  <span className={pnlClass(flow.trainingStats.bestTrade)}>{signedMoney(flow.trainingStats.bestTrade)}</span> /{" "}
                  <span className={pnlClass(flow.trainingStats.worstTrade)}>{signedMoney(flow.trainingStats.worstTrade)}</span>
                </span>
              </div>
            </div>
            <p className="dim" style={{ fontSize: 10.5, margin: "10px 0 0" }}>
              Kept as individual metrics on purpose — no opaque composite score.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

/* ============================ sub-components ============================ */

function TapeRowView({ row }: { row: TapeRow }) {
  const cls = row.sweepLike ? "sweep" : row.large ? "large" : row.burst ? "burst" : "";
  const sideCls = row.aggressorSide === "BUY" ? "up" : row.aggressorSide === "SELL" ? "down" : "dim";
  return (
    <tr className={`flow-tape-row ${cls}`}>
      <td className="mono dim">{tapeTime(row.timestamp)}</td>
      <td className={`r mono ${sideCls}`}>{fmtPrice(row.price)}</td>
      <td className="r mono">{row.size}</td>
      <td className="r mono dim">
        <span className="flow-rel-size" style={{ width: `${Math.max(2, row.relativeSize * 100)}%` }} />
        {row.size}
      </td>
      <td className={`r ${sideCls}`}>{row.aggressorSide}</td>
    </tr>
  );
}

function DOMSide({
  levels,
  side,
  maxSize,
  changes,
}: {
  levels: Level[];
  side: "bid" | "ask";
  maxSize: number;
  changes: Map<string, BookChange>;
}) {
  const rows = side === "ask" ? [...levels].reverse() : levels;
  return (
    <div className={`flow-dom flow-dom-${side}`}>
      {rows.map((l) => {
        const change = changes.get(`${side}:${l.price}`);
        const k = change ? change.kind.toLowerCase() : "";
        return (
          <div key={`${side}-${l.price}`} className={`flow-dom-row ${k ? `flow-dom-${k}` : ""}`}>
            <span className="flow-dom-bar" style={{ width: `${(l.size / maxSize) * 100}%` }} />
            <span className="mono flow-dom-price">{fmtPrice(l.price)}</span>
            <span className="mono flow-dom-size">{l.size}</span>
            <span className="mono dim flow-dom-ord">×{l.orderCount}</span>
            {k && <span className={`flow-dom-tag mono flow-dom-tag-${k}`}>{BOOK_CHANGE_LABELS[change!.kind]}</span>}
          </div>
        );
      })}
    </div>
  );
}

function AnalyticsDashboard({ analytics }: { analytics: FlowAnalytics }) {
  const { thresholds } = analytics;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Flow training performance</h3>
        <span className="right badge">DERIVED FROM {analytics.sessions} SESSION{analytics.sessions === 1 ? "" : "S"}</span>
      </div>
      <div className="card-body">
        <div className="flow-analytics-summary">
          <div className="flow-stat"><span className="flow-stat-label">Sessions</span><span className="flow-stat-value mono">{analytics.sessions}</span></div>
          <div className="flow-stat"><span className="flow-stat-label">Trades</span><span className="flow-stat-value mono">{analytics.trades}</span></div>
          <div className="flow-stat"><span className="flow-stat-label">Win rate</span><span className="flow-stat-value mono">{analytics.winRatePct !== null ? `${analytics.winRatePct}%` : INSUFFICIENT_SAMPLE_LABEL}</span></div>
          <div className="flow-stat"><span className="flow-stat-label">Net P&amp;L</span><span className={`flow-stat-value mono ${pnlClass(analytics.netPnL)}`}>{signedMoney(analytics.netPnL)}</span></div>
          <div className="flow-stat"><span className="flow-stat-label">Avg trade</span><span className="flow-stat-value mono">{analytics.avgTrade !== null ? signedMoney(analytics.avgTrade) : "—"}</span></div>
          <div className="flow-stat"><span className="flow-stat-label">Profit factor</span><span className="flow-stat-value mono">{analytics.profitFactor !== null ? analytics.profitFactor : INSUFFICIENT_SAMPLE_LABEL}</span></div>
          <div className="flow-stat"><span className="flow-stat-label">MFE capture</span><span className="flow-stat-value mono">{analytics.mfeCapturePct !== null ? `${analytics.mfeCapturePct}%` : INSUFFICIENT_SAMPLE_LABEL}</span></div>
          <div className="flow-stat"><span className="flow-stat-label">Avg hold</span><span className="flow-stat-value mono">{analytics.avgHoldMs !== null ? `${(analytics.avgHoldMs / 1000).toFixed(1)}s` : INSUFFICIENT_SAMPLE_LABEL}</span></div>
          <div className="flow-stat"><span className="flow-stat-label">Avg confidence</span><span className="flow-stat-value mono">{analytics.avgConfidence !== null ? `${analytics.avgConfidence}/5` : INSUFFICIENT_SAMPLE_LABEL}</span></div>
          <div className="flow-stat"><span className="flow-stat-label">Trades / session</span><span className="flow-stat-value mono">{analytics.tradesPerSession !== null ? analytics.tradesPerSession : "—"}</span></div>
        </div>

        <div className="flow-analytics-cols">
          <div>
            <p className="flow-block-title">PATTERN RECOGNITION</p>
            <table className="table">
              <thead>
                <tr><th>Pattern</th><th className="r">Accuracy</th><th className="r">N</th></tr>
              </thead>
              <tbody>
                {analytics.byPattern.map((p) => (
                  <tr key={p.patternId}>
                    <td>{p.pattern}</td>
                    <td className="r mono">{p.insufficient ? <span className="dim">{INSUFFICIENT_SAMPLE_LABEL}</span> : `${p.accuracyPct}%`}</td>
                    <td className="r mono dim">{p.predictions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <p className="flow-block-title">DIRECTION</p>
            <table className="table">
              <thead>
                <tr><th>Bias</th><th className="r">Accuracy</th><th className="r">N</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td className="up">Long</td>
                  <td className="r mono">{analytics.direction.long.insufficient ? <span className="dim">{INSUFFICIENT_SAMPLE_LABEL}</span> : `${analytics.direction.long.accuracyPct}%`}</td>
                  <td className="r mono dim">{analytics.direction.long.calls}</td>
                </tr>
                <tr>
                  <td className="down">Short</td>
                  <td className="r mono">{analytics.direction.short.insufficient ? <span className="dim">{INSUFFICIENT_SAMPLE_LABEL}</span> : `${analytics.direction.short.accuracyPct}%`}</td>
                  <td className="r mono dim">{analytics.direction.short.calls}</td>
                </tr>
              </tbody>
            </table>

            <p className="flow-block-title" style={{ marginTop: 14 }}>BY DIFFICULTY</p>
            <table className="table">
              <thead>
                <tr><th>Difficulty</th><th className="r">Win rate</th><th className="r">Recog.</th><th className="r">N</th></tr>
              </thead>
              <tbody>
                {analytics.byDifficulty.map((d) => (
                  <tr key={d.difficulty}>
                    <td>{d.difficulty[0] + d.difficulty.slice(1).toLowerCase()}</td>
                    <td className="r mono">{d.insufficient ? <span className="dim">—</span> : d.winRatePct !== null ? `${d.winRatePct}%` : "—"}</td>
                    <td className="r mono">{d.recognitionAccuracyPct !== null ? `${d.recognitionAccuracyPct}%` : <span className="dim">—</span>}</td>
                    <td className="r mono dim">{d.sessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div>
            <p className="flow-block-title">CONFIDENCE VS RESULT</p>
            <table className="table">
              <thead>
                <tr><th>Conf.</th><th className="r">Win rate</th><th className="r">Avg trade</th><th className="r">N</th></tr>
              </thead>
              <tbody>
                {analytics.byConfidence.map((b) => (
                  <tr key={b.level}>
                    <td className="mono">{b.level}</td>
                    <td className="r mono">{b.insufficient ? <span className="dim">—</span> : b.winRatePct !== null ? `${b.winRatePct}%` : "—"}</td>
                    <td className={`r mono ${b.avgNetPnL !== null ? pnlClass(b.avgNetPnL) : ""}`}>{b.avgNetPnL !== null ? signedMoney(b.avgNetPnL) : "—"}</td>
                    <td className="r mono dim">{b.trades}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="flow-block-title" style={{ marginTop: 14 }}>RECOGNITION</p>
            <div className="kv">
              <span className="k">Trader accuracy</span>
              <span className="v">{analytics.recognition.traderAccuracyPct !== null ? `${analytics.recognition.traderAccuracyPct}%` : INSUFFICIENT_SAMPLE_LABEL}</span>
              <span className="k">Engine accuracy</span>
              <span className="v">{analytics.recognition.engineAccuracyPct !== null ? `${analytics.recognition.engineAccuracyPct}%` : INSUFFICIENT_SAMPLE_LABEL}</span>
              <span className="k">Agreement</span>
              <span className="v">{analytics.recognition.agreementPct !== null ? `${analytics.recognition.agreementPct}%` : INSUFFICIENT_SAMPLE_LABEL}</span>
            </div>
          </div>
        </div>

        <p className="flow-block-title" style={{ marginTop: 16 }}>OBSERVATIONS</p>
        {analytics.weaknesses.length === 0 ? (
          <p className="dim" style={{ fontSize: 11, margin: 0 }}>
            No supported observations yet — {INSUFFICIENT_SAMPLE_LABEL.toLowerCase()} (each statement needs ≥ {thresholds.minSample} observations).
          </p>
        ) : (
          <ul className="flow-weakness-list">
            {analytics.weaknesses.map((w) => (
              <li key={w.text} className={`flow-weakness kind-${w.kind.toLowerCase()}`}>
                <span className="badge">{w.kind.replace("_", " ")}</span>
                <span>{w.text}</span>
                <span className="dim mono">n={w.sample}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="dim" style={{ fontSize: 10.5, margin: "10px 0 0", lineHeight: 1.5 }}>
          Derived analytics over revealed sessions. Buckets below the minimum sample show
          “{INSUFFICIENT_SAMPLE_LABEL}” instead of a misleading rate. Statements are rule-based
          observations about the record — not psychological diagnoses.
        </p>
      </div>
    </div>
  );
}

function ReviewPanel({
  review,
  timelineEmpty,
  onJump,
}: {
  review: FlowReview;
  timelineEmpty: boolean;
  onJump: (index: number) => void;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h3>Session review</h3>
        <span className="right badge ok">REVIEW MODE</span>
      </div>
      <div className="card-body">
        {review.trades.length === 0 ? (
          <p className="dim" style={{ fontSize: 11, margin: 0 }}>
            No completed trades this session — review the evidence timeline below to see what the flow
            showed.
          </p>
        ) : (
          <div className="flow-review-trades">
            {review.trades.map((t) => (
              <div key={t.tradeId} className="flow-review-trade">
                <div className="flow-review-head">
                  <span className={`flow-review-side ${t.side === "LONG" ? "long" : "short"}`}>
                    {t.side} {t.quantity}
                  </span>
                  <span className="mono">{fmtPrice(t.entryPrice)} → {fmtPrice(t.exitPrice)}</span>
                  <span className={`mono ${pnlClass(t.netPnL)}`}>{signedMoney(t.netPnL)}</span>
                  <span className="dim mono">{t.exitReason}</span>
                  <button className="chip" onClick={() => onJump(t.entryIndex)}>JUMP TO ENTRY</button>
                  <button className="chip" onClick={() => onJump(t.exitIndex)}>JUMP TO EXIT</button>
                </div>
                <div className="flow-review-body">
                  <div className="kv">
                    <span className="k">Why taken</span><span className="v">{t.reason || "—"}</span>
                    <span className="k">Prediction</span><span className="v">{t.prediction} · {t.bias}</span>
                    <span className="k">Confidence</span><span className="v">{t.confidence}/5</span>
                    <span className="k">MFE / MAE</span>
                    <span className="v mono"><span className="up">{signedMoney(t.mfe)}</span> / <span className="down">{signedMoney(t.mae)}</span></span>
                    <span className="k">Hold</span><span className="v mono">{(t.durationMs / 1000).toFixed(1)}s</span>
                  </div>
                  <div>
                    <p className="flow-block-title">AT ENTRY — OBSERVABLE FLOW</p>
                    {t.atEntry.length === 0 ? (
                      <p className="dim" style={{ fontSize: 10.5, margin: 0 }}>No evidence recorded at or before entry.</p>
                    ) : (
                      <div className="flow-entry-evidence">
                        {t.atEntry.map((e) => (
                          <span key={e.metric} className="badge">
                            {e.label}: <strong>{e.interpretation}</strong>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <p className="flow-review-outcome mono">Outcome: {t.outcome}</p>
              </div>
            ))}
          </div>
        )}

        <p className="flow-block-title" style={{ marginTop: 16 }}>JUMP TO MAJOR EVIDENCE</p>
        {timelineEmpty && review.jumps.length <= 1 ? (
          <p className="dim" style={{ fontSize: 11, margin: 0 }}>No navigation targets yet — step the tape forward.</p>
        ) : (
          <div className="flow-review-jumps">
            {review.jumps.map((j, i) => (
              <button
                key={`${j.kind}-${j.index}-${i}`}
                className={`chip flow-jump flow-jump-${j.kind.toLowerCase()}`}
                onClick={() => onJump(j.index)}
                title={`Seek to event ${j.index}`}
              >
                {j.label}
              </button>
            ))}
          </div>
        )}
        <p className="dim" style={{ fontSize: 10.5, margin: "10px 0 0", lineHeight: 1.5 }}>
          Every jump rebuilds the scenario deterministically to that event. Entry/exit markers on the
          chart are visible in REVIEW mode only — they would reveal outcomes while blind.
        </p>
      </div>
    </div>
  );
}
