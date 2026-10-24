import { useEffect, useState } from "react";
import { controller, useApp, type AppState } from "./state/useApp";
import { TopBar } from "./components/TopBar";
import { LeftColumn } from "./components/LeftColumn";
import { RightColumn } from "./components/RightColumn";
import { Chart } from "./components/Chart";
import { BottomPanel } from "./components/BottomPanel";
import { BlindPage } from "./pages/BlindPage";
import { FlowPage } from "./pages/FlowPage";
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

/** A focused button or link owns Space; the replay transport must not steal it. */
function isActivatableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "button" || tag === "a";
}

const FIRST_RUN_KEY = "tl_first_run_seen";

/**
 * Shown once, until dismissed. A cold visitor otherwise lands in a dense
 * three-panel terminal with no statement of what it is or what it is not.
 */
function FirstRunNote() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(FIRST_RUN_KEY) === "1";
    } catch {
      // Storage blocked: show the note rather than silently skipping it.
      return false;
    }
  });

  if (dismissed) return null;

  const close = () => {
    try {
      localStorage.setItem(FIRST_RUN_KEY, "1");
    } catch {
      // Storage blocked; dismissing lasts for this session only.
    }
    setDismissed(true);
  };

  return (
    <div className="first-run">
      <button className="first-run-close" onClick={close} aria-label="Dismiss this introduction">
        ×
      </button>
      <strong>This is a replay trainer, not a live market.</strong> Tape Lab plays back recorded and
      generated OHLC bars so you can practise reading price action, and keeps score as if you were
      trading. Nothing here is live, there is no broker connection, and nothing you see predicts a real
      market. Start on the <strong>Terminal</strong> — press ▶ PLAY to step the session forward — or open{" "}
      <a href="/academy.html" target="_blank" rel="noreferrer">
        the course ↗
      </a>{" "}
      to learn the reads first.
    </div>
  );
}

/** Always-visible disclosure. The trading app previously carried none. */
function AppFooter() {
  return (
    <footer className="app-footer">
      <span>
        Educational simulation · <strong>not financial advice</strong> · most people who day trade lose
        money · no live market data and no broker connection
      </span>
      <span className="desktop-only-note">
        Tape Lab is built for a desktop screen; the replay controls are hidden at this width.
      </span>
      <a href="/legal.html" target="_blank" rel="noreferrer">
        Risk, data &amp; privacy ↗
      </a>
    </footer>
  );
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

  // Hotkeys belong to the terminal. Bound globally they hijacked Space — the
  // platform's scroll and button-activate key — on every scrollable page.
  useEffect(() => {
    if (state.page !== "terminal") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === " " && isActivatableTarget(e.target)) return;
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
  }, [state.page]);

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
        <AppFooter />
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
            {state.page === "flow" && <FlowPage state={state} />}
            {state.page === "scenarios" && <ScenariosPage state={state} />}
            {state.page === "data" && <DataPage state={state} />}
            {state.page === "journal" && <JournalPage state={state} />}
            {state.page === "score" && <ScorePage state={state} />}
          </div>
        </div>
      )}
      <AppFooter />
      <FirstRunNote />
      {state.message && (
        <div className="toast" onClick={() => controller.clearMessage()} role="status">
          {state.message} <span className="dim">(click to dismiss)</span>
        </div>
      )}
    </div>
  );
}
