import { useState } from "react";
import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { JOURNAL_NOTE_FIELDS, exportJournalCsv } from "../journal/journal";
import { clockTime, isoDate } from "../data/timezone";
import { money, signedMoney, pnlClass, num, durationLabel } from "../util/format";

export function JournalPage({ state }: { state: AppState }) {
  const { trades, settings } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = trades.find((t) => t.id === selectedId) ?? trades[trades.length - 1] ?? null;

  return (
    <>
      <h2>Trade journal</h2>
      <p className="lede">
        Every simulated trade is recorded automatically with instrument, session, entry and exit,
        size, direction, stop, target, gross and net P&amp;L, R multiple and holding time. The
        reflective fields below are yours to fill in. The journal is also part of the replay score —
        but only through what it records, never through what it says.
      </p>

      <div className="card">
        <div className="card-head">
          <h3>Journal</h3>
          <div className="right btn-row">
            <span className="badge">{trades.length} trades</span>
            <button
              className="btn sm"
              disabled={trades.length === 0}
              onClick={() => exportJournalCsv(trades, settings.timezone.displayTimeZone)}
            >
              EXPORT CSV
            </button>
          </div>
        </div>
        <div className="tbl-scroll" style={{ maxHeight: 340 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Session</th>
                <th>Contract</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Dir</th>
                <th className="r">Qty</th>
                <th className="r">Entry px</th>
                <th className="r">Exit px</th>
                <th className="r">Stop</th>
                <th className="r">Target</th>
                <th className="r">Gross</th>
                <th className="r">Net</th>
                <th className="r">R</th>
                <th className="r">Held</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && (
                <tr>
                  <td colSpan={15}>
                    <div className="empty">No trades recorded yet.</div>
                  </td>
                </tr>
              )}
              {[...trades].reverse().map((t) => (
                <tr
                  key={t.id}
                  onClick={() => setSelectedId(t.id)}
                  style={{
                    cursor: "pointer",
                    background: selected?.id === t.id ? "#12161b" : undefined,
                  }}
                >
                  <td>{isoDate(t.entryTime, settings.timezone.displayTimeZone)}</td>
                  <td>{t.sessionType}</td>
                  <td>{t.contract}</td>
                  <td>{clockTime(t.entryTime, settings.timezone.displayTimeZone)}</td>
                  <td>{clockTime(t.exitTime, settings.timezone.displayTimeZone)}</td>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="card">
          <div className="card-head">
            <h3>
              Trade notes — {selected.direction.toUpperCase()} {selected.contracts} {selected.instrument} @{" "}
              {num(selected.entryPrice)}
            </h3>
            <span className={`right badge ${pnlClass(selected.netPnl) === "up" ? "ok" : "bad"}`}>
              {signedMoney(selected.netPnl)} · {selected.rMultiple !== undefined ? `${num(selected.rMultiple, 2)}R` : "no R"}
            </span>
          </div>
          <div className="card-body">
            <div className="kv" style={{ marginBottom: 12 }}>
              <span className="k">Session</span>
              <span className="v">
                {selected.instrument} {selected.sessionType} · {selected.sessionDate}
              </span>
              <span className="k">Entry / exit</span>
              <span className="v">
                {num(selected.entryPrice)} → {num(selected.exitPrice)}
              </span>
              <span className="k">Stop / target</span>
              <span className="v">
                {selected.stop !== undefined ? num(selected.stop) : "—"} /{" "}
                {selected.target !== undefined ? num(selected.target) : "—"}
              </span>
              <span className="k">Gross / commission / net</span>
              <span className="v">
                {money(selected.grossPnl)} − {money(selected.commission)} = {signedMoney(selected.netPnl)}
              </span>
              <span className="k">Holding time</span>
              <span className="v">{durationLabel(selected.holdingMs)}</span>
              <span className="k">Exit reason</span>
              <span className="v">{selected.exitReason}</span>
            </div>
            <div className="two-col">
              {JOURNAL_NOTE_FIELDS.map((f) => (
                <div className="field wide" key={f.key}>
                  <label>
                    {f.label} <span className="dim">— {f.hint}</span>
                  </label>
                  <textarea
                    value={selected.notes[f.key]}
                    onChange={(e) =>
                      controller.updateTradeNotes(selected.id, { [f.key]: e.target.value })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
