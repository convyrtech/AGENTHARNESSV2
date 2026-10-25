/**
 * «Память» panel backend (harness memory v1, STATUS-harness «Этап 10 · S4»): the files are
 * the harness's, read and changed only through its MemoryStore. The project key is the
 * same as the turn snapshots' (`workspaceKey`), so the panel and the agent see one folder.
 *
 * After «Забыть» the open session's memory section is frozen until the next session, so
 * the host appends a hidden note (`prsloy-memory.forgot`, display:false) for the model.
 *
 * M-1 (research/24 §3.6): «Закрепить» (`pin`), «Вернуть» for anything in «Было» (`revert` by
 * the journal's opId), and turning memory off in the settings erases it (`eraseAll`).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { MemoryStore, memoryDirFor } from "@prsloy/harness";
import type {
  MemoryForgottenItem,
  MemoryHistoryItem,
  MemoryItem,
  MemorySnapshot,
} from "@zeno/contracts";
import { onHarnessFlagsChanged } from "./flags-events.ts";
import type { IpcMainLike } from "./ipc.ts";
import { workspaceKey } from "./turn-snapshots.ts";

export const PRSLOY_MEMORY_IPC = {
  list: "prsloy:memory-list",
  forget: "prsloy:memory-forget",
  restore: "prsloy:memory-restore",
  forgetAll: "prsloy:memory-forget-all",
  pin: "prsloy:memory-pin",
  revert: "prsloy:memory-revert",
  confirm: "prsloy:memory-confirm",
  forgetSource: "prsloy:memory-forget-source",
} as const;

/** The hidden note the harness writes after its own `forget` (memory.ts): same text. */
export const MEMORY_FORGOT_NOTE_TYPE = "prsloy-memory.forgot";
export const memoryForgotNote = (text: string) =>
  `Пользователь попросил забыть: «${text}». Больше не учитывай.`;

export const MEMORY_FORGOT_ALL_NOTE =
  "Пользователь попросил забыть всё, что было в памяти. Больше ничего из неё не учитывай.";

/** After «Вернуть» in this session: the model still holds the newer text. */
export const MEMORY_REVERTED_NOTE_TYPE = "prsloy-memory.reverted";
export const memoryRevertedNote = (text: string, instead?: string) =>
  instead
    ? `Пользователь вернул прежнее: «${text}». «${instead}» больше не учитывай.`
    : `Пользователь вернул в память: «${text}».`;

