/**
 * #10: the turn's status line from facts, in both themes. Until the harness sends it (#7), a mock
 * pi extension in the test's agent dir sends `prsloy-harness.turn-status` at the end of each turn
 * with the facts named in the prompt («[факты: checks-fail stubs-left]»). Green facts are a line
 * under the reply; red checks are a card above the model's text, and the turn no longer says
 * «Готово». axe finds nothing on either.
 */
import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, launchZenoApp, startHost, test } from "./fixtures.ts";

const MOCK = `export default function (pi) {
  let facts = [];
  pi.on("before_agent_start", (event) => {
    const m = /\\[факты: ([a-z ,-]+)\\]/.exec(event.prompt ?? "");
    facts = m ? m[1].split(/[ ,]+/).filter(Boolean) : [];
  });
  pi.on("agent_end", () => {
    if (!facts.length) return;
    pi.sendMessage(
      {
        customType: "prsloy-harness.turn-status",
        content: facts.join(", "),
        display: true,
        details: { facts, files: facts.includes("stubs-left") ? ["src/cart.ts"] : [] },
      },
      { triggerTurn: false },
    );
  });
}
`;

/** TURN_STATUS_SHOTS=1 saves docs/prsloy/screens/turn-status-<mode>.png. */
const SCREENS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "prsloy",
  "screens",
);

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .setLegacyMode(true)
    .withTags(["wcag2a", "wcag2aa"])
    .include('[data-testid="timeline"]')
    .analyze();
  return result.violations.map((v: { id: string }) => v.id);
}

async function send(page: Page, text: string) {
  await page.getByTestId("prompt-input").fill(text);
  await page.getByTestId("send-prompt").click();
  await expect(page.getByTestId("host-status").first()).toContainText("Agent settled", {
    timeout: 60_000,
  });
}

for (const mode of ["light", "dark"] as const) {
  test(`turn status from facts (${mode}): green under the reply, red above it without «Готово»`, async () => {
    test.setTimeout(180_000);
    const launched = await launchZenoApp();
    try {
      const { page, agentDir } = launched;
      await mkdir(join(agentDir, "extensions"), { recursive: true });
      await writeFile(join(agentDir, "extensions", "turn-status-mock.js"), MOCK);
      await page.evaluate((value) => {
        localStorage.setItem("zeno.locale", "ru");
        localStorage.setItem("zeno.colorMode", value);
      }, mode);
      await page.reload();
      await startHost(page);
      // a cold host may start before the mock is picked up: reload it, as features-honesty does
      await page.evaluate(async () => {
        await window.zeno.runtime.reload();
      });

      await send(page, "use the tool please [факты: checks-pass page-ok]");
      const green = page.getByTestId("turn-status").last();
      await expect(green).toHaveAttribute("data-tone", "ok", { timeout: 30_000 });
      await expect(green).toHaveText("Проверки прошли · Страница открылась без ошибок");
      const firstReply = page.locator('[data-kind="assistant"]').last();
      expect((await green.boundingBox())!.y).toBeGreaterThan((await firstReply.boundingBox())!.y);

      await send(page, "use the tool again [факты: checks-fail stubs-left]");
      const red = page.getByTestId("turn-status").last();
      await expect(red).toHaveAttribute("data-tone", "fail", { timeout: 30_000 });
      await expect(red).toContainText("Проверки не прошли · Остались заглушки");
      await expect(red).toContainText("Файлы: src/cart.ts");
      // above the model's reply of the same turn
      const reply = page.locator('[data-kind="assistant"]').last();
      expect((await red.boundingBox())!.y).toBeLessThan((await reply.boundingBox())!.y);
      // the turn's header says how long it worked, never «Готово»
      const header = page.locator(".process-header, [data-testid='process-header']").last();
      if (await header.count()) await expect(header).not.toContainText("Готово");
      await expect(page.getByText(/^Работал/u).last()).toBeVisible();
      expect(await axe(page)).toEqual([]);
      if (process.env.TURN_STATUS_SHOTS) {
        await page.screenshot({ path: join(SCREENS, `turn-status-${mode}.png`) });
      }
    } finally {
      await launched.app.close().catch(() => undefined);
      await launched.fakeModel.stop().catch(() => undefined);
      await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
