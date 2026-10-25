import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryStore } from "@prsloy/harness";
import { expect, sendPrompt, startHost, test, waitSettled } from "./fixtures.ts";
import { closeLaunched, launchRu, shot } from "./features-helpers.ts";

/**
 * #14, research/27 §2 on core's real memory tool and `prsloy:memory-*` (PRSLOY_MEMORY=1): the agent's tool
 * only proposes «забыть»; the card «Забыть «…»?» · [Да] forgets it on disk. And chat ⋯ → «Забыть всё, что
 * выучено из этого чата» forgets what this chat taught (by the Pi session id), lists it, [Вернуть] brings
 * it back.
 */
const ID = "u-e2e1";

test("«Забыть «…»?» · [Да]: the agent asked, the owner decided, the entry is gone on disk", async () => {
  const launched = await launchRu({
    tools: "read,memory",
    toolCall: { name: "memory", arguments: { action: "forget", id: ID } },
    env: { PRSLOY_MEMORY: "1" },
  });
  const dir = join(launched.agentDir, "prsloy-memory");
  const onDisk = async () => JSON.parse(await readFile(join(dir, "user.json"), "utf8"));
  try {
    const { page } = launched;
    const seeded = new MemoryStore(dir).add("user", launched.workspace, {
      text: "Сайты делать в тёмной теме",
      quote: "делай сайты в тёмной теме",
    });
    expect(seeded.ok).toBe(true);
    // Store ids are random; the fake model's tool call is fixed at launch, so give the entry a known id.
    const file = await onDisk();
    file.entries[0].id = ID;
    await writeFile(join(dir, "user.json"), `${JSON.stringify(file, null, 2)}\n`);
    await startHost(page);
    await sendPrompt(page, "Use the tool: забудь про тёмную тему");
    await waitSettled(page);
    const card = page.getByTestId("memory-card");
    await expect(card).toContainText("Забыть «Сайты делать в тёмной теме»?");
    // Only a proposal so far: the entry is still remembered.
    expect((await onDisk()).entries.map((e: { id: string }) => e.id)).toContain(ID);
    await shot(page, "memory-6-confirm");
    await card.getByTestId("memory-confirm-yes").click();
    await expect(card).toContainText("Забыл.");
    await expect.poll(async () => (await onDisk()).entries.length).toBe(0);
    await shot(page, "memory-7-confirmed");
  } finally {
    await closeLaunched(launched);
  }
});

test("chat ⋯ → «Забыть всё, что выучено из этого чата» → «Вернуть»", async () => {
  const launched = await launchRu({
    tools: "read,memory",
    toolCall: {
      name: "memory",
      arguments: {
        action: "remember",
        scope: "user",
        text: "Отвечать коротко",
        quote: "отвечай коротко",
      },
    },
    env: { PRSLOY_MEMORY: "1" },
  });
  const userFile = join(launched.agentDir, "prsloy-memory", "user.json");
  const texts = async () =>
    JSON.parse(await readFile(userFile, "utf8")).entries.map((e: { text: string }) => e.text);
  try {
    const { page } = launched;
    await startHost(page);
    await sendPrompt(page, "Use the tool: отвечай коротко");
    await waitSettled(page);
    await expect(page.getByTestId("memory-card")).toContainText("Запомнил «Отвечать коротко");
    expect(await texts()).toEqual(["Отвечать коротко"]);

    await page.getByTestId("thread-header-menu").click();
    await page.getByTestId("thread-header-forget-memory").click();
    const ask = page.getByTestId("forget-chat-memory-confirm");
    await expect(ask).toContainText("их можно будет вернуть");
    await shot(page, "memory-8-forget-chat");
    await ask.getByRole("button", { name: "Забыть" }).click();
    const result = page.getByTestId("forget-chat-memory-result");
    await expect(result).toContainText("Забыл записей: 1");
    await expect(result).toContainText("«Отвечать коротко»");
    await expect.poll(texts).toEqual([]);
    await shot(page, "memory-9-forgot-chat");
    await result.getByRole("button", { name: "Вернуть" }).click();
    await expect.poll(texts).toEqual(["Отвечать коротко"]);
  } finally {
    await closeLaunched(launched);
  }
});
