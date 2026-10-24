import { expect, test } from "@playwright/test";
import { openApp, watchErrors } from "./helpers";

/**
 * The site's claim is that a visitor cannot mistake this for live data. These
 * two specs pin the disclosures a reader actually lands on: the Data page's
 * statement of where the bars come from, and the course page's warning, which
 * must not describe charts the page no longer has.
 */

test("the Data page states where the bundled bars come from", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  await page.locator(".navbtn", { hasText: /^Data$/ }).click();
  await expect(page.locator(".navbtn.active")).toHaveText("Data");

  await expect(page.getByText("OHLCV only.")).toBeVisible();

  const provenance = page.locator(".callout.warn");
  await expect(provenance).toBeVisible();
  await expect(provenance).toContainText("seeded random walk");
  await expect(provenance).toContainText("not recorded market history");
  await expect(provenance).toContainText("not licensed from any data vendor");
  // Flow Lab ships genuine recorded venue data, so the page must not sweep it
  // into the synthetic claim.
  await expect(provenance).toContainText("genuine recorded venue data");

  expect(errors).toEqual([]);
});

test("the course warning does not claim charts the page no longer renders", async ({ page }) => {
  await page.goto("/academy.html");

  // Four warn callouts share the page; the disclaimer is the one about advice.
  const warn = page.locator(".callout.warn").filter({ hasText: "not advice" });
  await expect(warn).toBeVisible();
  await expect(warn).not.toContainText("charts");
  await expect(page.locator("canvas")).toHaveCount(0);
});
