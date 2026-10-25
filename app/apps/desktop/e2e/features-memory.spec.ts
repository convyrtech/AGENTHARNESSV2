import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «Память» (research/18 §6.7, S5 UI): the harness's real `memory` tool (memory on via
 * PRSLOY_MEMORY=1) shows «Запомнил «…»» in the chat; «Изменить» asks in the composer.
 * Settings → «Память» writes the harness flag and lists the memory through core's
 * `prsloy:memory-*` (window.zeno.memory): «Забыть» moves the entry to «Забытое».
 */
const QUOTE = "отвечай коротко, без умных слов";

test("a memory card in the chat and the «Память» settings", async () => {
  const launched = await launchRu({
    tools: "read,memory",
    toolCall: {
      name: "memory",
      arguments: {
        action: "remember",
        scope: "user",
        text: "Отвечать коротко, без умных слов",
        quote: QUOTE,
      },
    },
    env: { PRSLOY_MEMORY: "1" },
  });
  try {
    const { page, agentDir } = launched;
    await startHost(page);
    await sendPrompt(page, `Use the tool: ${QUOTE}`);
    await waitSettled(page);
    const card = page.getByTestId("memory-card");
    await expect(card).toContainText("Запомнил «Отвечать коротко, без умных слов»");
    await expect(card).toHaveAttribute("data-memory", "saved");
    const saved = JSON.parse(await readFile(join(agentDir, "prsloy-memory", "user.json"), "utf8"));
    expect(saved.entries[0].text).toBe("Отвечать коротко, без умных слов");
    await shot(page, "memory-1-card");

    await card.getByTestId("memory-card-edit").click();
    await expect(page.getByTestId("prompt-input")).toHaveValue(
      "Поправь запись в памяти «Отвечать коротко, без умных слов»: ",
    );

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-memory").click();
    await expect(page.getByTestId("settings-memory")).toContainText("Запоминать, когда я прошу");
    await expect(page.getByTestId("memory-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("memory-user")).toContainText("Отвечать коротко, без умных слов");
    // Memory is on by default (MVP, 25.10): the switch shows what main reads.
    const toggle = page.getByTestId("settings-memory-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await shot(page, "memory-2-settings-before");

    // «Забыть» → gone from «Обо мне», offered in «Забытое», tombstone on disk.
    await page.getByTestId("memory-user-forget").first().click();
    await expect(page.getByTestId("memory-forgotten")).toContainText(
      "Отвечать коротко, без умных слов",
    );
    await expect(page.getByTestId("memory-user")).not.toContainText("Отвечать коротко");
    const after = JSON.parse(await readFile(join(agentDir, "prsloy-memory", "user.json"), "utf8"));
    expect(after.entries).toEqual([]);
    expect(after.tombstones).toHaveLength(1);

    // Nothing remembered now: the switch turns memory off at once and writes false.
    await toggle.click();
    await expect(page.getByTestId("memory-off-confirm")).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("settings-memory-auto-toggle")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    const flags = JSON.parse(await readFile(join(agentDir, "prsloy-harness.json"), "utf8"));
    expect(flags.memory).toBe(false);
    await shot(page, "memory-3-settings-after");
  } finally {
    await closeLaunched(launched);
  }
});

test("«Забыть» and «Вернуть» from the card and the panel, «Забыть всё», on real files", async () => {
  const launched = await launchRu({
    tools: "read,memory",
    toolCall: {
      name: "memory",
      arguments: {
        action: "remember",
        scope: "user",
        text: "Звать меня Аня",
        quote: "зови меня Аня, пожалуйста",
      },
    },
    env: { PRSLOY_MEMORY: "1" },
  });
  const userFile = join(launched.agentDir, "prsloy-memory", "user.json");
  const onDisk = async () => JSON.parse(await readFile(userFile, "utf8"));
  try {
    const { page } = launched;
    await startHost(page);
    await sendPrompt(page, "Use the tool: зови меня Аня, пожалуйста");
    await waitSettled(page);
    const card = page.getByTestId("memory-card");
    await expect(card).toContainText("Запомнил «Звать меня Аня");

    // The card: «Забыть» → «Забыл.» [Вернуть] → «Вернул.», each on disk.
    await card.getByTestId("memory-card-forget").click();
    await expect(card).toContainText("Забыл.");
    await expect.poll(async () => (await onDisk()).entries.length).toBe(0);
    await shot(page, "memory-4-card-forgot");
    await card.getByTestId("memory-card-restore").click();
    await expect(card).toContainText("Вернул.");
    await expect
      .poll(async () => (await onDisk()).entries.map((e: { text: string }) => e.text))
      .toEqual(["Звать меня Аня"]);
    expect((await onDisk()).tombstones).toEqual([]);

    // The panel: «Забыть» → «Недавно забыто» → «Вернуть».
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-memory").click();
    await expect(page.getByTestId("memory-user")).toContainText("Звать меня Аня");
    await page.getByTestId("memory-user-forget").click();
    await expect(page.getByTestId("memory-forgotten")).toContainText("Звать меня Аня");
    await page.getByTestId("memory-forgotten-restore").click();
    await expect(page.getByTestId("memory-user")).toContainText("Звать меня Аня");
    await expect.poll(async () => (await onDisk()).entries.length).toBe(1);

    // «Забыть всё» only after the confirm; then nothing is left.
    await page.getByTestId("memory-forget-all").click();
    const confirm = page.getByTestId("memory-forget-all-confirm");
    await expect(confirm).toContainText("Отменить нельзя");
    await shot(page, "memory-5-forget-all");
    await confirm.getByRole("button", { name: "Забыть всё" }).click();
    await expect(page.getByTestId("memory-user")).toContainText("Пока пусто.");
    await expect.poll(async () => (await onDisk()).entries.length).toBe(0);
  } finally {
    await closeLaunched(launched);
  }
});
