// Хранилище памяти (research/18 §6.2, §6.3, §6.6): файлы в `<папка агента>/prsloy-memory/` —
// user.json (обо мне), projects/<sha256(realpath)[:16]>/project.json (об этом проекте), journal.jsonl (каждая
// операция: до и после — для «Вернуть» и аудита). Без Pi: тот же модуль может читать и править память из main
// для панели «Память». Пишет атомарно (tmp + rename).
// M-1 (research/24 §3.2, §3.6): схема v2 — `origin` user/auto, `kind`, `pinned`, `evidence` ≤3, `strength`,
// `lastSeen`; общая история «было» (заменено / истекло / забыто) с `opId` и «Вернуть» байт-в-байт; операции
// add / reinforce / supersede / revert / pin в журнале с `opId`. v1-файлы читаются как есть.
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
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

/** Вид записи (§3.5): от него зависит забывание. */
export type MemoryKind = "profile" | "preference" | "decision" | "correction";

/** Где пользователь это сказал (до трёх, новые в конце). */
export interface MemoryEvidence {
  quote: string;
  session?: string;
  at: string;
}

export interface MemoryEntry {
  id: string;
  text: string;
  /** Слова пользователя, по которым запись сделана. */
  quote: string;
  /** user — пользователь попросил запомнить; auto — заметил экстрактор (M-3). */
  origin: "user" | "auto";
  kind?: MemoryKind;
  /** Закреплено: само не исчезает и меняется только через карточку. */
  pinned?: boolean;
  evidence?: MemoryEvidence[];
  /** Сколько раз подтверждено (reinforce), от 1. */
  strength?: number;
  lastSeen?: string;
  session?: string;
  created: string;
  shown?: number;
}

export type MemoryHistoryKind = "replaced" | "expired" | "forgotten";

/**
 * «Было»: что ушло из памяти и чем «Вернуть» это вернёт (байт-в-байт). В файле лежат replaced и expired
 * (90 дней); forgotten собирается из журнала (там текст 30 дней), чтобы в файле после «Забыть» были одни хэши.
 */
export interface MemoryHistoryItem {
  opId: string;
  kind: MemoryHistoryKind;
  /** Запись, как она лежала до операции. */
  entry: MemoryEntry;
  /** Для replaced — что встало на её место. */
  now?: MemoryEntry;
  /** Место записи в списке: «Вернуть» ставит её туда же. */
  pos: number;
  at: string;
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
  /** 2 — схема M-1; 1 читается как есть (новые поля необязательны). */
  version: 1 | 2;
  entries: MemoryEntry[];
  tombstones: Tombstone[];
  /** Какими правилами записи уже перепроверены ("m0"). */
  rules?: string;
  quarantined?: QuarantinedEntry[];
  /** Новые в конце; старше HISTORY_DAYS удаляются при записи. */
  history?: MemoryHistoryItem[];
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

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Windows: antivirus, the indexer or another process holding the file for a moment. */
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "";

/** rename с повтором: на Windows замена файла, который кто-то держит открытым, на миг падает с EPERM/EBUSY. */
export function renameWithRetry(from: string, to: string, attempts = 20): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (!BUSY.has(errorCode(error)) || i >= attempts - 1) throw error;
      sleepSync(10 + i * 10);
    }
  }
}

function writeAtomic(path: string, value: unknown, raw?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, raw ?? `${JSON.stringify(value, null, 2)}\n`);
  try {
    renameWithRetry(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // уже нет
    }
    throw error;
  }
}

/** Замок старше этого — от упавшего процесса. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const held = new Map<string, number>();

/**
 * Одна запись в папку памяти за раз: харнесс в агент-хосте и main (панель «Память», экстрактор) пишут одни
 * файлы. Замок — `.lock` (создание с `wx`), внутри процесса повторный вход разрешён.
 */
export function withMemoryLock<T>(dir: string, fn: () => T): T {
  const depth = held.get(dir) ?? 0;
  if (depth > 0) {
    held.set(dir, depth + 1);
    try {
      return fn();
    } finally {
      held.set(dir, depth);
    }
  }
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST" && !BUSY.has(errorCode(error))) throw error;
      let stale = Date.now() > deadline;
      try {
        stale ||= Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue; // снят, пока смотрели
      }
      if (stale) {
        try {
          unlinkSync(lock);
        } catch {
          // снял кто-то другой
        }
        continue;
      }
      sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }
  held.set(dir, 1);
  try {
    return fn();
  } finally {
    held.delete(dir);
    try {
      unlinkSync(lock);
    } catch {
      // уже снят
    }
  }
}

