/**
 * #83: a question the user can see — and always a way out of it.
 *
 * The bug: the agent asked, the window never appeared (the question was dropped when the
 * chat on screen was a different one, or silently cancelled by the question behind it), and
 * the app sat there looking busy forever. Here the same extension asks twice in a row:
 * the first question is on screen, the second waits its turn and is named on screen, and
 * answering the first brings up the second instead of losing it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, startHost, test } from "./fixtures.ts";

const FIRST = "E2E first question";
const SECOND = "E2E second question";

async function installTwoQuestionExtension(agentDir: string): Promise<void> {
  const extensionsDir = join(agentDir, "extensions");
  await mkdir(extensionsDir, { recursive: true });
  await writeFile(
    join(extensionsDir, "e2e-ask-twice.ts"),
    `export default function (pi: any) {
  pi.on("session_start", (_event: unknown, ctx: any) => {
    // Fire-and-forget: the two questions overlap, which is exactly the queue case.
    void ctx.ui.select(${JSON.stringify(FIRST)}, ["first answer"], { timeout: 120_000 });
    void ctx.ui.select(${JSON.stringify(SECOND)}, ["second answer"], { timeout: 120_000 });
  });
}
`,
  );
}

test.describe("Extension UI queue (#83)", () => {
  test("shows the second question after the first is answered", async ({ page, zeno }) => {
    await installTwoQuestionExtension(zeno.agentDir);
    await startHost(page);
    await page.evaluate(async () => {
      await window.zeno.runtime.reload();
    });

    const dialog = page.getByTestId("extension-ui-select-dialog");
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("extension-ui-select-title")).toContainText(FIRST);

    // The question behind it is announced: it is waiting, not lost.
    const queued = page.getByTestId("extension-ui-queue");
    await expect(queued).toBeVisible();
    await expect(queued).toContainText("1");

    await page.getByTestId("extension-ui-select-option-0").click();
    await expect(page.getByTestId("extension-ui-select-title")).toContainText(SECOND, {
      timeout: 15_000,
    });

    await page.getByTestId("extension-ui-select-option-0").click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // Nothing is left waiting on screen or in the queue.
    await expect(page.getByTestId("extension-ui-queue")).toBeHidden();
  });

  test("closing the question leaves the app usable", async ({ page, zeno }) => {
    await installTwoQuestionExtension(zeno.agentDir);
    await startHost(page);
    await page.evaluate(async () => {
      await window.zeno.runtime.reload();
    });

    const dialog = page.getByTestId("extension-ui-select-dialog");
    await expect(dialog).toBeVisible({ timeout: 45_000 });
    await page.getByRole("button", { name: /取消|Отмена|Cancel/ }).click();
    // The cancelled question is gone; the one behind it takes its place.
    await expect(page.getByTestId("extension-ui-select-title")).toContainText(SECOND, {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: /取消|Отмена|Cancel/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByTestId("prompt-input")).toBeVisible();
  });
});
