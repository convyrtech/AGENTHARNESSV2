// Хранилище памяти (research/18 §6.2, §6.3, §6.6): файлы в `<папка агента>/prsloy-memory/` —
// user.json (обо мне), projects/<sha256(realpath)[:16]>/project.json (об этом проекте), journal.jsonl (каждая
// операция: до и после — для «Вернуть» и аудита). Без Pi: тот же модуль может читать и править память из main
// для панели «Память». Пишет атомарно (tmp + rename).
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectKey } from "./learning-log.ts";

export type MemoryScope = "user" | "project";

export interface MemoryEntry {
  id: string;
  text: string;
  /** Слова пользователя, по которым запись сделана. */
  quote: string;
  origin: "user";
  session?: string;
  created: string;
  shown?: number;
}

export interface Tombstone {
  id: string;
  textHash: string;
  forgotten: string;
}

export interface Digest {
  origin: "system";
  updated: string;
  text: string;
}

interface UserFile {
  version: 1;
  entries: MemoryEntry[];
  tombstones: Tombstone[];
}

interface ProjectFile extends UserFile {
  path: string;
  digest?: Digest;
}

/** Лимиты §6.6. */
export const MEMORY_LIMITS = {
  entryChars: 160,
  user: { entries: 12, chars: 1200 },
  project: { entries: 10, chars: 1800 },
  digestChars: 600,
} as const;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

export function textHash(text: string): string {
  return `sha256:${createHash("sha256").update(normalize(text)).digest("hex")}`;
}

