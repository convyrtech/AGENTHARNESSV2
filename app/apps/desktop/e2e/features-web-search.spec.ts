import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, sendPrompt, test, waitSettled } from "./fixtures.ts";
import {
  closeLaunched,
  launchRu,
  launchWithCard,
  shot,
  startHostWithCard,
} from "./features-helpers.ts";

/**
 * Settings → «Поиск в интернете» (issue #23) on design's real main handlers (`prsloy:search:*`):
 * free search in use by default, a Brave key saved through main and shown only as a mask, «Выбрать»,
 * and «Искать в интернете» writing the harness flag `webTools`. «Проверить» is not pressed: it goes
 * to the network; its lines are covered by SearchSection.test.tsx.
 */
const KEY = "BSA-e2e-secret-key-7f3a";

test("«Поиск в интернете»: free by default, a key only as a mask, «Выбрать», the switch", async () => {
  const launched = await launchRu();
  try {
    const { page, agentDir } = launched;
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-web-search").click();
    const screen = page.getByTestId("settings-web-search");
    await expect(screen).toContainText("Каким поиском искать");
    const free = page.getByTestId("web-search-free");
    await expect(free.getByTestId("web-search-active")).toHaveText("Сейчас этот");
    await expect(page.getByTestId("web-search-checked-on")).toContainText("2026");
    await shot(page, "web-search-1-default");

    const brave = page.getByTestId("web-search-brave");
    await brave.getByTestId("web-search-edit").click();
    await brave.getByTestId("web-search-key").fill(KEY);
    await shot(page, "web-search-2-key-form");
    await brave.getByTestId("web-search-save").click();
    await expect(brave).toContainText("Ключ: ");
    await expect(brave.getByTestId("web-search-remove")).toBeVisible();
    await expect(brave.getByTestId("web-search-key")).toHaveCount(0);
    expect(await page.content()).not.toContain(KEY);

    await brave.getByTestId("web-search-use").click();
    await expect(brave.getByTestId("web-search-active")).toBeVisible();
    await expect(free.getByTestId("web-search-use")).toBeVisible();

    const toggle = page.getByTestId("web-search-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const flags = JSON.parse(await readFile(join(agentDir, "prsloy-harness.json"), "utf8"));
    expect(flags.webTools).toBe(true);
    await brave.scrollIntoViewIfNeeded();
    await shot(page, "web-search-3-brave");

    // «Убрать» on the provider in use puts free back first.
    await brave.getByTestId("web-search-remove").click();
    await expect(free.getByTestId("web-search-active")).toBeVisible();
    await expect(brave.getByTestId("web-search-edit")).toHaveText("Добавить ключ");
  } finally {
    await closeLaunched(launched);
  }
});

test("«лимит поиска исчерпан» in the chat: «Добавить ключ» opens Brave's form in the settings", async () => {
  const launched = await launchWithCard({
    customType: "prsloy-harness.search-limit",
    content: "Brave: 429 Too Many Requests",
    details: { provider: "brave", code: "limit" },
  });
  try {
    const { page } = launched;
    await startHostWithCard(page);
    await sendPrompt(page, "Use the tool: найди свежую версию Node");
    await waitSettled(page);
    const card = page.getByTestId("search-limit-card");
    await expect(card).toContainText("Brave: лимит исчерпан");
    await expect(card).toContainText("Агент продолжил другим поиском");
    await shot(page, "web-search-4-limit-card");
    await card.getByTestId("search-limit-key").click();
    const brave = page.getByTestId("web-search-brave");
    await expect(brave.getByTestId("web-search-key")).toBeFocused();
    await shot(page, "web-search-5-from-card");
  } finally {
    await closeLaunched(launched);
  }
});
