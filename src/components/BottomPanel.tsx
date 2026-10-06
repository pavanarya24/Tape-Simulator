import { useState } from "react";
import type { AppState } from "../state/app";
import { clockTime } from "../data/timezone";
import { money, signedMoney, pnlClass, num, pct, durationLabel } from "../util/format";
import { VIOLATION_LABELS, scoreGrade } from "../scoring/scoring";

type Tab = "trades" | "performance" | "orders" | "score";

export function BottomPanel({ state }: { state: AppState }) {
  const [tab, setTab] = useState<Tab>("trades");
  const { trades, stats, sessionStats, score, settings, fills, orders } = state;
  const grade = scoreGrade(score.overall);

  return (
    <div className="bottom">
      <div className="tabs">
        <button className={`tab ${tab === "trades" ? "active" : ""}`} onClick={() => setTab("trades")}>
          Trade history ({trades.length})
        </button>
        <button className={`tab ${tab === "performance" ? "active" : ""}`} onClick={() => setTab("performance")}>
          Performance
        </button>
        <button className={`tab ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>
          Orders &amp; fills ({orders.length})
        </button>
        <button className={`tab ${tab === "score" ? "active" : ""}`} onClick={() => setTab("score")}>
          Replay score
        </button>
        <span className="right" style={{ marginLeft: "auto", padding: "0 12px", alignSelf: "center" }}>
          <span className={`badge ${stats.netPnl > 0 ? "ok" : stats.netPnl < 0 ? "bad" : ""}`}>
            NET {signedMoney(stats.netPnl)}
          </span>
        </span>
      </div>

      <div className="tab-body">
        {tab === "trades" && (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Dir</th>
                <th className="r">Qty</th>
                <th className="r">Entry</th>
                <th className="r">Exit</th>
                <th className="r">Stop</th>
                <th className="r">Target</th>
                <th className="r">Gross</th>
                <th className="r">Net</th>
                <th className="r">R</th>
                <th className="r">Held</th>
                <th>Exit reason</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && (
                <tr>
                  <td colSpan={13}>
                    <div className="empty">
                      No trades yet. Place an order while the replay is running — fills are simulated
                      against revealed candles only.
                    </div>
                  </td>
                </tr>
              )}
              {[...trades].reverse().map((t, i) => (
                <tr key={t.id}>
                  <td>{trades.length - i}</td>
                  <td>{clockTime(t.entryTime, settings.timezone.displayTimeZone)}</td>
                  <td className={t.direction === "long" ? "up" : "down"}>{t.direction.toUpperCase()}</td>
                  <td className="r">{t.contracts}</td>
                  <td className="r">{num(t.entryPrice)}</td>
                  <td className="r">{num(t.exitPrice)}</td>
                  <td className="r">{t.stop !== undefined ? num(t.stop) : "—"}</td>
                  <td className="r">{t.target !== undefined ? num(t.target) : "—"}</td>
                  <td className={`r ${pnlClass(t.grossPnl)}`}>{signedMoney(t.grossPnl)}</td>
                  <td className={`r ${pnlClass(t.netPnl)}`}>{signedMoney(t.netPnl)}</td>
                  <td className={`r ${pnlClass(t.rMultiple)}`}>
                    {t.rMultiple !== undefined ? `${num(t.rMultiple, 2)}R` : "—"}
                  </td>
                  <td className="r">{durationLabel(t.holdingMs)}</td>
                  <td>{t.exitReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === "performance" && (
          <div style={{ padding: 12 }}>
            <div className="stat-grid" style={{ marginBottom: 12 }}>
              <Stat k="Net P&L" v={signedMoney(stats.netPnl)} cls={pnlClass(stats.netPnl)} />
              <Stat k="Gross profit" v={money(stats.grossProfit)} />
              <Stat k="Gross loss" v={money(-stats.grossLoss)} cls={stats.grossLoss ? "down" : ""} />
              <Stat k="Win rate" v={pct(stats.winRate)} />
              <Stat
                k="Profit factor"
                v={Number.isFinite(stats.profitFactor) ? num(stats.profitFactor, 2) : "∞"}
              />
              <Stat k="Avg winner" v={money(stats.avgWinner)} cls="up" />
              <Stat k="Avg loser" v={money(-stats.avgLoser)} cls="down" />
              <Stat k="Avg trade" v={signedMoney(stats.avgTrade)} cls={pnlClass(stats.avgTrade)} />
              <Stat k="Largest winner" v={money(stats.largestWinner)} cls="up" />
              <Stat k="Largest loser" v={money(stats.largestLoser)} cls="down" />
              <Stat k="Max drawdown" v={money(stats.maxDrawdown)} cls="down" />
              <Stat k="Number of trades" v={String(stats.trades)} />
              <Stat k="Average R" v={stats.avgR !== null ? `${num(stats.avgR, 2)}R` : "—"} />
              <Stat k="Expectancy" v={signedMoney(stats.expectancy)} cls={pnlClass(stats.expectancy)} />
              <Stat k="Commission" v={money(stats.totalCommission)} />
            </div>
            <div className="card" style={{ margin: 0 }}>
              <div className="card-head">
                <h3>Session statistics</h3>
              </div>
              <div className="card-body">
                <div className="stat-grid">
                  <Stat k="Starting balance" v={money(sessionStats.startingBalance)} />
                  <Stat k="Ending balance" v={money(sessionStats.endingBalance)} />
                  <Stat
                    k="Session P&L"
                    v={signedMoney(sessionStats.sessionPnl)}
                    cls={pnlClass(sessionStats.sessionPnl)}
                  />
                  <Stat k="Peak balance" v={money(sessionStats.peakBalance)} />
                  <Stat k="Maximum drawdown" v={money(sessionStats.maxDrawdown)} cls="down" />
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === "orders" && (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Side</th>
                <th className="r">Qty</th>
                <th className="r">Limit / stop</th>
                <th className="r">Fill</th>
                <th>Status</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">No orders submitted in this replay.</div>
                  </td>
                </tr>
              )}
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{clockTime(o.createdAt, settings.timezone.displayTimeZone)}</td>
                  <td>{o.type.toUpperCase()}</td>
                  <td className={o.side === "buy" ? "up" : "down"}>{o.side.toUpperCase()}</td>
                  <td className="r">{o.qty}</td>
                  <td className="r">{o.price !== undefined ? num(o.price) : "—"}</td>
                  <td className="r">{o.fillPrice !== undefined ? num(o.fillPrice) : "—"}</td>
                  <td>
                    <span className={`badge ${o.status === "filled" ? "ok" : o.status === "cancelled" ? "bad" : "warn"}`}>
                      {o.status}
                    </span>
                  </td>
                  <td className="dim">{o.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === "score" && (
          <div style={{ padding: 12 }}>
            <div className="score-grid" style={{ marginBottom: 12 }}>
              <ScoreCell k="Risk management" v={score.riskManagement} />
              <ScoreCell k="Execution" v={score.execution} />
              <ScoreCell k="Prediction" v={score.prediction} />
              <ScoreCell k="Discipline" v={score.discipline} />
              <ScoreCell k={`Overall (${grade.grade})`} v={score.overall} />
            </div>
            <div className="two-col">
              <div className="card" style={{ margin: 0 }}>
                <div className="card-head">
                  <h3>Score notes</h3>
                  <span className="right badge">{grade.label}</span>
                </div>
                <div className="card-body">
                  {score.notes.length === 0 ? (
                    <p className="dim" style={{ margin: 0, fontSize: 11.5 }}>
                      No outstanding notes. Profitability is only one of five inputs.
                    </p>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5 }}>
                      {score.notes.map((n, i) => (
                        <li key={i} className="dim">
                          {n}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div className="card" style={{ margin: 0 }}>
                <div className="card-head">
                  <h3>Rule violations</h3>
                  <span className="right badge">{state.violations.length}</span>
                </div>
                <div className="card-body">
                  {state.violations.length === 0 ? (
                    <p className="dim" style={{ margin: 0, fontSize: 11.5 }}>
                      No configured risk rule was broken.
                    </p>
                  ) : (
                    <div className="kv">
                      {[...state.violations].reverse().slice(0, 12).map((v) => (
                        <span key={v.id} style={{ display: "contents" }}>
                          <span className="k">{clockTime(v.time, settings.timezone.displayTimeZone)}</span>
                          <span className="v" style={{ color: "var(--down)" }}>
                            {VIOLATION_LABELS[v.kind]}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <p className="dim mono" style={{ fontSize: 10.5, marginTop: 10 }}>
              {fills.length} simulated fills · {trades.length} closed trades · starting balance{" "}
              {money(settings.startingBalance)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className={`v ${cls ?? ""}`}>{v}</span>
    </div>
  );
}

function ScoreCell({ k, v }: { k: string; v: number }) {
  return (
    <div className="score-cell">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      <div className="score-bar">
        <i style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}
