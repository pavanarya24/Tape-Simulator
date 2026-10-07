/**
 * Phase 8.5 — Flow Lab professional workspace UX.
 *
 * The market workspace compact/expanded toggle is pure presentation state:
 * it must never touch replay, execution, scoring or blind-mode state. These
 * tests pin the tiny helper the page uses so the mode space stays closed
 * (exactly two modes, expanded default, stable class mapping).
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKSPACE_MODE,
  FLOW_WORKSPACE_MODES,
  flowWorkspaceClass,
  normalizeWorkspaceMode,
  toggleWorkspaceMode,
  type FlowWorkspaceMode,
} from "../src/flow/workspace";

describe("Phase 8.5 workspace mode helper (presentation only)", () => {
  test("exposes exactly two modes with expanded as the default", () => {
    expect(FLOW_WORKSPACE_MODES).toEqual(["expanded", "compact"]);
    expect(DEFAULT_WORKSPACE_MODE).toBe("expanded");
  });

  test("normalizes unknown values to the expanded default", () => {
    expect(normalizeWorkspaceMode(undefined)).toBe("expanded");
    expect(normalizeWorkspaceMode(null)).toBe("expanded");
    expect(normalizeWorkspaceMode("")).toBe("expanded");
    expect(normalizeWorkspaceMode("nonsense")).toBe("expanded");
    expect(normalizeWorkspaceMode("compact")).toBe("compact");
    expect(normalizeWorkspaceMode("EXPANDED")).toBe("expanded");
  });

  test("toggling never leaves the two-mode space", () => {
    const seen = new Set<FlowWorkspaceMode>();
    let mode: FlowWorkspaceMode = DEFAULT_WORKSPACE_MODE;
    for (let i = 0; i < 7; i++) {
      mode = toggleWorkspaceMode(mode);
      seen.add(mode);
    }
    expect(seen.size).toBe(2);
    expect(mode).toBe("compact"); // 7 toggles from expanded end on compact
    expect(toggleWorkspaceMode("expanded")).toBe("compact");
    expect(toggleWorkspaceMode("compact")).toBe("expanded");
  });

  test("class mapping covers exactly the exposed modes", () => {
    for (const mode of FLOW_WORKSPACE_MODES) {
      expect(flowWorkspaceClass(mode)).toBe(`flow-workspace flow-ws-${mode}`);
    }
    expect(flowWorkspaceClass(normalizeWorkspaceMode("bogus"))).toBe(
      "flow-workspace flow-ws-expanded",
    );
  });
});
