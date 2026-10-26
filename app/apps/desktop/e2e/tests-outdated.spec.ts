import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, sendPrompt, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot, startHostWithCard } from "./features-helpers.ts";

/**
 * #25 on the fake model through the real host: the harness's «Старые тесты устарели» card shows, «Обновить
 * тесты» sends its phrase as the owner's next message, «Оставить как есть» closes the question and sends
 * nothing. Two cards in one turn (a test-only extension emits both), one answered each way.
 */
const here = dirname(fileURLToPath(import.meta.url));
const TEXT =
  "Старые тесты расходятся с вашей просьбой — похоже, они устарели. Обновить их под новое правило?";
const card = (request: string, file: string) => ({
  customType: "prsloy-harness.tests-outdated",
  content: TEXT,
  details: {
    files: [file],
    quote: "expect(price(100)).toBe(90)",
    request,
    actions: [
      { label: "Обновить тесты", prompt: `Обнови тесты под новое правило: ${request}` },
      { label: "Оставить как есть" },
    ],
  },
});

test("«Старые тесты устарели»: «Обновить тесты» sends the phrase, «Оставить как есть» closes", async () => {
  const launched = await launchRu({
    tools: "read,emit_cards",
    toolCall: {
      name: "emit_cards",
      arguments: {
        cards: [
          card("скидка 15% постоянным покупателям", "tests/price.test.js"),
          card("доставка бесплатно от 3000 ₽", "tests/delivery.test.js"),
        ],
      },
    },
  });
  mkdirSync(join(launched.agentDir, "extensions"), { recursive: true });
  copyFileSync(
    join(here, "rc-cards-ext.mjs"),
    join(launched.agentDir, "extensions", "rc-cards-ext.ts"),
  );
  try {
    const { page } = launched;
    await startHostWithCard(page);
    await sendPrompt(page, "Use the tool: сделай скидку 15%");
    await waitSettled(page);
    const cards = page.getByTestId("tests-outdated-card");
    await expect(cards).toHaveCount(2);
    const [first, second] = [cards.nth(0), cards.nth(1)];
    await expect(first).toContainText(TEXT);
    await expect(first.getByTestId("tests-outdated-files")).toHaveText(
      "Тесты: tests/price.test.js",
    );
    await expect(first.getByTestId("tests-outdated-quote")).toHaveText(
      "expect(price(100)).toBe(90)",
    );
    await shot(page, "tests-outdated-1-card");

    // «Оставить как есть»: the question closes, nothing goes to the model
    const before = launched.fakeModel.requests.length;
    await second.getByTestId("tests-outdated-keep").click();
    await expect(second.getByTestId("tests-outdated-answered")).toHaveText(
      "Выбрано: Оставить как есть",
    );
    await expect(second.getByRole("button")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(launched.fakeModel.requests.length).toBe(before);

    // «Обновить тесты»: the phrase is the owner's next message, the buttons are gone
    await first.getByTestId("tests-outdated-update").click();
    await expect(first.getByTestId("tests-outdated-answered")).toHaveText(
      "Выбрано: Обновить тесты",
    );
    await expect(first.getByTestId("tests-outdated-update")).toHaveCount(0);
    await expect(page.getByTestId("timeline").locator('[data-kind="user"]').last()).toContainText(
      "Обнови тесты под новое правило: скидка 15% постоянным покупателям",
    );
    await waitSettled(page);
    expect(JSON.stringify(launched.fakeModel.requests.slice(before))).toContain(
      "Обнови тесты под новое правило: скидка 15% постоянным покупателям",
    );
    await shot(page, "tests-outdated-2-answered");
  } finally {
    await closeLaunched(launched);
  }
});
