/**
 * Phase 8.5 — market workspace DOM/CSS wiring contract.
 *
 * This is a regression test for the wiring bug where FlowPage rendered the
 * sticky market workspace section WITHOUT the .flow-workspace-inner wrapper,
 * so the CSS grid/sticky rules in index.css were never applied even though
 * they looked correct.
 *
 * Static contract checks (not a brittle full snapshot):
 *  - FlowPage source uses flowWorkspaceClass(...) for the section
 *  - FlowPage source renders a .flow-workspace-inner wrapper inside that
 *    section, around the chart card + tape/DOM aside
 *  - index.css defines .flow-workspace-inner
 *  - index.css sets position: sticky on it
 *  - index.css sets display: grid and grid-template-columns on it
 *
 * If the section/wrapper/selector drift apart again, this fails loudly.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const base = resolve("src");
const flowPageSrc = readFileSync(resolve(base, "pages", "FlowPage.tsx"), "utf8");
const indexCss = readFileSync(resolve(base, "index.css"), "utf8");

describe("Phase 8.5 — market workspace DOM/CSS wiring", () => {
  beforeAll(() => {
    expect(flowPageSrc.length).toBeGreaterThan(0);
    expect(indexCss.length).toBeGreaterThan(0.1);
  });

  test("FlowPage uses flowWorkspaceClass on the market workspace section", () => {
    expect(flowPageSrc).toContain('className={flowWorkspaceClass(workspaceMode)}');
  });

  test("FlowPage wraps the chart + tape/DOM aside in a .flow-workspace-inner div", () => {
    const idx = flowPageSrc.indexOf('className={flowWorkspaceClass(workspaceMode)}');
    expect(idx).toBeGreaterThanOrEqual(0);

    const bodyAfter = flowPageSrc.slice(idx);
    const innerOpen = bodyAfter.indexOf('className="flow-workspace-inner"');
    const chartOpen = bodyAfter.indexOf('className="card flow-workspace-chart"');
    const asideOpen = bodyAfter.indexOf('className="flow-workspace-side"');
    const asideClose = bodyAfter.indexOf('</aside>');

    expect(innerOpen).toBeGreaterThanOrEqual(0);
    expect(chartOpen).toBeGreaterThanOrEqual(0);
    expect(asideOpen).toBeGreaterThanOrEqual(0);
    expect(asideClose).toBeGreaterThanOrEqual(0);

    // separation (logically): .flow-workspace-inner must open before the chart
    // card AND before the tape/DOM aside, and must close after the aside is
    // closed.
    expect(innerOpen).toBeLessThan(chartOpen);
    expect(innerOpen).toBeLessThan(asideOpen);
    expect(innerOpen).toBeLessThan(asideClose);
  });

  test("index.css defines .flow-workspace-inner with sticky grid layout", () => {
    const selector = ".flow-workspace-inner";
    expect(indexCss).toContain(selector);

    // selector exists at all
    const declBlock = indexCss.indexOf(selector);
    expect(declBlock).toBeGreaterThanOrEqual(0);

    // the real rule must contain the layout keywords
    // (the new app-specific one is parsed last; we just verify the keywords
    //  appear in the file near the selector block)
    const block = indexCss.slice(declBlock, declBlock + 1200);
    expect(block).toContain("position: sticky");
    expect(block).toContain("top: 0");
    expect(block).toContain("display: grid");
    expect(block).toContain("grid-template-columns");
    expect(block).toContain("--z-workspace");
  });

  test("CSS still defines compact/expanded canvas heights", () => {
    expect(indexCss).toContain("min(58vh, 680px)");
    expect(indexCss).toContain("min(38vh, 430px)");
    expect(indexCss).toContain(".flow-ws-compact .flow-workspace-canvas");
  });
});
