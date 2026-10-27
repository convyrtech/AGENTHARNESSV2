import { copyFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { launchZenoApp, startHost, type LaunchOptions } from "./fixtures.ts";

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

export async function closeLaunched(
  launched: Awaited<ReturnType<typeof launchZenoApp>>,
  options: { keepRoot?: boolean } = {},
) {
  await launched.app.close().catch(() => undefined);
  await launched.fakeModel.stop().catch(() => undefined);
  // A restart test relaunches on the same root: its sessions and prefs must survive.
  if (options.keepRoot) return;
  await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
}

export async function shot(page: Page, name: string, settleMs = 300): Promise<void> {
  mkdirSync(SCREENS, { recursive: true });
  await page.waitForTimeout(settleMs);
  await page.screenshot({ path: join(SCREENS, `features-${name}.png`) });
}

/**
 * The app with a test-only Pi extension (`features-cards-ext.mjs`) whose `emit_card` tool shows a
 * card as the harness will (sendMessage with customType and details); the fake model calls it.
 */
export async function launchWithCard(card: {
  customType: string;
  content: string;
  details: unknown;
}) {
  const launched = await launchRu({
    tools: "read,emit_card",
    toolCall: { name: "emit_card", arguments: card },
  });
  const dir = join(launched.agentDir, "extensions");
  mkdirSync(dir, { recursive: true });
  copyFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "features-cards-ext.mjs"),
    join(dir, "features-cards-ext.ts"),
  );
  return launched;
}

/** The extension is picked up on reload, as in extension-ui-select.spec.ts. */
export async function startHostWithCard(page: Page): Promise<void> {
  await startHost(page);
  await page.evaluate(async () => {
    await window.zeno.runtime.reload();
  });
}
