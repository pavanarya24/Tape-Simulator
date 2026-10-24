import { expect, test } from "@playwright/test";
import { watchErrors } from "./helpers";

/**
 * Baseline for the standalone course page at /academy.html.
 *
 * The page is a plain scrolling document with no JavaScript: every section is
 * visible on load and the lessons open with native <details>, so nothing here
 * has to click a tab first.
 *
 * Deliberately asserts only on the TEACHING content — the 18 lessons, the
 * Library and the "what this is" disclosure. The interactive half of the old
 * page (charts, drills, trading desk, tape sim, report card, quiz) lives in the
 * React app now and is covered by the app specs.
 */

test("the course page loads its lessons and library", async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto("/academy.html");
  await expect(page).toHaveTitle(/Tape Reading Academy/);
  await expect(page.locator("#what-this-is")).toBeVisible();

  await expect(page.locator("details.lesson")).toHaveCount(18);
  await expect(page.locator("details.lesson").first()).toBeVisible();
  await expect(page.locator("h2", { hasText: /^Library$/ })).toBeVisible();

  expect(errors).toEqual([]);
});

test("a lesson opens and shows its teaching prose", async ({ page }) => {
  await page.goto("/academy.html");

  const first = page.locator("details.lesson").first();
  await expect(first).not.toHaveAttribute("open", "");
  await first.locator("summary").click();
  await expect(first).toHaveAttribute("open", "");

  const text = (await first.innerText()).trim();
  expect(text.length).toBeGreaterThan(300);
});

test("every lesson has a numbered heading", async ({ page }) => {
  await page.goto("/academy.html");

  const lessons = page.locator("details.lesson");
  await expect(lessons).toHaveCount(18);

  const headings: string[] = [];
  for (let i = 0; i < 18; i++) headings.push((await lessons.nth(i).locator("summary").innerText()).trim());

  for (const [i, h] of headings.entries()) {
    expect(h.length).toBeGreaterThan(3);
    expect(h).toContain(String(i + 1).padStart(2, "0"));
  }
});
