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
    expect(line.costUsd).toBeNull(); // the fake model has no price
    expect(fakeModel.requests.length).toBe(requestsBefore + 1);
    // The chat that was left is untouched by the extractor.
    expect(await readFile(left!, "utf8")).toBe(before);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
  }
});
