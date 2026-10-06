import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { REPLAY_SPEEDS } from "../replay/ReplayEngine";
import { CONTRACTS, contractsForRoot } from "../market/instruments";
import { formatDateLabel, clockTime } from "../data/timezone";
import { compact, num, pct, price as fmtPrice, tzDate } from "../util/format";

export function LeftColumn({ state }: { state: AppState }) {
  const { session, engine, settings, indicators, blind } = state;

  return (
    <div className="col left">
      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Session selector</span>
        </div>
        <div className="panel-body">
          <div className="kv" style={{ marginBottom: 10 }}>
            <span className="k">Instrument</span>
            <span className="v">{settings.instrument}</span>
            <span className="k">Session</span>
            <span className="v">{settings.sessionType === "RTH" ? "RTH 09:30–16:00" : "Full session"}</span>
            <span className="k">Date</span>
            <span className="v">{session ? formatDateLabel(session.date) : "—"}</span>
            <span className="k">Bars</span>
            <span className="v">{session?.bars ?? "—"}</span>
            {blind.active ? (
              // Session high/low/volume are future price data for the whole
              // session. Blind Mode must never reveal them.
              <>
                <span className="k">Session high / low</span>
                <span className="v dim">hidden in blind mode</span>
                <span className="k">Session volume</span>
                <span className="v dim">hidden in blind mode</span>
              </>
            ) : (
              <>
                <span className="k">Session high</span>
                <span className="v">{session ? fmtPrice(session.high) : "—"}</span>
                <span className="k">Session low</span>
                <span className="v">{session ? fmtPrice(session.low) : "—"}</span>
                <span className="k">Session volume</span>
                <span className="v">{session ? compact(session.volume) : "—"}</span>
              </>
            )}
          </div>
          <div className="btn-row">
            <button className="btn sm" onClick={() => void controller.randomSession()}>
              Random session
            </button>
            <button className="btn sm" onClick={() => void controller.stepSession(-1)}>
              Previous
            </button>
            <button className="btn sm" onClick={() => void controller.stepSession(1)}>
              Next
            </button>
          </div>
          <p className="dim" style={{ fontSize: 10.5, marginBottom: 0, marginTop: 10 }}>
            Only sessions present in the loaded dataset are listed. RTH boundaries are always
            09:30–16:00 America/New_York.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Replay engine</span>
          <span className="right badge">{engine?.playing ? "PLAYING" : "PAUSED"}</span>
        </div>
        <div className="panel-body">
          <div className="btn-row" style={{ marginBottom: 8 }}>
            <button className="btn primary" onClick={() => controller.togglePlay()} disabled={!engine}>
              {engine?.playing ? "❚❚ PAUSE" : "▶ PLAY"}
            </button>
            <button className="btn" onClick={() => controller.stepBack()} disabled={!engine}>
              ◀ STEP
            </button>
            <button className="btn" onClick={() => controller.stepForward()} disabled={!engine}>
              STEP ▶
            </button>
            <button className="btn" onClick={() => controller.resetReplay()} disabled={!engine}>
              ⟲ RESET
            </button>
          </div>

          <input
            className="scrub"
            type="range"
            min={0}
            max={Math.max(0, (engine?.length ?? 1) - 1)}
            value={engine?.cursor ?? 0}
            onChange={(e) => controller.seek(Number(e.target.value))}
            disabled={!engine}
          />

          <div style={{ marginBottom: 8 }}>
            <span className="tb-label">Speed</span>
            <div className="chips" style={{ marginTop: 4 }}>
              {REPLAY_SPEEDS.map((s) => (
                <button
                  key={s}
                  className={`chip ${engine?.speed === s ? "on" : ""}`}
                  onClick={() => controller.setSpeed(s)}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>

          <div className="replay-strip">
            <div className="cell">
              <span className="k">Replay time</span>
              <span className="v">
                {engine ? clockTime(engine.replayTime, settings.timezone.displayTimeZone) : "—"}
              </span>
            </div>
            <div className="cell">
              <span className="k">Progress</span>
              <span className="v">{engine ? pct(engine.progressPct) : "—"}</span>
            </div>
            <div className="cell">
              <span className="k">Bars elapsed</span>
              <span className="v">{engine?.barsElapsed ?? "—"}</span>
            </div>
            <div className="cell">
              <span className="k">Bars remaining</span>
              <span className="v">{engine?.barsRemaining ?? "—"}</span>
            </div>
          </div>
          <div className="progress">
            <i style={{ width: `${engine?.progressPct ?? 0}%` }} />
          </div>
          <p className="dim" style={{ fontSize: 10.5, margin: "8px 0 0" }}>
            Space play/pause · → next bar · ← previous bar · R reset
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Execution model</span>
        </div>
        <div className="panel-body">
          <div className="field">
            <label>Contract</label>
            <select value={settings.contract} onChange={(e) => controller.setContract(e.target.value as never)}>
              {contractsForRoot(settings.instrument).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id} — {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="kv" style={{ marginBottom: 10 }}>
            <span className="k">Point value</span>
            <span className="v">${CONTRACTS[settings.contract].pointValue.toFixed(2)}</span>
            <span className="k">Tick size</span>
            <span className="v">{CONTRACTS[settings.contract].tickSize}</span>
            <span className="k">Tick value</span>
            <span className="v">${CONTRACTS[settings.contract].tickValue.toFixed(2)}</span>
          </div>
          <div className="field">
            <label>Ambiguity</label>
            <select
              value={settings.ambiguityRule}
              onChange={(e) => controller.setAmbiguityRule(e.target.value as never)}
            >
              <option value="adverse-first">Adverse level first (default)</option>
              <option value="favorable-first">Favourable level first</option>
              <option value="skip">Ignore ambiguous bar</option>
            </select>
          </div>
          <div className="field">
            <label>Slippage</label>
            <select
              value={settings.slippageTicks}
              onChange={(e) => controller.updateSettings({ slippageTicks: Number(e.target.value) })}
            >
              {[0, 1, 2, 3].map((t) => (
                <option key={t} value={t}>
                  {t} tick{t === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Commission</label>
            <input
              type="number"
              step={0.5}
              min={0}
              value={settings.commissionPerContractRoundTurn}
              onChange={(e) =>
                controller.updateSettings({ commissionPerContractRoundTurn: Number(e.target.value) })
              }
            />
          </div>
          <div className="callout warn" style={{ marginTop: 10, fontSize: 10.5 }}>
            <strong>OHLC limitation.</strong> Fills are candle-based assumptions, not reconstructions.
            Market orders fill at the next candle open. When one bar contains both stop and target,
            the intrabar path is unknown and the ambiguity rule above decides.
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <span className="panel-title">Session classification</span>
        </div>
        <div className="panel-body">
          {state.currentClassification?.features ? (
            <div className="kv">
              <span className="k">Opening range</span>
              <span className="v">
                {fmtPrice(indicators?.openingRange.high)} / {fmtPrice(indicators?.openingRange.low)}
              </span>
              <span className="k">Net / range</span>
              <span className="v">{num(state.currentClassification.features.netToRange, 2)}</span>
              <span className="k">Close location</span>
              <span className="v">{pct(state.currentClassification.features.closeLocationPct, 0)}</span>
              <span className="k">Primary tag</span>
              <span className="v">
                {state.currentClassification.primary ? state.currentClassification.primary.replace(/-/g, " ") : "mixed"}
              </span>
              <span className="k">Session open</span>
              <span className="v">{session ? tzDate(session.firstTime, settings.timezone.displayTimeZone) : "—"}</span>
            </div>
          ) : (
            <p className="dim" style={{ fontSize: 11, margin: 0 }}>
              No opening range available for this session type.
            </p>
          )}
          <p className="dim" style={{ fontSize: 10.5, marginBottom: 0 }}>
            Tags are derived from OHLC structure only — never from order flow.
          </p>
        </div>
      </section>
    </div>
  );
}
