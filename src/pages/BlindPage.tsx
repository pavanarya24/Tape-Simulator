import { useMemo, useState } from "react";
import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { Chart } from "../components/Chart";
import { minutesOfDay, clockTime, isoDate } from "../data/timezone";
import { PREDICTION_CHOICES, REVEAL_HORIZONS, type PredictionChoice } from "../scoring/predictions";
import { price as fmtPrice, pct, tzTime } from "../util/format";

const START_TIMES = [
  { label: "09:30", minutes: 9 * 60 + 30 },
  { label: "09:45", minutes: 9 * 60 + 45 },
  { label: "10:00", minutes: 10 * 60 },
  { label: "10:30", minutes: 10 * 60 + 30 },
  { label: "11:00", minutes: 11 * 60 },
  { label: "12:00", minutes: 12 * 60 },
  { label: "13:30", minutes: 13 * 60 + 30 },
  { label: "14:00", minutes: 14 * 60 },
];

const ANCHOR_TZ = "America/New_York";

export function BlindPage({ state }: { state: AppState }) {
  const [startTime, setStartTime] = useState(START_TIMES[0].minutes);
  const [choice, setChoice] = useState<PredictionChoice>("Bullish");
  const [reasoning, setReasoning] = useState("");

  const bars = controller.session?.bars ?? null;

  const startIndex = useMemo(() => {
    if (!bars) return 0;
    for (let i = 0; i < bars.length; i++) {
      if (minutesOfDay(bars.t[i], ANCHOR_TZ) >= startTime) return i;
    }
    return Math.max(0, bars.length - 1);
  }, [bars, startTime]);

  const correct = state.predictions.filter((p) => p.correct).length;
  const accuracy = state.predictions.length ? (correct / state.predictions.length) * 100 : 0;

  return (
    <>
      <h2>Blind training mode</h2>
      <p className="lede">
        The replay stops at a chosen time. You see only the market history revealed so far — the
        future stays hidden. State what you expect next, then reveal 5, 10 or 20 bars and find out.
        Predictions are judged by fixed rules over the revealed bars, not by hindsight.
      </p>

      <div className="two-col">
        <div className="card">
          <div className="card-head">
            <h3>Setup</h3>
            {state.blind.active ? (
              <span className="right badge ok">BLIND SESSION ACTIVE</span>
            ) : (
              <span className="right badge">NOT STARTED</span>
            )}
          </div>
          <div className="card-body">
            <div className="kv" style={{ marginBottom: 12 }}>
              <span className="k">Instrument</span>
              <span className="v">{state.settings.instrument}</span>
              <span className="k">Session</span>
              <span className="v">{state.settings.sessionType}</span>
              <span className="k">Date</span>
              <span className="v">{state.session?.date ?? "—"}</span>
              <span className="k">Starting time</span>
              <span className="v">{clockTime(bars?.t[startIndex] ?? 0, ANCHOR_TZ)}</span>
              <span className="k">Starting bar</span>
              <span className="v">
                {startIndex + 1} / {bars?.length ?? 0}
              </span>
            </div>
            <div className="chips" style={{ marginBottom: 12 }}>
              {START_TIMES.map((t) => (
                <button
                  key={t.label}
                  className={`chip ${startTime === t.minutes ? "on" : ""}`}
                  onClick={() => setStartTime(t.minutes)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="btn-row">
              <button
                className="btn primary"
                onClick={() => controller.startBlind(startIndex)}
                disabled={!state.session}
              >
                START BLIND SESSION
              </button>
              <button className="btn" onClick={() => controller.exitBlind()} disabled={!state.blind.active}>
                EXIT
              </button>
              <button className="btn" onClick={() => controller.stepForward()}>
                STEP ▶
              </button>
              <button className="btn" onClick={() => controller.stepBack()}>
                ◀ STEP
              </button>
            </div>
            {state.blind.active && (
              <p className="dim" style={{ fontSize: 10.5, marginTop: 10, marginBottom: 0 }}>
                Scrubbing forward is disabled while Blind Mode is active — the timeline cannot be
                used to peek at future prices. Stepping forward reveals one bar at a time.
              </p>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Make a prediction</h3>
            <span className="right badge">
              {state.predictions.length} logged · {pct(accuracy)} correct
            </span>
          </div>
          <div className="card-body">
            <div className="field wide">
              <label>What do you expect next?</label>
              <div className="chips" style={{ marginTop: 4 }}>
                {PREDICTION_CHOICES.map((c) => (
                  <button key={c} className={`chip ${choice === c ? "on" : ""}`} onClick={() => setChoice(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="field wide">
              <label>Explain your reasoning (optional)</label>
              <textarea
                value={reasoning}
                onChange={(e) => setReasoning(e.target.value)}
                placeholder="Structure, level, volume context, what would invalidate the idea…"
              />
            </div>
            <button
              className="btn primary wide"
              disabled={!state.blind.active || state.blind.awaitingReveal}
              onClick={() => controller.makePrediction(choice, reasoning)}
            >
              MAKE PREDICTION
            </button>

            {state.pendingPrediction && (
              <div className="callout info" style={{ marginTop: 12 }}>
                <strong>{state.pendingPrediction.choice}</strong> predicted at{" "}
                {tzTime(state.pendingPrediction.time, ANCHOR_TZ)} ·{" "}
                {fmtPrice(state.pendingPrediction.startPrice)}. Now choose how much to reveal.
                <div className="btn-row" style={{ marginTop: 9 }}>
                  {REVEAL_HORIZONS.map((h) => (
                    <button key={h} className="btn" onClick={() => controller.revealPrediction(h)}>
                      REVEAL {h} BARS
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!state.blind.active && (
              <p className="dim" style={{ fontSize: 11, marginTop: 10, marginBottom: 0 }}>
                Start a blind session to record predictions.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Replay</h3>
          <span className="right badge">
            {state.blind.active ? "FUTURE HIDDEN" : "FULL HISTORY VISIBLE"}
          </span>
        </div>
        <div style={{ height: 430, display: "flex", flexDirection: "column" }}>
          <Chart state={state} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Prediction history</h3>
          <span className="right badge">{state.predictions.length}</span>
        </div>
        <div className="card-body">
          {state.predictions.length === 0 ? (
            <p className="dim" style={{ margin: 0, fontSize: 11.5 }}>
              No predictions yet.
            </p>
          ) : (
            <div className="pred-history">
              {[...state.predictions].reverse().map((p) => (
                <div key={p.id} className="pred-row">
                  <span className="dim">
                    {p.time ? tzTime(p.time, ANCHOR_TZ) : ""} · {isoDate(p.time, ANCHOR_TZ)}
                  </span>
                  <span>
                    <strong>{p.choice}</strong> · {p.detail}
                    {p.reasoning && (
                      <>
                        <br />
                        <span className="dim">{p.reasoning}</span>
                      </>
                    )}
                  </span>
                  <span className={`badge ${p.correct ? "ok" : "bad"}`}>
                    {p.correct ? "CORRECT" : "MISSED"} · {p.horizon}B
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
