/**
 * «Память» panel backend (harness memory v1, STATUS-harness «Этап 10 · S4»): the files are
 * the harness's, read and changed only through its MemoryStore. The project key is the
 * same as the turn snapshots' (`workspaceKey`), so the panel and the agent see one folder.
 *
 * After «Забыть» the open session's memory section is frozen until the next session, so
 * the host appends a hidden note (`prsloy-memory.forgot`, display:false) for the model.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { MemoryStore, memoryDirFor } from "@prsloy/harness";
import type { PrsloyMemoryChange, PrsloyMemoryEntry, PrsloyMemoryList } from "@zeno/contracts";
import type { IpcMainLike } from "./ipc.ts";

export const PRSLOY_MEMORY_IPC = {
  list: "prsloy:memory-list",
  forget: "prsloy:memory-forget",
  restore: "prsloy:memory-restore",
  forgetAll: "prsloy:memory-forget-all",
} as const;

/** The hidden note the harness writes after its own `forget` (memory.ts): same text. */
export const MEMORY_FORGOT_NOTE_TYPE = "prsloy-memory.forgot";
export const memoryForgotNote = (text: string) =>
  `Пользователь попросил забыть: «${text}». Больше не учитывай.`;

export const MEMORY_FORGOT_ALL_NOTE =
  "Пользователь попросил забыть всё, что было в памяти. Больше ничего из неё не учитывай.";

export type PrsloyMemoryIpcDeps = {
  agentDir: string;
  getWorkspace(): string | undefined;
  /** Hidden note to the open session; best effort. */
  appendSessionNote?(customType: string, text: string): Promise<void>;
};

const MAX_PATH = 4096;

function workspaceOf(raw: unknown, deps: PrsloyMemoryIpcDeps): string {
  if (raw === undefined || raw === null || raw === "") {
    // No project open: user-scope memory still works (project lists stay empty).
    return deps.getWorkspace() ?? homedir();
  }
  if (typeof raw !== "string" || raw.length > MAX_PATH || !isAbsolute(raw)) {
    throw new Error("Invalid workspace");
  }
  return raw;
}

function idOf(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-z]{1,8}-[A-Za-z0-9_-]{1,64}$/u.test(raw)) {
    throw new Error("Invalid memory id");
  }
  return raw;
}

function list(store: MemoryStore, workspace: string): PrsloyMemoryList {
  const view = (scope: "user" | "project"): PrsloyMemoryEntry[] =>
    store
      .entries(scope, workspace)
      .map((e) => ({ id: e.id, text: e.text, scope, created: e.created }));
  const digest = store.digest(workspace);
  return {
    user: view("user"),
    project: view("project"),
    ...(digest ? { digest: { text: digest.text, updated: digest.updated } } : {}),
  };
}

/** Project folders the memory knows, from `projects/<key>/project.json` (`path`). */
function knownProjects(dir: string): string[] {
  const root = join(dir, "projects");
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  for (const key of readdirSync(root)) {
    try {
      const file = JSON.parse(readFileSync(join(root, key, "project.json"), "utf8")) as {
        path?: unknown;
      };
      if (typeof file.path === "string" && file.path) paths.push(file.path);
    } catch {
      // unreadable project file: nothing to forget there
    }
  }
  return paths;
}

export function registerPrsloyMemoryIpc(ipcMain: IpcMainLike, deps: PrsloyMemoryIpcDeps): void {
  const store = () => new MemoryStore(memoryDirFor(deps.agentDir));
  const note = async (text: string) => {
    try {
      await deps.appendSessionNote?.(MEMORY_FORGOT_NOTE_TYPE, memoryForgotNote(text));
    } catch (error) {
      console.warn("[prsloy] memory note for the model failed:", error);
    }
  };

  const noteAll = async () => {
    try {
      await deps.appendSessionNote?.(MEMORY_FORGOT_NOTE_TYPE, MEMORY_FORGOT_ALL_NOTE);
    } catch (error) {
      console.warn("[prsloy] memory note for the model failed:", error);
    }
  };

  ipcMain.handle(PRSLOY_MEMORY_IPC.list, (_event, rawWorkspace) =>
    list(store(), workspaceOf(rawWorkspace, deps)),
  );

  ipcMain.handle(
    PRSLOY_MEMORY_IPC.forget,
    async (_event, rawId, rawWorkspace): Promise<PrsloyMemoryChange> => {
      const id = idOf(rawId);
      const workspace = workspaceOf(rawWorkspace, deps);
      const s = store();
      const entry = s.forget(id, workspace);
      if (entry) await note(entry.text);
      return { ok: Boolean(entry), list: list(s, workspace) };
    },
  );

  ipcMain.handle(PRSLOY_MEMORY_IPC.restore, (_event, rawId, rawWorkspace): PrsloyMemoryChange => {
    const id = idOf(rawId);
    const workspace = workspaceOf(rawWorkspace, deps);
    const s = store();
    const entry = s.restore(id, workspace);
    return { ok: Boolean(entry), list: list(s, workspace) };
  });

  ipcMain.handle(PRSLOY_MEMORY_IPC.forgetAll, async (): Promise<PrsloyMemoryChange> => {
    const s = store();
    const workspace = workspaceOf(undefined, deps);
    const had = s.entries("user", workspace).length + s.entries("project", workspace).length;
    // About the user + the open project, then every other project the memory knows.
    s.forgetAll(workspace);
    for (const path of knownProjects(s.dir)) {
      if (s.entries("project", path).length || s.digest(path)) s.forgetAll(path);
    }
    if (had) await noteAll();
    return { ok: true, list: list(s, workspace) };
  });
}
