import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, launchZenoApp, sendPrompt, startHost, test } from "./fixtures.ts";

/**
 * Memory M-sp: after the user leaves a chat (a new chat here), main makes one model call
 * outside any turn. Its price goes to prsloy-memory/extractor.jsonl, and the chat the user
 * left gets nothing written into it.
 */
test("extractor probe: a call outside the turn after leaving a chat, its own journal", async () => {
  const launched = await launchZenoApp({
    env: {
      PRSLOY_MEMORY_EXTRACTOR: "probe",
      PRSLOY_MEMORY_EXTRACTOR_PROVIDER: "zeno-fake",
      PRSLOY_MEMORY_EXTRACTOR_MODEL: "zeno-fake",
    },
  });
  try {
    const { page, agentDir, fakeModel } = launched;
    await startHost(page);
    await sendPrompt(page, "Привет.");
    const sessions = join(agentDir, "sessions");
    const files = async () => {
      const out: string[] = [];
      for (const entry of await readdir(sessions, { recursive: true })) {
        if (String(entry).endsWith(".jsonl")) out.push(join(sessions, String(entry)));
      }
      return out;
    };
    const [left] = await files();
    expect(left).toBeTruthy();
    const before = await readFile(left!, "utf8");
    const requestsBefore = fakeModel.requests.length;

    await page.evaluate(() => window.zeno.session.create());
    const journal = join(agentDir, "prsloy-memory", "extractor.jsonl");
    await expect.poll(() => existsSync(journal), { timeout: 30_000 }).toBe(true);
    const line = JSON.parse((await readFile(journal, "utf8")).trim().split("\n")[0]!);
    expect(line).toMatchObject({ kind: "probe", model: "zeno-fake", ok: true, status: 200 });
    expect(line.input).toBeGreaterThan(0);
    expect(line.costRub).toBeNull(); // the fake model has no price
    expect(fakeModel.requests.length).toBe(requestsBefore + 1);
    // The chat that was left is untouched by the extractor.
    expect(await readFile(left!, "utf8")).toBe(before);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
  }
});

/**
 * Memory M-3 in the shadow: the user's own words with a signal reach the model outside the
 * turn; the result is journaled, nothing is written into the memory or the chat.
 */
test("extractor shadow: a signal goes to the model after leaving a chat, memory untouched", async () => {
  const launched = await launchZenoApp({
    env: {
      PRSLOY_MEMORY_EXTRACTOR: "shadow",
      PRSLOY_MEMORY_EXTRACTOR_PROVIDER: "zeno-fake",
      PRSLOY_MEMORY_EXTRACTOR_MODEL: "zeno-fake",
    },
  });
  try {
    const { page, agentDir, fakeModel } = launched;
    await startHost(page);
    await sendPrompt(page, "Запомни: я не программист, объясняй проще.");
    const requestsBefore = fakeModel.requests.length;
    await page.evaluate(() => window.zeno.session.create());
    const journal = join(agentDir, "prsloy-memory", "extractor.jsonl");
    await expect.poll(() => existsSync(journal), { timeout: 30_000 }).toBe(true);
    const line = JSON.parse((await readFile(journal, "utf8")).trim().split("\n")[0]!);
    // The fake model answers with prose, not JSON: the pipe and the checks, no candidates.
    expect(line).toMatchObject({ kind: "extract", ok: true, signals: 1, json: false });
    expect(fakeModel.requests.length).toBe(requestsBefore + 1);
    expect(JSON.stringify(fakeModel.requests.at(-1)?.messages ?? [])).toContain("я не программист");
    expect(existsSync(join(agentDir, "prsloy-memory", "user.json"))).toBe(false);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
  }
});

/**
 * Memory M-3b (#14), the first hour with defaults: the extractor writes after «Новый чат», and its
 * «Заметил и запомнил» card reaches the chat the person is in now. «Забыть» and «Вернуть» on the card
 * change the memory on disk.
 */
test("extractor write: the «Заметил и запомнил» card shows in the chat the person moved to", async () => {
  const launched = await launchZenoApp({
    env: {
      PRSLOY_MEMORY_EXTRACTOR: "write",
      PRSLOY_MEMORY_EXTRACTOR_PROVIDER: "zeno-fake",
      PRSLOY_MEMORY_EXTRACTOR_MODEL: "zeno-fake",
    },
    // The extractor's request (its messages come wrapped in <message>): a model's JSON answer.
    reply: (text) =>
      text.includes('<message id="')
        ? JSON.stringify({
            ops: [
              {
                op: "add",
                scope: "user",
                kind: "preference",
                text: "Делать сайты без анимаций",
                quote: "без анимаций",
              },
            ],
          })
        : undefined,
  });
  try {
    const { page, agentDir } = launched;
    await startHost(page);
    await sendPrompt(
      page,
      "Сделай сайт-визитку, только без анимаций — терпеть не могу, когда всё прыгает.",
    );
    await page.evaluate(() => window.zeno.session.create());
    const userFile = join(agentDir, "prsloy-memory", "user.json");
    const texts = async () =>
      existsSync(userFile)
        ? (
            JSON.parse(await readFile(userFile, "utf8")) as { entries: { text: string }[] }
          ).entries.map((e) => e.text)
        : [];
    await expect.poll(texts, { timeout: 30_000 }).toEqual(["Делать сайты без анимаций"]);
    const card = page.getByTestId("memory-card").filter({ hasText: "Делать сайты без анимаций" });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByTestId("memory-auto-forget").click();
    await expect.poll(texts).toEqual([]);
    await card.getByTestId("memory-auto-restore").click();
    await expect.poll(texts).toEqual(["Делать сайты без анимаций"]);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
  }
});
