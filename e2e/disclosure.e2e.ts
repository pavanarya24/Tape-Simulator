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

test("the risk, data and privacy page states each claim it has to", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/legal.html");

  const body = page.locator("main");
  await expect(body).toContainText("Not financial advice");
  await expect(body).toContainText("No broker connection");
  await expect(body).toContainText("No live market data");

  // Flow Lab ships recorded venue data, so the page must name it and say what
  // it may not be used for — not just disclaim the synthetic terminal data.
  const table = page.locator("table");
  await expect(table).toContainText("Binance Spot BTCUSDT");
  await expect(table).toContainText("Binance Historical aggTrades");
  await expect(table).toContainText("Synthetic Practice Scenario");
  // The licensed CME capture must not be advertised as part of the app, and the
  // page must say so rather than leaving a reader to guess.
  await expect(table).not.toContainText("Databento");
  await expect(body).toContainText("not included in the application");
  await expect(body).toContainText("not licensed to you for redistribution");

  // The privacy claim is only honest because the app really has no backend.
  await expect(body).toContainText("There is no server, no account, and no analytics");
  await expect(body).toContainText("IndexedDB");
  await expect(body).toContainText("Google Fonts");

  // The storage inventory is a factual claim, so it is pinned to what the app
  // really stores. The journal outlives the tab and the page has to say so, along
  // with what a reload does not bring back.
  await expect(body).toContainText("trade journal");
  await expect(body).toContainText("notes you wrote on it");
  await expect(body).toContainText("does not");
  await expect(body).toContainText("replay position");

  await expect(page.locator("footer a", { hasText: "Tape Lab" })).toBeVisible();
  expect(errors).toEqual([]);
});
