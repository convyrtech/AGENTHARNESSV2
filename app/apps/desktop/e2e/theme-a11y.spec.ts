/**
 * The blueprint theme in both modes: axe finds no color-contrast (or other WCAG A/AA) problem on
 * the main screens — blueprint blue on cream and cyan on black included — the UI is set in the
 * bundled Geist with the wordmark in Piazzolla, and with reduced motion nothing animates.
 */
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function setTheme(page: Page, mode: "light" | "dark") {
  await page.evaluate((value) => localStorage.setItem("zeno.colorMode", value), mode);
  await page.reload();
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  await page.evaluate(() => document.fonts.ready);
  // The splash and any entrance are done before axe reads colors mid-animation.
  await page.waitForTimeout(1_400);
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    // Electron cannot open the blank page axe's default mode finishes in; run in the window.
    .setLegacyMode(true)
    .withTags(["wcag2a", "wcag2aa"])
    // Hidden developer panels of test builds are not part of the product.
    .exclude('[data-testid="runtime-snapshot"]')
    .analyze();
  type Node = { target: unknown[]; html: string; failureSummary?: string };
  return result.violations.map((violation: { id: string; nodes: Node[] }) => ({
    id: violation.id,
    nodes: violation.nodes
      .slice(0, 5)
      .map((node) => `${node.html.slice(0, 160)}: ${node.failureSummary ?? ""}`),
  }));
}

for (const mode of ["light", "dark"] as const) {
  test(`${mode} theme: axe finds no contrast problem on the main screens`, async ({ page }) => {
    test.setTimeout(240_000);
    await setTheme(page, mode);
    await expect(page.locator(`[data-theme="${mode}"]`).first()).toBeAttached();

    await expect(page.getByTestId("fig-caption").first()).toBeVisible();
    expect(await axe(page), "home").toEqual([]);

    await page.getByTestId("nav-design").click();
    await expect(page.getByTestId("design-page")).toBeVisible();
    expect(await axe(page), "design").toEqual([]);

    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await expect(page.getByTestId("settings-general")).toBeVisible();
    expect(await axe(page), "settings").toEqual([]);
    await page.getByTestId("settings-nav-appearance").click();
    await page.waitForTimeout(400);
    expect(await axe(page), "appearance").toEqual([]);
  });
}

test("Geist for the UI, Piazzolla for the wordmark; reduced motion stills everything", async ({
  page,
  zeno,
}) => {
  await setTheme(page, "light");
  const fonts = await page.evaluate(() => ({
    body: getComputedStyle(document.body).fontFamily,
    geist: document.fonts.check('16px "Geist"', "Проверка"),
  }));
  expect(fonts.body).toMatch(/^"?Geist"?/u);
  expect(fonts.geist).toBe(true);

  await zeno.page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => localStorage.setItem("zeno.colorMode", "dark"));
  await page.reload();
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]');
  // Under reduced motion every animation and transition finishes at once.
  const running = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const timing = animation.effect?.getComputedTiming();
        return Number(timing?.duration ?? 0) > 1 && animation.playState === "running";
      })
      .map((animation) => (animation as CSSAnimation).animationName ?? "transition"),
  );
  expect(running).toEqual([]);
});
