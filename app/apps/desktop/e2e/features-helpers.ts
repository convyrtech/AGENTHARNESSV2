import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { launchZenoApp, type LaunchOptions } from "./fixtures.ts";

/**
 * Shared bits of the `features-*` specs (research 19 §1): the app in Russian at a fixed
 * size, and before/after screenshots in docs/prsloy/screens/features-*.png.
 */
const SCREENS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "prsloy",
  "screens",
);

export async function launchRu(options: LaunchOptions = {}) {
  const launched = await launchZenoApp(options);
  const { page } = launched;
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });
  await page.evaluate(() => localStorage.setItem("zeno.locale", "ru"));
  await page.reload();
  return launched;
}

export async function closeLaunched(launched: Awaited<ReturnType<typeof launchZenoApp>>) {
  await launched.app.close().catch(() => undefined);
  await launched.fakeModel.stop().catch(() => undefined);
  await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
}

export async function shot(page: Page, name: string, settleMs = 300): Promise<void> {
  mkdirSync(SCREENS, { recursive: true });
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: join(SCREENS, `features-${name}.png`) });
}
