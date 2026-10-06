/**
 * Phase 8 §11 — keyboard shortcut resolution.
 *
 * Kept as a pure function so the mapping and the input-field protection can be
 * tested without a DOM: the Flow Lab component only wires keydown → resolve →
 * controller call.
 *
 *   Space        Play / Pause
 *   →  (Right)   Step forward (honours the current step unit)
 *   ←  (Left)    Step back
 *   R            Reset
 *   B            Buy
 *   S            Sell
 *   F            Flatten
 */

export type FlowShortcut =
  | "PLAY_PAUSE"
  | "STEP_FORWARD"
  | "STEP_BACK"
  | "RESET"
  | "BUY"
  | "SELL"
  | "FLATTEN";

export const FLOW_SHORTCUTS: readonly FlowShortcut[] = [
  "PLAY_PAUSE",
  "STEP_FORWARD",
  "STEP_BACK",
  "RESET",
  "BUY",
  "SELL",
  "FLATTEN",
];

/** Display hints for the on-screen shortcut legend. */
export const FLOW_SHORTCUT_KEYS: Record<FlowShortcut, string> = {
  PLAY_PAUSE: "Space",
  STEP_FORWARD: "→",
  STEP_BACK: "←",
  RESET: "R",
  BUY: "B",
  SELL: "S",
  FLATTEN: "F",
};

const KEY_MAP: Record<string, FlowShortcut> = {
  " ": "PLAY_PAUSE",
  Spacebar: "PLAY_PAUSE",
  ArrowRight: "STEP_FORWARD",
  ArrowLeft: "STEP_BACK",
  r: "RESET",
  R: "RESET",
  b: "BUY",
  B: "BUY",
  s: "SELL",
  S: "SELL",
  f: "FLATTEN",
  F: "FLATTEN",
};

/**
 * True when focus is inside a control the user is typing into — shortcuts must
 * never fire there (spec §11).
 */
export function isTypingTarget(tagName: string, isContentEditable = false): boolean {
  if (isContentEditable) return true;
  const tag = tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || tag === "option";
}

/** Map a keydown to a Flow Lab action, or null when it is not a shortcut. */
export function resolveFlowShortcut(key: string, typing: boolean): FlowShortcut | null {
  if (typing) return null;
  return KEY_MAP[key] ?? null;
}
