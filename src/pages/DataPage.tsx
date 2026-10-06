import { useRef, useState } from "react";
import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { TIMEZONE_CHOICES, formatDateLabel, isoDate } from "../data/timezone";
import type { RootSymbol } from "../market/types";
import { compact, num } from "../util/format";
import { timeframeLabel } from "../util/format";

function QualityRow({ label, value, ok }: { label: string; value: string; ok: boolean | null }) {
  return (
    <div className="kv" style={{ padding: "3px 0" }}>
      <span className="k">{label}</span>
      <span className="v" style={{ color: ok === null ? "var(--dim)" : ok ? "var(--up)" : "var(--down)" }}>
        {value}
        {ok !== null && <span style={{ marginLeft: 8 }}>{ok ? "✓" : "✕"}</span>}
      </span>
    </div>
  );
}

export function DataPage({ state }: { state: AppState }) {
  const [dragOver, setDragOver] = useState<RootSymbol | null>(null);
  const inputs = {
    NQ: useRef<HTMLInputElement | null>(null),
    ES: useRef<HTMLInputElement | null>(null),
  };

  const handleFile = (instrument: RootSymbol, file: File | undefined) => {
    if (!file) return;
    void controller.importCsv(instrument, file);
  };

  return (
    <>
      <h2>Data explorer</h2>
      <p className="lede">
        Tape Lab stores normalized bars in a local IndexedDB database and loads exactly one session at
        a time — the full multi-year series is never pulled into the browser UI. Import 5-minute OHLCV
        CSVs with a <span className="mono">Time, Open, High, Low, Close, Volume</span> header to replace
        the synthetic demo data.
      </p>

      <div className="callout info">
        <strong>OHLCV only.</strong> These datasets contain no Time &amp; Sales, no bid/ask and no
        Level-2 depth. Nothing in Tape Lab will claim otherwise.
      </div>

      {state.ingest && (
        <div className="card">
          <div className="card-head">
            <h3>Importing</h3>
            <span className="right badge warn">{state.ingest.phase.toUpperCase()}</span>
          </div>
          <div className="card-body">
            <p className="mono" style={{ margin: 0, fontSize: 11.5 }}>
              {state.ingest.message}
            </p>
            <div className="progressbar">
              <i
                style={{
                  width: `${
                    state.ingest.totalBytes > 0
                      ? Math.round((state.ingest.bytesRead / state.ingest.totalBytes) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Import CSV</h3>
          <span className="right badge">
            source timezone: {state.settings.timezone.sourceTimeZone}
          </span>
        </div>
        <div className="card-body">
          <div className="two-col">
            {(["NQ", "ES"] as RootSymbol[]).map((root) => (
              <div key={root}>
                <div
                  className={`drop ${dragOver === root ? "over" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(root);
                  }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(null);
                    handleFile(root, e.dataTransfer.files[0]);
                  }}
                  onClick={() => inputs[root].current?.click()}
                >
                  <strong style={{ color: "var(--text)" }}>{root}</strong> — drop CSV here or click to
                  choose
                  <div className="dim" style={{ marginTop: 6 }}>
                    ~{root === "NQ" ? "329,458" : "353,206"} rows expected · 5-minute bars · Aug 2019 →
                    Aug 2024
                  </div>
                </div>
                <input
                  ref={inputs[root]}
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: "none" }}
                  onChange={(e) => handleFile(root, e.target.files?.[0])}
                />
              </div>
            ))}
          </div>
          <p className="dim" style={{ fontSize: 10.5, marginBottom: 0, marginTop: 10 }}>
            Timestamps without an offset are interpreted as wall-clock time in the source timezone
            above. ISO strings with <span className="mono">Z</span> or a numeric offset are treated as
            absolute instants. Epoch seconds and milliseconds are also accepted.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Timezone</h3>
        </div>
        <div className="card-body">
          <div className="grid2">
            <div className="field">
              <label>Source</label>
              <select
                value={state.settings.timezone.sourceTimeZone}
                onChange={(e) => void controller.setSourceTimezone(e.target.value)}
              >
                {TIMEZONE_CHOICES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Display</label>
              <select
                value={state.settings.timezone.displayTimeZone}
                onChange={(e) => controller.setDisplayTimezone(e.target.value)}
              >
                {TIMEZONE_CHOICES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="dim" style={{ fontSize: 10.5, margin: 0 }}>
            Changing the source timezone re-interprets every stored timestamp and rebuilds the session
            index. RTH always means 09:30–16:00 America/New_York.
          </p>
        </div>
      </div>

      {state.datasets.map((d) => {
        const q = d.meta.quality;
        const allSessions = [...d.rthSessions, ...d.ethSessions];
        const dates = d.rthSessions.length >= d.ethSessions.length ? d.rthSessions : d.ethSessions;
        const firstDates = dates.slice(0, 10).map((s) => s.date);
        const lastDates = dates.slice(-10).map((s) => s.date);
        return (
          <div className="card" key={d.instrument}>
            <div className="card-head">
              <h3>
                {d.instrument} — {d.meta.label}
              </h3>
              <span className={`right badge ${d.meta.source === "DEMO" ? "demo" : "ok"}`}>
                {d.meta.source === "DEMO" ? "SYNTHETIC DEMO" : "IMPORTED CSV"}
              </span>
              <span className={`badge ${q.passed ? "ok" : "bad"}`}>
                {q.passed ? "VALIDATION PASSED" : "ISSUES FOUND"}
              </span>
            </div>
            <div className="card-body">
              <div className="two-col">
                <div>
                  <div className="kv">
                    <span className="k">Bars</span>
                    <span className="v">{q.rows.toLocaleString()}</span>
                    <span className="k">Timeframe</span>
                    <span className="v">{timeframeLabel(q.detectedTimeframeMs)}</span>
                    <span className="k">RTH sessions</span>
                    <span className="v">{d.rthSessions.length}</span>
                    <span className="k">ETH sessions</span>
                    <span className="v">{d.ethSessions.length}</span>
                    <span className="k">First bar</span>
                    <span className="v">{q.firstBar ? formatDateLabel(isoDate(q.firstBar, d.meta.timezone.sourceTimeZone)) : "—"}</span>
                    <span className="k">Last bar</span>
                    <span className="v">{q.lastBar ? formatDateLabel(isoDate(q.lastBar, d.meta.timezone.sourceTimeZone)) : "—"}</span>
                    <span className="k">Total volume</span>
                    <span className="v">{compact(allSessions.reduce((a, s) => a + s.volume, 0))}</span>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <div className="panel-title" style={{ marginBottom: 6 }}>
                      Available dates ({dates.length})
                    </div>
                    <div className="chips">
                      {firstDates.map((dt) => (
                        <span key={`f-${dt}`} className="chip">
                          {dt}
                        </span>
                      ))}
                      {dates.length > 20 && <span className="dim mono" style={{ fontSize: 10.5 }}>…</span>}
                      {dates.length > 10 &&
                        lastDates
                          .filter((dt) => !firstDates.includes(dt))
                          .map((dt) => (
                            <span key={`l-${dt}`} className="chip">
                              {dt}
                            </span>
                          ))}
                    </div>
                    <p className="dim" style={{ fontSize: 10.5, marginBottom: 0 }}>
                      Showing the earliest and latest sessions; every date in between is selectable
                      in the session dropdown on the terminal.
                    </p>
                  </div>
                </div>
                <div>
                  <div className="panel-title" style={{ marginBottom: 6 }}>
                    Data-quality checks
                  </div>
                  <QualityRow
                    label="Duplicate timestamps"
                    value={q.duplicateTimestamps.toLocaleString()}
                    ok={q.duplicateTimestamps === 0}
                  />
                  <QualityRow label="Missing bars" value={q.missingBars.toLocaleString()} ok={q.missingBars === 0} />
                  <QualityRow label="Invalid OHLC" value={q.invalidOhlc.toLocaleString()} ok={q.invalidOhlc === 0} />
                  <QualityRow
                    label="Zero volume"
                    value={q.zeroVolumeBars.toLocaleString()}
                    ok={q.zeroVolumeBars === 0}
                  />
                  <QualityRow
                    label="Timeframe consistency"
                    value={q.timeframeConsistent ? "consistent" : "mixed intervals"}
                    ok={q.timeframeConsistent}
                  />
                  <QualityRow label="Non-monotonic rows" value={String(q.nonMonotonic)} ok={q.nonMonotonic === 0} />
                  {q.missingExamples.length > 0 && (
                    <p className="dim mono" style={{ fontSize: 10.5, marginTop: 8 }}>
                      Gap examples: {q.missingExamples.join(" · ")}
                    </p>
                  )}
                  {q.invalidExamples.length > 0 && (
                    <p className="dim mono" style={{ fontSize: 10.5, marginTop: 4 }}>
                      Invalid rows: {q.invalidExamples.join(" · ")}
                    </p>
                  )}
                  {d.meta.source === "DEMO" && (
                    <p className="dim" style={{ fontSize: 10.5, marginTop: 8, marginBottom: 0 }}>
                      Synthetic data is generated locally for demonstration and is reported as clean by
                      construction. Import a real CSV to run genuine validation.
                    </p>
                  )}
                </div>
              </div>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button
                  className="btn sm"
                  onClick={() => {
                    controller.setPage("terminal");
                    void controller.selectInstrument(d.instrument);
                  }}
                >
                  Replay this instrument
                </button>
                <button className="btn sm" onClick={() => void controller.repo.remove(d.instrument)}>
                  Delete dataset
                </button>
                <span className="dim mono" style={{ fontSize: 10.5, alignSelf: "center" }}>
                  {num(q.rows / Math.max(1, d.rthSessions.length), 1)} RTH bars / session
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
