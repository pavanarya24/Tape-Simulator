import { useEffect } from "react";
import type { AppState } from "../state/app";
import { controller } from "../state/useApp";
import { SCENARIOS, scenarioById, type ScenarioId } from "../scenarios/scenarios";
import { formatDateLabel } from "../data/timezone";

export function ScenariosPage({ state }: { state: AppState }) {
  const matchesFor = (id: ScenarioId) => state.scenarioMatches.find((m) => m.scenario === id)?.sessions ?? [];

  // Classify on first visit so the page is never empty.
  useEffect(() => {
    if (state.scenarioMatches.length === 0 && !state.classifying) {
      controller.classifyAllSessions();
    }
  }, [state.scenarioMatches.length, state.classifying]);

  return (
    <>
      <h2>Scenario mode</h2>
      <p className="lede">
        Tagged historical environments for deliberate practice. Classification uses only the OHLC
        structure of each session — opening range behaviour, net move versus range, close location
        and VWAP interaction. No order-flow information is inferred or invented: the future order-flow
        features listed on each scenario are what a real tick / Level-2 source would add later.
      </p>

      <div className="card">
        <div className="card-head">
          <h3>Scenario engine</h3>
          <div className="right btn-row">
            <span className="badge">
              {state.settings.instrument} · {state.settings.sessionType} · OR {state.settings.openingRangeMinutes}m
            </span>
            <button className="btn sm" onClick={() => controller.classifyAllSessions()} disabled={state.classifying}>
              {state.classifying ? "CLASSIFYING…" : "CLASSIFY SESSIONS"}
            </button>
          </div>
        </div>
        <div className="card-body">
          <p className="dim" style={{ margin: 0, fontSize: 11.5 }}>
            Session tagging runs over the loaded dataset in your browser and never leaves this device.
            Click a date chip to load that session into the terminal and replay it.
          </p>
        </div>
      </div>

      {state.currentClassification?.primary && (
        <div className="callout info">
          <strong>Current session tag:</strong>{" "}
          {scenarioById(state.currentClassification.primary).name} ·{" "}
          <span className="dim">
            scores —{" "}
            {state.currentClassification.matches
              .filter((m) => m.matched)
              .map((m) => `${scenarioById(m.scenario).name} ${(m.score * 100).toFixed(0)}`)
              .join(", ")}
          </span>
        </div>
      )}

      {state.classifying && (
        <div className="callout">Classifying {state.settings.instrument} sessions…</div>
      )}

      {SCENARIOS.map((s) => {
        const examples = matchesFor(s.id);
        return (
          <div className="scenario-card" key={s.id}>
            <h4>{s.name}</h4>
            <p>{s.description}</p>
            <p className="dim" style={{ marginBottom: 6 }}>
              <strong style={{ color: "var(--text)" }}>Focus:</strong> {s.focus}
            </p>
            <p className="dim" style={{ marginBottom: 10 }}>
              <strong style={{ color: "var(--text)" }}>Future order-flow layer (requires tick/L2):</strong>{" "}
              {s.futureOrderFlow.join(" · ")}
            </p>
            <div className="scenario-examples">
              {examples.length === 0 ? (
                <span className="dim" style={{ fontSize: 11 }}>
                  No tagged examples in the loaded dataset yet.
                </span>
              ) : (
                examples.map((e) => (
                  <button
                    key={e.meta.id}
                    className="chip"
                    title={`score ${(e.score * 100).toFixed(0)}`}
                    onClick={() => {
                      controller.setPage("terminal");
                      void controller.selectSession(e.meta.id);
                    }}
                  >
                    {formatDateLabel(e.meta.date)} · {(e.score * 100).toFixed(0)}
                  </button>
                ))
              )}
            </div>
          </div>
        );
      })}

      <div className="callout warn">
        <strong>Scope limit.</strong> A scenario tag describes how price behaved, not why. Tape Lab
        cannot tell you whether a break was absorbed, spoofed or initiated — that requires historical
        Time &amp; Sales and Level-2 depth, which the OHLCV dataset does not contain.
      </div>
    </>
  );
}
