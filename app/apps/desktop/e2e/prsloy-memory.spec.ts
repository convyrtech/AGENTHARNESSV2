import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@prsloy/harness";
import { expect, launchZenoApp, sendPrompt, startHost, test } from "./fixtures.ts";
import { closeLaunched } from "./features-helpers.ts";

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
 * #73 end-to-end through the real app: switching projects A → B → A. A project entry never
 * crosses into another project — neither in the «Память» panel nor in the memory section
 * the model of the next chat actually receives — while user entries follow everywhere, and
 * coming back to A shows A's memory again.
 */
test("memory #73: project A → B → A — project entries stay home, user entries follow", async () => {
  // The usual zeno-e2e-* root is deliberately classified as a non-project by the app.
  const root = await mkdtemp(join(tmpdir(), "prsloy-memory-e2e-"));
  const zeno = await launchZenoApp({ root });
  const { page } = zeno;
  try {
    const dir = join(zeno.agentDir, "prsloy-memory");
    const projectA = join(zeno.root, "memory-proj-alpha");
    const projectB = join(zeno.root, "memory-proj-beta");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    await writeFile(join(projectA, "README.md"), "alpha\n");
    await writeFile(join(projectB, "README.md"), "beta\n");

    const store = new MemoryStore(dir);
    const textUser = "Зовут меня Аня";
    const textA = "Проект «Альфа» — игра про кота";
    const textB = "Проект «Бета» — магазин чая";
    for (const seeded of [
      store.add("user", zeno.workspace, { text: textUser, quote: "зовут меня аня" }),
      store.add("project", projectA, { text: textA, quote: "игра про кота" }),
      store.add("project", projectB, { text: textB, quote: "магазин чая" }),
    ]) {
      expect(seeded.ok).toBe(true);
    }

    await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 60_000,
    });

    const openProject = async (path: string): Promise<void> => {
      // Stub only the native folder picker; let the renderer update its project/session state.
      await zeno.app.evaluate(({ dialog }, folder) => {
        Object.defineProperty(dialog, "showOpenDialog", {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [folder] }),
        });
      }, path);
      await page.getByTestId("projects-section-toggle").hover();
      await page.getByTestId("workspace-open").click();
      const want = path.replace(/\\/g, "/").toLowerCase();
      await expect
        .poll(
          async () => {
            // Opening a different project briefly detaches the foreground host.
            const snap = await page.evaluate(() => window.zeno.host.snapshot()).catch(() => null);
            return (snap?.cwd ?? "").replace(/\\/g, "/").toLowerCase();
          },
          { timeout: 30_000 },
        )
        .toBe(want);
      await expect(page.getByTestId("runtime-snapshot").first()).toContainText(
        JSON.stringify(path),
      );
      // Returning to A can promote its parked chat: explicitly open a fresh chat so
      // a previous request/history cannot satisfy the memory injection assertions.
      const previous = await page.evaluate(() => window.zeno.host.snapshot());
      await page.getByTestId("start-host").click();
      await expect
        .poll(async () => (await page.evaluate(() => window.zeno.host.snapshot())).sessionId)
        .not.toBe(previous.sessionId);
      await expect(page.getByTestId("runtime-snapshot").first()).toContainText(
        JSON.stringify(path),
      );
      await expect(page.getByTestId("empty-hero")).toContainText(path.split(/[\\/]/).at(-1)!);
    };

    // The real preload snapshot for the current project.
    const panel = async () => {
      const listed = await page.evaluate(() => window.zeno.memory!.list());
      return { user: listed.user.map((e) => e.text), project: listed.project.map((e) => e.text) };
    };
    // What the model of the new chat actually got (the memory section is in the request).
    const modelSaw = async (prompt: string) => {
      const before = zeno.fakeModel.requests.length;
      await sendPrompt(page, prompt);
      await expect.poll(() => zeno.fakeModel.requests.length).toBeGreaterThan(before);
      const request = JSON.stringify(zeno.fakeModel.requests[before]?.messages ?? []);
      expect(request).toContain(prompt);
      return request;
    };

    const checkVisibleMemory = async (own: string, other: string) => {
      await page.getByTestId("nav-settings").click();
      await page.getByTestId("settings-nav-memory").click();
      await expect(page.getByTestId("memory-user")).toContainText(textUser);
      await expect(page.getByTestId("memory-project")).toContainText(own);
      await expect(page.getByTestId("memory-project")).not.toContainText(other);
      await expect(page.getByTestId("memory-user")).not.toContainText(own);
      await expect(page.getByTestId("memory-user")).not.toContainText(other);
      await page.getByTestId("settings-back").click();
    };

    await openProject(projectA);
    expect(await panel()).toEqual({ user: [textUser], project: [textA] });
    let saw = await modelSaw("Привет из проекта Альфа.");
    expect(saw).toContain(textUser);
    expect(saw).toContain(textA);
    expect(saw).not.toContain(textB);
    await checkVisibleMemory(textA, textB);

    await openProject(projectB);
    expect(await panel()).toEqual({ user: [textUser], project: [textB] });
    saw = await modelSaw("Привет из проекта Бета.");
    expect(saw).toContain(textUser);
    expect(saw).toContain(textB);
    expect(saw).not.toContain(textA);
    await checkVisibleMemory(textB, textA);

    await openProject(projectA);
    expect(await panel()).toEqual({ user: [textUser], project: [textA] });
    saw = await modelSaw("Снова в проекте Альфа.");
    expect(saw).toContain(textUser);
    expect(saw).toContain(textA);
    expect(saw).not.toContain(textB);
    await checkVisibleMemory(textA, textB);

    // On disk nothing crossed either: the user file has no project entries.
    const userFile = JSON.parse(await readFile(join(dir, "user.json"), "utf8")) as {
      entries: { text: string }[];
    };
    expect(userFile.entries.map((e) => e.text)).toEqual([textUser]);
  } finally {
    await closeLaunched(zeno);
  }
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
