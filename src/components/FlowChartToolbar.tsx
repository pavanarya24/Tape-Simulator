import type { FlowWorkspaceMode } from "../flow/workspace";
import { price as fmtPrice } from "../util/format";

export interface FlowChartToolbarProps {
  showVwap: boolean;
  onToggleVwap: () => void;
  showAma: boolean;
  onToggleAma: () => void;
  showCvd: boolean;
  onToggleCvd: () => void;
  showProfile: boolean;
  onToggleProfile: () => void;
  showAnnotations: boolean;
  onToggleAnnotations: () => void;
  showTradeMarkers: boolean;
  onToggleTradeMarkers: () => void;
  tradeMarkersAllowed: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  currentAma?: number | null;
  workspaceMode?: FlowWorkspaceMode;
  onToggleWorkspaceMode?: () => void;
}

/**
 * Compact toolbar for Flow Lab chart controls.
 * Provides accessible, keyboard-friendly toggles for all technical overlays,
 * markers, volume profile gutter, and fullscreen chart presentation.
 */
export function FlowChartToolbar({
  showVwap,
  onToggleVwap,
  showAma,
  onToggleAma,
  showCvd,
  onToggleCvd,
  showProfile,
  onToggleProfile,
  showAnnotations,
  onToggleAnnotations,
  showTradeMarkers,
  onToggleTradeMarkers,
  tradeMarkersAllowed,
  isFullscreen,
  onToggleFullscreen,
  currentAma,
  workspaceMode,
  onToggleWorkspaceMode,
}: FlowChartToolbarProps) {
  return (
    <div
      className="right chips flow-chart-toolbar"
      role="toolbar"
      aria-label="Chart indicators and view controls"
      style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
    >
      {onToggleWorkspaceMode && (
        <button
          type="button"
          className="chip"
          onClick={onToggleWorkspaceMode}
          aria-label={`Toggle workspace mode (currently ${workspaceMode ?? "expanded"})`}
          title="Compact / expanded market workspace — presentation only, never affects replay, execution or scoring"
        >
          {workspaceMode === "compact" ? "EXPAND ⤢" : "COMPACT ⤡"}
        </button>
      )}

      <button
        type="button"
        className={`chip ${showVwap ? "on" : ""}`}
        onClick={onToggleVwap}
        aria-pressed={showVwap}
        aria-label="Toggle VWAP overlay"
        title="Volume-Weighted Average Price overlay (dashed blue line)"
      >
        VWAP
      </button>

      <button
        type="button"
        className={`chip ${showAma ? "on" : ""}`}
        onClick={onToggleAma}
        aria-pressed={showAma}
        aria-label="Toggle Adaptive Moving Average overlay"
        title="Adaptive Moving Average overlay (cyan line)"
      >
        AMA
      </button>

      <button
        type="button"
        className={`chip ${showCvd ? "on" : ""}`}
        onClick={onToggleCvd}
        aria-pressed={showCvd}
        aria-label="Toggle Cumulative Volume Delta pane"
        title="Cumulative Volume Delta lower pane (purple area)"
      >
        CVD
      </button>

      <button
        type="button"
        className={`chip ${showProfile ? "on" : ""}`}
        onClick={onToggleProfile}
        aria-pressed={showProfile}
        aria-label="Toggle Volume Profile gutter"
        title="Volume-at-price profile side gutter"
      >
        Profile
      </button>

      <button
        type="button"
        className={`chip ${showAnnotations ? "on" : ""}`}
        onClick={onToggleAnnotations}
        aria-pressed={showAnnotations}
        aria-label="Toggle objective evidence markers"
        title="Objective evidence markers — observable only, never a pattern call"
      >
        Evidence
      </button>

      <button
        type="button"
        className={`chip ${showTradeMarkers && tradeMarkersAllowed ? "on" : ""}`}
        onClick={onToggleTradeMarkers}
        disabled={!tradeMarkersAllowed}
        aria-pressed={showTradeMarkers && tradeMarkersAllowed}
        aria-label="Toggle trade markers"
        title={
          tradeMarkersAllowed
            ? "Trade entry/exit markers (review mode)"
            : "Entry/exit markers unlock after Reveal"
        }
      >
        Trades
      </button>

      <button
        type="button"
        className={`chip ${isFullscreen ? "on" : ""}`}
        onClick={onToggleFullscreen}
        aria-pressed={isFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen chart mode" : "Enter fullscreen chart mode"}
        title={
          isFullscreen
            ? "Exit fullscreen chart mode (Esc)"
            : "Fullscreen chart mode"
        }
      >
        {isFullscreen ? "EXIT ⤢" : "FULLSCREEN ⛶"}
      </button>

      {currentAma !== undefined && (
        <span className="badge mono" title="Current Adaptive Moving Average">
          AMA {currentAma !== null ? fmtPrice(currentAma) : "—"}
        </span>
      )}
    </div>
  );
}
