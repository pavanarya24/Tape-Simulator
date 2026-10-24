import { expect, test } from "@playwright/test";
import { focusApp, openApp, watchErrors } from "./helpers";

/**
 * The app is a simulated trainer that had no persistent statement of that fact,
 * no first-run explanation, and a global Space binding that stopped the browser
 * doing what Space normally does. These specs pin the fixes for all three, and
 * the narrow-screen case where the replay controls are gone entirely.
 */

test("a first-time visitor is told what this is, and can dismiss it for good", async ({ page }) => {
  await page.goto("/");

  const note = page.locator(".first-run");
  await expect(note).toBeVisible();
  await expect(note).toContainText("not a live market");
  await expect(note).toContainText("no broker connection");
  await expect(note).toContainText("practise reading price action");

  await page.locator(".first-run-close").click();
  await expect(note).toHaveCount(0);

  // The dismissal has to survive a reload, or it is not an onboarding step,
  // it is a permanent obstruction.
  await page.reload();
  await expect(page.locator(".navbtn").first()).toBeVisible();
  await expect(page.locator(".first-run")).toHaveCount(0);
});

test("the risk line is on every page, not only the one you land on", async ({ page }) => {
  await openApp(page);

  const footer = page.locator(".app-footer");
  await expect(footer).toBeVisible();
  await expect(footer).toContainText("not financial advice");
  await expect(footer).toContainText("most people who day trade lose money");
  await expect(footer).toContainText("no broker connection");

  // At a desktop width the narrow-screen note stays out of the way.
  await expect(page.locator(".desktop-only-note")).toBeHidden();

  await page.locator(".navbtn", { hasText: /^Score$/ }).click();
  await expect(page.locator(".navbtn.active")).toHaveText("Score");
  await expect(footer).toBeVisible();

  // The trading results card must not read as a track record.
  await expect(page.locator(".card", { hasText: "Trading results" })).toContainText("SIMULATED");
  await expect(page.locator(".card", { hasText: "Trading results" })).toContainText(
    "No order was ever sent to a broker",
  );
});

test("below 1080px the app says the replay controls are hidden instead of silently dropping them", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 900, height: 800 });
  await openApp(page);

  // The transport lives in .col.left, which this width hides, so the terminal
  // cannot be driven here. Pin the disclosure, not the omission.
  await expect(page.locator(".col.left")).toBeHidden();
  const note = page.locator(".desktop-only-note");
  await expect(note).toBeVisible();
  await expect(note).toContainText("desktop");

  // An order ticket the reader cannot act on must not imply a working terminal.
  await expect(page.getByRole("button", { name: "MARKET BUY", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Space drives the replay on the terminal, and is left alone everywhere else", async ({ page }) => {
  await openApp(page);

  const play = page.getByRole("button", { name: /PLAY|PAUSE/ });
  await expect(play).toBeEnabled();

  await focusApp(page);
  await page.keyboard.press(" ");
  await expect(play).toHaveText(/PAUSE/);
  await page.keyboard.press(" ");
  await expect(play).toHaveText(/PLAY/);

  // On another page the same key belongs to the browser: it scrolls, and it
  // activates whatever holds focus. It must not reach the replay transport.
  const data = page.locator(".navbtn", { hasText: /^Data$/ });
  await data.focus();
  await page.keyboard.press(" ");
  await expect(page.locator(".navbtn.active")).toHaveText("Data");
});
