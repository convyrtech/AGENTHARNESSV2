import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, sendPrompt, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, startHostWithCard } from "./features-helpers.ts";
import { axeSerious, focusedId, focusHidden, tabTo, walkTab } from "./a11y-walk.ts";
import { GOOD_KEY, launchFirstRun } from "./first-run-app.ts";

/**
 * The key screens by keyboard alone (research/28 §4 item 3): every action is reached by Tab in a
 * sensible order, focus shows, nothing traps it, Esc closes dialogs, and axe finds no serious or
 * critical issue. First run (key → import → folder), the chat's cards with buttons (memory confirm,
 * «Вернуть», «Не получилось»), Settings → «Память» and «Поиск в интернете», a dialog, «Дизайн».
 */
const here = dirname(fileURLToPath(import.meta.url));

async function screenIsClean(page: Parameters<typeof axeSerious>[0], name: string) {
  expect(await axeSerious(page), `${name}: axe serious/critical`).toEqual([]);
  expect(await focusHidden(page), `${name}: focus not shown`).toEqual([]);
}

test("first run by keyboard: key → import → folder", async () => {
  test.setTimeout(240_000);
  const launched = await launchFirstRun(true);
  try {
    const { page } = launched;
    await expect(page.getByTestId("prsloy-first-run-key")).toBeVisible({ timeout: 60_000 });
    // the key field has focus from the start; Tab goes on to the help links and comes back round
    await expect(page.getByPlaceholder("sk-…")).toBeFocused();
    const ring = (await walkTab(page, 3)).map((s) => s.id);
    expect(ring).toEqual(["prsloy-key-link", "prsloy-server-link", ring[2]]);
    await expect(page.getByPlaceholder("sk-…")).toBeFocused();
    await screenIsClean(page, "key");
    await page.keyboard.type(GOOD_KEY);
    await page.keyboard.press("Enter");

    // the next step takes the focus to its main action, not to the page
    await expect(page.getByTestId("prsloy-first-run-import")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("prsloy-import-submit")).toBeFocused({ timeout: 10_000 });
    const back = (await walkTab(page, 2, true)).map((s) => s.id);
    expect(back.every((id) => id.startsWith("input:"))).toBe(true); // the tool checkboxes
    await screenIsClean(page, "import");
    await tabTo(page, "prsloy-import-later", 10);
    await page.keyboard.press("Enter");

    await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("prsloy-folder-pick")).toBeFocused({ timeout: 10_000 });
    await screenIsClean(page, "folder");
  } finally {
    await launched.close();
  }
});

test("chat cards, Settings «Память» and «Поиск», a dialog and «Дизайн» by keyboard", async () => {
  test.setTimeout(240_000);
  const cards = [
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
      customType: "prsloy-harness.blocker",
      content: "Не получилось: исправить скидку",
      details: {
        what: "исправить скидку",
        why: "старый тест ждёт 10 %",
        need: "скажите, какую скидку оставить",
        reason: "test_conflicts_request",
        options: ["Оставь 15 %", "Верни 10 %"],
      },
    },
  ];
  const launched = await launchRu({
    tools: "read,emit_cards",
    toolCall: { name: "emit_cards", arguments: { cards } },
  });
  mkdirSync(join(launched.agentDir, "extensions"), { recursive: true });
  copyFileSync(
    join(here, "rc-cards-ext.mjs"),
    join(launched.agentDir, "extensions", "rc-cards-ext.ts"),
  );
  try {
    const { page } = launched;
    // a dialog from the empty chat: a recipe opens with Enter and Esc closes it, focus back on it
    await tabTo(page, "recipe-landing");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("recipe-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("recipe-dialog")).toBeHidden();
    expect(await focusedId(page)).toBe("recipe-landing");

    await startHostWithCard(page);
    await sendPrompt(page, "Use the tool please");
    await waitSettled(page);
    await expect(page.getByTestId("blocker-card")).toBeVisible();

    // from the composer back up: the cards' buttons, newest card first, each reachable
    await page.getByTestId("prompt-input").focus();
    const up = (await walkTab(page, 14, true)).map((s) => s.id);
    for (const id of [
      "blocker-reply",
      "blocker-option",
      "memory-updated-revert",
      "memory-confirm-no",
      "memory-confirm-yes",
    ]) {
      expect(up, `Shift+Tab reaches ${id}`).toContain(id);
    }
    expect(up.indexOf("memory-confirm-yes")).toBeGreaterThan(up.indexOf("blocker-reply"));
    await screenIsClean(page, "chat");
    // a ready answer goes out from the keyboard
    await page.getByTestId("blocker-option").first().focus();
    const before = launched.fakeModel.requests.length;
    await page.keyboard.press("Enter");
    await waitSettled(page);
    expect(JSON.stringify(launched.fakeModel.requests.slice(before))).toContain("Оставь 15 %");

    // Settings → «Память»: a section from the list, its switches
    await page.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await tabTo(page, "settings-nav-memory");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("settings-memory")).toBeVisible();
    await tabTo(page, "settings-memory-toggle", 30);
    await tabTo(page, "settings-memory-auto-toggle", 5);
    await screenIsClean(page, "settings-memory");

    // «Поиск в интернете»: the switch flips with Space and back
    await page.getByTestId("settings-nav-web-search").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("settings-web-search")).toBeVisible();
    const toggle = page.getByTestId("web-search-toggle");
    await tabTo(page, "web-search-toggle", 30);
    const state = await toggle.getAttribute("aria-checked");
    await page.keyboard.press("Space");
    await expect(toggle).not.toHaveAttribute("aria-checked", state ?? "");
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", state ?? "");
    await tabTo(page, "web-search-models-edit", 30);
    await screenIsClean(page, "settings-search");

    // «Дизайн»: back to the app, the tab from the sidebar
    await page.getByTestId("settings-back").focus();
    await page.keyboard.press("Enter");
    await tabTo(page, "nav-design");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("design-page")).toBeVisible();
    await screenIsClean(page, "design");
    // no trap: Tab keeps moving through the window and comes round to «Дизайн» again
    await tabTo(page, "nav-design", 60);
  } finally {
    await closeLaunched(launched);
  }
});
