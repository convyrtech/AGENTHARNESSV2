// S3 из research/18-memory-self-learning.md (§6.1 (c), §6.3, §6.5, §7.4–§7.7): уроки вкладки «Код».
// - Постоянные (mode=always, статус active или trial): раздел промпта prsloy_lessons, ≤5 на модель, ≤800 символов.
//   Считается один раз на сессию (и при смене модели) — та же строка на каждом ходе, кэш не ломается.
//   trial показывается в ~15% сессий (по хэшу сессии), чтобы было с чем сравнить.
// - Ситуативные (mode=on-event): дописываются в уже существующий возврат харнесса, когда совпали вид события и
//   подпись; ≤1 на возврат, ≤240 символов.
// - Счётчики без LLM (§7.5): shown / helped / hurt в prsloy-learning/local-lessons.json. hurt ≥ helped после
//   ≥10 показов — урок выключается сам (включить обратно — только новой версией файла уроков).
// - Флаги: "lessons": false и "disabledLessons": [id] в prsloy-harness.json.
// Включает урок в файл только человек (PR + стенд); код здесь ничего не учит сам.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import bundled from "../lessons/code.json" with { type: "json" };
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFlags } from "./flags.ts";
import { fitPromptBudget } from "./prompt-budget.ts";
import {
  learningDir,
  type LearningEvent,
  type LearningKind,
  modelFamily,
  onLearningEvent,
  recordEvent,
} from "./learning-log.ts";

export interface Lesson {
  id: string;
  surface: string;
  /** Семейства моделей (`deepseek-v4.1-flash`) или `*` — для всех. */
  models: string[];
  mode: "always" | "on-event";
  trigger?: { kind: LearningKind; sig?: string };
  text: string;
  status: "candidate" | "trial" | "active" | "retired";
  /** Урок уже доставлен иначе (постоянный раздел промпта, код) — в prsloy_lessons не дублируется. */
  delivery?: string;
  since?: string;
  cause?: string;
  codeFix?: string | null;
}

export const LESSONS_MAX = 5;
export const LESSONS_MAX_CHARS = 800;
export const TIP_MAX_CHARS = 240;
/** Доля сессий, где показывается урок в статусе trial (§7.5: 10–20%). */
export const TRIAL_SHARE = 0.15;
export const LESSONS_HEADER = "Notes from past runs of this model. Use them if they fit the task.";
export const TIP_PREFIX = "Совет из прошлых задач: ";

/** Уроки из комплекта: JSON встраивается в сборку хоста (путь к файлу внутри asar ненадёжен). */
export const BUNDLED_LESSONS: Lesson[] = (bundled as { lessons: Lesson[] }).lessons;

/** Уроки из файла (тесты, стенд) или из комплекта. */
export function loadLessons(path?: string): Lesson[] {
  if (!path) return BUNDLED_LESSONS;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { lessons?: unknown };
    return Array.isArray(raw.lessons)
      ? (raw.lessons as Lesson[]).filter((l) => l && typeof l.id === "string")
      : [];
  } catch {
    return [];
  }
}

function modelMatches(lesson: Lesson, family: string | undefined): boolean {
  return lesson.models.includes("*") || (family !== undefined && lesson.models.includes(family));
}

/** Попадает ли сессия в долю trial — детерминированно по сессии и уроку. */
export function inTrial(session: string, id: string, share = TRIAL_SHARE): boolean {
  const h = createHash("sha256").update(`${session}\u0000${id}`).digest().readUInt32BE(0);
  return h / 0xffffffff < share;
}

function usable(lesson: Lesson, session: string, off: Set<string>): boolean {
  if (lesson.surface !== "code" || off.has(lesson.id)) return false;
  if (lesson.status === "active") return true;
  return lesson.status === "trial" && inTrial(session, lesson.id);
}

