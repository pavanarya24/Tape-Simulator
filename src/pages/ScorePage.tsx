import type { AppState } from "../state/app";
import { scoreGrade, VIOLATION_LABELS } from "../scoring/scoring";
import { money, signedMoney, pnlClass, num, pct } from "../util/format";
import { clockTime } from "../data/timezone";

const WEIGHTS: Array<{ key: keyof ReturnType<typeof pickScore>; label: string; weight: number; why: string }> = [
  { key: "riskManagement", label: "Risk management", weight: 30, why: "Drawdown against account, size discipline, stop usage." },
  { key: "execution", label: "Execution", weight: 25, why: "Profit factor, win rate and average R over closed trades." },
  { key: "prediction", label: "Prediction", weight: 20, why: "Accuracy of blind-mode calls across recorded predictions." },
  { key: "discipline", label: "Discipline", weight: 25, why: "Configured rule violations — size, stops, trade count, loss limit." },
];

function pickScore() {
  return { riskManagement: 0, execution: 0, prediction: 0, discipline: 0, overall: 0 };
}

export function ScorePage({ state }: { state: AppState }) {
  const { score, stats, sessionStats, predictions, violations, settings } = state;
  const grade = scoreGrade(score.overall);
  const correct = predictions.filter((p) => p.correct).length;

  return (
    <>
      <h2>Replay score</h2>
      <p className="lede">
        A single number hides more than it shows, so the replay score is split into four sub-scores.
        Profitability is one of them — and deliberately not the largest. A flat, disciplined session
        with clean risk scores better than a profitable one that broke every rule to get there.
      </p>

      <div className="card">
        <div className="card-head">
          <h3>Overall</h3>
          <span className={`right badge ${score.overall >= 80 ? "ok" : score.overall >= 60 ? "warn" : "bad"}`}>
            GRADE {grade.grade} · {grade.label}
          </span>
        </div>
        <div className="card-body">
          <div className="score-grid">
            {WEIGHTS.map((w) => {
              const value = score[w.key];
              return (
                <div className="score-cell" key={w.key}>
                  <div className="k">
                    {w.label} · {w.weight}%
                  </div>
                  <div className="v">{value}</div>
                  <div className="score-bar">
                    <i style={{ width: `${value}%` }} />
                  </div>
                  <p className="dim" style={{ fontSize: 10.5, margin: "7px 0 0" }}>
                    {w.why}
                  </p>
                </div>
              );
            })}
            <div className="score-cell">
              <div className="k">Overall</div>
              <div className="v">{score.overall}</div>
              <div className="score-bar">
                <i style={{ width: `${score.overall}%` }} />
              </div>
              <p className="dim" style={{ fontSize: 10.5, margin: "7px 0 0" }}>
                Weighted 30 / 25 / 20 / 25 across the four sub-scores.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-head">
            <h3>Trading results</h3>
          </div>
          <div className="card-body">
            <div className="kv">
              <span className="k">Closed trades</span>
              <span className="v">{stats.trades}</span>
              <span className="k">Net P&amp;L</span>
              <span className={`v ${pnlClass(stats.netPnl)}`}>{signedMoney(stats.netPnl)}</span>
              <span className="k">Win rate</span>
              <span className="v">{pct(stats.winRate)}</span>
              <span className="k">Profit factor</span>
              <span className="v">{Number.isFinite(stats.profitFactor) ? num(stats.profitFactor, 2) : "∞"}</span>
              <span className="k">Average R</span>
              <span className="v">{stats.avgR !== null ? `${num(stats.avgR, 2)}R` : "—"}</span>
              <span className="k">Expectancy</span>
              <span className={`v ${pnlClass(stats.expectancy)}`}>{signedMoney(stats.expectancy)}</span>
              <span className="k">Max drawdown</span>
              <span className="v down">{money(stats.maxDrawdown)}</span>
              <span className="k">Starting balance</span>
              <span className="v">{money(settings.startingBalance)}</span>
              <span className="k">Ending balance</span>
              <span className="v">{money(sessionStats.endingBalance)}</span>
              <span className="k">Peak balance</span>
              <span className="v">{money(sessionStats.peakBalance)}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Prediction accuracy</h3>
            <span className="right badge">
              {correct} / {predictions.length}
            </span>
          </div>
          <div className="card-body">
            {predictions.length === 0 ? (
              <p className="dim" style={{ margin: 0, fontSize: 11.5 }}>
                No blind-mode predictions recorded — the prediction sub-score sits at its neutral value
                of 70 rather than counting as a failure.
              </p>
            ) : (
              <>
                <div className="stat-grid" style={{ marginBottom: 10 }}>
                  <div className="stat">
                    <span className="k">Accuracy</span>
                    <span className="v">{pct(predictions.length ? (correct / predictions.length) * 100 : 0)}</span>
                  </div>
                  <div className="stat">
                    <span className="k">Predictions</span>
                    <span className="v">{predictions.length}</span>
                  </div>
                  <div className="stat">
                    <span className="k">Correct</span>
                    <span className="v up">{correct}</span>
                  </div>
                </div>
                <div className="pred-history">
                  {[...predictions].reverse().slice(0, 8).map((p) => (
                    <div className="pred-row" key={p.id}>
                      <span className="dim">{p.choice}</span>
                      <span className="dim">{p.detail}</span>
                      <span className={`badge ${p.correct ? "ok" : "bad"}`}>{p.horizon}B</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Rule violations</h3>
          <span className="right badge">{violations.length}</span>
        </div>
        <div className="card-body">
          {violations.length === 0 ? (
            <p className="dim" style={{ margin: 0, fontSize: 11.5 }}>
              No configured rule was broken this session.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Rule</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {[...violations].reverse().map((v) => (
                  <tr key={v.id}>
                    <td>{clockTime(v.time, settings.timezone.displayTimeZone)}</td>
                    <td className="down">{VIOLATION_LABELS[v.kind]}</td>
                    <td className="dim">{v.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="dim" style={{ fontSize: 10.5, marginBottom: 0, marginTop: 10 }}>
            Risk rules live on the terminal: contract cap {settings.maxContracts}, session trade limit{" "}
            {settings.maxTradesPerSession}, daily loss limit {money(settings.dailyLossLimit)}, protective
            stop {settings.requireStop ? "required" : "optional"}.
          </p>
        </div>
      </div>

      {score.notes.length > 0 && (
        <div className="callout">
          <strong>Score notes:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
            {score.notes.map((n, i) => (
              <li key={i} className="dim">
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
