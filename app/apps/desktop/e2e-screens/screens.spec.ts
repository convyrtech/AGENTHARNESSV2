/**
 * Screenshots of the main PRSLOY screens in light and dark at 1280×800.
 *
 *   pnpm --filter @zeno/desktop run build
 *   pnpm --filter @zeno/desktop exec playwright test -c playwright.screens.config.ts
 *
 * The app and its fake model: screens-app.ts.
 */
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { launch, outDir, setTheme, shot } from "./screens-app.ts";

test("PRSLOY main screens, light and dark", async () => {
  await mkdir(outDir, { recursive: true });
  const { app, page, server } = await launch();
  try {
    for (const mode of ["light", "dark"] as const) {
      await setTheme(page, mode);

      await page.waitForTimeout(300);
      await page.getByTestId("start-host").click({ force: true });
      await expect(page.getByTestId("runtime-snapshot").first()).toContainText("runtimeId", {
        timeout: 60_000,
      });
      await expect(page.getByTestId("host-status").first()).toContainText(
        /Agent Host ready|Agent Host restarted/,
        { timeout: 45_000 },
      );
      await expect(page.getByTestId("example-chips")).toBeVisible();
      await shot(page, `${mode}-1-home`);
      await shot(page, `${mode}-empty-chat`);
      // Keyboard focus is visible on the chips (and every other control without its own ring).
      const chip = page.getByRole("button", { name: "Сайт-визитка для моего дела" });
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press("Tab");
        if (await chip.evaluate((el) => el === document.activeElement)) break;
      }
      await expect(chip).toBeFocused();
      expect(await chip.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
      await shot(page, `${mode}-focus`);
      // A chip fills the composer and sends nothing.
      await page.getByRole("button", { name: "Сайт-визитка для моего дела" }).click();
      await expect(page.getByTestId("prompt-input")).toHaveValue("Сайт-визитка для моего дела");
      await expect(page.getByTestId("example-chips")).toBeVisible();

      await page.getByTestId("prompt-input").fill("Посмотри проект и скажи, что тут");
      await page.getByTestId("send-prompt").click();
      await expect(page.getByTestId("timeline"))
        .toContainText("С чего начнём?", { timeout: 60_000 })
        .catch(async (error: unknown) => {
          await shot(page, `debug-${mode}`);
          throw error;
        });
      await expect(page.getByTestId("cost-turn")).toBeVisible();
      await page
        .getByText(/^Готово за/)
        .first()
        .click();
      await shot(page, `${mode}-2-chat`);

      await page.getByTestId("prompt-input").fill("Запусти тесты");
      await page.getByTestId("send-prompt").click();
      await expect(page.getByTestId("turn-progress")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("turn-progress-action")).toHaveText("Запускаю тесты");
      await shot(page, `${mode}-progress-line`);
      await expect(page.getByTestId("timeline")).toContainText("Тесты прошли.", {
        timeout: 30_000,
      });
      await expect(page.getByTestId("turn-progress")).toBeHidden();

      await page.getByTestId("prompt-input").fill("Цена за месяц?");
      await page.getByTestId("send-prompt").click();
      await expect(page.getByTestId("timeline")).toContainText("Итого: 1000 ₽, было 8000 ₽.", {
        timeout: 30_000,
      });
      // Scoped to the chat: test builds also dump raw events in a hidden developer panel.
      const leak = page
        .getByTestId("timeline")
        .getByText("Let me look at the working directory first.");
      await expect(leak).toHaveCount(0);
      await page
        .getByText(/^Готово за/)
        .last()
        .click();
      await expect(page.getByTestId("thinking-toggle").last()).toHaveText("Думаю…");
      await expect(leak).toHaveCount(0);
      await shot(page, `${mode}-price-thinking`);

      // «Код» preview: the turn that wrote a page offers it; it opens beside the chat.
      await page.getByTestId("prompt-input").fill("Сделай сайт-визитку для флориста");
      await page.getByTestId("send-prompt").click();
      await page.getByTestId("turn-preview-btn").last().click({ timeout: 30_000 });
      const site = page.frameLocator('[data-testid="code-preview-frame"]');
      await expect(site.getByRole("heading", { name: "Анна Смирнова" })).toBeVisible();
      await shot(page, `${mode}-code-preview`);
      await page.getByTestId("code-preview-device-phone").click();
      await shot(page, `${mode}-code-preview-phone`);
      await page.getByTestId("code-preview-close").click();

      await page.getByTestId("prompt-input").fill("Проверим обрыв связи");
      await page.getByTestId("send-prompt").click();
      await expect(page.getByTestId("model-failure")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("model-failure")).toContainText("Связь с моделью оборвалась");
      await shot(page, `${mode}-model-failure`);
      // The retry resends the same prompt; this time the model answers (a second reply).
      await page.getByTestId("model-failure-retry").click();
      await expect(page.getByTestId("timeline").getByText("С чего начнём?")).toHaveCount(2, {
        timeout: 30_000,
      });

      await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      await expect(page.getByTestId("settings-general")).toBeVisible();
      await shot(page, `${mode}-3-settings`);

      await page.getByTestId("settings-nav-appearance").click();
      await shot(page, `${mode}-4-appearance`);
      await page.getByTestId("settings-back").click();
    }

    // Small laptop window: 1024×640, nothing overflows sideways or gets cut off.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1024, 640);
    });
    const noSideScroll = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("main, section, .page, [data-testid]")]
          .filter(
            (el) =>
              el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "hidden",
          )
          .filter((el) => getComputedStyle(el).overflowX !== "visible" || el === document.body)
          .map((el) => el.dataset.testid ?? el.className.toString().slice(0, 40)),
      );
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1024);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      1024,
    );
    expect(await noSideScroll()).toEqual([]);
    await expect(page.getByTestId("prompt-input")).toBeInViewport();
    await shot(page, "small-chat");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await page.getByTestId("settings-nav-account").click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      1024,
    );
    expect(await noSideScroll()).toEqual([]);
    await shot(page, "small-account");
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
});
