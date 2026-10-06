import { useEffect } from "react";
import { controller, useApp, type AppState } from "./state/useApp";
import { TopBar } from "./components/TopBar";
import { LeftColumn } from "./components/LeftColumn";
import { RightColumn } from "./components/RightColumn";
import { Chart } from "./components/Chart";
import { BottomPanel } from "./components/BottomPanel";
import { BlindPage } from "./pages/BlindPage";
import { ScenariosPage } from "./pages/ScenariosPage";
import { DataPage } from "./pages/DataPage";
import { JournalPage } from "./pages/JournalPage";
import { ScorePage } from "./pages/ScorePage";

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function TerminalView({ state }: { state: AppState }) {
  return (
    <div className="workspace">
      <div className="cols">
        <LeftColumn state={state} />
        <div className="col center">
          <Chart state={state} />
        </div>
        <RightColumn state={state} />
      </div>
      <BottomPanel state={state} />
    </div>
  );
}

export default function App() {
  const state = useApp();

  useEffect(() => {
    void controller.initialize();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          controller.togglePlay();
          break;
        case "ArrowRight":
          e.preventDefault();
          controller.stepForward();
          break;
        case "ArrowLeft":
          e.preventDefault();
          controller.stepBack();
          break;
        case "r":
        case "R":
          e.preventDefault();
          controller.resetReplay();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state.ready) {
    return (
      <div className="empty" style={{ paddingTop: 120 }}>
        Loading Tape Lab — indexing NQ / ES sessions…
      </div>
    );
  }

  if (!state.session) {
    return (
      <div className="app">
        <TopBar state={state} />
        <div className="page">
          <div className="page-inner">
            <div className="callout warn" style={{ marginTop: 20 }}>
              <strong>No session could be loaded.</strong> The terminal needs at least one session in
              the dataset store. Import a 5-minute NQ/ES OHLCV CSV on the Data page, or reload the
              page to retry seeding the synthetic demo sessions.
              {state.message && <div style={{ marginTop: 8 }}>{state.message}</div>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar state={state} />
      {state.page === "terminal" ? (
        <TerminalView state={state} />
      ) : (
        <div className="page">
          <div className="page-inner">
            {state.page === "blind" && <BlindPage state={state} />}
            {state.page === "scenarios" && <ScenariosPage state={state} />}
            {state.page === "data" && <DataPage state={state} />}
            {state.page === "journal" && <JournalPage state={state} />}
            {state.page === "score" && <ScorePage state={state} />}
          </div>
        </div>
      )}
      {state.message && (
        <div className="toast" onClick={() => controller.clearMessage()} role="status">
          {state.message} <span className="dim">(click to dismiss)</span>
        </div>
      )}
    </div>
  );
}
