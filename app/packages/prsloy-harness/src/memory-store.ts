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
import { looksLikeThreat, looksSensitive } from "./memory-checks.ts";
import {
  type HashedSignature,
  hashedSignature,
  matchesForgotten,
  relation,
  signature,
  textMatchesQuote,
} from "./memory-match.ts";

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
  /** M-0: хэши основ и их полярность — пересказ забытого тоже не возвращается. */
  stems?: HashedSignature["stems"];
  negations?: HashedSignature["negations"];
}

/** Запись, которая не прошла перепроверку правилами M-0 (писалась через старую дыру). */
export interface QuarantinedEntry extends MemoryEntry {
  reason: "not-linked" | "secret" | "threat";
  quarantined: string;
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
  /** Какими правилами записи уже перепроверены ("m0"). */
  rules?: string;
  quarantined?: QuarantinedEntry[];
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

function writeAtomic(path: string, value: unknown, raw?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, raw ?? `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export type AddResult =
  /** `replaced` — прежняя запись с обратным смыслом: пользователь передумал, последнее слово главнее. */
  | { ok: true; entry: MemoryEntry; replaced?: MemoryEntry }
  | { ok: false; reason: "duplicate" | "forgotten" | "too_long" | "full" };

/** Текст в журнале живёт 30 дней, потом остаются хэши (research/24 §1). */
export const JOURNAL_TEXT_DAYS = 30;
const RULES = "m0";

function tombstoneFor(entry: MemoryEntry, now = new Date()): Tombstone {
  const sig = hashedSignature(entry.text);
  return {
    id: entry.id,
    textHash: textHash(entry.text),
    forgotten: now.toISOString(),
    stems: sig.stems,
    negations: sig.negations,
  };
}

/** Запись без текста: то, что остаётся в журнале после срока или после «Забыть всё». */
function hashedEntry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hashedEntry);
  if (!value || typeof value !== "object") return value;
  const e = value as Record<string, unknown>;
  if (typeof e.text !== "string") return value;
  const { text, quote: _quote, ...rest } = e;
  return { ...rest, textHash: textHash(text) };
}

/** Перепроверка старой записи теми же правилами, что и новой. */
function recheck(entry: MemoryEntry): QuarantinedEntry["reason"] | undefined {
  if (looksSensitive(entry.text, entry.quote ?? "")) return "secret";
  if (looksLikeThreat(entry.text) || looksLikeThreat(entry.quote ?? "")) return "threat";
  if (!textMatchesQuote(entry.text, entry.quote ?? "")) return "not-linked";
  return undefined;
}

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
    let file: ProjectFile;
    if (scope === "user") {
      const f = readJson<UserFile>(this.#userPath(), { version: 1, entries: [], tombstones: [] });
      file = { path: "", ...f, entries: f.entries ?? [], tombstones: f.tombstones ?? [] };
    } else {
      const f = readJson<ProjectFile>(this.#projectPath(cwd), {
        version: 1,
        path: cwd,
        entries: [],
        tombstones: [],
      });
      file = {
        ...f,
        path: f.path || cwd,
        entries: f.entries ?? [],
        tombstones: f.tombstones ?? [],
      };
    }
    return this.#migrate(scope, cwd, file);
  }

  /**
   * v1-записи писались без проверки связи text ↔ quote: при первом чтении их перепроверяют теми же правилами.
   * Не прошедшие уходят из раздела в `quarantined` (видно в журнале), остальные остаются как были.
   */
  #migrate(scope: MemoryScope, cwd: string, file: ProjectFile): ProjectFile {
    if (file.rules === RULES || (!file.entries.length && !file.tombstones.length)) return file;
    const now = new Date().toISOString();
    const kept: MemoryEntry[] = [];
    const quarantined: QuarantinedEntry[] = [...(file.quarantined ?? [])];
    for (const entry of file.entries) {
      const reason = recheck(entry);
      if (!reason) {
        kept.push(entry);
        continue;
      }
      quarantined.push({ ...entry, reason, quarantined: now });
      this.#journal({
        op: "quarantine",
        scope,
        id: entry.id,
        before: entry,
        after: null,
        origin: "system",
        reason,
      });
    }
    const next: ProjectFile = {
      ...file,
      entries: kept,
      rules: RULES,
      ...(quarantined.length ? { quarantined } : {}),
    };
    try {
      this.#write(scope, cwd, next);
    } catch {
      // нет прав на запись — перепроверим в следующий раз, в раздел всё равно не попадёт
    }
    return next;
  }

  #write(scope: MemoryScope, cwd: string, rawFile: ProjectFile): void {
    // Всё, что пишет этот код, уже прошло проверки M-0.
    const file = { ...rawFile, rules: RULES };
    if (scope === "user") {
      const { path: _path, digest: _digest, ...user } = file;
      writeAtomic(this.#userPath(), user);
    } else writeAtomic(this.#projectPath(cwd), file);
  }

  #journal(line: Record<string, unknown>): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      this.compactJournal();
      appendFileSync(
        join(this.dir, "journal.jsonl"),
        `${JSON.stringify({ ts: new Date().toISOString(), ...line })}\n`,
      );
    } catch {
      // журнал — не повод терять запись
    }
  }

  /**
   * Тексты записей в журнале — не дольше JOURNAL_TEXT_DAYS дней, потом только хэши. `all` — стереть тексты
   * сразу во всём журнале («Забыть всё»). Возвращает, сколько строк переписано.
   */
  compactJournal(options: { now?: Date; all?: boolean } = {}): number {
    const path = join(this.dir, "journal.jsonl");
    if (!existsSync(path)) return 0;
    const cutoff = (options.now ?? new Date()).getTime() - JOURNAL_TEXT_DAYS * 86_400_000;
    let changed = 0;
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        try {
          const j = JSON.parse(line) as Record<string, unknown>;
          const old = typeof j.ts === "string" ? Date.parse(j.ts) < cutoff : false;
          if (!options.all && !old) return line;
          const next = JSON.stringify({
            ...j,
            before: hashedEntry(j.before),
            after: hashedEntry(j.after),
          });
          if (next !== line) changed += 1;
          return next;
        } catch {
          return line;
        }
      });
    if (changed) writeAtomic(path, null, `${lines.join("\n")}\n`);
    return changed;
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
    const sig = signature(text);
    // Дубль — то же по основам и с той же полярностью.
    if (
      file.entries.some(
        (e) => textHash(e.text) === hash || relation(sig, signature(e.text)) === "same",
      )
    )
      return { ok: false, reason: "duplicate" };
    // Забытое само не возвращается, и пересказом тоже. Обратная полярность — не то же самое.
    if (
      file.tombstones.some((t) =>
        t.stems && t.negations
          ? matchesForgotten(text, { stems: t.stems, negations: t.negations })
          : t.textHash === hash,
      )
    )
      return { ok: false, reason: "forgotten" };
    // Противоречие: пользователь передумал. Прежняя запись уходит, новая встаёт на её место.
    const replaced = file.entries.find((e) => relation(sig, signature(e.text)) === "contradicts");
    if (replaced) file.entries = file.entries.filter((e) => e.id !== replaced.id);
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
    if (replaced) {
      this.#journal({
        op: "supersede",
        scope,
        id: replaced.id,
        before: replaced,
        after: entry,
        origin: "user",
      });
    } else {
      this.#journal({
        op: "remember",
        scope,
        id: entry.id,
        before: null,
        after: entry,
        origin: "user",
      });
    }
    return replaced ? { ok: true, entry, replaced } : { ok: true, entry };
  }

  /** Забыть по id (в обоих местах); запись уходит в tombstones. */
  forget(id: string, cwd: string): MemoryEntry | undefined {
    for (const scope of ["user", "project"] as const) {
      const file = this.#read(scope, cwd);
      const entry = file.entries.find((e) => e.id === id);
      if (!entry) continue;
      file.entries = file.entries.filter((e) => e.id !== id);
      file.tombstones.push(tombstoneFor(entry));
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
    // После срока в журнале только хэш: вернуть нечего.
    if (!found || typeof found.entry.text !== "string") return undefined;
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
      for (const e of file.entries) file.tombstones.push(tombstoneFor(e));
      // В журнале — только хэши: «Забыть всё» стирает тексты сразу.
      this.#journal({
        op: "forget-all",
        scope,
        before: hashedEntry(file.entries),
        after: [],
        origin: "user",
      });
      file.entries = [];
      delete file.quarantined;
      if (scope === "project") delete file.digest;
      this.#write(scope, cwd, file);
    }
    this.compactJournal({ all: true });
  }
}
