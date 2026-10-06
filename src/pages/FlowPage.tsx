import { useEffect, useState } from "react";
import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { FlowChart } from "../components/FlowChart";
import { FLOW_SCENARIOS, scenarioName, type FlowScenarioId } from "../flow/scenarios";
import type { Level } from "../flow/dom";
import { pct, price as fmtPrice } from "../util/format";

const ANCHOR_TZ = "America/New_York";

const PATTERN_OPTIONS: Array<{ id: FlowScenarioId | "any"; label: string }> = [
  { id: "any", label: "Any pattern" },
  ...FLOW_SCENARIOS.map((s) => ({ id: s.id, label: `${s.name} only` })),
];

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
        Deterministic synthetic market events (real trades, Level-2 snapshots and book resets — never
        OHLC-derived) replayed one event at a time. Read the tape, then reveal what the generator built.
      </p>

      <div className="callout info flow-honesty">
        <span className="badge mono">SYNTHETIC TRAINING DATA</span>{" "}
        <span className="dim">
          Every event here is generated for practice. Nothing on this page is real market data, and no
          scenario is ever derived from OHLC candles.
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
            <button className="btn primary" onClick={() => { setPlaying(false); controller.generateFlowScenario(pattern); }}>
              GENERATE CHART
            </button>
            <button className="btn" onClick={() => controller.stepFlowBack()} disabled={!flow.active || flow.eventIndex === 0}>
              ◀ STEP
            </button>
            <button className="btn" onClick={() => { setPlaying(false); controller.stepFlow(1); }} disabled={!flow.active || flow.atEnd}>
              STEP ▶
            </button>
            <button
              className={playing ? "btn primary" : "btn"}
              onClick={() => setPlaying((p) => !p)}
              disabled={!flow.active || flow.atEnd}
            >
              {playing ? "⏸ PAUSE" : "▶ PLAY"}
            </button>
            <button className="btn" onClick={() => { setPlaying(false); controller.resetFlow(); }} disabled={!flow.active}>
              ⟲ RESET
            </button>
          </div>
          <div className="flow-progress" title={`${flow.eventIndex} of ${flow.totalEvents} events revealed`}>
            <div style={{ width: `${progress}%` }} />
          </div>
          <p className="dim" style={{ fontSize: 10.5, margin: "9px 0 0" }}>
            {pattern === "any"
              ? "Any pattern: a random pattern is generated — identify it from the tape before revealing."
              : `Generator target: ${scenarioName(pattern)}. Watch for it, then confirm with the reveal.`}
            {" "}Stepping back replays deterministically from the start — no event is ever re-rolled.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Tape</h3>
          <div className="right chips">
            <button className={`chip ${showCvd ? "on" : ""}`} onClick={() => setShowCvd((v) => !v)}>Show CVD</button>
            <button className={`chip ${showProfile ? "on" : ""}`} onClick={() => setShowProfile((v) => !v)}>Show profile</button>
            <button className={`chip ${showDom ? "on" : ""}`} onClick={() => setShowDom((v) => !v)}>Show DOM</button>
          </div>
        </div>
        <div style={{ height: 400 }}>
          <FlowChart
            priceSeries={flow.priceSeries}
            cvdSeries={of?.cvdSeries ?? []}
            profile={of?.volumeAtPrice ?? []}
            showCvd={showCvd}
            showProfile={showProfile}
            vwap={of && of.vwap > 0 ? of.vwap : null}
          />
        </div>
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
                <button className="btn primary wide" onClick={() => controller.revealFlow()}>
                  REVEAL WHAT IT WAS
                </button>
              </>
            )}
          </div>
        </section>
      </div>
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
