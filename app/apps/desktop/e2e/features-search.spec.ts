import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * Search over old chats (research 19 §1.6): the sidebar's magnifier opens the palette; two
 * letters and a pause search pi's session files in main («ё» = «е»); a found chat opens
 * like a click in the sidebar.
 */
test("the palette finds an old chat by its words and opens it", async () => {
  const launched = await launchRu();
  try {
    const { page } = launched;
    await startHost(page);
    await sendPrompt(page, "Сделай бота для доставки ёлок по городу");
    await waitSettled(page);
    await startHost(page);
    await sendPrompt(page, "Сделай сайт кофейни");
    await waitSettled(page);
    await expect(page.getByTestId("timeline")).not.toContainText("доставки ёлок");

    await page.getByTestId("open-palette").click();
    const input = page.getByTestId("command-palette-input");
    await input.fill("елок доставк");
    const chats = page.getByTestId("command-chat");
    await expect(chats).toHaveCount(1);
    await expect(chats.first()).toContainText("Сделай бота для доставки ёлок по городу");
    await shot(page, "search-1-before");

    await chats.first().click();
    await expect(page.getByTestId("command-palette")).toBeHidden();
    await expect(page.getByTestId("timeline")).toContainText("доставки ёлок");
    await shot(page, "search-2-after");

    // Words that are in no chat: commands only, no chat group.
    await page.getByTestId("open-palette").click();
    await page.getByTestId("command-palette-input").fill("пицца");
    await page.waitForTimeout(600);
    await expect(page.getByTestId("command-chat")).toHaveCount(0);
  } finally {
    await closeLaunched(launched);
  }
});
