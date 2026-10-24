import { expect, type Page } from "@playwright/test";

/** Collect console errors and uncaught page exceptions for the life of a page. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e)}`));
  page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  return errors;
}

/**
 * Load the app and wait past the loading screen. The first-run explainer is
 * suppressed: it is fixed over the centre of the screen and would intercept
 * clicks in specs that are not about it. `onboarding.e2e.ts` covers it with a
 * fresh profile.
 */
export async function openApp(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("tl_first_run_seen", "1");
    } catch {
      // Storage unavailable; the note will show and may intercept a click.
    }
  });
  await page.goto("/app.html");
  await expect(page.locator(".navbtn").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "MARKET BUY", exact: true })).toBeVisible();
}

export const marketBuy = (page: Page) => page.getByRole("button", { name: "MARKET BUY", exact: true });

/** Click the page background so window-level keyboard shortcuts are not swallowed by an input. */
export async function focusApp(page: Page): Promise<void> {
  await page.locator(".topbar").click({ position: { x: 5, y: 5 } });
}

/** Step the replay forward one bar with the documented keyboard shortcut. */
export async function step(page: Page, times = 1): Promise<void> {
  await focusApp(page);
  for (let i = 0; i < times; i++) await page.keyboard.press("ArrowRight");
}

/** The Working orders panel badge — the count of live orders. */
export const workingCount = (page: Page) =>
  page.locator("section.panel", { has: page.getByText("Working orders", { exact: true }) }).locator(".badge");

/** The Position panel's direction label ("FLAT" / "LONG 1" / "SHORT 2"). */
export const positionDir = (page: Page) =>
  page.locator("section.panel", { has: page.getByText("Position", { exact: true }) }).locator(".pos-dir");

/** The order ticket's explanatory note under the buttons. */
export const ticketNote = (page: Page) =>
  page
    .locator("section.panel")
    .filter({ has: page.getByText("Order ticket", { exact: true }) })
    .locator("p.dim");

/** Step until the replay settles, returning the number of steps taken. */
export async function stepToEnd(page: Page, max = 200): Promise<number> {
  for (let i = 0; i < max; i++) {
    if (await marketBuy(page).isDisabled()) return i;
    await step(page);
  }
  throw new Error(`replay did not settle within ${max} steps`);
}
