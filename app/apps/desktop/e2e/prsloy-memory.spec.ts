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

/**
 * M-1 (research/24 §3.6) through the real preload: «Закрепить», «Вернуть» a forgotten entry
 * by its opId from «Было», and turning memory off in the settings erases it from disk.
 */
test("memory M-1: pin, revert by opId, turning memory off erases the files", async ({
  page,
  zeno,
}) => {
  const dir = join(zeno.agentDir, "prsloy-memory");
  await mkdir(dir, { recursive: true });
  const entry = (id: string, text: string) => ({
    id,
    text,
    quote: text,
    origin: "user",
    created: "2026-10-25T10:00:00Z",
  });
  await writeFile(
    join(dir, "user.json"),
    JSON.stringify({
      version: 1,
      entries: [entry("u-e2e1", "Пиши без англицизмов"), entry("u-e2e2", "Зовут Аня")],
      tombstones: [],
    }),
  );
  await page.evaluate(() => window.zeno.harnessFlags.set({ memory: true }));

  const pinned = await page.evaluate(() => window.zeno.memory!.pin("u-e2e2", true));
  expect(pinned.user.find((e) => e.id === "u-e2e2")).toMatchObject({ pinned: true });

  const forgot = await page.evaluate(() => window.zeno.memory!.forget("u-e2e1"));
  const item = forgot.history?.find((h) => h.kind === "forgotten");
  expect(item).toMatchObject({ scope: "user", text: "Пиши без англицизмов" });
  const back = await page.evaluate((opId) => window.zeno.memory!.revert(opId), item!.opId);
  // Back in its place, byte for byte.
  expect(back.user.map((e) => e.id)).toEqual(["u-e2e1", "u-e2e2"]);
  expect(back.history).toEqual([]);

  await page.evaluate(() => window.zeno.harnessFlags.set({ memory: false }));
  const off = await page.evaluate(() => window.zeno.memory!.list());
  expect(off.user).toEqual([]);
  const disk = [
    await readFile(join(dir, "user.json"), "utf8"),
    await readFile(join(dir, "journal.jsonl"), "utf8"),
  ].join("\n");
  expect(disk).not.toMatch(/англицизм|Аня/u);
});

/**
 * #14 (research/27 §2) through the real preload: a change the agent's tool proposed waits for
 * the user's answer, and «forget this chat» drops what was learned only there.
 */
test("memory #14: confirm a proposed change, forget what one chat taught", async ({
  page,
  zeno,
}) => {
  const dir = join(zeno.agentDir, "prsloy-memory");
  await mkdir(dir, { recursive: true });
  const entry = (id: string, text: string, session: string) => ({
    id,
    text,
    quote: text,
    origin: "auto",
    evidence: [{ quote: text, session, at: "2026-10-25T10:00:00Z" }],
    created: "2026-10-25T10:00:00Z",
  });
  await writeFile(
    join(dir, "user.json"),
    JSON.stringify({
      version: 2,
      rules: "m0",
      entries: [
        entry("u-e2e1", "Любит тёмные сайты", "chat-a"),
        entry("u-e2e2", "Зовут Аня", "chat-b"),
      ],
      tombstones: [],
    }),
  );
  await writeFile(
    join(dir, "pending.json"),
    JSON.stringify({
      items: [
        {
          id: "cf-0123456789ab",
          at: new Date().toISOString(),
          action: "forget",
          scope: "user",
          target: "u-e2e2",
          text: "Зовут Аня",
        },
      ],
    }),
  );
  const listed = await page.evaluate(() => window.zeno.memory!.list());
  expect(listed.user.map((e) => e.sessions)).toEqual([["chat-a"], ["chat-b"]]);

  const confirmed = await page.evaluate(() =>
    window.zeno.memory!.confirm!("cf-0123456789ab", true),
  );
  expect(confirmed.user.map((e) => e.id)).toEqual(["u-e2e1"]);

  const forgotten = await page.evaluate(() => window.zeno.memory!.forgetSource!("chat-a"));
  expect(forgotten.user).toEqual([]);
  expect(forgotten.history?.map((h) => [h.kind, h.text])).toEqual(
    expect.arrayContaining([["forgotten", "Любит тёмные сайты"]]),
  );
});