export type PrsloyMemoryIpcDeps = {
  agentDir: string;
  getWorkspace(): string | undefined;
  /** Hidden note to the open session; best effort. */
  appendSessionNote?(
    customType: string,
    text: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
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

function confirmIdOf(raw: unknown): string {
  if (typeof raw !== "string" || !/^cf-[a-f0-9]{6,32}$/u.test(raw)) {
    throw new Error("Invalid memory confirmation");
  }
  return raw;
}

/** Pi session id (a UUID) or a short id: letters, digits, dashes. */
function sessionIdOf(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(raw)) {
    throw new Error("Invalid session id");
  }
  return raw;
}

/** After the user confirmed a replacement: the open session still holds the older text. */
export const memoryReplacedNote = (before: string, after: string) =>
  `Пользователь подтвердил: теперь «${after}», а не «${before}».`;

function opIdOf(raw: unknown): string {
  if (typeof raw !== "string" || !/^op-[a-f0-9]{6,32}$/u.test(raw)) {
    throw new Error("Invalid memory operation");
  }
  return raw;
}

const FORGOTTEN_MAX = 20;

/** Tombstones of the user file and this project's file, with the text the journal kept. */
function forgottenOf(store: MemoryStore, workspace: string): MemoryForgottenItem[] {
  const texts = new Map<string, string>();
  try {
    for (const line of readFileSync(join(store.dir, "journal.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const j = JSON.parse(line) as { op?: string; id?: string; before?: unknown };
      const before = j.before as { id?: unknown; text?: unknown } | unknown[] | null | undefined;
      if (
        j.op === "forget" &&
        j.id &&
        before &&
        !Array.isArray(before) &&
        typeof before.text === "string"
      ) {
        texts.set(j.id, before.text);
      }
    }
  } catch {
    // no journal yet
  }
  const read = (path: string) => {
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as {
        tombstones?: { id?: unknown; forgotten?: unknown }[];
      };
      return file.tombstones ?? [];
    } catch {
      return [];
    }
  };
  const out: MemoryForgottenItem[] = [];
  for (const [scope, path] of [
    ["user", join(store.dir, "user.json")],
    ["project", join(store.dir, "projects", workspaceKey(workspace), "project.json")],
  ] as const) {
    for (const t of read(path)) {
      if (typeof t.id !== "string" || typeof t.forgotten !== "string") continue;
      const text = texts.get(t.id);
      // «Забыть всё» keeps no per-entry text to restore from: not offered.
      if (text !== undefined) out.push({ id: t.id, text, scope, forgotten: t.forgotten });
    }
  }
  return out.sort((a, b) => b.forgotten.localeCompare(a.forgotten)).slice(0, FORGOTTEN_MAX);
}

function sessionsOf(e: { session?: string; evidence?: { session?: string }[] }) {
  const sessions = [
    ...new Set(
      (e.evidence?.length ? e.evidence.map((x) => x.session) : [e.session]).filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      ),
    ),
  ];
  return sessions.length ? { sessions } : {};
}

function list(store: MemoryStore, workspace: string): MemorySnapshot {
  const view = (scope: "user" | "project"): MemoryItem[] =>
    store.entries(scope, workspace).map((e) => ({
      id: e.id,
      text: e.text,
      created: e.created,
      origin: e.origin,
      ...(e.quote ? { quote: e.quote } : {}),
      ...(e.pinned ? { pinned: true } : {}),
      ...sessionsOf(e),
    }));
  const digest = store.digest(workspace);
  const history: MemoryHistoryItem[] = store.history(workspace).map((h) => ({
    opId: h.opId,
    scope: h.scope,
    kind: h.kind,
    text: h.entry.text,
    ...(h.now ? { now: h.now.text } : {}),
    at: h.at,
  }));
  return {
    user: view("user"),
    project: view("project"),
    ...(digest ? { digest: { text: digest.text, updated: digest.updated } } : {}),
    forgotten: forgottenOf(store, workspace),
    history,
  };
}

/**
 * Memory turned off in the settings (research/24 §3.6): entries, «Было», digests and the
 * journal's texts go at once, in every project. Hashed tombstones stay.
 */
export function eraseMemory(agentDir: string): void {
  new MemoryStore(memoryDirFor(agentDir)).eraseAll();
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

  // Turned off in the settings: erase, and tell the open session to stop using its section.
  onHarnessFlagsChanged("memory", async (before, after) => {
    if (!before.memory || after.memory) return;
    eraseMemory(deps.agentDir);
    await noteAll();
  });

  ipcMain.handle(PRSLOY_MEMORY_IPC.list, (_event, rawWorkspace) =>
    list(store(), workspaceOf(rawWorkspace, deps)),
  );

  ipcMain.handle(
    PRSLOY_MEMORY_IPC.forget,
    async (_event, rawId, rawWorkspace): Promise<MemorySnapshot> => {
      const id = idOf(rawId);
      const workspace = workspaceOf(rawWorkspace, deps);
      const s = store();
      const entry = s.forget(id, workspace);
      if (entry) await note(entry.text);
      return list(s, workspace);
    },
  );

  ipcMain.handle(PRSLOY_MEMORY_IPC.restore, (_event, rawId, rawWorkspace): MemorySnapshot => {
    const id = idOf(rawId);
    const workspace = workspaceOf(rawWorkspace, deps);
    const s = store();
    s.restore(id, workspace);
    return list(s, workspace);
  });

  ipcMain.handle(PRSLOY_MEMORY_IPC.forgetAll, async (): Promise<MemorySnapshot> => {
    const s = store();
    const workspace = workspaceOf(undefined, deps);
    const had = s.entries("user", workspace).length + s.entries("project", workspace).length;
    // About the user + the open project, then every other project the memory knows.
    s.forgetAll(workspace);
    for (const path of knownProjects(s.dir)) {
      if (s.entries("project", path).length || s.digest(path)) s.forgetAll(path);
    }
    if (had) await noteAll();
    return list(s, workspace);
  });

  ipcMain.handle(
    PRSLOY_MEMORY_IPC.pin,
    (_event, rawId, rawPinned, rawWorkspace): MemorySnapshot => {
      const id = idOf(rawId);
      if (typeof rawPinned !== "boolean") throw new Error("Invalid pinned");
      const workspace = workspaceOf(rawWorkspace, deps);
      const s = store();
      s.pin(id, rawPinned, workspace);
      return list(s, workspace);
    },
  );

  ipcMain.handle(
    PRSLOY_MEMORY_IPC.revert,
    async (_event, rawOpId, rawWorkspace): Promise<MemorySnapshot> => {
      const opId = opIdOf(rawOpId);
      const workspace = workspaceOf(rawWorkspace, deps);
      const s = store();
      const item = s.history(workspace).find((h) => h.opId === opId);
      const back = s.revert(opId, workspace);
      if (back && item?.now) {
        try {
          await deps.appendSessionNote?.(
            MEMORY_REVERTED_NOTE_TYPE,
            memoryRevertedNote(back.text, item.now.text),
          );
        } catch (error) {
          console.warn("[prsloy] memory note for the model failed:", error);
        }
      }
      return list(s, workspace);
    },
  );

  ipcMain.handle(
    PRSLOY_MEMORY_IPC.confirm,
    async (_event, rawId, rawYes, rawWorkspace): Promise<MemorySnapshot> => {
      const id = confirmIdOf(rawId);
      if (typeof rawYes !== "boolean") throw new Error("Invalid answer");
      const workspace = workspaceOf(rawWorkspace, deps);
      const s = store();
      const result = s.confirm(id, rawYes, workspace);
      if (result?.applied) {
        const change = result.change;
        try {
          if (change.action === "forget")
            await deps.appendSessionNote?.(MEMORY_FORGOT_NOTE_TYPE, memoryForgotNote(change.text));
          else
            await deps.appendSessionNote?.(
              MEMORY_REVERTED_NOTE_TYPE,
              memoryReplacedNote(change.before, change.input.text),
            );
        } catch (error) {
          console.warn("[prsloy] memory note for the model failed:", error);
        }
      }
      return list(s, workspace);
    },
  );

  ipcMain.handle(
    PRSLOY_MEMORY_IPC.forgetSource,
    async (_event, rawSession, rawWorkspace): Promise<MemorySnapshot> => {
      const session = sessionIdOf(rawSession);
      const workspace = workspaceOf(rawWorkspace, deps);
      const s = store();
      const { forgotten } = s.forgetSource(session, workspace);
      for (const entry of forgotten) await note(entry.text);
      return list(s, workspace);
    },
  );
}
