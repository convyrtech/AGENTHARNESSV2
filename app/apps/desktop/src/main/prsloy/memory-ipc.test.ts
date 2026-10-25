/**
 * «Память» panel backend over IPC (S5): list / forget / restore / forget-all on the
 * harness's MemoryStore files, a hidden note for the open session after «Забыть», the
 * project key shared with the turn snapshots, and the main-frame sender check.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { MemorySnapshot } from "@zeno/contracts";
import { bootstrapPrsloy } from "./context.ts";
import { registerPrsloyIpc } from "./ipc.ts";
import { MemoryStore } from "@prsloy/harness";
import { harnessFlagsChanged } from "./flags-events.ts";
import {
  MEMORY_FORGOT_ALL_NOTE,
  MEMORY_FORGOT_NOTE_TYPE,
  MEMORY_REVERTED_NOTE_TYPE,
  memoryForgotNote,
  memoryRevertedNote,
  PRSLOY_MEMORY_IPC,
} from "./memory-ipc.ts";
import { workspaceKey } from "./turn-snapshots.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const entry = (id: string, text: string) => ({
  id,
  text,
  quote: text,
  origin: "user",
  created: "2026-10-25T10:00:00.000Z",
});

function setup(options: { trusted?: boolean } = {}) {
  const ctx = bootstrapPrsloy({
    userDataPath: tempDir("prsloy-mem-ud-"),
    cipher: {
      isEncryptionAvailable: () => true,
      encryptString: (t) => Buffer.from(t),
      decryptString: (b) => b.toString(),
    },
    env: {},
    platform: "linux",
  });
  const projectA = tempDir("prsloy-mem-a-");
  const projectB = tempDir("prsloy-mem-b-");
  const dir = join(ctx.agentDir, "prsloy-memory");
  const projectFile = (path: string) => join(dir, "projects", workspaceKey(path), "project.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "user.json"),
    JSON.stringify({
      version: 1,
      entries: [entry("u-aaaa", "Пиши без англицизмов")],
      tombstones: [],
    }),
  );
  for (const [path, id, text] of [
    [projectA, "p-bbbb", "Сайт для пекарни «Колос»"],
    [projectB, "p-cccc", "Цвета — зелёный и белый"],
  ] as const) {
    mkdirSync(join(projectFile(path), ".."), { recursive: true });
    writeFileSync(
      projectFile(path),
      JSON.stringify({
        version: 1,
        path,
        entries: [entry(id, text)],
        tombstones: [],
        digest: {
          origin: "system",
          updated: "2026-10-25T10:05:00.000Z",
          text: "Прошлый раз: шапка.",
        },
      }),
    );
  }
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const notes: { customType: string; text: string }[] = [];
  let workspace: string | undefined = projectA;
  registerPrsloyIpc(
    { handle: (channel, fn) => void handlers.set(channel, fn) },
    {
      ctx,
      fetch,
      restartHost: async () => undefined,
      getWorkspace: () => workspace,
      needsWorkspace: () => false,
      isAgentBusy: () => false,
      appendSessionNote: async (customType, text) => void notes.push({ customType, text }),
      refreshModels: false,
      isTrustedSender: () => options.trusted ?? true,
    },
  );
  const invoke = async <T>(channel: string, ...args: unknown[]) =>
    (await handlers.get(channel)!({}, ...args)) as T;
  return {
    invoke,
    notes,
    dir,
    projectA,
    projectB,
    projectFile,
    closeProject: () => (workspace = undefined),
  };
}

describe("memory IPC (S5)", () => {
  it("lists what the agent remembers about the user and the open project", async () => {
    const t = setup();
    const list = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.list);
    expect(list.user).toEqual([
      {
        id: "u-aaaa",
        text: "Пиши без англицизмов",
        created: "2026-10-25T10:00:00.000Z",
        origin: "user",
        quote: "Пиши без англицизмов",
      },
    ]);
    expect(list.history).toEqual([]);
    expect(list.project.map((e) => e.id)).toEqual(["p-bbbb"]);
    expect(list.digest?.text).toBe("Прошлый раз: шапка.");
    // Another project by path; the key is the turn snapshots' workspaceKey.
    const b = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.list, t.projectB);
    expect(b.project.map((e) => e.id)).toEqual(["p-cccc"]);
    // No project open: the user part still shows.
    t.closeProject();
    const none = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.list);
    expect(none.user).toHaveLength(1);
    expect(none.project).toEqual([]);
  });

  it("«Забыть» → tombstone + hidden note for the open session; «Вернуть» brings it back", async () => {
    const t = setup();
    const forgot = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.forget, "p-bbbb");
    expect(forgot.project).toEqual([]);
    expect(t.notes).toEqual([
      { customType: MEMORY_FORGOT_NOTE_TYPE, text: memoryForgotNote("Сайт для пекарни «Колос»") },
    ]);
    const file = JSON.parse(readFileSync(t.projectFile(t.projectA), "utf8"));
    expect(file.tombstones.map((x: { id: string }) => x.id)).toEqual(["p-bbbb"]);
    // «Вернуть» is on offer with the text.
    expect(forgot.forgotten).toMatchObject([
      { id: "p-bbbb", text: "Сайт для пекарни «Колос»", scope: "project" },
    ]);
    const back = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.restore, "p-bbbb");
    expect(back.forgotten).toEqual([]);
    expect(back.project.map((e) => e.id)).toEqual(["p-bbbb"]);
    // Unknown id: nothing changes, no note.
    const missing = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.forget, "u-zzzz");
    expect(missing.user.map((e) => e.id)).toEqual(["u-aaaa"]);
    expect(t.notes).toHaveLength(1);
    const journal = readFileSync(join(t.dir, "journal.jsonl"), "utf8");
    expect(journal).toContain('"op":"forget"');
    expect(journal).toContain('"op":"restore"');
  });

  it("«Забыть всё» clears the user and every project, one note", async () => {
    const t = setup();
    const all = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.forgetAll);
    expect(all).toEqual({ user: [], project: [], forgotten: [], history: [] });
    const b = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.list, t.projectB);
    expect(b).toEqual({ user: [], project: [], forgotten: [], history: [] });
    expect(t.notes).toEqual([
      { customType: MEMORY_FORGOT_NOTE_TYPE, text: MEMORY_FORGOT_ALL_NOTE },
    ]);
  });

  it("M-1: «Закрепить» / «Открепить» keeps the entry and marks it", async () => {
    const t = setup();
    const pinned = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.pin, "u-aaaa", true);
    expect(pinned.user[0]).toMatchObject({ id: "u-aaaa", pinned: true });
    const unpinned = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.pin, "u-aaaa", false);
    expect(unpinned.user[0]?.pinned).toBeUndefined();
    expect(readFileSync(join(t.dir, "journal.jsonl"), "utf8").match(/"op":"pin"/gu)).toHaveLength(
      2,
    );
  });

  it("M-1: «Вернуть» a replaced entry by opId — the old one back in place, a note for the session", async () => {
    const t = setup();
    const store = new MemoryStore(t.dir);
    const before = readFileSync(join(t.dir, "user.json"), "utf8");
    const entriesBefore = JSON.parse(before).entries;
    // The user changed their mind: the opposite replaces the old entry.
    const flip = store.add("user", t.projectA, {
      text: "Пиши с англицизмами",
      quote: "пиши с англицизмами",
    });
    expect(flip.ok && flip.replaced?.id).toBe("u-aaaa");
    const list = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.list);
    expect(list.history).toMatchObject([
      { kind: "replaced", scope: "user", text: "Пиши без англицизмов", now: "Пиши с англицизмами" },
    ]);
    const back = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.revert, list.history![0]!.opId);
    expect(back.user.map((e) => e.text)).toEqual(["Пиши без англицизмов"]);
    expect(back.history).toEqual([]);
    // Byte for byte: the same entries as before the change.
    expect(JSON.parse(readFileSync(join(t.dir, "user.json"), "utf8")).entries).toEqual(
      entriesBefore,
    );
    expect(t.notes).toEqual([
      {
        customType: MEMORY_REVERTED_NOTE_TYPE,
        text: memoryRevertedNote("Пиши без англицизмов", "Пиши с англицизмами"),
      },
    ]);
    // Twice: nothing to revert.
    const again = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.revert, list.history![0]!.opId);
    expect(again.user.map((e) => e.text)).toEqual(["Пиши без англицизмов"]);
  });

  it("M-1: a forgotten entry is in «Было» and comes back by its opId", async () => {
    const t = setup();
    const forgot = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.forget, "p-bbbb");
    expect(forgot.history).toMatchObject([
      { kind: "forgotten", scope: "project", text: "Сайт для пекарни «Колос»" },
    ]);
    const back = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.revert, forgot.history![0]!.opId);
    expect(back.project.map((e) => e.id)).toEqual(["p-bbbb"]);
    expect(back.history).toEqual([]);
    expect(back.forgotten).toEqual([]);
  });

  it("M-1: turning memory off erases entries, digests, history and journal texts everywhere", async () => {
    const t = setup();
    await t.invoke(PRSLOY_MEMORY_IPC.forget, "u-aaaa");
    const flags = {
      secondOpinion: true,
      memory: true,
      autoMemory: "off",
      honestExit: false,
      testGuard: false,
      claimCheck: false,
      webTools: false,
      testQuality: false,
      reviewerCheats: false,
    } as const;
    // Other switches: nothing happens.
    await harnessFlagsChanged(flags, { ...flags, secondOpinion: false });
    expect((await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.list)).project).toHaveLength(1);
    await harnessFlagsChanged(flags, { ...flags, memory: false });
    for (const path of [t.projectA, t.projectB]) {
      const s = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.list, path);
      expect(s).toEqual({ user: [], project: [], forgotten: [], history: [] });
    }
    const files = [
      readFileSync(join(t.dir, "user.json"), "utf8"),
      readFileSync(t.projectFile(t.projectA), "utf8"),
      readFileSync(t.projectFile(t.projectB), "utf8"),
      readFileSync(join(t.dir, "journal.jsonl"), "utf8"),
    ].join("\n");
    expect(files).not.toMatch(/англицизм|пекарн|зелён|шапка/u);
    expect(t.notes.at(-1)).toEqual({
      customType: MEMORY_FORGOT_NOTE_TYPE,
      text: MEMORY_FORGOT_ALL_NOTE,
    });
  });

  it("#14: the tool's proposal waits for the user — yes applies it and tells the session, no drops it", async () => {
    const t = setup();
    const store = new MemoryStore(t.dir);
    const forget = store.propose({
      action: "forget",
      scope: "user",
      target: "u-aaaa",
      text: "Пиши без англицизмов",
    });
    const no = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.confirm, forget, false);
    expect(no.user.map((e) => e.id)).toEqual(["u-aaaa"]);
    expect(t.notes).toEqual([]);
    const again = store.propose({
      action: "forget",
      scope: "user",
      target: "u-aaaa",
      text: "Пиши без англицизмов",
    });
    const yes = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.confirm, again, true);
    expect(yes.user).toEqual([]);
    expect(t.notes).toEqual([
      { customType: MEMORY_FORGOT_NOTE_TYPE, text: memoryForgotNote("Пиши без англицизмов") },
    ]);
    // Used: a second answer changes nothing.
    await t.invoke(PRSLOY_MEMORY_IPC.confirm, again, true);
    expect(t.notes).toHaveLength(1);
  });

  it("#14: «forget this chat» — entries learned only there go, the session is told", async () => {
    const t = setup();
    const store = new MemoryStore(t.dir);
    store.add("user", t.projectA, {
      text: "Любит тёмные сайты",
      quote: "люблю тёмные сайты",
      session: "chat-1",
      message: "m1",
    });
    const listed = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.list);
    expect(listed.user.find((e) => e.text === "Любит тёмные сайты")?.sessions).toEqual(["chat-1"]);
    const after = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.forgetSource, "chat-1");
    expect(after.user.map((e) => e.id)).toEqual(["u-aaaa"]);
    expect(t.notes.map((n) => n.text)).toEqual([memoryForgotNote("Любит тёмные сайты")]);
    await expect(t.invoke(PRSLOY_MEMORY_IPC.forgetSource, "../x")).rejects.toThrow(
      /Invalid session id/,
    );
    await expect(t.invoke(PRSLOY_MEMORY_IPC.confirm, "op-1234567", true)).rejects.toThrow(
      /Invalid memory confirmation/,
    );
  });

  it("rejects bad input and untrusted senders", async () => {
    const t = setup();
    await expect(t.invoke(PRSLOY_MEMORY_IPC.forget, "../../etc")).rejects.toThrow(
      /Invalid memory id/,
    );
    await expect(t.invoke(PRSLOY_MEMORY_IPC.list, "relative/dir")).rejects.toThrow(
      /Invalid workspace/,
    );
    await expect(t.invoke(PRSLOY_MEMORY_IPC.list, 42)).rejects.toThrow(/Invalid workspace/);
    await expect(t.invoke(PRSLOY_MEMORY_IPC.pin, "u-aaaa", "yes")).rejects.toThrow(/pinned/);
    await expect(t.invoke(PRSLOY_MEMORY_IPC.revert, "u-aaaa")).rejects.toThrow(
      /Invalid memory operation/,
    );
    const untrusted = setup({ trusted: false });
    await expect(untrusted.invoke(PRSLOY_MEMORY_IPC.list)).rejects.toThrow(/Untrusted IPC sender/);
    await expect(untrusted.invoke(PRSLOY_MEMORY_IPC.forgetAll)).rejects.toThrow(/Untrusted/);
    expect(existsSync(join(untrusted.dir, "journal.jsonl"))).toBe(false);
  });
});
