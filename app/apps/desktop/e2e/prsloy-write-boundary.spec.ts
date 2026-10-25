import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchZenoApp, startHost, test } from "./fixtures.ts";

/**
 * PRSLOY stage 6: a write outside the project stops the agent and asks the user in Russian
 * (Pi tool_call → host → renderer dialog). «Нет» keeps the file from being written.
 */
test("write outside the project asks first; «Нет» blocks it", async () => {
  // Not under the system temp dir (an allowed root): a folder next to the repo.
  const outside = await mkdtemp(join(process.cwd(), ".e2e-outside-"));
  const target = join(outside, "secret.txt");
  const launched = await launchZenoApp({
    tools: "read,write",
    toolCall: { name: "write", arguments: { path: target, content: "nope" } },
  });
  try {
    const { page } = launched;
    await startHost(page);
    await page.getByTestId("prompt-input").fill("Use the tool to write the file.");
    await page.getByTestId("send-prompt").click();

    const dialog = page.getByTestId("extension-ui-select-dialog");
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("extension-ui-select-title")).toContainText(
      `Агент хочет изменить файл вне проекта: ${target}. Разрешить?`,
    );
    await expect(page.getByTestId("extension-ui-select-options")).toContainText(
      "Разрешать в этом разговоре",
    );
    await page.getByTestId("extension-ui-select-option-1").click(); // «Нет»

    await expect(page.getByTestId("host-status").first()).toContainText("Agent settled", {
      timeout: 60_000,
    });
    expect(existsSync(target)).toBe(false);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
  }
});
