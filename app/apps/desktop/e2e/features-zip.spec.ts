import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readZip } from "../src/main/design/zip.ts";
import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «Скачать архив» in «Код» (research 19 §1.4): the project as one zip through the save
 * dialog, without .env, .git and node_modules. The dialog is stubbed in main: Playwright
 * cannot click a native window.
 */
test("«Скачать архив» saves the project without secrets and dependencies", async () => {
  const launched = await launchRu({
    tools: "read,write",
    toolCall: {
      name: "write",
      arguments: { path: "index.html", content: "<!doctype html><h1>Визитка</h1>" },
    },
  });
  try {
    const { page, app, workspace, root } = launched;
    await writeFile(join(workspace, ".env"), "PRSLOY_TEST_SECRET=1\n");
    await mkdir(join(workspace, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "left-pad", "index.js"), "x");
    const target = join(root, "saved.zip");
    await app.evaluate(({ dialog, shell }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as never;
      shell.showItemInFolder = () => undefined;
    }, target);

    await startHost(page);
    await sendPrompt(page, "Use the tool to write the page.");
    await waitSettled(page);
    await page.getByTestId("turn-preview-btn").click();
    const zip = page.getByTestId("code-preview-zip");
    await expect(zip).toHaveText("Скачать архив");
    await shot(page, "zip-1-before");

    await zip.click();
    await expect(page.getByTestId("code-preview-zip-note")).toHaveText("Архив сохранён: saved.zip");
    await shot(page, "zip-2-after");

    const entries = readZip(await readFile(target), {
      files: 1000,
      bytes: 50 << 20,
      fileBytes: 50 << 20,
    });
    const names = entries.map((e) => e.name);
    const folder = basename(workspace);
    expect(names).toContain(`${folder}/index.html`);
    expect(names).toContain(`${folder}/fixture.txt`);
    expect(names.some((n) => n.includes(".env") || n.includes("node_modules"))).toBe(false);
    expect(entries.map((e) => e.data.toString()).join("")).not.toContain("PRSLOY_TEST_SECRET");

    // Cancel in the dialog: nothing is said.
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => ({ canceled: true, filePath: "" })) as never;
    });
    await zip.click();
    await expect(page.getByTestId("code-preview-zip-note")).toBeHidden();
  } finally {
    await closeLaunched(launched);
  }
});