export type AddResult =
  /** `replaced` — прежняя запись с обратным смыслом: пользователь передумал, последнее слово главнее. */
  | { ok: true; opId: string; entry: MemoryEntry; replaced?: MemoryEntry }
  /** Дубль усиливает запись, что уже есть (reinforce): strength, lastSeen, evidence. */
  | { ok: false; reason: "duplicate"; opId: string; entry: MemoryEntry }
  /** `pinned` — автоматическая запись не вытесняет закреплённую: только карточка (§3.4 п. 9). */
  | { ok: false; reason: "forgotten" | "too_long" | "full" | "pinned" };

export interface AddInput {
  text: string;
  quote: string;
  session?: string | undefined;
  origin?: MemoryEntry["origin"];
  kind?: MemoryKind;
}

/** Строка «Было» для панели: обе области, новые первыми. */
export interface MemoryHistoryView extends MemoryHistoryItem {
  scope: MemoryScope;
}

/** Кандидаты экстрактора в тени (M-3): слова пользователя, поэтому тот же срок, что у текстов журнала. */
export const CANDIDATES_FILE = "candidates.jsonl";

/** «Было» с «Вернуть» живёт 90 дней (§3.5). */
export const HISTORY_DAYS = 90;
export const EVIDENCE_MAX = 3;

/** «Забыть» по журналу: запись, её место и opId (у строк до M-1 его нет). */
interface ForgetRecord {
  opId?: string;
  scope: MemoryScope;
  entry: MemoryEntry;
  pos: number;
  at: string;
}

export const newOpId = () => `op-${randomBytes(6).toString("hex")}`;

