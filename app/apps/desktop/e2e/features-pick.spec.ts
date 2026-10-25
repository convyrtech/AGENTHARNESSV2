import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «Выбрать на странице» (research 19 §1.5): the preview server injects the inspector into
 * the agent's page; the owner presses the button, clicks an element in the frame, and the
 * composer gets the exact place with «Что поменять здесь:». The model then sees it.
 */
const PAGE = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Студия</title>
<style>body{font-family:sans-serif;padding:32px} .cta{padding:12px 20px;background:#222;color:#fff;border:0;border-radius:8px}</style>
</head>
<body>
  <h1>Студия йоги «Лотос»</h1>
  <p>Занятия каждый день с 8:00 до 21:00.</p>
  <section class="hero"><button class="cta">Записаться</button> <button>Позвонить</button></section>
</body></html>
`;

test("pick an element in the preview and the composer gets its exact place", async () => {
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
    await expect(frame.getByRole("heading", { name: "Студия йоги «Лотос»" })).toBeVisible();

    const pick = page.getByTestId("code-preview-pick");
    await expect(pick).toHaveText("Выбрать на странице");
    await shot(page, "pick-1-before");

    await pick.click();
    await expect(pick).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("code-preview-pick-note")).toContainText("Esc");
    const cta = frame.getByRole("button", { name: "Записаться" });
    await cta.hover();
    await expect(cta).toHaveClass(/prsloy-pick-highlight/);
    await shot(page, "pick-2-hover");

    await cta.click();
    await expect(pick).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("code-preview-pick-note")).toContainText("«Записаться»");
    const input = page.getByTestId("prompt-input");
    await expect(input).toHaveValue(/\[Место на странице index\.html\]/);
    const draft = await input.inputValue();
    // parse5 marks the served page: the exact file and line of the button.
    expect(draft).toContain("Файл: index.html, строка 8");
    expect(draft).not.toContain("data-pl");
    expect(draft).toContain("Текст: Записаться");
    expect(draft).toContain('Код: `<button class="cta">Записаться</button>`');
    expect(draft.trimEnd().endsWith("Что поменять здесь:")).toBe(true);
    // The selector in the block finds exactly that button on the page.
    const selector = /Элемент: `([^`]+)`/u.exec(draft)?.[1] ?? "";
    await expect(frame.locator(selector)).toHaveText("Записаться");
    // The page works normally again: no leftover highlight.
    await expect(cta).not.toHaveClass(/prsloy-pick-highlight/);
    await input.press("End");
    await input.pressSequentially("сделай зелёной");
    await shot(page, "pick-3-after");

    // Esc cancels picking without touching the draft.
    await pick.click();
    await expect(pick).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(pick).toHaveAttribute("aria-pressed", "false");

    await expect(input).toHaveValue(/сделай зелёной$/u);

    const before = launched.fakeModel.requests.length;
    await page.getByTestId("send-prompt").click();
    await waitSettled(page);
    const sent = JSON.stringify(launched.fakeModel.requests.slice(before));
    expect(sent).toContain("Что поменять здесь: сделай зелёной");
  } finally {
    await closeLaunched(launched);
  }
});
