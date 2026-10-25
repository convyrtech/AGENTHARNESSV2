/**
 * The blueprint theme (stage 10): screenshots of both modes into docs/prsloy/screens/theme-*,
 * and short mp4 clips of its motion: the launch splash and the waiting line with the rolling
 * clock (theme-splash-*.mp4, theme-working-*.mp4; needs ffmpeg).
 *
 *   pnpm --filter @zeno/desktop run build
 *   pnpm --filter @zeno/desktop exec playwright test -c playwright.screens.config.ts theme
 */
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startClip } from "./clip-recorder.ts";
import { launch, outDir, setTheme, shot } from "./screens-app.ts";

test("blueprint theme, light and dark, with its motion", async () => {
  test.setTimeout(300_000);
  await mkdir(outDir, { recursive: true });
  const { app, page, server } = await launch();
  try {
    for (const mode of ["light", "dark"] as const) {
      // the splash plays on every load; the window is 1280×800 and it sits in the middle
      const splash = await startClip(page, join(outDir, `theme-splash-${mode}.mp4`), {
        x: 320,
        y: 240,
        width: 640,
        height: 320,
      });
      await setTheme(page, mode);
      await page.waitForTimeout(1_400);
      await splash();
      await page.getByTestId("start-host").click({ force: true });
      await expect(page.getByTestId("runtime-snapshot").first()).toContainText("runtimeId", {
        timeout: 60_000,
      });
      await expect(page.getByTestId("host-status").first()).toContainText(
        /Agent Host ready|Agent Host restarted/,
        { timeout: 45_000 },
      );
      await expect(page.getByTestId("recipes")).toBeVisible();
      await shot(page, `theme-${mode}-home`);

      await page.getByTestId("prompt-input").fill("Посмотри проект и скажи, что тут");
      await page.getByTestId("send-prompt").click();
      await expect(page.getByTestId("timeline")).toContainText("С чего начнём?", {
        timeout: 60_000,
      });
      await expect(page.getByTestId("cost-turn")).toBeVisible();
      await shot(page, `theme-${mode}-chat`);

      // «Запускаю тесты · 15 с»: the waiting line and the rolling clock.
      await page.getByTestId("prompt-input").fill("Запусти тесты");
      await page.getByTestId("send-prompt").click();
      const line = page.getByTestId("turn-progress");
      await expect(line).toBeVisible({ timeout: 30_000 });
      const box = (await line.boundingBox())!;
      const working = await startClip(page, join(outDir, `theme-working-${mode}.mp4`), {
        x: Math.round(box.x) - 8,
        y: Math.round(box.y) - 16,
        width: Math.round(box.width / 2) * 2 + 16,
        height: Math.round(box.height / 2) * 2 + 32,
      });
      await page.waitForTimeout(4_000);
      await working();
      await shot(page, `theme-${mode}-working`);
      await expect(page.getByTestId("turn-progress")).toBeHidden({ timeout: 30_000 });

      await page.getByTestId("nav-design").click();
      await expect(page.getByTestId("design-page")).toBeVisible();
      await shot(page, `theme-${mode}-design`);

      await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
      await expect(page.getByTestId("settings-general")).toBeVisible();
      await shot(page, `theme-${mode}-settings`);
      await page.getByTestId("settings-nav-appearance").click();
      await shot(page, `theme-${mode}-appearance`);
      await page.getByTestId("settings-back").click();
    }
  } finally {
    await app.close().catch(() => undefined);
    server.close();
  }
});