/** Текст в журнале живёт 30 дней, потом остаются хэши (research/24 §1). */
export const JOURNAL_TEXT_DAYS = 30;
const RULES = "m0";
const VERSION = 2;

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
  const { text, quote: _quote, evidence, ...rest } = e;
  // Цитаты в evidence — те же слова пользователя: остаётся только их число.
  return {
    ...rest,
    textHash: textHash(text),
    ...(Array.isArray(evidence) ? { evidence: evidence.length } : {}),
  };
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
    return this.#migrate(scope, cwd, this.#readRaw(scope, cwd));
  }

  #readRaw(scope: MemoryScope, cwd: string): ProjectFile {
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
    return file;
  }

  /**
   * v1-записи писались без проверки связи text ↔ quote: при первом чтении их перепроверяют теми же правилами.
   * Не прошедшие уходят из раздела в `quarantined` (видно в журнале), остальные остаются как были.
   */
  #migrate(scope: MemoryScope, cwd: string, read: ProjectFile): ProjectFile {
    const needed = (f: ProjectFile) =>
      f.rules !== RULES && (f.entries.length > 0 || f.tombstones.length > 0);
    if (!needed(read)) return read;
    // Под замком и по свежему чтению: другой процесс мог дописать запись между чтениями.
    return withMemoryLock(this.dir, () => {
      const file = this.#readRaw(scope, cwd);
      return needed(file) ? this.#migrateNow(scope, cwd, file) : file;
    });
  }

  #migrateNow(scope: MemoryScope, cwd: string, file: ProjectFile): ProjectFile {
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
    const cutoff = Date.now() - HISTORY_DAYS * 86_400_000;
    const history = (rawFile.history ?? []).filter((h) => Date.parse(h.at) >= cutoff);
    const { history: _h, ...rest } = rawFile;
    const file = {
      ...rest,
      version: VERSION as 1 | 2,
      rules: RULES,
      ...(history.length ? { history } : {}),
    };
    if (scope === "user") {
      const { path: _path, digest: _digest, ...user } = file;
      writeAtomic(this.#userPath(), user);
    } else writeAtomic(this.#projectPath(cwd), file);
  }

  #journal(line: Record<string, unknown>): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      this.#compactJournal({});
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
    return withMemoryLock(this.dir, () => this.#compactJournal(options));
  }

  #compactJournal(options: { now?: Date; all?: boolean }): number {
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

  add(scope: MemoryScope, cwd: string, input: AddInput): AddResult {
    return withMemoryLock(this.dir, () => this.#add(scope, cwd, input));
  }

  #add(scope: MemoryScope, cwd: string, input: AddInput): AddResult {
    const text = input.text.replace(/\s+/g, " ").trim();
    if (text.length > MEMORY_LIMITS.entryChars) return { ok: false, reason: "too_long" };
    const file = this.#read(scope, cwd);
    const hash = textHash(text);
    const sig = signature(text);
    const now = new Date().toISOString();
    const quote = input.quote.trim();
    const evidence: MemoryEvidence = {
      quote,
      ...(input.session ? { session: input.session } : {}),
      at: now,
    };
    // Дубль — то же по основам и с той же полярностью: запись усиливается (reinforce).
    const dup = file.entries.findIndex(
      (e) => textHash(e.text) === hash || relation(sig, signature(e.text)) === "same",
    );
    if (dup >= 0) {
      const before = file.entries[dup]!;
      const seen = before.evidence ?? [{ quote: before.quote, at: before.created }];
      const after: MemoryEntry = {
        ...before,
        strength: (before.strength ?? 1) + 1,
        lastSeen: now,
        evidence: (seen.some((e) => e.quote === quote) ? seen : [...seen, evidence]).slice(
          -EVIDENCE_MAX,
        ),
      };
      file.entries[dup] = after;
      this.#write(scope, cwd, file);
      const opId = newOpId();
      this.#journal({
        op: "reinforce",
        opId,
        scope,
        id: after.id,
        before,
        after,
        origin: input.origin ?? "user",
      });
      return { ok: false, reason: "duplicate", opId, entry: after };
    }
    // Забытое само не возвращается, и пересказом тоже. Обратная полярность — не то же самое.
    if (
      file.tombstones.some((t) =>
        t.stems && t.negations
          ? matchesForgotten(text, { stems: t.stems, negations: t.negations })
          : t.textHash === hash,
      )
    )
      return { ok: false, reason: "forgotten" };
    // Противоречие: пользователь передумал. Прежняя запись уходит в «Было», новая встаёт на её место.
    const pos = file.entries.findIndex((e) => relation(sig, signature(e.text)) === "contradicts");
    const replaced = pos >= 0 ? file.entries[pos] : undefined;
    if (replaced?.pinned && input.origin === "auto") return { ok: false, reason: "pinned" };
    if (replaced) file.entries = file.entries.filter((e) => e.id !== replaced.id);
    const limits = scope === "user" ? MEMORY_LIMITS.user : MEMORY_LIMITS.project;
    const used =
      file.entries.reduce((n, e) => n + e.text.length, 0) +
      (scope === "project" ? (file.digest?.text.length ?? 0) : 0);
    if (file.entries.length >= limits.entries || used + text.length > limits.chars)
      return { ok: false, reason: "full" };
    const origin = input.origin ?? "user";
    const entry: MemoryEntry = {
      id: `${scope === "user" ? "u" : "p"}-${randomBytes(2).toString("hex")}`,
      text,
      quote,
      origin,
      ...(input.kind ? { kind: input.kind } : {}),
      evidence: [evidence],
      strength: 1,
      lastSeen: now,
      ...(input.session ? { session: input.session } : {}),
      created: now,
    };
    file.entries.push(entry);
    const opId = newOpId();
    if (replaced)
      file.history = [
        ...(file.history ?? []),
        { opId, kind: "replaced", entry: replaced, now: entry, pos, at: now },
      ];
    this.#write(scope, cwd, file);
    if (replaced) {
      this.#journal({
        op: "supersede",
        opId,
        scope,
        id: replaced.id,
        before: replaced,
        after: entry,
        origin,
      });
    } else {
      this.#journal({
        op: "remember",
        opId,
        scope,
        id: entry.id,
        before: null,
        after: entry,
        origin,
      });
    }
    return replaced ? { ok: true, opId, entry, replaced } : { ok: true, opId, entry };
  }

  /** Забыть по id (в обоих местах); запись уходит в tombstones. */
  forget(id: string, cwd: string): MemoryEntry | undefined {
    return withMemoryLock(this.dir, () => this.#forget(id, cwd));
  }

  #forget(id: string, cwd: string): MemoryEntry | undefined {
    for (const scope of ["user", "project"] as const) {
      const file = this.#read(scope, cwd);
      const pos = file.entries.findIndex((e) => e.id === id);
      const entry = file.entries[pos];
      if (!entry) continue;
      file.entries = file.entries.filter((e) => e.id !== id);
      file.tombstones.push(tombstoneFor(entry));
      this.#write(scope, cwd, file);
      // Текст забытого — только в журнале (30 дней): в файле после «Забыть» одни хэши.
      this.#journal({
        op: "forget",
        opId: newOpId(),
        scope,
        id,
        pos,
        before: entry,
        after: null,
        origin: "user",
      });
      return entry;
    }
    return undefined;
  }

  /** «Вернуть» после «Забыть»: из журнала, если запись ещё в tombstones. */
  restore(id: string, cwd: string): MemoryEntry | undefined {
    return withMemoryLock(this.dir, () => this.#restore(id, cwd));
  }

  #restore(id: string, cwd: string): MemoryEntry | undefined {
    const found = this.#forgets().find((f) => f.entry.id === id);
    return found ? this.#undoForget(found, cwd) : undefined;
  }

  /** «Забыть» из журнала, пока там текст (после срока — хэш, и вернуть нечего). Последний раз — последним. */
  #forgets(): ForgetRecord[] {
    const out: ForgetRecord[] = [];
    try {
      for (const line of readFileSync(join(this.dir, "journal.jsonl"), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const j = JSON.parse(line) as {
          ts?: string;
          op?: string;
          opId?: string;
          scope?: MemoryScope;
          id?: string;
          pos?: number;
          before?: MemoryEntry;
        };
        if (j.op !== "forget" || !j.id || !j.scope || typeof j.before?.text !== "string") continue;
        out.push({
          ...(j.opId ? { opId: j.opId } : {}),
          scope: j.scope,
          entry: j.before,
          pos: typeof j.pos === "number" ? j.pos : Number.MAX_SAFE_INTEGER,
          at: j.ts ?? "",
        });
      }
    } catch {
      // нет журнала
    }
    return out.reverse();
  }

  #undoForget(found: ForgetRecord, cwd: string): MemoryEntry | undefined {
    const { scope, entry } = found;
    const file = this.#read(scope, cwd);
    if (
      !file.tombstones.some((t) => t.id === entry.id) ||
      file.entries.some((e) => e.id === entry.id)
    )
      return undefined;
    file.tombstones = file.tombstones.filter((t) => t.id !== entry.id);
    file.entries.splice(Math.min(found.pos, file.entries.length), 0, entry);
    this.#write(scope, cwd, file);
    this.#journal({
      op: "restore",
      opId: newOpId(),
      ...(found.opId ? { revertOf: found.opId } : {}),
      scope,
      id: entry.id,
      before: null,
      after: entry,
      origin: "user",
    });
    return entry;
  }

  /** Сводка «прошлый раз» (S6): пишет только код харнесса. */
  setDigest(cwd: string, text: string): void {
    withMemoryLock(this.dir, () => this.#setDigest(cwd, text));
  }

  #setDigest(cwd: string, text: string): void {
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
    withMemoryLock(this.dir, () => this.#forgetAll(cwd));
  }

  #forgetAll(cwd: string): void {
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
      delete file.history;
      if (scope === "project") delete file.digest;
      this.#write(scope, cwd, file);
    }
    rmSync(join(this.dir, CANDIDATES_FILE), { force: true });
    this.#compactJournal({ all: true });
  }

  /**
   * Кандидаты экстрактора (M-3, в тени): дописать строки; строки старше JOURNAL_TEXT_DAYS при этом уходят.
   * В раздел промпта и в записи памяти отсюда ничего не попадает.
   */
  recordCandidates(lines: readonly Record<string, unknown>[], now = new Date()): void {
    withMemoryLock(this.dir, () => {
      const path = join(this.dir, CANDIDATES_FILE);
      const cutoff = now.getTime() - JOURNAL_TEXT_DAYS * 86_400_000;
      let kept: string[] = [];
      try {
        kept = readFileSync(path, "utf8")
          .split("\n")
          .filter((l) => {
            if (!l.trim()) return false;
            try {
              const ts = (JSON.parse(l) as { ts?: string }).ts;
              return typeof ts === "string" && Date.parse(ts) >= cutoff;
            } catch {
              return false;
            }
          });
      } catch {
        // нет файла
      }
      const added = lines.map((l) => JSON.stringify({ ts: now.toISOString(), ...l }));
      writeAtomic(path, null, `${[...kept, ...added].join("\n")}\n`);
    });
  }

  /** Пользователь просил это забыть: тот же признак, что у `add` (хэши основ, полярность). Только чтение. */
  isForgotten(scope: MemoryScope, cwd: string, text: string): boolean {
    const hash = textHash(text);
    return this.#read(scope, cwd).tombstones.some((t) =>
      t.stems && t.negations
        ? matchesForgotten(text, { stems: t.stems, negations: t.negations })
        : t.textHash === hash,
    );
  }

  /** «Было» обеих областей для этой папки, новые первыми. */
  history(cwd: string): MemoryHistoryView[] {
    return this.#history(cwd);
  }

  #history(cwd: string): MemoryHistoryView[] {
    const files = { user: this.#read("user", cwd), project: this.#read("project", cwd) };
    const out: MemoryHistoryView[] = (["user", "project"] as const).flatMap((scope) =>
      (files[scope].history ?? []).map((h) => ({ ...h, scope })),
    );
    // Забытое — из журнала: только с opId (после M-1) и только то, что лежит в tombstones этой папки.
    const seen = new Set<string>();
    for (const f of this.#forgets()) {
      if (!f.opId || seen.has(f.entry.id)) continue;
      seen.add(f.entry.id);
      const file = files[f.scope];
      if (!file.tombstones.some((t) => t.id === f.entry.id)) continue;
      if (file.entries.some((e) => e.id === f.entry.id)) continue;
      out.push({
        opId: f.opId,
        kind: "forgotten",
        entry: f.entry,
        pos: f.pos,
        at: f.at,
        scope: f.scope,
      });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /**
   * «Вернуть» операцию из «Было» (§3.6): запись встаёт на прежнее место такой, какой была; для replaced
   * уходит то, что её заменило. Возвращает вернувшуюся запись или undefined (нет такой операции, срок вышел,
   * запись уже на месте).
   */
  revert(opId: string, cwd: string): MemoryEntry | undefined {
    return withMemoryLock(this.dir, () => this.#revert(opId, cwd));
  }

  #revert(opId: string, cwd: string): MemoryEntry | undefined {
    const forgot = this.#forgets().find((f) => f.opId === opId);
    if (forgot) return this.#undoForget(forgot, cwd);
    for (const scope of ["user", "project"] as const) {
      const file = this.#read(scope, cwd);
      const item = file.history?.find((h) => h.opId === opId);
      if (!item) continue;
      if (file.entries.some((e) => e.id === item.entry.id)) return undefined;
      const removed = item.now ? file.entries.find((e) => e.id === item.now!.id) : undefined;
      if (removed) file.entries = file.entries.filter((e) => e.id !== removed.id);
      file.entries.splice(Math.min(item.pos, file.entries.length), 0, item.entry);
      file.history = file.history!.filter((h) => h.opId !== opId);
      this.#write(scope, cwd, file);
      this.#journal({
        op: "revert",
        opId: newOpId(),
        revertOf: opId,
        scope,
        id: item.entry.id,
        before: removed ?? null,
        after: item.entry,
        origin: "user",
      });
      return item.entry;
    }
    return undefined;
  }

  /** «Закрепить» / «Открепить» (§3.5–3.6). */
  pin(id: string, pinned: boolean, cwd: string): MemoryEntry | undefined {
    return withMemoryLock(this.dir, () => this.#pin(id, pinned, cwd));
  }

  #pin(id: string, pinned: boolean, cwd: string): MemoryEntry | undefined {
    for (const scope of ["user", "project"] as const) {
      const file = this.#read(scope, cwd);
      const at = file.entries.findIndex((e) => e.id === id);
      const before = file.entries[at];
      if (!before) continue;
      if (Boolean(before.pinned) === pinned) return before;
      const { pinned: _p, ...rest } = before;
      const after: MemoryEntry = pinned ? { ...rest, pinned: true } : rest;
      file.entries[at] = after;
      this.#write(scope, cwd, file);
      this.#journal({ op: "pin", opId: newOpId(), scope, id, before, after, origin: "user" });
      return after;
    }
    return undefined;
  }

  /**
   * Память выключили (§3.6): стереть записи, «Было», сводку и тексты журнала во всех областях и проектах.
   * Tombstones (только хэши) остаются: забытое не вернётся и после повторного включения.
   */
  eraseAll(): void {
    withMemoryLock(this.dir, () => {
      const projects = join(this.dir, "projects");
      const paths = existsSync(projects)
        ? readdirSync(projects).map((key) => join(projects, key, "project.json"))
        : [];
      for (const path of [this.#userPath(), ...paths]) {
        if (!existsSync(path)) continue;
        const file = readJson<ProjectFile | null>(path, null);
        if (!file || typeof file !== "object") continue;
        const { entries, history: _h, quarantined: _q, digest: _d, ...rest } = file;
        writeAtomic(path, { ...rest, version: VERSION, rules: RULES, entries: [] });
        this.#journal({
          op: "erase",
          opId: newOpId(),
          scope: path === this.#userPath() ? "user" : "project",
          before: hashedEntry(entries ?? []),
          after: [],
          origin: "user",
        });
      }
      rmSync(join(this.dir, CANDIDATES_FILE), { force: true });
      this.#compactJournal({ all: true });
    });
  }
}
