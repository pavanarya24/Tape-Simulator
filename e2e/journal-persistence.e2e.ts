import { expect, test } from "@playwright/test";
import { marketBuy, openApp, stepToEnd, watchErrors } from "./helpers";

/**
 * The journal is the only thing in Tape Lab the reader authors themselves, so it
 * has to outlive the tab. These specs are the browser-level proof: the trade list
 * and the written notes come back after a reload, and the notes are still
 * editable once the execution simulator that produced the trades is gone.
 *
 * Each test gets a fresh browser context, so localStorage starts empty and no
 * cleanup is needed — which is also why nothing here may use addInitScript to
 * clear the journal: that would run again on the reload and erase the evidence.
 */

const journalNav = (page: import("@playwright/test").Page) =>
  page.locator(".navbtn", { hasText: /^Journal$/ });

async function openJournal(page: import("@playwright/test").Page): Promise<void> {
  await journalNav(page).click();
  await expect(page.locator(".navbtn.active")).toHaveText("Journal");
}

/** The journal card's "N trades" badge. */
const tradeCount = (page: import("@playwright/test").Page) =>
  page.locator(".card", { has: page.getByText("Journal", { exact: true }) }).locator(".badge");

/** The selected trade's notes panel — the first field is the thesis. */
const thesis = (page: import("@playwright/test").Page) => page.locator("textarea").first();

test("a closed trade and its written notes are still there after a reload", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  // Enter a trade and run the replay out, so the simulator closes it.
  await marketBuy(page).click();
  await stepToEnd(page);

  await openJournal(page);
  await expect(tradeCount(page)).toHaveText("1 trade");

  await thesis(page).fill("breakout retest, waited for the pullback");
  await expect(thesis(page)).toHaveValue("breakout retest, waited for the pullback");

  // The reload is the whole point: the execution simulator is rebuilt from
  // scratch, so anything shown afterwards came from storage.
  await page.reload();
  await expect(page.locator(".navbtn").first()).toBeVisible();

  await openJournal(page);
  await expect(tradeCount(page)).toHaveText("1 trade");
  await expect(thesis(page)).toHaveValue("breakout retest, waited for the pullback");

  expect(errors).toEqual([]);
});

test("a note written after a reload survives the next one", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  await marketBuy(page).click();
  await stepToEnd(page);
  await openJournal(page);
  await thesis(page).fill("first note");

  await page.reload();
  await expect(page.locator(".navbtn").first()).toBeVisible();
  await openJournal(page);

  // Editing a restored trade means the note map, not the simulator, is the thing
  // being written — this is the path that would otherwise silently do nothing.
  await thesis(page).fill("second note, edited after the reload");

  await page.reload();
  await expect(page.locator(".navbtn").first()).toBeVisible();
  await openJournal(page);
  await expect(tradeCount(page)).toHaveText("1 trade");
  await expect(thesis(page)).toHaveValue("second note, edited after the reload");

  expect(errors).toEqual([]);
});

test("starting the session over clears the journal, and the reload agrees", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  await marketBuy(page).click();
  await stepToEnd(page);
  await openJournal(page);
  await expect(tradeCount(page)).toHaveText("1 trade");

  // RESET is on the terminal; a clean account has always meant a clean journal.
  await page.locator(".navbtn", { hasText: /^Terminal$/ }).click();
  await page.getByRole("button", { name: /RESET/ }).click();
  await openJournal(page);
  await expect(tradeCount(page)).toHaveText("0 trades");

  await page.reload();
  await expect(page.locator(".navbtn").first()).toBeVisible();
  await openJournal(page);
  await expect(tradeCount(page)).toHaveText("0 trades");

  expect(errors).toEqual([]);
});
