import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «На странице ошибка → Починить» (research 19 §1.2): the injected script hears the page's
 * own errors (a broken script, a picture that is not there); the panel shows one banner,
 * and «Починить» sends the agent every error with its place. Nothing is sent on its own.
 */
const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Кофейня</title>
<script>document.querySelector("#menu").classList.add("open");</script>
</head>
<body style="font-family:sans-serif;padding:32px">
  <h1>Кофейня «Зерно»</h1>
  <img src="img/logo.png" alt="логотип" width="120" height="60">
  <ul id="menu"><li>Капучино — 250 ₽</li></ul>
</body></html>
`;

test("an error on the page shows a banner and «Починить» sends it to the agent", async () => {
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
    await expect(frame.getByRole("heading", { name: "Кофейня «Зерно»" })).toBeVisible();

    const banner = page.getByTestId("code-preview-errors");
    await expect(banner).toContainText("Ошибок на странице: 2");
    await expect(banner).toContainText("/index.html:3");
    await shot(page, "errors-1-before");

    // Nothing goes to the model until the owner asks.
    const before = launched.fakeModel.requests.length;
    await page.waitForTimeout(500);
    expect(launched.fakeModel.requests.length).toBe(before);

    await page.getByTestId("code-preview-fix").click();
    await expect(banner).toBeHidden();
    await waitSettled(page);
    const sent = JSON.stringify(launched.fakeModel.requests.slice(before));
    expect(sent).toContain("Исправь ошибки на странице index.html");
    expect(sent).toContain("не загрузился файл /img/logo.png");
    expect(sent).toMatch(/TypeError[^"]*\(\/index\.html:3/u);
    await shot(page, "errors-2-after");

    // «Обновить» loads the page again: still broken, so the banner is back; «Скрыть» hides it.
    await page.getByTestId("code-preview-reload").click();
    await expect(banner).toBeVisible();
    await page.getByTestId("code-preview-errors-hide").click();
    await expect(banner).toBeHidden();
  } finally {
    await closeLaunched(launched);
  }
});