/** Раздел prsloy_lessons для модели: ≤5 уроков, ≤800 символов вместе с заголовком. Пусто — раздела нет. */
export function lessonsSection(
  lessons: Lesson[],
  family: string | undefined,
  session: string,
  off: Set<string> = new Set(),
): { text: string; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];
  for (const lesson of lessons) {
    if (lesson.mode !== "always" || lesson.delivery || !modelMatches(lesson, family)) continue;
    if (!usable(lesson, session, off)) continue;
    const line = `- ${lesson.text.trim()}`;
    const next = [LESSONS_HEADER, ...lines, line].join("\n");
    if (lines.length >= LESSONS_MAX || next.length > LESSONS_MAX_CHARS) continue;
    lines.push(line);
    ids.push(lesson.id);
  }
  return lines.length
    ? { text: [LESSONS_HEADER, ...lines].join("\n"), ids }
    : { text: "", ids: [] };
}

function globMatch(pattern: string | undefined, value: string | undefined): boolean {
  if (!pattern) return true;
  if (value === undefined) return false;
  const re = new RegExp(
    `^${pattern
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(value);
}

/** Ситуативный урок под событие: вид совпал, подпись подходит под маску. */
export function pickTip(
  lessons: Lesson[],
  family: string | undefined,
  session: string,
  event: { kind: LearningKind; sig?: string | undefined },
  off: Set<string> = new Set(),
): Lesson | undefined {
  return lessons.find(
    (l) =>
      l.mode === "on-event" &&
      l.trigger?.kind === event.kind &&
      globMatch(l.trigger.sig, event.sig) &&
      l.text.trim().length <= TIP_MAX_CHARS &&
      modelMatches(l, family) &&
      usable(l, session, off),
  );
}

interface Counter {
  shown: number;
  helped: number;
  hurt: number;
}

/** Счётчики и автоматическое выключение (§7.4: выключить — автоматически, включить — через ворота). */
export class LessonCounters {
  readonly #path: string;
  #data: { version: 1; lessons: Record<string, Counter> };

  constructor(path = join(learningDir(), "local-lessons.json")) {
    this.#path = path;
    this.#data = { version: 1, lessons: {} };
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf8")) as { lessons?: Record<string, Counter> };
        if (raw.lessons && typeof raw.lessons === "object") this.#data.lessons = raw.lessons;
      }
    } catch {
      // битый файл — с нуля
    }
  }

  get(id: string): Counter {
    return { shown: 0, helped: 0, hurt: 0, ...this.#data.lessons[id] };
  }

  bump(id: string, field: keyof Counter): void {
    const c = this.get(id);
    c[field] += 1;
    this.#data.lessons[id] = c;
  }

  /** hurt ≥ helped после ≥10 показов. */
  retired(id: string): boolean {
    const c = this.get(id);
    return c.shown >= 10 && c.hurt >= c.helped;
  }

  save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`);
      renameSync(tmp, this.#path);
    } catch {
      // счётчики — не повод ронять ход
    }
  }
}

interface SessionState {
  family: string | undefined;
  section: string;
  /** `attached` — событие, к которому совет дописан, ещё не пришло (оно не повтор). */
  shownThisTurn: {
    id: string;
    kind: LearningKind;
    sig: string | undefined;
    attached: boolean;
    recurred: boolean;
  }[];
}

const sessions = new Map<string, SessionState>();
let shared:
  | { lessons: Lesson[]; counters: LessonCounters; settingsPath: string | undefined }
  | undefined;

function sessionOf(ctx: ExtensionContext | undefined): string {
  try {
    return ctx?.sessionManager.getSessionId() ?? "";
  } catch {
    return "";
  }
}

function offSet(): Set<string> {
  if (!shared) return new Set();
  const flags = readFlags(shared.settingsPath);
  const off = new Set(flags.disabledLessons);
  for (const lesson of shared.lessons) if (shared.counters.retired(lesson.id)) off.add(lesson.id);
  return off;
}

/**
 * Совет из прошлых задач к возврату харнесса. Пусто — дописывать нечего. Возвращает и id для журнала.
 * Вызывать рядом с recordEvent того же вмешательства.
 */
