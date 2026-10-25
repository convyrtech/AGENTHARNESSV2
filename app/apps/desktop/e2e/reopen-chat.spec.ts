import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu } from "./features-helpers.ts";

/**
 * A chat reopened from the sidebar reads as it did live (features' first-hour pass): the reply was
 * streamed with a trailing space, history stores it trimmed, and the streamed copy used to survive —
 * the answer twice, the first one folded under «Готово за N с».
 */
test("a reopened chat shows its answer once", async () => {
  const launched = await launchRu();
  try {
    const { page } = launched;
    await startHost(page);
    await sendPrompt(page, "first thread hello");
    await waitSettled(page);
    const timeline = page.getByTestId("timeline");
    const answers = timeline.locator('[data-testid="markdown-content"]');
    await expect(answers).toHaveCount(1);

    await page.getByTestId("start-host").click({ force: true });
    await expect(page.getByTestId("empty-hero")).toBeVisible({ timeout: 30_000 });
    await page
      .getByTestId("conversations-list")
      .locator('button[data-active="false"]')
      .first()
      .click();
    await expect(timeline).toContainText("first thread hello", { timeout: 20_000 });
    await page.waitForTimeout(1000);
    await expect(answers).toHaveCount(1);
    await expect(timeline.getByTestId("timeline-process")).toHaveCount(0);
  } finally {
    await closeLaunched(launched);
  }
});
