import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «Рецепты» (research/19 §2.1 + §2.3): a card on the empty «Код» screen opens a small form;
 * main lays the bundled starter into a new project folder, the app opens it and sends the
 * request filled from the form. All offline: the starter ships inside the app.
 */
test("a recipe: card → form → new project with the starter → the filled request", async () => {
  const launched = await launchRu();
  try {
    const { page, app } = launched;
    await startHost(page);
    const documents = await app.evaluate(({ app: electronApp }) =>
      electronApp.getPath("documents"),
    );
    const cards = page.getByTestId("recipes");
    await expect(cards).toContainText("Начните с рецепта");
    await expect(cards.locator(".recipe-card")).toHaveCount(5);
    await shot(page, "recipes-1-cards");

    await page.getByTestId("recipe-tg-bot").click();
    const dialog = page.getByTestId("recipe-dialog");
    await expect(dialog).toContainText("Бот для Telegram");
    // The token is never a form field: the agent asks for it in its own window.
    await expect(dialog.getByLabel(/токен/iu)).toHaveCount(0);
    await dialog.getByTestId("recipe-start").click();
    await expect(dialog.getByRole("alert")).toHaveText("Заполните это поле");
    await dialog.getByLabel(/Что делает бот\?/u).fill("Принимает заказы на торты");
    await dialog.getByRole("switch", { name: "Кнопки меню" }).click();
    await shot(page, "recipes-2-form");

    const before = launched.fakeModel.requests.length;
    await dialog.getByTestId("recipe-start").click();
    await expect(dialog).toBeHidden();
    // The new project's host comes up first («Agent Host ready»), then the request goes out: wait for
    // the model to get it, not just for a settled host.
    await expect
      .poll(() => JSON.stringify(launched.fakeModel.requests.slice(before)), { timeout: 60_000 })
      .toContain("Что делает бот: Принимает заказы на торты.");
    await waitSettled(page);
    const project = join(documents, "PRSLOY", "Бот");
    expect(existsSync(join(project, "bot.py"))).toBe(true);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toContain(".env");
    expect(readdirSync(project)).toContain(".env.example");
    const sent = JSON.stringify(launched.fakeModel.requests.slice(before));
    expect(sent).toContain("Что делает бот: Принимает заказы на торты.");
    expect(sent).toContain("Кнопки меню под сообщением: нет.");
    expect(sent).toContain("request_secret");
    await expect(page.getByTestId("timeline")).toContainText("Принимает заказы на торты");
    await shot(page, "recipes-3-started");
  } finally {
    await closeLaunched(launched);
  }
});

async function axeViolations(page: import("@playwright/test").Page) {
  const { AxeBuilder } = await import("@axe-core/playwright");
  const result = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(["wcag2a", "wcag2aa"])
    .exclude('[data-testid="runtime-snapshot"]')
    .analyze();
  return result.violations.map(
    (v: { id: string; nodes: { html: string; failureSummary?: string }[] }) =>
      `${v.id}: ${v.nodes.map((n) => `${n.html.slice(0, 120)} ${n.failureSummary ?? ""}`).join(" | ")}`,
  );
}

for (const mode of ["light", "dark"] as const) {
  test(`recipes, ${mode}: the cards and the form pass axe WCAG A/AA`, async () => {
    const launched = await launchRu();
    try {
      const { page } = launched;
      await page.evaluate((value) => localStorage.setItem("zeno.colorMode", value), mode);
      await page.reload();
      await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]');
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByTestId("recipes")).toBeVisible();
      await page.waitForTimeout(1_400);
      expect(await axeViolations(page), "cards").toEqual([]);
      await page.getByTestId("recipe-landing").click();
      const dialog = page.getByTestId("recipe-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("recipe-start").click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await page.waitForTimeout(400);
      expect(await axeViolations(page), "form").toEqual([]);
      await shot(page, `recipes-form-${mode}`);
    } finally {
      await closeLaunched(launched);
    }
  });
}
