import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchZenoApp, sendPrompt, startHost, test } from "./fixtures.ts";
import { longSessionJsonl } from "./long-session.ts";

/**
 * Compaction on a long chat (stage 7b): the next turn runs, the chat still shows the old
 * turns, and the session cost (₽ chip) keeps counting from where it was.
 */
test("compaction on a long chat keeps history, turns and cost", async () => {
  const launched = await launchZenoApp();
  try {
    const { page } = launched;
    await startHost(page);
    await mkdir(join(launched.agentDir, "sessions"), { recursive: true });
    await writeFile(
      join(launched.agentDir, "sessions", "long-chat.jsonl"),
      longSessionJsonl(launched.workspace, 150),
    );
    // Give the fake model a price, so turns and the compaction summary cost something.
    const modelsPath = join(launched.agentDir, "models.json");
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    for (const model of models.providers["zeno-fake"].models) {
      model.cost = { input: 1000, output: 4000, cacheRead: 100, cacheWrite: 1000 };
    }
    await writeFile(modelsPath, JSON.stringify(models));
    await page.reload();
    await startHost(page);
    await page.locator('[data-session-path$="long-chat.jsonl"]').first().click();
    const timeline = page.getByTestId("timeline");
    await expect(timeline).toContainText("Ход 150: покажи файлы", { timeout: 60_000 });

    const cost = async () =>
      (await page.evaluate(() => window.zeno.host.snapshot())).usage?.cost ?? Number.NaN;
    // The fake model's 8k window would auto-compact on the first turn: compact by hand first.
    const before = await cost();
    const compacted = await page.evaluate(() => window.zeno.session.compact());
    const afterCompact = await cost();
    await sendPrompt(page, "Продолжим после сжатия.");
    const afterTurn = await cost();
    // pi may summarize again after the turn (8k window): pick the turn's own request.
    const lastRequest = launched.fakeModel.requests.findLast((request) =>
      JSON.stringify(request.messages ?? []).includes("Продолжим после сжатия."),
    );
    console.log(
      `[compaction] ${JSON.stringify({
        before,
        afterCompact,
        afterTurn,
        compacted: Boolean(compacted),
        messagesAfter: lastRequest?.messages?.length,
      })}`,
    );
    // The turn after compaction ran (sendPrompt waited for it to settle) on a short context.
    await expect(timeline).toContainText("Продолжим после сжатия.");
    expect(JSON.stringify(lastRequest?.messages ?? [])).toContain("Продолжим после сжатия.");
    // 150 turns are 600 messages; after compaction the model gets a summary and the tail.
    expect(lastRequest?.messages?.length ?? 0).toBeLessThan(100);
    // Old turns are still in the chat (behind «Показать предыдущие сообщения»).
    while ((await page.getByTestId("timeline-show-earlier").count()) > 0) {
      await page.getByTestId("timeline-show-earlier").click();
    }
    await expect(timeline).toContainText("Ход 1: покажи файлы", { timeout: 30_000 });
    // The session cost keeps counting: no drop after compaction, no jump on the next turn.
    expect(before).toBeGreaterThan(0);
    expect(afterCompact).toBeGreaterThanOrEqual(before);
    expect(afterTurn).toBeGreaterThan(afterCompact);
    expect(afterTurn - before).toBeLessThan(before);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
