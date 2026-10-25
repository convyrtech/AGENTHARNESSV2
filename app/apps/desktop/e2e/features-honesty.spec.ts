import { expect, sendPrompt, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchWithCard, shot, startHostWithCard } from "./features-helpers.ts";

/**
 * research/24 §3.6 and §4.5 on mocks: the harness's future cards — «Заметил и запомнил»,
 * «Обновил: было … стало …», «Не получилось / Почему / Что нужно от вас» — reach the chat
 * through the real host. A test-only Pi extension (`features-cards-ext.mjs`) shows them as the
 * harness will (sendMessage with customType and details); the fake model calls it.
 */
test("«Не получилось»: three lines, a ready answer goes to the agent", async () => {
  const launched = await launchWithCard({
    customType: "prsloy-harness.blocker",
    content: "Не получилось: исправить скидку",
    details: {
      what: "исправить скидку",
      why: "старый тест ждёт 10%, а вы просили 15%",
      need: "скажите, какую скидку оставить",
      reason: "test_conflicts_request",
      options: ["Оставь 15%, тест поправь", "Верни 10%"],
    },
  });
  try {
    const { page } = launched;
    await startHostWithCard(page);
    await sendPrompt(page, "Use the tool: сделай скидку 15%");
    await waitSettled(page);
    const card = page.getByTestId("blocker-card");
    await expect(card).toContainText("Не получилось: исправить скидку");
    await expect(card.getByTestId("blocker-why")).toHaveText(
      "Почему: старый тест ждёт 10%, а вы просили 15%",
    );
    await expect(card.getByTestId("blocker-need")).toContainText("Что нужно от вас");
    await shot(page, "honesty-1-blocker");
    const before = launched.fakeModel.requests.length;
    await card.getByRole("button", { name: "Верни 10%" }).click();
    await waitSettled(page);
    expect(JSON.stringify(launched.fakeModel.requests.slice(before))).toContain("Верни 10%");
    await shot(page, "honesty-2-answered");
  } finally {
    await closeLaunched(launched);
  }
});

test("memory v2 card: «Запомнил несколько вещей (2)» · [Показать] lists both with the user's words", async () => {
  const launched = await launchWithCard({
    customType: "prsloy-memory.auto",
    content: "Запомнил несколько вещей (2)",
    details: {
      items: [
        { id: "a-1", scope: "user", text: "Отвечать без терминов", quote: "пиши проще" },
        { id: "a-2", scope: "project", text: "Сайт без сборщиков", quote: "не надо npm" },
      ],
    },
  });
  try {
    const { page } = launched;
    await startHostWithCard(page);
    await sendPrompt(page, "Use the tool please");
    await waitSettled(page);
    const card = page.getByTestId("memory-card");
    await expect(card).toContainText("Запомнил несколько вещей (2)");
    await card.getByTestId("memory-auto-show").click();
    await expect(card.getByTestId("memory-auto-entry")).toHaveCount(2);
    await expect(card).toContainText("Ваши слова: «пиши проще»");
    await shot(page, "honesty-3-memory-auto");
  } finally {
    await closeLaunched(launched);
  }
});

test("memory v2 card: «Обновил: было … стало …» · [Вернуть]", async () => {
  const launched = await launchWithCard({
    customType: "prsloy-memory.updated",
    content: "Обновил: было «Отвечать по-английски», стало «Отвечать по-русски»",
    details: {
      opId: "op-1",
      id: "m-1",
      scope: "user",
      before: "Отвечать по-английски",
      after: "Отвечать по-русски",
    },
  });
  try {
    const { page } = launched;
    await startHostWithCard(page);
    await sendPrompt(page, "Use the tool please");
    await waitSettled(page);
    const card = page.getByTestId("memory-card");
    await expect(card).toContainText("Отвечать по-английски");
    await expect(card).toContainText("Отвечать по-русски");
    await expect(card.getByTestId("memory-updated-revert")).toBeVisible();
    await shot(page, "honesty-4-memory-updated");
  } finally {
    await closeLaunched(launched);
  }
});
