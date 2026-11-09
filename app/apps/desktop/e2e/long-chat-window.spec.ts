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
    // Electron's native capture includes the whole window at non-default zoom.
    // Playwright's viewport screenshot can crop physical pixels to CSS dimensions.
    const capture = async (name: string) => {
      const shot = await launched.app.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage();
        return { png: image.toPNG().toString("base64"), jpg: image.toJPEG(65).toString("base64") };
      });
      await writeFile(test.info().outputPath(`${name}.png`), Buffer.from(shot.png, "base64"));
      await writeFile(test.info().outputPath(`${name}.jpg`), Buffer.from(shot.jpg, "base64"));
    };
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
    // One full-height control keeps dense chats reachable without overlapping tiny targets.
    const minimap = page.locator(".minimap-slider");
    await expect(minimap).toBeVisible();
    await minimap.focus();
    await minimap.press("End");
    await minimap.press("Home");
    await expect(timeline).toContainText("Ход 1: покажи файлы", { timeout: 30_000 });

    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => {
        localStorage.setItem("zeno.locale", "ru");
        localStorage.setItem("zeno.colorMode", value);
      }, theme);
      await page.reload();
      await startHost(page);
      await page.locator('[data-session-path$="long-chat.jsonl"]').first().click();
      await expect(timeline).toContainText("Ход 150: покажи файлы", { timeout: 60_000 });
      for (const zoom of [1, 1.5]) {
        await launched.app.evaluate(({ BrowserWindow }, factor) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.setContentSize(1920, 1080);
          window.webContents.setZoomFactor(factor);
        }, zoom);
        await expect(minimap).toBeVisible();
        const box = await minimap.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(24);
        expect(box!.height).toBeGreaterThanOrEqual(24);
        expect(await page.locator(".minimap-rail button").count()).toBe(0);
        expect(
          await minimap.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return [0.1, 0.5, 0.9].every(
              (fraction) =>
                document.elementFromPoint(
                  rect.left + rect.width / 2,
                  rect.top + rect.height * fraction,
                ) === el,
            );
          }),
        ).toBe(true);

        await minimap.press("End");
        const max = Number(await minimap.getAttribute("max"));
        await expect(minimap).toHaveValue(String(max));
        await minimap.press("Home");
        await expect(minimap).toHaveValue("0");
        await minimap.press("ArrowDown");
        await expect(minimap).toHaveValue("1");
        await minimap.press("ArrowUp");
        await expect(minimap).toHaveValue("0");

        const centers = await page.locator(".minimap-marker").evaluateAll((nodes) =>
          nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return rect.top + rect.height / 2;
          }),
        );
        for (const index of [0, Math.floor(max / 2), max]) {
          await page.mouse.click(box!.x + box!.width / 2, centers[index]!);
          await expect(minimap).toHaveValue(String(index));
          if (index === 0) {
            await expect(
              timeline.getByText("Ход 1: покажи файлы и объясни", { exact: true }),
            ).toBeInViewport();
          } else if (index === max) {
            await expect(
              timeline.getByRole("heading", { name: "Итог хода 150", exact: true }),
            ).toBeInViewport();
          }
        }
        // Navigation can resize/reflow the rail; hover its current box before capturing.
        const currentBox = await minimap.boundingBox();
        await minimap.hover({ position: { x: 13, y: currentBox!.height - 5 } });
        const popover = page.locator(".minimap-popover");
        await expect(popover).toBeVisible();
        const previewBox = await popover.boundingBox();
        expect(previewBox!.y).toBeGreaterThanOrEqual(currentBox!.y - 1);
        expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(
          currentBox!.y + currentBox!.height + 1,
        );
        await capture(`minimap-${theme}-${zoom}`);
      }
      await page.keyboard.press("Control+,");
      await expect(page.getByTestId("settings-general")).toBeVisible();
      await capture(`settings-${theme}`);
    }
  } catch (error) {
    await writeFile(test.info().outputPath("electron-output.log"), launched.output.join(""));
    throw error;
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
