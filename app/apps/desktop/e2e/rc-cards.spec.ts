import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, sendPrompt, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, startHostWithCard } from "./features-helpers.ts";

/**
 * RC check (desktop/ui-rc): the new cards — memory confirm / auto / updated («Было» · [Вернуть]),
 * «Не получилось», «Лимит поиска» — in one chat at 100 % and 125 %, light and dark, on a
 * 1366×768 laptop. Shots go to test-results/rc-cards; every card is checked for cut-off text
 * and for spilling out of the chat column.
 */
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "test-results", "rc-cards");

const CARDS = [
  {
    customType: "prsloy-memory.confirm",
    content: "Забыть «Сайты делать в тёмной теме»?",
    details: {
      confirmId: "c-1",
      action: "forget",
      scope: "user",
      id: "m-1",
      text: "Сайты делать в тёмной теме",
    },
  },
  {
    customType: "prsloy-memory.confirm",
    content:
      "Раньше: «Отвечать по-английски». Теперь: «Отвечать по-русски, коротко и без терминов»?",
    details: {
      confirmId: "c-2",
      action: "replace",
      scope: "user",
      id: "m-2",
      before: "Отвечать по-английски",
      after: "Отвечать по-русски, коротко и без терминов",
    },
  },
  {
    customType: "prsloy-memory.auto",
    content: "Заметил и запомнил",
    details: {
      items: [
        {
          id: "a-1",
          scope: "project",
          text: "Сайт кондитерской: цены в рублях, без английских слов в меню",
          quote: "цены пиши в рублях и никаких английских слов",
        },
      ],
    },
  },
  {
    customType: "prsloy-memory.auto",
    content: "Запомнил 2",
    details: {
      items: [
        { id: "a-2", scope: "user", text: "Отвечать без терминов", quote: "пиши проще" },
        { id: "a-3", scope: "project", text: "Сайт без сборщиков", quote: "не надо npm" },
      ],
    },
  },
  {
    customType: "prsloy-memory.updated",
    content: "Обновил",
    details: {
      opId: "op-1",
      id: "m-3",
      scope: "user",
      before: "Отвечать по-английски",
      after: "Отвечать по-русски",
    },
  },
  {
    customType: "prsloy-memory.updated",
    content: "Обновил",
    details: {
      opId: "op-2",
      id: "m-4",
      scope: "user",
      before: "Кнопки делать синими",
      after: "Кнопки делать зелёными, как в логотипе",
      pinned: true,
    },
  },
  {
    customType: "prsloy-harness.blocker",
    content: "Не получилось: исправить скидку",
    details: {
      what: "исправить скидку в корзине",
      why: "старый тест ждёт скидку 10 %, а вы просили 15 % для постоянных покупателей",
      need: "скажите, какую скидку оставить, и я доделаю",
      reason: "test_conflicts_request",
      options: ["Оставь 15 %, тест поправь", "Верни 10 %"],
    },
  },
  {
    customType: "prsloy-harness.search-limit",
    content: "Brave: 429 Too Many Requests",
    details: { provider: "brave", code: "limit" },
  },
];

/** Cut-off text and cards wider than the chat column, inside the cards only. */
async function problems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const cards = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid="memory-card"], [data-testid="blocker-card"], [data-testid="search-limit-card"]',
      ),
    ];
    for (const card of cards) {
      const name = card.dataset.testid + (card.dataset.memory ? `/${card.dataset.memory}` : "");
      const parent = card.parentElement?.getBoundingClientRect();
      const box = card.getBoundingClientRect();
      if (parent && box.right > parent.right + 1) out.push(`${name}: wider than the column`);
      if (card.scrollWidth > card.clientWidth + 1) out.push(`${name}: horizontal overflow`);
      for (const el of card.querySelectorAll<HTMLElement>("*")) {
        if (el.children.length > 0 || !el.textContent?.trim()) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > box.right + 1)
          out.push(`${name}: «${el.textContent.trim().slice(0, 40)}» sticks out`);
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== "visible")
          out.push(`${name}: «${el.textContent.trim().slice(0, 40)}» cut off`);
      }
      for (const button of card.querySelectorAll<HTMLElement>("button")) {
        const r = button.getBoundingClientRect();
        if (r.height < 24 || r.width < 24)
          out.push(`${name}: button «${button.textContent}» < 24px`);
      }
    }
    return out;
  });
}

for (const mode of ["light", "dark"] as const) {
  test(`RC: the new cards at 100 % and 125 % (${mode})`, async () => {
    test.setTimeout(240_000);
    mkdirSync(OUT, { recursive: true });
    const launched = await launchRu({
      tools: "read,emit_cards",
      toolCall: { name: "emit_cards", arguments: { cards: CARDS } },
    });
    const dir = join(launched.agentDir, "extensions");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(here, "rc-cards-ext.mjs"), join(dir, "rc-cards-ext.ts"));
    const found: string[] = [];
    try {
      const { page } = launched;
      // The owner's own setting, as «Внешний вид» saves it.
      await page.evaluate((value) => localStorage.setItem("zeno.colorMode", value), mode);
      await page.reload();
      await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]');
      await page.setViewportSize({ width: 1366, height: 768 });
      await startHostWithCard(page);
      await sendPrompt(page, "Use the tool please");
      await waitSettled(page);
      await expect(page.getByTestId("memory-card")).toHaveCount(6);
      await expect(page.getByTestId("blocker-card")).toBeVisible();
      await expect(page.getByTestId("search-limit-card")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(mode);
      await page.getByTestId("memory-auto-show").click();
      await page.evaluate(() => document.fonts.ready);

      for (const zoom of [1, 1.25]) {
        // Windows 125 %: everything 1.25× larger in the same window (fewer CSS pixels across).
        await page.evaluate((factor) => {
          document.documentElement.style.zoom = String(factor);
        }, zoom);
        await page.waitForTimeout(400);
        const tag = `${Math.round(zoom * 100)}-${mode}`;
        for (const p of await problems(page)) found.push(`${tag} ${p}`);
        const cards = page.locator(
          '[data-testid="memory-card"], [data-testid="blocker-card"], [data-testid="search-limit-card"]',
        );
        const count = await cards.count();
        for (let i = 0; i < count; i += 1) {
          await cards.nth(i).evaluate((el) => el.scrollIntoView({ block: "center" }));
          await page.waitForTimeout(150);
          const box = await cards.nth(i).boundingBox();
          if (!box) continue;
          await page.screenshot({
            path: join(OUT, `${tag}-card-${i + 1}.png`),
            clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 },
          });
        }
        await page.screenshot({ path: join(OUT, `${tag}-chat.png`) });
      }
    } finally {
      await closeLaunched(launched);
    }
    expect(found).toEqual([]);
  });
}
