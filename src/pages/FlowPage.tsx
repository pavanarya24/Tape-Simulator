import { useEffect, useState } from "react";
import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { FlowChart } from "../components/FlowChart";
import { FLOW_DIFFICULTIES, FLOW_SCENARIOS, scenarioName, type FlowDifficulty, type FlowScenarioId } from "../flow/scenarios";
import { flowEvidenceLabel } from "../flow/recognition";
import type { FlowBias, FlowPrediction } from "../flow/execution";
import type { Level } from "../flow/dom";
import { money, pct, price as fmtPrice, signedMoney } from "../util/format";

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

/** Parse a risk/cost input: empty string means "off" (null). */
function numVal(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pnlClass(n: number): string {
  return n > 0 ? "up" : n < 0 ? "down" : "";
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

export function FlowPage({ state }: { state: AppState }) {
  const flow = state.flow;
  const [pattern, setPattern] = useState<FlowScenarioId | "any">("any");
  const [showCvd, setShowCvd] = useState(true);
  const [showProfile, setShowProfile] = useState(true);
  const [showDom, setShowDom] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showAma, setShowAma] = useState(true);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      if (!controller.stepFlow(3)) setPlaying(false);
    }, 80);
    return () => clearInterval(id);
  }, [playing]);

  useEffect(() => {
    if (flow.atEnd) setPlaying(false);
  }, [flow.atEnd]);

  const of = flow.orderFlow;
  const dom = flow.dom;
  const progress = flow.totalEvents > 0 ? Math.min(100, (flow.eventIndex / flow.totalEvents) * 100) : 0;
  const maxLevelSize = flow.book
    ? Math.max(...flow.book.bids.map((l) => l.size), ...flow.book.asks.map((l) => l.size), 1)
    : 1;

  return (
    <>
      <h2>Flow Lab — order-flow training</h2>
      <p className="lede">
        READ → DECIDE → EXECUTE → MANAGE → SCORE. Deterministic synthetic market events (real trades,
        Level-2 snapshots and book resets — never OHLC-derived) replayed one event at a time. Trade the
        simulated tape, then reveal what the generator built.
      </p>

      <div className="callout info flow-honesty">
        <span className="badge mono">SYNTHETIC TRAINING DATA</span>{" "}
        <span className="badge mono">SIMULATED TRADING — SYNTHETIC MARKET DATA</span>{" "}
        <span className="dim">
          Every event here is generated for practice. Nothing on this page is real market data, no
          scenario is ever derived from OHLC candles, and fills are book-price reproductions — not real
          market execution.
        </span>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Session control</h3>
          <span className="right badge">{flow.active ? `${flow.eventIndex} / ${flow.totalEvents} events` : "NO SCENARIO"}</span>
        </div>
        <div className="card-body">
          <div className="flow-controls">
            <div className="field">
              <label>Pattern</label>
              <select value={pattern} onChange={(e) => setPattern(e.target.value as FlowScenarioId | "any")}>
                {PATTERN_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Difficulty</label>
              <select
                value={flow.difficulty}
                onChange={(e) => controller.setFlowDifficulty(e.target.value as FlowDifficulty)}
              >
                {FLOW_DIFFICULTIES.map((d) => (
                  <option key={d} value={d}>
                    {d[0] + d.slice(1).toLowerCase()}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn primary" onClick={() => { setPlaying(false); controller.generateFlowScenario(pattern); }}>
              GENERATE CHART
            </button>
            <button className="btn" onClick={() => controller.stepFlowBack()} disabled={!flow.active || flow.eventIndex === 0 || flow.held}>
              ◀ STEP
            </button>
            <button className="btn" onClick={() => { setPlaying(false); controller.stepFlow(1); }} disabled={!flow.active || flow.atEnd || flow.held}>
              STEP ▶
            </button>
            <button
              className={playing ? "btn primary" : "btn"}
              onClick={() => setPlaying((p) => !p)}
              disabled={!flow.active || flow.atEnd || flow.held}
            >
              {playing ? "⏸ PAUSE" : "▶ PLAY"}
            </button>
            <button className="btn" onClick={() => { setPlaying(false); controller.resetFlow(); }} disabled={!flow.active}>
              ⟲ RESET
            </button>
          </div>
          <div className="flow-controls flow-replay-row">
            <button
              className="btn"
              onClick={() => { setPlaying(false); controller.restartFlowScenario(); }}
              disabled={!flow.active}
              title="Same seed, same events — restart with a clean position and journal"
            >
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
          <div className="flow-progress" title={`${flow.eventIndex} of ${flow.totalEvents} events revealed`}>
            <div style={{ width: `${progress}%` }} />
          </div>
          <p className="dim" style={{ fontSize: 10.5, margin: "9px 0 0" }}>
            {pattern === "any"
              ? "Any pattern: a random pattern is generated — identify it from the tape before revealing."
              : `Generator target: ${scenarioName(pattern)}. Watch for it, then confirm with the reveal.`}
            {" "}Difficulty shapes the structure ({DIFFICULTY_HINTS[flow.difficulty]}), never random noise.
            {" "}Stepping back replays deterministically from the start — no event is ever re-rolled.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Trading panel</h3>
          <span className="right badge warn">SIMULATED TRADING — SYNTHETIC MARKET DATA</span>
        </div>
        <div className="card-body">
          {!flow.active ? (
            <p className="dim" style={{ fontSize: 11, margin: 0 }}>
              Generate a scenario to start trading the synthetic tape. Market orders fill at the current
              revealed bid/ask — never against future events, never against OHLC candles.
            </p>
          ) : (
            <div className="flow-trade-cols">
              {/* ---------------- POSITION ---------------- */}
              <div className="flow-block">
                <p className="flow-block-title">POSITION</p>
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
                  <button
                    className="btn flat"
                    onClick={() => controller.flowFlatten()}
                    disabled={flow.held || flow.position.side === "FLAT"}
                  >
                    FLATTEN
                  </button>
                </div>
                <div className="kv flow-pos-kv">
                  <span className="k">Entry</span>
                  <span className="v mono">{flow.position.averageEntryPrice !== null ? fmtPrice(flow.position.averageEntryPrice) : "—"}</span>
                  <span className="k">Current</span>
                  <span className="v mono">{flow.position.currentPrice !== null ? fmtPrice(flow.position.currentPrice) : "—"}</span>
                  <span className="k">Unrealized</span>
                  <span className={`v mono ${pnlClass(flow.position.unrealizedPnL)}`}>{signedMoney(flow.position.unrealizedPnL)}</span>
                  <span className="k">Realized</span>
                  <span className={`v mono ${pnlClass(flow.position.realizedPnL)}`}>{signedMoney(flow.position.realizedPnL)}</span>
                  <span className="k">Net</span>
                  <span className={`v mono ${pnlClass(flow.position.totalPnL)}`}>{signedMoney(flow.position.totalPnL)}</span>
                  <span className="k">Costs accrued</span>
                  <span className="v mono dim">{money(flow.position.costsAccrued)}</span>
                  <span className="k">MFE</span>
                  <span className="v mono up">{flow.position.maxFavorableExcursion > 0 ? signedMoney(flow.position.maxFavorableExcursion) : "—"}</span>
                  <span className="k">MAE</span>
                  <span className="v mono down">{flow.position.maxAdverseExcursion > 0 ? signedMoney(flow.position.maxAdverseExcursion) : "—"}</span>
                </div>
              </div>

              {/* ---------------- RISK + COSTS ---------------- */}
              <div className="flow-block">
                <p className="flow-block-title">RISK</p>
                <div className="field">
                  <label>Max position</label>
                  <input
                    type="number"
                    min={1}
                    value={flow.risk.maxPositionQty}
                    onChange={(e) => controller.setFlowRisk({ maxPositionQty: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                  />
                </div>
                <div className="field">
                  <label>Max daily loss $</label>
                  <input
                    type="number"
                    min={0}
                    placeholder="off"
                    value={flow.risk.maxDailyLoss ?? ""}
                    onChange={(e) => controller.setFlowRisk({ maxDailyLoss: numVal(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>Stop (ticks)</label>
                  <input
                    type="number"
                    min={0}
                    placeholder="off"
                    value={flow.risk.stopLossTicks ?? ""}
                    onChange={(e) => controller.setFlowRisk({ stopLossTicks: numVal(e.target.value) })}
                  />
                </div>
                <div className="field">
                  <label>Target (ticks)</label>
                  <input
                    type="number"
                    min={0}
                    placeholder="off"
                    value={flow.risk.takeProfitTicks ?? ""}
                    onChange={(e) => controller.setFlowRisk({ takeProfitTicks: numVal(e.target.value) })}
                  />
                </div>
                <p className="flow-block-title" style={{ marginTop: 12 }}>SIMULATED COSTS</p>
                <div className="field">
                  <label>Commission $</label>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={flow.costs.commissionPerContract}
                    onChange={(e) => controller.setFlowCosts({ commissionPerContract: Math.max(0, numVal(e.target.value) ?? 0) })}
                  />
                </div>
                <div className="field">
                  <label>Slippage (ticks)</label>
                  <input
                    type="number"
                    min={0}
                    value={flow.costs.slippageTicks}
                    onChange={(e) => controller.setFlowCosts({ slippageTicks: Math.max(0, Math.floor(numVal(e.target.value) ?? 0)) })}
                  />
                </div>
                <p className="dim" style={{ fontSize: 10, margin: "6px 0 0", lineHeight: 1.5 }}>
                  Defaults: qty 1, max position 4, $2.25/contract/fill + 1 tick slippage — conservative
                  and clearly simulated. No prop-firm rules unless you set a loss limit yourself.
                </p>
              </div>

              {/* ---------------- DECISION ---------------- */}
              <div className="flow-block">
                <p className="flow-block-title">DECISION</p>
                <div className="flow-decision-row">
                  <span className="flow-decision-label">Bias</span>
                  {BIAS_OPTIONS.map((b) => (
                    <button
                      key={b}
                      className={`chip ${flow.decision.bias === b ? "on" : ""}`}
                      onClick={() => controller.setFlowDecision({ bias: b })}
                    >
                      {b}
                    </button>
                  ))}
                </div>
                <div className="field">
                  <label>Pattern</label>
                  <select
                    value={flow.decision.expected}
                    onChange={(e) => controller.setFlowDecision({ expected: e.target.value as FlowPrediction })}
                  >
                    {PREDICTION_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flow-decision-row">
                  <span className="flow-decision-label">Confidence</span>
                  {CONFIDENCE_LEVELS.map((n) => (
                    <button
                      key={n}
                      className={`chip ${flow.decision.level === n ? "on" : ""}`}
                      onClick={() => controller.setFlowDecision({ level: n })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="field wide" style={{ marginTop: 8 }}>
                  <label>Reason</label>
                  <input
                    type="text"
                    placeholder="Why you are taking this trade…"
                    value={flow.decision.reason}
                    onChange={(e) => controller.setFlowDecision({ reason: e.target.value })}
                  />
                </div>
                <p className="dim" style={{ fontSize: 10, margin: "6px 0 0", lineHeight: 1.5 }}>
                  Optional — trade the tape without a prediction. Your decision is stored with each entry
                  and scored only after reveal.
                </p>
              </div>
            </div>
          )}
          {flow.active && flow.notice && (
            <p className={`flow-notice ${flow.notice.ok ? "ok" : "bad"}`}>{flow.notice.text}</p>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Tape</h3>
          <div className="right chips">
            <button
              className={`chip ${showCvd ? "on" : ""}`}
              onClick={() => setShowCvd((v) => !v)}
              title="Cumulative volume delta pane below the candles"
            >
              Show CVD
            </button>
            <button
              className={`chip ${showProfile ? "on" : ""}`}
              onClick={() => setShowProfile((v) => !v)}
              title="Volume-at-price profile in the right-hand gutter"
            >
              Show profile
            </button>
            <button className={`chip ${showDom ? "on" : ""}`} onClick={() => setShowDom((v) => !v)}>Show DOM</button>
            <button
              className={`chip ${showMarkers ? "on" : ""}`}
              onClick={() => setShowMarkers((v) => !v)}
              title="Observable event markers — objective measurements only, never a pattern call"
            >
              Show events
            </button>
            <button
              className={`chip ${showAma ? "on" : ""}`}
              onClick={() => setShowAma((v) => !v)}
              title="Adaptive Moving Average — efficiency-ratio smoothed trend line"
            >
              Show AMA
            </button>
            <span className="badge mono" title="Current Adaptive Moving Average value">
              AMA {flow.ama !== null ? fmtPrice(flow.ama) : "—"}
            </span>
          </div>
        </div>
        <div style={{ height: 440 }}>
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
          />
        </div>
        <p className="dim" style={{ fontSize: 10, margin: "8px 0 0", lineHeight: 1.5 }}>
          Candles are time-bucketed OHLC aggregates of the revealed synthetic tape — the generator
          never consumes OHLC data. Axes: price (right of the plot) · time (bottom, New York tape
          clock). The CVD pane shares the time axis; the profile gutter scales to the price axis.
          The cyan AMA line adapts with the tape — tight in purposeful moves, slow in the chop.
        </p>
      </div>

      <div className="flow-grid">
        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Time &amp; Sales</span>
            <span className="right badge">{of ? `${of.tradeCount} prints` : "—"}</span>
          </div>
          <div className="panel-body flow-tape">
            {!of || of.tape.length === 0 ? (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>No prints revealed yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Time</th><th className="r">Price</th><th className="r">Size</th><th className="r">Side</th></tr>
                </thead>
                <tbody>
                  {[...of.tape].reverse().map((t) => (
                    <tr key={t.sequence}>
                      <td className="mono dim">{tapeTime(t.timestamp)}</td>
                      <td className="r mono">{fmtPrice(t.price)}</td>
                      <td className="r mono">{t.size}</td>
                      <td className={`r ${t.aggressorSide === "BUY" ? "up" : t.aggressorSide === "SELL" ? "down" : "dim"}`}>
                        {t.aggressorSide}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <span className="panel-title">Order flow</span>
            <span className="right badge">{of ? `SEQ ${of.sequence}` : "—"}</span>
          </div>
          <div className="panel-body">
            {of ? (
              <>
                <div className="kv">
                  <span className="k">Buy volume</span><span className="v up">{of.totalBuyVolume}</span>
                  <span className="k">Sell volume</span><span className="v down">{of.totalSellVolume}</span>
                  <span className="k">Delta</span>
                  <span className={`v ${of.delta > 0 ? "up" : of.delta < 0 ? "down" : ""}`}>{of.delta}</span>
                  <span className="k">Cumulative delta</span>
                  <span className={`v ${of.cumulativeDelta > 0 ? "up" : of.cumulativeDelta < 0 ? "down" : ""}`}>{of.cumulativeDelta}</span>
                  <span className="k">VWAP</span><span className="v mono">{fmtPrice(of.vwap)}</span>
                  <span className="k">Last</span><span className="v mono">{fmtPrice(of.lastPrice)}</span>
                  <span className="k">Spread</span><span className="v">{of.spread !== null ? fmtPrice(of.spread) : "—"}</span>
                  <span className="k">Microprice</span><span className="v">{of.microprice !== null ? fmtPrice(of.microprice) : "—"}</span>
                  <span className="k">Bid/ask imbalance</span>
                  <span className="v">{of.bidAskImbalance !== null ? `${(of.bidAskImbalance * 100).toFixed(1)}%` : "—"}</span>
                  <span className="k">Velocity</span><span className="v">{of.velocityPerMin}/min</span>
                  <span className="k">Aggression</span>
                  <span className="v">{of.buyAggressionPct.toFixed(1)}% buy · {of.sellAggressionPct.toFixed(1)}% sell</span>
                </div>
                <p className="dim" style={{ fontSize: 10.5, margin: "10px 0 4px" }}>Largest prints</p>
                <div className="flow-largest">
                  {of.largestTrades.map((t) => (
                    <span key={t.sequence} className={`badge ${t.aggressorSide === "BUY" ? "ok" : "bad"}`}>
                      {t.size} @ {fmtPrice(t.price)} {t.aggressorSide}
                    </span>
                  ))}
                  {of.largestTrades.length === 0 && <span className="dim">—</span>}
                </div>
              </>
            ) : (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>Generate a scenario to see order-flow statistics.</p>
            )}
          </div>
        </section>

        {/* ---------------- FLOW EVIDENCE (objective, safe while blind) ---------------- */}
        <section className="panel flow-evidence">
          <div className="panel-head">
            <span className="panel-title">Flow evidence</span>
            <span className="right badge">
              {flow.revealed ? "OBSERVABLE DATA" : "OBSERVATIONS ONLY — NO PATTERN CALL"}
            </span>
          </div>
          <div className="panel-body">
            {flow.evidence.length === 0 ? (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>
                Generate a scenario — objective measurements appear as the tape reveals events.
              </p>
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
            <p className="dim" style={{ fontSize: 10, margin: "9px 0 0", lineHeight: 1.5 }}>
              Measured straight from the revealed tape, CVD, profile and book. The engine's own
              classification stays hidden until Reveal.
            </p>
          </div>
        </section>

        {showDom && (
          <section className="panel">
            <div className="panel-head">
              <span className="panel-title">DOM / Level 2</span>
              <span className="right badge">{dom?.hasBook ? `SPR ${fmtPrice(dom.spread ?? 0)}` : "NO BOOK"}</span>
            </div>
            <div className="panel-body">
              {dom && flow.book ? (
                <>
                  <DOMSide levels={flow.book.asks} side="ask" maxSize={maxLevelSize} />
                  <div className="flow-mid mono">
                    {fmtPrice(dom.bestBid ?? 0)} × {fmtPrice(dom.bestAsk ?? 0)}
                  </div>
                  <DOMSide levels={flow.book.bids} side="bid" maxSize={maxLevelSize} />
                  <div className="kv" style={{ marginTop: 10 }}>
                    <span className="k">Bid liquidity</span><span className="v up">{dom.totalBidLiquidity}</span>
                    <span className="k">Ask liquidity</span><span className="v down">{dom.totalAskLiquidity}</span>
                    <span className="k">Imbalance</span>
                    <span className="v">{dom.imbalance !== null ? `${(dom.imbalance * 100).toFixed(1)}%` : "—"}</span>
                    <span className="k">Stacking</span><span className="v">{dom.stackBidLevels}B / {dom.stackAskLevels}A</span>
                    <span className="k">Pulls</span><span className="v">{dom.pullBidCount}B / {dom.pullAskCount}A</span>
                    <span className="k">Replenished</span><span className="v">{dom.replenishCount}</span>
                    <span className="k">Depleted</span>
                    <span className="v">{dom.depletedBid ? "BID " : ""}{dom.depletedAsk ? "ASK" : ""}{!dom.depletedBid && !dom.depletedAsk ? "—" : ""}</span>
                    <span className="k">Sweeps</span><span className="v">{dom.sweepBuyCount} up / {dom.sweepSellCount} down</span>
                    <span className="k">Top-of-book chg</span><span className="v">{dom.topOfBookChanges}</span>
                  </div>
                </>
              ) : (
                <p className="dim" style={{ fontSize: 11, margin: 0 }}>No book snapshot revealed yet.</p>
              )}
            </div>
          </section>
        )}

        <section className="panel flow-reveal">
          <div className="panel-head">
            <span className="panel-title">Answer</span>
            <span className="right badge">{flow.revealed ? "REVEALED" : "HIDDEN"}</span>
          </div>
          <div className="panel-body">
            {!flow.active ? (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>
                Generate a scenario first. The pattern stays hidden while you read the tape.
              </p>
            ) : flow.revealed ? (
              <>
                <div className="flow-truth-name">
                  {scenarioName(flow.revealed.pattern)}
                  <span className={`badge ${flow.revealed.direction === "bullish" ? "ok" : "bad"}`}>
                    {flow.revealed.direction.toUpperCase()}
                  </span>
                </div>
                <ul className="flow-truth-list">
                  {flow.revealed.characteristics.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <p className="dim" style={{ fontSize: 10.5, margin: "8px 0 0" }}>
                  Key window: events {flow.revealed.startEvent}–{flow.revealed.endEvent} · generator
                  confidence {pct(flow.revealed.confidence * 100)}
                </p>
              </>
            ) : (
              <>
                <p className="dim" style={{ fontSize: 11, marginTop: 0 }}>
                  Commit to a read from the tape, CVD and DOM first. Revealing ends the exercise for
                  this scenario.
                </p>
                <button className="btn primary wide" onClick={() => { setPlaying(false); controller.revealFlow(); }}>
                  REVEAL WHAT IT WAS
                </button>
              </>
            )}
          </div>
        </section>

        <section className="panel flow-span">
          <div className="panel-head">
            <span className="panel-title">Trade history</span>
            <span className="right badge">{flow.trades.length} COMPLETED</span>
          </div>
          <div className="panel-body">
            {flow.trades.length === 0 ? (
              <p className="dim" style={{ fontSize: 11, margin: 0 }}>
                No completed trades yet. Positions are journaled when flattened, reversed, stopped or
                targeted out — every record shows gross, costs and net.
              </p>
            ) : (
              <div className="flow-trades-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th><th>Entry time</th><th>Side</th><th className="r">Qty</th>
                      <th className="r">Entry</th><th className="r">Exit</th>
                      <th className="r">Gross</th><th className="r">Costs</th><th className="r">Net</th>
                      <th className="r">MFE</th><th className="r">MAE</th><th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flow.trades.map((t) => (
                      <tr key={t.tradeId}>
                        <td className="mono dim">{t.tradeId}</td>
                        <td className="mono dim">{tapeTime(t.entryTimestamp)}</td>
                        <td className={t.side === "LONG" ? "up" : "down"}>{t.side}</td>
                        <td className="r mono">{t.quantity}</td>
                        <td className="r mono">{fmtPrice(t.entryPrice)}</td>
                        <td className="r mono">{fmtPrice(t.exitPrice)}</td>
                        <td className="r mono">{signedMoney(t.grossPnL)}</td>
                        <td className="r mono dim">{money(t.costs)}</td>
                        <td className={`r mono ${pnlClass(t.netPnL)}`}>{signedMoney(t.netPnL)}</td>
                        <td className="r mono up">{signedMoney(t.maxFavorableExcursion)}</td>
                        <td className="r mono down">{signedMoney(t.maxAdverseExcursion)}</td>
                        <td className="dim" title={`Duration ${Math.round(t.durationMs / 1000)}s · seq ${t.entrySequence}→${t.exitSequence}`}>
                          {t.exitReason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>

      {flow.revealed && flow.results && (
        <div className="card flow-results-card">
          <div className="card-head">
            <h3>Flow session results</h3>
            <span className="right badge ok">POST-REVEAL</span>
          </div>
          <div className="card-body">
            <div className="flow-results-kvs">
              <div className="kv">
                <span className="k">Pattern</span><span className="v">{flow.results.pattern} · {flow.results.direction.toUpperCase()}</span>
                <span className="k">Your bias</span><span className="v">{flow.results.bias}</span>
                <span className="k">Your prediction</span><span className="v">{flow.results.predictionName}</span>
                <span className="k">Prediction</span><span className={`v ${flow.results.patternResult === "CORRECT" ? "up" : flow.results.patternResult === "INCORRECT" ? "down" : ""}`}>{flow.results.patternResult}</span>
                <span className="k">Engine recognition</span>
                <span className={`v ${flow.results.recognitionResult === "CORRECT" ? "up" : flow.results.recognitionResult === "INCORRECT" ? "down" : "dim"}`}>
                  {flow.results.recognitionPattern === "unknown" ? "NO SIGNAL" : scenarioName(flow.results.recognitionPattern)}
                </span>
                <span className="k">Engine result</span>
                <span className={`v ${flow.results.recognitionResult === "CORRECT" ? "up" : flow.results.recognitionResult === "INCORRECT" ? "down" : "dim"}`}>
                  {flow.results.recognitionResult}
                </span>
                <span className="k">Engine confidence</span>
                <span className="v">{flow.results.recognitionConfidence !== null ? pct(flow.results.recognitionConfidence * 100) : "—"}</span>
                <span className="k">Direction</span><span className={`v ${flow.results.directionResult === "CORRECT" ? "up" : flow.results.directionResult === "INCORRECT" ? "down" : ""}`}>{flow.results.directionResult}</span>
                <span className="k">Trading result</span><span className={`v ${flow.results.tradeResult === "PROFIT" ? "up" : flow.results.tradeResult === "LOSS" ? "down" : ""}`}>{flow.results.tradeResult}</span>
                <span className="k">Trades</span><span className="v">{flow.results.trades}</span>
                <span className="k">Wins</span><span className="v up">{flow.results.wins}</span>
                <span className="k">Losses</span><span className="v down">{flow.results.losses}</span>
                <span className="k">Net P&amp;L</span><span className={`v mono ${pnlClass(flow.results.netPnL)}`}>{signedMoney(flow.results.netPnL)}</span>
              </div>
              <div className="kv">
                <span className="k">Best trade</span><span className={`v mono ${pnlClass(flow.results.bestTrade)}`}>{signedMoney(flow.results.bestTrade)}</span>
                <span className="k">Worst trade</span><span className={`v mono ${pnlClass(flow.results.worstTrade)}`}>{signedMoney(flow.results.worstTrade)}</span>
                <span className="k">Gross / costs</span><span className="v mono">{signedMoney(flow.results.grossPnL)} / {money(flow.results.costs)}</span>
                <span className="k">MFE</span><span className="v mono up">{signedMoney(flow.results.mfe)}</span>
                <span className="k">MAE</span><span className="v mono down">{signedMoney(flow.results.mae)}</span>
                <span className="k">R multiple</span><span className="v mono">{flow.results.rMultiple !== null ? `${flow.results.rMultiple}R` : "—"}</span>
                <span className="k">Entry timing</span><span className="v">{flow.results.entryTiming}</span>
                <span className="k">MFE capture</span><span className="v mono">{flow.results.mfeCapturePct !== null ? `${flow.results.mfeCapturePct}%` : "—"}</span>
                <span className="k">Confidence</span><span className="v">{flow.results.confidence}/5</span>
                <span className="k">Confidence vs result</span><span className="v">{flow.results.confidenceVsResult}</span>
              </div>
            </div>
            <p className="flow-block-title" style={{ marginTop: 16 }}>What the flow was telling you</p>
            <ul className="flow-truth-list">
              {flow.results.narrative.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="dim" style={{ fontSize: 10.5, margin: "10px 0 0" }}>
              Raw metrics are kept as-is — no hidden scoring formula. Restart the scenario to trade the
              identical event sequence again.
            </p>
            {flow.held && (
              <button
                className="btn primary"
                style={{ marginTop: 10 }}
                onClick={() => controller.continueFlowAfterReveal()}
              >
                CONTINUE AFTER REVEAL
              </button>
            )}
          </div>
        </div>
      )}

      {/* ---------------- RECOGNITION + EVIDENCE TIMELINE (post-reveal) ---------------- */}
      {flow.revealed && flow.recognition && flow.results && (
        <div className="card">
          <div className="card-head">
            <h3>Recognition &amp; evidence timeline</h3>
            <span className="right badge ok">POST-REVEAL</span>
          </div>
          <div className="card-body flow-recog-cols">
            <div>
              <p className="flow-block-title">RECOGNITION</p>
              <div className="kv">
                <span className="k">Actual pattern</span>
                <span className="v">{flow.results.pattern}</span>
                <span className="k">Your prediction</span>
                <span className={`v ${flow.results.patternResult === "CORRECT" ? "up" : flow.results.patternResult === "INCORRECT" ? "down" : ""}`}>
                  {flow.results.predictionName} {flow.results.patternResult === "CORRECT" ? "✓" : flow.results.patternResult === "INCORRECT" ? "✗" : ""}
                </span>
                <span className="k">Engine recognition</span>
                <span className={`v ${flow.results.recognitionResult === "CORRECT" ? "up" : flow.results.recognitionResult === "INCORRECT" ? "down" : "dim"}`}>
                  {flow.recognition.pattern === "unknown"
                    ? "No signal — ambiguous tape"
                    : `${scenarioName(flow.recognition.pattern)} ${flow.results.recognitionResult === "CORRECT" ? "✓" : "✗"}`}
                </span>
                <span className="k">Engine confidence</span>
                <span className="v">{pct(flow.recognition.confidence * 100)}</span>
                <span className="k">Recognition result</span>
                <span className={`v ${flow.results.recognitionResult === "CORRECT" ? "up" : flow.results.recognitionResult === "INCORRECT" ? "down" : "dim"}`}>
                  {flow.results.recognitionResult}
                </span>
                <span className="k">Window</span>
                <span className="v mono">
                  {flow.recognition.window
                    ? `SEQ ${flow.recognition.window.startSequence} → ${flow.recognition.window.endSequence}`
                    : "—"}
                </span>
                <span className="k">Trader vs engine</span>
                <span className="v">
                  {flow.results.traderEngineAgreement === null
                    ? "NO COMPARISON"
                    : flow.results.traderEngineAgreement
                      ? "AGREE"
                      : "DISAGREE"}
                </span>
              </div>
              {flow.recognition.signals.length > 0 && (
                <div className="flow-signal-chips">
                  {flow.recognition.signals.map((s) => (
                    <span key={s} className="badge">{s}</span>
                  ))}
                </div>
              )}
              <p className="dim" style={{ fontSize: 10, margin: "9px 0 0", lineHeight: 1.5 }}>
                The engine reads the same observable tape you do — no access to the generator's answer.
                No signal is reported rather than a forced call.
              </p>
            </div>
            <div>
              <p className="flow-block-title">EVIDENCE TIMELINE</p>
              {flow.timeline.length === 0 ? (
                <p className="dim" style={{ fontSize: 11, margin: 0 }}>
                  No qualifying observable events before this point — step forward to record more.
                </p>
              ) : (
                <ul className="flow-timeline">
                  {flow.timeline.map((e) => (
                    <li key={`${e.index}-${e.metric}`} className={e.important ? "imp" : ""}>
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
        </div>
      )}

      {/* ---------------- TRAINING INTELLIGENCE (raw metrics, post-reveal) ---------------- */}
      {flow.revealed && flow.trainingStats && (
        <div className="card">
          <div className="card-head">
            <h3>Training statistics</h3>
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
                <span className="k">Avg confidence · correct</span>
                <span className="v up">{flow.trainingStats.avgConfidenceCorrect !== null ? `${flow.trainingStats.avgConfidenceCorrect}/5` : "—"}</span>
                <span className="k">Avg confidence · incorrect</span>
                <span className="v down">{flow.trainingStats.avgConfidenceIncorrect !== null ? `${flow.trainingStats.avgConfidenceIncorrect}/5` : "—"}</span>
                <span className="k">MFE capture</span>
                <span className="v">{flow.trainingStats.avgMfeCapturePct !== null ? `${flow.trainingStats.avgMfeCapturePct}%` : "—"}</span>
                <span className="k">Avg MAE</span>
                <span className="v mono">{money(flow.trainingStats.avgMae)}</span>
                <span className="k">Best / worst trade</span>
                <span className="v mono"><span className={pnlClass(flow.trainingStats.bestTrade)}>{signedMoney(flow.trainingStats.bestTrade)}</span> / <span className={pnlClass(flow.trainingStats.worstTrade)}>{signedMoney(flow.trainingStats.worstTrade)}</span></span>
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

function DOMSide({ levels, side, maxSize }: { levels: Level[]; side: "bid" | "ask"; maxSize: number }) {
  const rows = side === "ask" ? [...levels].reverse() : levels;
  return (
    <div className={`flow-dom flow-dom-${side}`}>
      {rows.map((l) => (
        <div key={`${side}-${l.price}`} className="flow-dom-row">
          <span className="flow-dom-bar" style={{ width: `${(l.size / maxSize) * 100}%` }} />
          <span className="mono flow-dom-price">{fmtPrice(l.price)}</span>
          <span className="mono flow-dom-size">{l.size}</span>
          <span className="mono dim flow-dom-ord">×{l.orderCount}</span>
        </div>
      ))}
    </div>
  );
}
