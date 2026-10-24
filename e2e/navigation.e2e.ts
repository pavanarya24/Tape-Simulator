import { expect, test } from "@playwright/test";
import { openApp, watchErrors } from "./helpers";

/** Every top-bar destination must open, render content, and raise no console errors. */
const PAGES = ["Terminal", "Blind Mode", "Flow Lab", "Scenarios", "Data", "Journal", "Score"];

test("every top-bar page opens and renders without errors", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  for (const name of PAGES) {
    await page.locator(".navbtn", { hasText: new RegExp(`^${name}$`) }).click();
    await expect(page.locator(".navbtn.active")).toHaveText(name);

    // The page must actually render something, not just switch the highlight.
    const body = (await page.locator("body").innerText()).trim();
    expect(body.length).toBeGreaterThan(80);
    // And it must not still be showing the loading gate.
    await expect(page.getByText("No session could be loaded")).toHaveCount(0);
  }

  expect(errors).toEqual([]);
});

test("the app survives a reload with its navigation intact", async ({ page }) => {
  const errors = watchErrors(page);
  await openApp(page);

  await page.reload();
  await expect(page.locator(".navbtn").first()).toBeVisible();
  await expect(page.locator(".navbtn.active")).toHaveText("Terminal");
  await expect(page.getByRole("button", { name: "MARKET BUY", exact: true })).toBeVisible();

  expect(errors).toEqual([]);
});

test.describe("narrow viewport", () => {
  test.use({ viewport: { width: 480, height: 820 } });

  test("does not overflow horizontally and keeps the order ticket usable", async ({ page }) => {
    const errors = watchErrors(page);
    await openApp(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "MARKET BUY", exact: true })).toBeVisible();

    expect(errors).toEqual([]);
  });
});
