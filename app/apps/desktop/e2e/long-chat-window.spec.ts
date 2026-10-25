import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, launchZenoApp, startHost, test } from "./fixtures.ts";
import { longSessionJsonl } from "./long-session.ts";

/**
 * Long chats render their tail only (stage 7b): the oldest turns are not in the DOM until
 * the reader asks for them — «Показать предыдущие сообщения» or a minimap jump.
 */
test("long chat opens with its tail; earlier turns on demand", async () => {
  const launched = await launchZenoApp();
  try {
    const { page } = launched;
    await startHost(page);
    await mkdir(join(launched.agentDir, "sessions"), { recursive: true });
    await writeFile(
      join(launched.agentDir, "sessions", "long-chat.jsonl"),
      longSessionJsonl(launched.workspace, 150),
    );
    await page.reload();
    await startHost(page);
    await page.locator('[data-session-path$="long-chat.jsonl"]').first().click();
    const timeline = page.getByTestId("timeline");
    await expect(timeline).toContainText("Ход 150: покажи файлы", { timeout: 60_000 });
    await expect(timeline).not.toContainText("Ход 1: покажи файлы");

    // Each click brings in one more step; the button goes once the first turn is in.
    const showEarlier = page.getByTestId("timeline-show-earlier");
    for (let clicks = 0; (await showEarlier.count()) > 0; clicks++) {
      expect(clicks).toBeLessThan(10);
      await showEarlier.click();
    }
    await expect(timeline).toContainText("Ход 1: покажи файлы", { timeout: 30_000 });

    // A fresh open renders the tail again; the minimap still reaches the first turn.
    await page.reload();
    await startHost(page);
    await page.locator('[data-session-path$="long-chat.jsonl"]').first().click();
    await expect(timeline).toContainText("Ход 150: покажи файлы", { timeout: 60_000 });
    await expect(timeline).not.toContainText("Ход 1: покажи файлы");
    // 300 dashes overlap on the packed rail: click the first one directly.
    await page.locator(".minimap-marker").first().dispatchEvent("click");
    await expect(timeline).toContainText("Ход 1: покажи файлы", { timeout: 30_000 });
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
