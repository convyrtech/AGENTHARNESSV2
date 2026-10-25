import { readFile } from "node:fs/promises";
import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «Снять часть страницы» (research 19 §1.9): the owner draws a frame over the preview,
 * main takes that part of our own window (capturePage, no screen-sharing prompt), and the
 * PNG lands in the composer's attachments; sending it gives the model the picture.
 */
const PAGE = `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:sans-serif">
  <div id="box" style="margin:40px;width:240px;height:120px;background:#e11d48;color:#fff;padding:12px">Кривой блок</div>
</body></html>`;

test("a frame drawn over the preview becomes a picture attached to the message", async () => {
  const launched = await launchRu({
    tools: "read,write",
    toolCall: { name: "write", arguments: { path: "index.html", content: PAGE } },
  });
  try {
    const { page } = launched;
    await startHost(page);
    await sendPrompt(page, "Use the tool to write the page.");
    await waitSettled(page);
    await page.getByTestId("turn-preview-btn").click();
    const frame = page.frameLocator('[data-testid="code-preview-frame"]');
    await expect(frame.locator("#box")).toBeVisible();
    await shot(page, "capture-1-before");

    await page.getByTestId("code-preview-capture").click();
    const layer = page.getByTestId("code-preview-capture-layer");
    await expect(layer).toContainText("Обведите рамкой");
    const box = await page.getByTestId("code-preview-frame").boundingBox();
    if (!box) throw new Error("no frame");
    // Around the red block: 40 px margin inside the frame, 240×120 plus padding.
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 120, { steps: 5 });
    await page.mouse.move(box.x + 310, box.y + 190, { steps: 5 });
    await shot(page, "capture-2-frame", 100);
    await page.mouse.up();

    await expect(layer).toBeHidden();
    await expect(page.getByTestId("code-preview-zip-note")).toHaveText(
      "Снимок добавлен к сообщению.",
    );
    const card = page.getByTestId("composer-attachment-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("attachment-image-preview")).toBeVisible();
    await shot(page, "capture-3-after");

    const before = launched.fakeModel.requests.length;
    await page.getByTestId("prompt-input").fill("Вот тут криво");
    await page.getByTestId("send-prompt").click();
    await waitSettled(page);
    const sent = JSON.stringify(launched.fakeModel.requests.slice(before));
    expect(sent).toContain("Вот тут криво");
    // The picture itself goes to the model (data URL), not just a file name.
    // The picture goes as an image part. The fake model has no image input, so pi marks it
    // omitted; PRSLOY's models all take images (shared/prsloy-config.ts).
    expect(sent).toContain("(image omitted: model does not support images)");
    const path = /<path>([^<]*preview-\d+\.png)<\/path>/u.exec(sent)?.[1] ?? "";
    expect(path).not.toBe("");
    const png = await readFile(path);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    // Roughly the drawn 280×160 (main applies the window zoom and the screen scale).
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(270);
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(150);
  } finally {
    await closeLaunched(launched);
  }
});
