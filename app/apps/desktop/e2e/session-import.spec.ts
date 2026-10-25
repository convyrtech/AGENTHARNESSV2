/**
 * #22 I1: chats from other agents on the first run, in the product path (no test commands).
 * A fresh profile whose home folder has a Cyrillic name with a space and holds synthetic Claude
 * Code and Codex chats (packages/session-import/test/fixtures, project folders pointed at real
 * folders here). Key → «Перенести чаты из других программ?» → «Перенести» → the folder step
 * offers the imported project → the app lists the imported chat, and continuing it sends the
 * code-written summary to the model. A second profile with no other agents never sees the step.
 *
 * IMPORT_SHOTS=1 saves docs/prsloy/screens/first-run-import-<mode>.png.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchFirstRun as launch, passKey } from "./first-run-app.ts";

const SCREENS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "prsloy",
  "screens",
);

test("first run brings Claude Code and Codex chats over and continues one", async () => {
  test.setTimeout(240_000);
  const launched = await launch(true);
  const { page } = launched;
  try {
    await passKey(page);
    const step = page.getByTestId("prsloy-first-run-import");
    await expect(step).toBeVisible({ timeout: 60_000 });
    await expect(step.getByRole("heading")).toHaveText("Перенести чаты из других программ?");
    const claude = page.getByTestId("prsloy-import-tool-claude-code");
    await expect(claude).toContainText("Claude Code");
    await expect(claude).toContainText("3 чата в 1 проекте");
    await expect(page.getByTestId("prsloy-import-tool-codex")).toContainText("1 чат в 1 проекте");
    const axe = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(["wcag2a", "wcag2aa"])
      .include('[data-testid="prsloy-first-run-import"]')
      .analyze();
    expect(axe.violations.map((v: { id: string }) => v.id)).toEqual([]);
    if (process.env.IMPORT_SHOTS) {
      await page.screenshot({ path: join(SCREENS, "first-run-import.png") });
    }
    // the fixtures are from October 2026; make sure both tools are ticked whatever today is
    for (const tool of ["claude-code", "codex"]) {
      const box = page.getByTestId(`prsloy-import-tool-${tool}`).locator("input");
      if (!(await box.isChecked())) await box.check();
    }
    await page.getByTestId("prsloy-import-submit").click();
    await expect(page.getByTestId("prsloy-import-result")).toHaveText("Перенёс 4 чата", {
      timeout: 60_000,
    });
    await page.getByTestId("prsloy-import-next").click();

    // the imported project is offered first on the folder step
    await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
    const recent = page.getByTestId("prsloy-folder-recent");
    await expect(recent.getByRole("button").first()).toHaveAttribute("title", /сайт-пекарни$/u);
    await recent.getByRole("button").first().click();
    await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    });

    // the imported chat is an ordinary chat of the project, and continuing it works
    const card = page.getByTestId("project-card").filter({ hasText: "сайт-пекарни" }).first();
    // the project chats were brought into starts open in the sidebar
    await expect(card).toHaveAttribute("data-expanded", "true", { timeout: 30_000 });
    const chat = page.getByText("Пекарня «Колосок»").first();
    await expect(chat).toBeVisible({ timeout: 60_000 });
    // a quiet badge says where it came from
    const row = page
      .locator(".sidebar-thread-row")
      .filter({ hasText: "Пекарня «Колосок»" })
      .first();
    await expect(row.getByTestId("imported-badge")).toHaveText("Claude Code");
    await chat.click();
    await expect(page.getByTestId("timeline")).toContainText("Добавил prices.html.", {
      timeout: 30_000,
    });
    // and the chat says what the model works from
    await expect(page.getByTestId("imported-notice")).toContainText(
      "Перенесено из Claude Code. Модель видит сводку разговора и последние ходы",
    );
    if (process.env.IMPORT_SHOTS) {
      await page.screenshot({ path: join(SCREENS, "imported-chat.png") });
    }
    await page.getByTestId("prompt-input").fill("Добавь страницу контактов");
    await page.getByTestId("send-prompt").click();
    await expect(page.getByTestId("timeline")).toContainText("Продолжаю с того же места.", {
      timeout: 90_000,
    });
    const sent = launched.bodies.at(-1) ?? "";
    expect(sent).toContain("Перенесённый чат из Claude Code");
    expect(sent).toContain("Добавь страницу контактов");
    expect(sent).not.toContain("Нужно начать с главной.");

    // the journal and the files are in PRSLOY's folders
    const ledger = JSON.parse(
      await readFile(join(launched.userData, "prsloy", "import-ledger.json"), "utf8"),
    ) as { entries: unknown[] };
    expect(ledger.entries).toHaveLength(4);
  } finally {
    await launched.close();
  }
});

test("no other agents: the first run goes straight from the key to the folder", async () => {
  test.setTimeout(180_000);
  const launched = await launch(false);
  try {
    await passKey(launched.page);
    await expect(launched.page.getByTestId("prsloy-first-run-folder")).toBeVisible({
      timeout: 60_000,
    });
    await expect(launched.page.getByTestId("prsloy-import-choose")).toHaveCount(0);
  } finally {
    await launched.close();
  }
});
