import { mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu } from "./features-helpers.ts";

/**
 * First-hour pass: «Новый чат» in an open project starts the new chat in that project (the old chat
 * stays listed), and «Настройки» clicked right after is not undone when the new chat finishes opening.
 */
test("«Новый чат» stays in the project; «Настройки» right after stays open", async () => {
  const launched = await launchRu();
  // A real project folder: the fixture's own workspace counts as a scratch folder, not a project.
  const workspace = await mkdtemp(join(homedir(), ".prsloy-newchat-"));
  try {
    const { page } = launched;
    await startHost(page);
    await page.evaluate(async (path) => {
      await window.zeno.workspace.openPath(path, { resumeRecent: false });
    }, workspace);
    const trust = page.getByTestId("project-trust-dialog");
    if (await trust.isVisible().catch(() => false))
      await page.getByTestId("project-trust-dialog-later").click();
    await expect(page.getByTestId("runtime-snapshot").first()).toContainText(workspace, {
      timeout: 45_000,
    });
    await sendPrompt(page, "Привет");
    await waitSettled(page);

    await page.getByTestId("start-host").click();
    await expect(page.getByTestId("empty-hero")).toContainText("Проект «", { timeout: 30_000 });
    await expect(page.getByTestId("empty-hero")).not.toContainText("проект не нужен");

    await page.getByTestId("start-host").click();
    await page.getByTestId("nav-settings").click();
    await page.waitForTimeout(6000);
    await expect(page.getByTestId("settings-nav-memory")).toBeVisible();
  } finally {
    await closeLaunched(launched);
    await rm(workspace, { recursive: true, force: true });
  }
});