export function lessonTip(
  ctx: ExtensionContext | undefined,
  event: { kind: LearningKind; sig?: string | undefined },
): { text: string; ids: string[] } {
  if (!shared || !readFlags(shared.settingsPath).lessons) return { text: "", ids: [] };
  const session = sessionOf(ctx);
  const state = sessions.get(session);
  const family = state?.family ?? modelFamily(ctx?.model?.id);
  const tip = pickTip(shared.lessons, family, session, event, offSet());
  if (!tip) return { text: "", ids: [] };
  shared.counters.bump(tip.id, "shown");
  shared.counters.save();
  state?.shownThisTurn.push({
    id: tip.id,
    kind: event.kind,
    sig: event.sig,
    attached: false,
    recurred: false,
  });
  return { text: `\n\n${TIP_PREFIX}${tip.text.trim()}`, ids: [tip.id] };
}

/**
 * Вмешательство харнесса: событие в журнал и совет из прошлых задач (если есть) — его дописывают в текст возврата.
 */
export function intervene(ctx: ExtensionContext | undefined, event: LearningEvent): string {
  const tip = lessonTip(ctx, event);
  recordEvent(ctx, tip.ids.length ? { ...event, lessons: tip.ids } : event);
  return tip.text;
}

export interface LessonsOptions {
  lessonsPath?: string | undefined;
  settingsPath?: string | undefined;
  countersPath?: string | undefined;
  /** Раздел памяти этой сессии (S4): общий бюджет с уроками — ≤3 800 символов. */
  memorySection?: (ctx: ExtensionContext) => string;
}

export function installLessons(pi: ExtensionAPI, options: LessonsOptions = {}): void {
  shared = {
    lessons: loadLessons(options.lessonsPath),
    counters: new LessonCounters(options.countersPath),
    settingsPath: options.settingsPath,
  };
  const state = shared;
  listenOnce();

  const freeze = (ctx: ExtensionContext) => {
    const session = sessionOf(ctx);
    const family = modelFamily(ctx.model?.id);
    const on = readFlags(state.settingsPath).lessons;
    const { text: raw, ids } = on
      ? lessonsSection(state.lessons, family, session, offSet())
      : { text: "", ids: [] };
    const text = fitPromptBudget({
      memory: options.memorySection?.(ctx) ?? "",
      lessons: raw,
    }).lessons;
    const previous = sessions.get(session);
    sessions.set(session, { family, section: text, shownThisTurn: previous?.shownThisTurn ?? [] });
    if (ids.length) recordEvent(ctx, { kind: "lessons.active", lessons: ids });
  };

  // Снимок уроков — один раз на сессию; новая модель — новый снимок (кэш при смене модели и так потерян).
  pi.on("session_start", (_event, ctx) => freeze(ctx));
  pi.on("model_select", (_event, ctx) => freeze(ctx));

  pi.on("before_agent_start", (event, ctx) => {
    // Сессия без session_start (загрузка расширения посреди сессии) — снимок на первом ходе.
    if (!sessions.has(sessionOf(ctx))) freeze(ctx);
    const s = sessions.get(sessionOf(ctx));
    if (event.messageType === "user" && s) s.shownThisTurn = [];
    if (s?.section) event.systemPromptOptions.sections.prsloy_lessons = s.section;
  });
}

let listening = false;

/**
 * Счётчики: совет помог — та же подпись больше не повторилась и ход зелёный; навредил — повторилась или ход
 * красный / кончился бюджет. Слушатель один на процесс: сессии различаются по id.
 */
function listenOnce(): void {
  if (listening) return;
  listening = true;
  onLearningEvent((session: string, event: LearningEvent) => {
    const s = sessions.get(session);
    if (!s || !shared) return;
    if (event.kind !== "turn.end") {
      for (const shown of s.shownThisTurn) {
        if (shown.kind !== event.kind || shown.sig !== event.sig) continue;
        if (!shown.attached) shown.attached = true;
        else shown.recurred = true;
      }
      return;
    }
    for (const shown of s.shownThisTurn) {
      if (shown.recurred || event.outcome === "red" || event.outcome === "budget")
        shared.counters.bump(shown.id, "hurt");
      else if (event.outcome === "green") shared.counters.bump(shown.id, "helped");
    }
    if (s.shownThisTurn.length) shared.counters.save();
    s.shownThisTurn = [];
  });
}
