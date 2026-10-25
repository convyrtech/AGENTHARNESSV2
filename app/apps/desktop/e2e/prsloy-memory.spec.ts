import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, sendPrompt, startHost, test } from "./fixtures.ts";

/**
 * PRSLOY S5: «Забыть» from the memory panel while a chat is open. The entry leaves the
 * harness's memory files, the open session gets a hidden note (the model reads it on the
 * next turn, the timeline doesn't show it).
 */
test("memory: forget mid-session → hidden note for the model, nothing in the chat", async ({
  page,
  zeno,
}) => {
  const dir = join(zeno.agentDir, "prsloy-memory");
  await mkdir(dir, { recursive: true });
  const text = "Пиши без англицизмов";
  await writeFile(
    join(dir, "user.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { id: "u-e2e1", text, quote: text, origin: "user", created: "2026-10-25T10:00:00Z" },
      ],
      tombstones: [],
    }),
  );
  await startHost(page);
  await sendPrompt(page, "Привет.");
  const listed = await page.evaluate(() => window.zeno.memory!.list());
  expect(listed.user.map((e) => e.id)).toEqual(["u-e2e1"]);

  const forgot = await page.evaluate(() => window.zeno.memory!.forget("u-e2e1"));
  expect(forgot.user).toEqual([]);
  expect(forgot.forgotten.map((e) => e.id)).toEqual(["u-e2e1"]);

  const note = `Пользователь попросил забыть: «${text}». Больше не учитывай.`;
  await sendPrompt(page, "Что дальше?");
  const last = zeno.fakeModel.requests.at(-1);
  expect(JSON.stringify(last?.messages ?? [])).toContain(note);
  await expect(page.getByTestId("timeline")).not.toContainText("Пользователь попросил забыть");

  // Stored in the session as a custom message the UI must not display.
  const sessions = join(zeno.agentDir, "sessions");
  const files: string[] = [];
  for (const entry of await readdir(sessions, { recursive: true })) {
    if (String(entry).endsWith(".jsonl")) files.push(join(sessions, String(entry)));
  }
  const all = (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
  const line = all.split("\n").find((l) => l.includes("prsloy-memory.forgot"));
  expect(line).toBeDefined();
  expect(JSON.parse(line!)).toMatchObject({ customType: "prsloy-memory.forgot", display: false });
});
