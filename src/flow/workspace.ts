/**
 * Phase 8.5 — market workspace presentation mode.
 *
 * Purely presentational: the compact/expanded toggle only changes how much
 * vertical space the sticky market workspace (chart | tape/DOM) reserves.
 * It must never influence replay state, event position, execution, scoring,
 * blind-mode gating or analytics — FlowPage keeps it in local useState and
 * nothing else reads it.
 */

export const FLOW_WORKSPACE_MODES = ["expanded", "compact"] as const;

export type FlowWorkspaceMode = (typeof FLOW_WORKSPACE_MODES)[number];

export const DEFAULT_WORKSPACE_MODE: FlowWorkspaceMode = "expanded";

/** Unknown/absent values fall back to the expanded default. */
export function normalizeWorkspaceMode(value: string | null | undefined): FlowWorkspaceMode {
  return value === "compact" ? "compact" : DEFAULT_WORKSPACE_MODE;
}

export function toggleWorkspaceMode(mode: FlowWorkspaceMode): FlowWorkspaceMode {
  return mode === DEFAULT_WORKSPACE_MODE ? "compact" : DEFAULT_WORKSPACE_MODE;
}

/** Class for the sticky workspace section — see .flow-workspace in index.css. */
export function flowWorkspaceClass(mode: FlowWorkspaceMode): string {
  return `flow-workspace flow-ws-${normalizeWorkspaceMode(mode)}`;
}