export function memoryDirFor(agentDir: string | undefined): string {
  const base = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(tmpdir(), "prsloy-harness");
  return process.env.PRSLOY_MEMORY_DIR ?? join(base, "prsloy-memory");
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export type AddResult =
  | { ok: true; entry: MemoryEntry }
  | { ok: false; reason: "duplicate" | "forgotten" | "too_long" | "full" };

export class MemoryStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  #userPath(): string {
    return join(this.dir, "user.json");
  }

  #projectPath(cwd: string): string {
    return join(this.dir, "projects", projectKey(cwd), "project.json");
  }

  #read(scope: MemoryScope, cwd: string): ProjectFile {
    if (scope === "user") {
      const f = readJson<UserFile>(this.#userPath(), { version: 1, entries: [], tombstones: [] });
      return { path: "", ...f, entries: f.entries ?? [], tombstones: f.tombstones ?? [] };
    }
    const f = readJson<ProjectFile>(this.#projectPath(cwd), {
      version: 1,
      path: cwd,
      entries: [],
      tombstones: [],
    });
    return { ...f, path: f.path || cwd, entries: f.entries ?? [], tombstones: f.tombstones ?? [] };
  }

  #write(scope: MemoryScope, cwd: string, file: ProjectFile): void {
    if (scope === "user") {
      const { path: _path, digest: _digest, ...user } = file;
      writeAtomic(this.#userPath(), user);
    } else writeAtomic(this.#projectPath(cwd), file);
  }

  #journal(line: Record<string, unknown>): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(
        join(this.dir, "journal.jsonl"),
        `${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`,
      );
    } catch {
      // журнал — не повод терять запись
    }
  }

  entries(scope: MemoryScope, cwd: string): MemoryEntry[] {
    return this.#read(scope, cwd).entries;
  }

  digest(cwd: string): Digest | undefined {
    return this.#read("project", cwd).digest;
  }

  add(
    scope: MemoryScope,
    cwd: string,
    input: { text: string; quote: string; session?: string | undefined },
  ): AddResult {
    const text = input.text.replace(/\s+/g, " ").trim();
    if (text.length > MEMORY_LIMITS.entryChars) return { ok: false, reason: "too_long" };
    const file = this.#read(scope, cwd);
    const hash = textHash(text);
    if (file.entries.some((e) => textHash(e.text) === hash))
      return { ok: false, reason: "duplicate" };
    // То, что пользователь просил забыть, само не возвращается.
    if (file.tombstones.some((t) => t.textHash === hash)) return { ok: false, reason: "forgotten" };
    const limits = scope === "user" ? MEMORY_LIMITS.user : MEMORY_LIMITS.project;
    const used =
      file.entries.reduce((n, e) => n + e.text.length, 0) +
      (scope === "project" ? (file.digest?.text.length ?? 0) : 0);
    if (file.entries.length >= limits.entries || used + text.length > limits.chars)
      return { ok: false, reason: "full" };
    const entry: MemoryEntry = {
      id: `${scope === "user" ? "u" : "p"}-${randomBytes(2).toString("hex")}`,
      text,
      quote: input.quote.trim(),
      origin: "user",
      ...(input.session ? { session: input.session } : {}),
      created: new Date().toISOString(),
    };
    file.entries.push(entry);
    this.#write(scope, cwd, file);
    this.#journal({
      op: "remember",
      scope,
      id: entry.id,
      before: null,
      after: entry,
      origin: "user",
    });
    return { ok: true, entry };
  }

  /** Забыть по id (в обоих местах); запись уходит в tombstones. */
  forget(id: string, cwd: string): MemoryEntry | undefined {
    for (const scope of ["user", "project"] as const) {
      const file = this.#read(scope, cwd);
      const entry = file.entries.find((e) => e.id === id);
      if (!entry) continue;
      file.entries = file.entries.filter((e) => e.id !== id);
      file.tombstones.push({
        id,
        textHash: textHash(entry.text),
        forgotten: new Date().toISOString(),
      });
      this.#write(scope, cwd, file);
      this.#journal({ op: "forget", scope, id, before: entry, after: null, origin: "user" });
      return entry;
    }
    return undefined;
  }

  /** «Вернуть» после «Забыть»: из журнала, если запись ещё в tombstones. */
  restore(id: string, cwd: string): MemoryEntry | undefined {
    let found: { scope: MemoryScope; entry: MemoryEntry } | undefined;
    try {
      for (const line of readFileSync(join(this.dir, "journal.jsonl"), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const j = JSON.parse(line) as {
          op?: string;
          scope?: MemoryScope;
          id?: string;
          before?: MemoryEntry;
        };
        if (j.op === "forget" && j.id === id && j.before && j.scope)
          found = { scope: j.scope, entry: j.before };
      }
    } catch {
      return undefined;
    }
    if (!found) return undefined;
    const file = this.#read(found.scope, cwd);
    if (!file.tombstones.some((t) => t.id === id) || file.entries.some((e) => e.id === id))
      return undefined;
    file.tombstones = file.tombstones.filter((t) => t.id !== id);
    file.entries.push(found.entry);
    this.#write(found.scope, cwd, file);
    this.#journal({
      op: "restore",
      scope: found.scope,
      id,
      before: null,
      after: found.entry,
      origin: "user",
    });
    return found.entry;
  }

  /** Сводка «прошлый раз» (S6): пишет только код харнесса. */
  setDigest(cwd: string, text: string): void {
    const file = this.#read("project", cwd);
    const trimmed = text.replace(/\s+$/, "").slice(0, MEMORY_LIMITS.digestChars);
    if (file.digest?.text === trimmed) return;
    const before = file.digest ?? null;
    file.digest = { origin: "system", updated: new Date().toISOString(), text: trimmed };
    this.#write("project", cwd, file);
    this.#journal({ op: "digest", scope: "project", before, after: file.digest, origin: "system" });
  }

  /** «Забыть всё» из панели «Память». */
  forgetAll(cwd: string): void {
    for (const scope of ["user", "project"] as const) {
      const file = this.#read(scope, cwd);
      for (const e of file.entries)
        file.tombstones.push({
          id: e.id,
          textHash: textHash(e.text),
          forgotten: new Date().toISOString(),
        });
      this.#journal({ op: "forget-all", scope, before: file.entries, after: [], origin: "user" });
      file.entries = [];
      if (scope === "project") delete file.digest;
      this.#write(scope, cwd, file);
    }
  }
}
