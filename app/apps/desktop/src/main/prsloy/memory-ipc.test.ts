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
import {
  MEMORY_FORGOT_ALL_NOTE,
  MEMORY_FORGOT_NOTE_TYPE,
  memoryForgotNote,
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
      },
    ]);
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
    expect(all).toEqual({ user: [], project: [], forgotten: [] });
    const b = await t.invoke<MemorySnapshot>(PRSLOY_MEMORY_IPC.list, t.projectB);
    expect(b).toEqual({ user: [], project: [], forgotten: [] });
    expect(t.notes).toEqual([
      { customType: MEMORY_FORGOT_NOTE_TYPE, text: MEMORY_FORGOT_ALL_NOTE },
    ]);
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
    const untrusted = setup({ trusted: false });
    await expect(untrusted.invoke(PRSLOY_MEMORY_IPC.list)).rejects.toThrow(/Untrusted IPC sender/);
    await expect(untrusted.invoke(PRSLOY_MEMORY_IPC.forgetAll)).rejects.toThrow(/Untrusted/);
    expect(existsSync(join(untrusted.dir, "journal.jsonl"))).toBe(false);
  });
});
