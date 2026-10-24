import { expect, test } from "@playwright/test";
import {
  marketBuy,
  openApp,
  positionDir,
  step,
  stepToEnd,
  ticketNote,
  watchErrors,
  workingCount,
} from "./helpers";

/**
 * Terminal behavioural baseline.
 *
 * The order-ticket tests are the browser-level regression for the Market Buy
 * blocker: at the final bar the replay is settled and `placeOrder` drops the
 * order, so the ticket must disable itself and say why rather than sit there
 * looking live.
 */

test("loads a tradeable session with a flat position and no working orders", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  await expect(
    page.locator("section.panel").filter({ has: page.getByText("Order ticket", { exact: true }) }),
  ).toBeVisible();
  await expect(positionDir(page)).toHaveText("FLAT");
  await expect(workingCount(page)).toHaveText("0");
  await expect(marketBuy(page)).toBeEnabled();
  await expect(ticketNote(page)).toContainText("Market orders fill at the");

  expect(errors).toEqual([]);
});

test("a market buy creates a working order that fills on the next revealed bar", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  await marketBuy(page).click();
  await expect(workingCount(page)).toHaveText("1");
  await expect(positionDir(page)).toHaveText("FLAT");

  await step(page, 1);
  await expect(workingCount(page)).toHaveText("0");
  await expect(positionDir(page)).toHaveText(/^LONG 1$/);

  expect(errors).toEqual([]);
});

test("the order ticket disables itself and explains why once the replay has settled", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  const steps = await stepToEnd(page);
  expect(steps).toBeGreaterThan(0);

  await expect(marketBuy(page)).toBeDisabled();
  await expect(ticketNote(page)).toContainText("Replay finished at the final bar");
  await expect(workingCount(page)).toHaveText("0");
  await expect(positionDir(page)).toHaveText("FLAT");

  // A click on a settled ticket must not produce an order.
  await marketBuy(page).click({ force: true });
  await expect(workingCount(page)).toHaveText("0");
  await expect(positionDir(page)).toHaveText("FLAT");

  expect(errors).toEqual([]);
});

test("reset returns the ticket to a live, orderable state", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  await stepToEnd(page);
  await expect(marketBuy(page)).toBeDisabled();

  await page.getByRole("button", { name: "⟲ RESET" }).click();

  await expect(marketBuy(page)).toBeEnabled();
  await expect(ticketNote(page)).toContainText("Market orders fill at the");
  await expect(workingCount(page)).toHaveText("0");
  await expect(positionDir(page)).toHaveText("FLAT");

  expect(errors).toEqual([]);
});

test("scrubbing back from the settled bar re-enables the ticket", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  await stepToEnd(page);
  await expect(marketBuy(page)).toBeDisabled();

  const scrub = page.locator("input.scrub");
  await scrub.fill(String(Math.floor(Number(await scrub.getAttribute("max")) / 2)));

  await expect(marketBuy(page)).toBeEnabled();
  await expect(ticketNote(page)).toContainText("Market orders fill at the");

  expect(errors).toEqual([]);
});
