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
    const minimap = page.locator(".minimap-rail");
    const markers = minimap.locator(".minimap-marker");
    await expect(markers).toHaveCount(300);
    const activeMarker = minimap.locator('.minimap-marker[aria-current="true"]');
    await expect(activeMarker).toHaveCount(1);
    const activeIsVisible = await activeMarker.evaluate((element) => {
      const track = element.closest(".minimap-track")!;
      const marker = element.getBoundingClientRect();
      const viewport = track.getBoundingClientRect();
      return marker.top >= viewport.top && marker.bottom <= viewport.bottom;
    });
    expect(activeIsVisible).toBe(true);
    const undersized = await markers.evaluateAll((elements) =>
      elements
        .map((element) => {
          const { width, height } = element.getBoundingClientRect();
          return { width: Math.round(width), height: Math.round(height) };
        })
        .filter(({ width, height }) => width < 24 || height < 24),
    );
    expect(undersized).toEqual([]);

    // Scroll the minimap itself and use a real click to reach the oldest hidden turn.
    const firstMarker = markers.first();
    await firstMarker.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        firstMarker.evaluate((element) => {
          const track = element.closest(".minimap-track")!;
          const marker = element.getBoundingClientRect();
          const viewport = track.getBoundingClientRect();
          return marker.top >= viewport.top && marker.bottom <= viewport.bottom;
        }),
      )
      .toBe(true);
    await firstMarker.click();
    await expect(timeline).toContainText("Ход 1: покажи файлы", { timeout: 30_000 });
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
