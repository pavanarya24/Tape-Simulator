import type { AppState, Page } from "../state/app";
import { controller } from "../state/useApp";
import { CONTRACTS } from "../market/instruments";
import { formatDateLabel } from "../data/timezone";
import { money, signedMoney, pnlClass, timeframeLabel } from "../util/format";
import type { RootSymbol } from "../market/types";

const PAGES: Array<{ id: Page; label: string }> = [
  { id: "terminal", label: "Terminal" },
  { id: "blind", label: "Blind Mode" },
  { id: "flow", label: "Flow Lab" },
  { id: "scenarios", label: "Scenarios" },
  { id: "data", label: "Data" },
  { id: "journal", label: "Journal" },
  { id: "score", label: "Score" },
];

export function TopBar({ state }: { state: AppState }) {
  const { session, engine, position, sessionStats, settings, stats, sessions } = state;
  const spec = CONTRACTS[settings.contract];
  const livePnl = sessionStats.sessionPnl + position.unrealized;
  const dataset = state.datasets.find((d) => d.instrument === settings.instrument);
  const datasetTimeframe = dataset?.meta.detectedTimeframeMs ?? 5 * 60 * 1000;

  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-mark">TL</span>
        <span>
          <span className="brand-name">TAPE LAB</span>
          <br />
          <span className="brand-sub">OHLC REPLAY</span>
        </span>
      </div>

      <div className="topbar-nav">
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={`navbtn ${state.page === p.id ? "active" : ""}`}
            onClick={() => controller.setPage(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="tb-group">
        <span className="tb-label">Instrument</span>
        <div className="seg">
          {(["NQ", "ES"] as RootSymbol[]).map((r) => (
            <button
              key={r}
              className={settings.instrument === r ? "on" : ""}
              onClick={() => void controller.selectInstrument(r)}
              disabled={!state.instruments.includes(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="tb-group">
        <span className="tb-label">Session</span>
        <div className="seg">
          <button
            className={settings.sessionType === "RTH" ? "on" : ""}
            onClick={() => void controller.selectSessionType("RTH")}
          >
            RTH
          </button>
          <button
            className={settings.sessionType === "ETH" ? "on" : ""}
            onClick={() => void controller.selectSessionType("ETH")}
          >
            ETH
          </button>
        </div>
        <select
          value={session?.id ?? ""}
          onChange={(e) => void controller.selectSession(e.target.value)}
          style={{ width: 172, maxWidth: "100%" }}
        >
          {sessions.length === 0 && <option value="">no sessions</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {formatDateLabel(s.date)} · {s.bars} bars
            </option>
          ))}
        </select>
        <button className="btn sm" title="Previous session" onClick={() => void controller.stepSession(-1)}>
          ◀
        </button>
        <button className="btn sm" title="Next session" onClick={() => void controller.stepSession(1)}>
          ▶
        </button>
        <button className="btn sm" title="Random session" onClick={() => void controller.randomSession()}>
          ⤫
        </button>
      </div>

      <div className="tb-group grow">
        <span className="sim-badge">
          <span className={`dot ${engine?.playing ? "live" : "paused"}`} />
          SIMULATED TRADING — HISTORICAL REPLAY
        </span>
        {state.datasets.some((d) => d.meta.source === "DEMO") && (
          <span className="badge demo" title="Synthetic demo dataset — import real CSVs on the Data page">
            DEMO DATA
          </span>
        )}
        <span className="tb-label mono">{timeframeLabel(datasetTimeframe)} bars</span>
        <a className="navbtn" href="/academy.html" target="_blank" rel="noreferrer">
          Academy ↗
        </a>
      </div>

      <div className="tb-group" style={{ gap: 18 }}>
        <div className="tb-stat">
          <span className="tb-label">Balance</span>
          <span className="tb-value sm">{money(sessionStats.endingBalance + position.unrealized)}</span>
        </div>
        <div className="tb-stat">
          <span className="tb-label">Current P&amp;L</span>
          <span className={`tb-value sm ${pnlClass(livePnl)}`}>{signedMoney(livePnl)}</span>
        </div>
        <div className="tb-stat">
          <span className="tb-label">Closed</span>
          <span className={`tb-value sm ${pnlClass(stats.netPnl)}`}>{signedMoney(stats.netPnl)}</span>
        </div>
        <div className="tb-stat">
          <span className="tb-label">Contract</span>
          <span className="tb-value sm">
            {spec.id} · {money(spec.tickValue)}/tick
          </span>
        </div>
      </div>
    </div>
  );
}
