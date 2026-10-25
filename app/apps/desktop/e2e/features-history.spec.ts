import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «История версий» (research 19 §1.8): every request leaves a version (core's snapshot);
 * the chat's «…» menu lists them, «Вернуть» brings the files back after a confirm, and the
 * state before going back is a version too, so the owner can return.
 */
test("version history lists requests and goes back and forth", async () => {
  const launched = await launchRu({
    tools: "read,write",
    toolCall: {
      name: "write",
      arguments: { path: "index.html", content: "<h1>Первая версия</h1>" },
    },
  });
  try {
    const { page, workspace } = launched;
    const file = join(workspace, "index.html");
    await startHost(page);
    await sendPrompt(page, "Use the tool to write the page.");
    await waitSettled(page);
    expect(await readFile(file, "utf8")).toBe("<h1>Первая версия</h1>");
    // The owner changes the page by hand, then asks again: a second version.
    await writeFile(file, "<h1>Вторая версия</h1>");
    await sendPrompt(page, "Привет");
    await waitSettled(page);

    await page.getByTestId("thread-header-menu").click();
    await page.getByTestId("thread-header-history").click();
    const dialog = page.getByTestId("version-history");
    await expect(dialog).toBeVisible();
    const rows = dialog.getByTestId("version-history-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Привет");
    await expect(rows.nth(0)).toContainText("сегодня");
    await expect(rows.nth(1)).toContainText("Use the tool to write the page.");
    await shot(page, "history-1-before");

    // Back to before the first request: the page did not exist yet.
    await rows.nth(1).getByTestId("version-history-restore").click();
    await expect(page.getByTestId("version-history-confirm")).toContainText(
      "Файлы станут как до «Use the tool to write the page.»",
    );
    await page
      .getByTestId("version-history-confirm")
      .getByRole("button", { name: "Вернуть" })
      .click();
    await expect(page.getByTestId("version-history-note")).toContainText("Ход откачен");
    expect(existsSync(file)).toBe(false);
    await expect(rows.nth(0)).toContainText("Перед откатом");
    await shot(page, "history-2-after");

    // «Перед откатом» brings the hand-made second version back.
    await rows.nth(0).getByTestId("version-history-restore").click();
    await page
      .getByTestId("version-history-confirm")
      .getByRole("button", { name: "Вернуть" })
      .click();
    await expect(rows).toHaveCount(4);
    expect(await readFile(file, "utf8")).toBe("<h1>Вторая версия</h1>");
    await page.getByTestId("version-history-close").click();
    await expect(dialog).toBeHidden();
  } finally {
    await closeLaunched(launched);
  }
});
