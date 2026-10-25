import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * «Память» (research/18 §6.7, S5 UI): the harness's real `memory` tool (memory on via
 * PRSLOY_MEMORY=1) shows «Запомнил: …» in the chat; «Изменить» asks in the composer.
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
        text: "Отвечать коротко, без терминов",
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
    await expect(card).toContainText("Запомнил: Отвечать коротко, без терминов");
    await expect(card).toHaveAttribute("data-memory", "saved");
    const saved = JSON.parse(await readFile(join(agentDir, "prsloy-memory", "user.json"), "utf8"));
    expect(saved.entries[0].text).toBe("Отвечать коротко, без терминов");
    await shot(page, "memory-1-card");

    await card.getByTestId("memory-card-edit").click();
    await expect(page.getByTestId("prompt-input")).toHaveValue(
      "Поправь запись в памяти «Отвечать коротко, без терминов»: ",
    );

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-nav-memory").click();
    await expect(page.getByTestId("settings-memory")).toContainText("Запоминать, когда я прошу");
    await expect(page.getByTestId("memory-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("memory-user")).toContainText("Отвечать коротко, без терминов");
    const toggle = page.getByTestId("settings-memory-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await shot(page, "memory-2-settings-before");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const flags = JSON.parse(await readFile(join(agentDir, "prsloy-harness.json"), "utf8"));
    expect(flags.memory).toBe(true);
    await shot(page, "memory-3-settings-after");

    // «Забыть» → gone from «Обо мне», offered in «Забытое», tombstone on disk.
    await page.getByTestId("memory-user-forget").first().click();
    await expect(page.getByTestId("memory-forgotten")).toContainText(
      "Отвечать коротко, без терминов",
    );
    await expect(page.getByTestId("memory-user")).not.toContainText("Отвечать коротко");
    const after = JSON.parse(await readFile(join(agentDir, "prsloy-memory", "user.json"), "utf8"));
    expect(after.entries).toEqual([]);
    expect(after.tombstones).toHaveLength(1);
  } finally {
    await closeLaunched(launched);
  }
});
