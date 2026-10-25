import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «Что дальше» (research 19 §1.7): after a turn that wrote a page, 2–3 buttons with the next
 * request. The fake model writes no <prsloy-next> tag, so the buttons come from the turn's
 * files without any extra model call. A click fills the composer and sends nothing.
 */
test("after a page is written, «Что дальше» offers next requests", async () => {
  const launched = await launchRu({
    tools: "read,write",
    toolCall: { name: "write", arguments: { path: "index.html", content: "<h1>Сайт</h1>" } },
  });
  try {
    const { page } = launched;
    await startHost(page);
    await sendPrompt(page, "Use the tool to write the page.");
    await waitSettled(page);
    const steps = page.getByTestId("next-steps");
    await expect(steps).toContainText("Что дальше:");
    await expect(page.getByTestId("next-step")).toHaveCount(3);
    await shot(page, "next-1-before");

    const requests = launched.fakeModel.requests.length;
    await page.getByTestId("next-step").filter({ hasText: "Добавь форму заявки" }).click();
    await expect(page.getByTestId("prompt-input")).toHaveValue("Добавь форму заявки");
    await expect(page.getByTestId("prompt-input")).toBeFocused();
    await expect(steps).toBeHidden();
    await page.waitForTimeout(300);
    expect(launched.fakeModel.requests.length).toBe(requests);
    await shot(page, "next-2-after");

    // A plain answer without files: no buttons.
    await page.getByTestId("send-prompt").click();
    await waitSettled(page);
    await expect(steps).toBeHidden();
  } finally {
    await closeLaunched(launched);
  }
});
