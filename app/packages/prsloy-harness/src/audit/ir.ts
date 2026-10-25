// Разборщик сессий (research/23 §7, research/24 §6 A-0): нормализатор. Pi JSONL сессии «Кода» и «Дизайна»
// (дизайн — тоже Pi, его гоняет run.py дирижёра) → шаги [S1…Sn] с ролью, инструментом, аргументами, isError,
// головой и хвостом результата, заметками харнесса и финальным текстом. Картинки и размышления выбрасываются:
// детекторам они не нужны, а шаг дизайна с картинками доходит до 93 МБ.
// Для дизайна рядом с сессией читаются turns.jsonl (реплики владельца и вопросы агента) и events/*.jsonl.
// Ничего не пишет и ничего не отправляет — только читает.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Сколько символов результата инструмента оставляем: голова и хвост (research/23 §1, «вид для аудитора»). */
export const RESULT_LIMIT = 600;
/** Сколько символов аргументов вызова оставляем в `argsText`. */
export const ARGS_LIMIT = 2000;

export type Surface = "code" | "design";

export type StepRole = "user" | "assistant" | "tool" | "harness";

export interface Step {
  /** «S1», «S2», … — сквозная нумерация по сессии. */
  id: string;
  /** Номер хода: растёт на каждом сообщении пользователя (до первого — 0). */
  turn: number;
  role: StepRole;
  /** Текст: реплика пользователя, текст ассистента, голова и хвост результата, заметка харнесса. */
  text: string;
  /** Для вызова (role assistant с вызовом) и результата (role tool). */
  tool?: string;
  callId?: string;
  args?: Record<string, unknown>;
  /** Аргументы одной строкой (bash — сама команда), до ARGS_LIMIT. */
  argsText?: string;
  isError?: boolean;
  /** Вид заметки харнесса (`prsloy-harness.stop-gate` …). */
  customType?: string;
  /** stopReason ассистента: stop | toolUse | length | error | aborted. */
  stopReason?: string;
  errorMessage?: string;
  model?: string;
  ts?: string;
}

export interface OwnerTurn {
  n: number;
  /** Что владелец написал агенту. */
  sent: string;
  /** Вопрос агента владельцу в конце шага, если был. */
  question?: string;
  tools?: number;
}

export interface Session {
  /** id из записи `session` или имя файла. */
  id: string;
  file: string;
  surface: Surface;
  model?: string;
  /** Задача стенда (из пути `…/<task>/…` или bench-*.json), шаг дизайна. */
  task?: string;
  cwd?: string;
  steps: Step[];
  /** Реплики владельца и вопросы агента (дизайн, turns.jsonl). */
  owner?: OwnerTurn[];
  /** Исход проверки стенда `check.mjs` (bench-*.json), если известен. */
  benchOk?: boolean;
}

interface Part {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

const partsOf = (content: unknown): Part[] =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? (content as Part[])
      : [];

const textOf = (content: unknown): string =>
  partsOf(content)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");

/** Голова и хвост длинного текста: детекторам нужно начало вывода и строка с кодом выхода в конце. */
export function headTailText(text: string, limit = RESULT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.round(limit * 0.4);
  return `${text.slice(0, head)}\n…\n${text.slice(text.length - (limit - head))}`;
}

function argsLine(args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    if (typeof a.command === "string") return a.command.slice(0, ARGS_LIMIT);
  }
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    s = String(args);
  }
  return s.slice(0, ARGS_LIMIT);
}

const asArgs = (args: unknown): Record<string, unknown> | undefined => {
  if (args && typeof args === "object" && !Array.isArray(args))
    return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // сорванные аргументы — оставляем только строку
    }
  }
  return undefined;
};

/** Разбор JSONL без падения на битой строке (журналы обрываются на полуслове). */
export function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // битая строка — пропуск
    }
  }
  return out;
}

/** Похоже ли содержимое файла на сессию Pi: первая запись `session` или записи `message`. */
export function isPiSession(entries: readonly unknown[]): boolean {
  const first = entries[0] as { type?: string } | undefined;
  if (first?.type === "session") return true;
  return entries
    .slice(0, 20)
    .some((e) => (e as { type?: string; message?: unknown }).type === "message");
}

export interface NormalizeOptions {
  file: string;
  surface?: Surface;
  task?: string;
}

/** Pi JSONL → Session. Понимает записи `session`, `model_change`, `message` (user/assistant/toolResult/custom),
 * `custom_message` (заметки харнесса). Остальное (компакция, метки) пропускает. */
export function normalizePi(entries: readonly unknown[], options: NormalizeOptions): Session {
  const steps: Step[] = [];
  let id = options.file.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, "");
  let cwd: string | undefined;
  let model: string | undefined;
  let turn = 0;
  const toolNames = new Map<string, string>();
  const push = (step: Omit<Step, "id" | "turn">) =>
    steps.push({ id: `S${steps.length + 1}`, turn, ...step });

  for (const raw of entries) {
    const e = raw as Record<string, unknown>;
    const ts = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (e.type === "session") {
      if (typeof e.id === "string") id = e.id;
      if (typeof e.cwd === "string") cwd = e.cwd;
      continue;
    }
    if (e.type === "model_change") {
      if (typeof e.modelId === "string") model = e.modelId;
      continue;
    }
    if (e.type === "custom_message") {
      push({
        role: "harness",
        text: textOf(e.content),
        ...(typeof e.customType === "string" ? { customType: e.customType } : {}),
        ...(ts ? { ts } : {}),
      });
      continue;
    }
    if (e.type !== "message") continue;
    const m = (e.message ?? {}) as Record<string, unknown>;
    const role = m.role;
    if (role === "user") {
      turn += 1;
      push({ role: "user", text: textOf(m.content), ...(ts ? { ts } : {}) });
    } else if (role === "assistant") {
      if (typeof m.model === "string") model = m.model;
      const parts = partsOf(m.content);
      const text = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
      const meta = {
        ...(typeof m.stopReason === "string" ? { stopReason: m.stopReason } : {}),
        ...(typeof m.errorMessage === "string" ? { errorMessage: m.errorMessage } : {}),
        ...(typeof m.model === "string" ? { model: m.model } : {}),
        ...(ts ? { ts } : {}),
      };
      const calls = parts.filter((p) => p.type === "toolCall");
      if (text.trim() || calls.length === 0) push({ role: "assistant", text, ...meta });
      for (const c of calls) {
        const name = typeof c.name === "string" ? c.name : "?";
        if (typeof c.id === "string") toolNames.set(c.id, name);
        const args = asArgs(c.arguments);
        push({
          role: "assistant",
          text: "",
          tool: name,
          ...(typeof c.id === "string" ? { callId: c.id } : {}),
          ...(args ? { args } : {}),
          argsText: argsLine(c.arguments),
          ...meta,
        });
      }
    } else if (role === "toolResult") {
      const callId = typeof m.toolCallId === "string" ? m.toolCallId : undefined;
      const tool =
        typeof m.toolName === "string" ? m.toolName : callId ? toolNames.get(callId) : undefined;
      push({
        role: "tool",
        text: headTailText(textOf(m.content)),
        ...(tool ? { tool } : {}),
        ...(callId ? { callId } : {}),
        isError: m.isError === true,
        ...(ts ? { ts } : {}),
      });
    } else if (role === "custom") {
      push({
        role: "harness",
        text: textOf(m.content),
        ...(typeof m.customType === "string" ? { customType: m.customType } : {}),
        ...(ts ? { ts } : {}),
      });
    }
  }
  return {
    id,
    file: options.file,
    surface: options.surface ?? "code",
    ...(model ? { model } : {}),
    ...(options.task ? { task: options.task } : {}),
    ...(cwd ? { cwd } : {}),
    steps,
  };
}

/** turns.jsonl дирижёра: `{n, sent, question?, tools?}` на строку. */
export function parseOwnerTurns(entries: readonly unknown[]): OwnerTurn[] {
  const out: OwnerTurn[] = [];
  for (const raw of entries) {
    const t = raw as Record<string, unknown>;
    if (typeof t.n !== "number") continue;
    out.push({
      n: t.n,
      sent: typeof t.sent === "string" ? t.sent : "",
      ...(typeof t.question === "string" && t.question.trim() ? { question: t.question } : {}),
      ...(typeof t.tools === "number" ? { tools: t.tools } : {}),
    });
  }
  return out;
}

// --- выборки, которыми пользуются детекторы ---

/** Вызовы инструментов (шаги ассистента с `tool`). */
export const calls = (s: Session | readonly Step[]): Step[] =>
  ("steps" in s ? s.steps : s).filter((x) => x.role === "assistant" && x.tool);

/** Результат вызова по callId (или следующий шаг tool, если id нет). */
export function resultOf(steps: readonly Step[], call: Step): Step | undefined {
  const i = steps.indexOf(call);
  for (let j = i + 1; j < steps.length; j++) {
    const s = steps[j]!;
    if (s.role === "tool" && (!call.callId || s.callId === call.callId)) return s;
    if (s.role === "user") break;
  }
  return undefined;
}

/** Шаги одного хода. */
export const turnSteps = (s: Session, turn: number): Step[] =>
  s.steps.filter((x) => x.turn === turn);

/** Номера ходов, в которых был ассистент. */
export function turnsOf(s: Session): number[] {
  return [...new Set(s.steps.filter((x) => x.role === "assistant").map((x) => x.turn))];
}

/** Финальный текст хода: последний текст ассистента без вызова. */
export function finalOf(steps: readonly Step[]): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;
    if (s.role === "assistant" && !s.tool) return s;
    if (s.role === "assistant" && s.tool) return undefined;
  }
  return undefined;
}

/** Путь файла из аргументов write/edit (Pi: `path`, иногда `file_path`). */
export function pathArg(step: Step): string | undefined {
  const a = step.args;
  if (!a) return undefined;
  for (const k of ["path", "file_path", "filePath", "file"]) {
    if (typeof a[k] === "string") return a[k] as string;
  }
  return undefined;
}

export const isWrite = (s: Step) => s.tool === "write" || s.tool === "edit";
export const isBash = (s: Step) => s.tool === "bash";

// --- загрузка корпуса с диска ---

/** base64 картинок в строке: вырезаем до JSON.parse — шаг дизайна с картинками весит до 93 МБ. */
const BASE64_RUN =
  /"(?:data|image_url|url)":\s*"(?:data:[^"]{0,64};base64,)?[A-Za-z0-9+/=]{2000,}"/g;

export function readJsonl(file: string): unknown[] {
  const text = readFileSync(file, "utf8");
  return parseLines(text.length > 1_000_000 ? text.replace(BASE64_RUN, '"data":""') : text);
}

/** Все *.jsonl под папкой (без node_modules и .git). */
export function findJsonl(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) out.push(p);
    }
  };
  if (statSync(root).isFile()) return [root];
  walk(root);
  return out.sort();
}

/** Ближайший файл с таким именем в папке сессии или выше (до 3 уровней). */
function nearby(file: string, name: string): string | undefined {
  let dir = dirname(file);
  for (let i = 0; i < 4; i++) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** Признаки прогона «Дизайна» дирижёра рядом с сессией: реплики, журнал шагов, сообщения владельца. */
const DESIGN_MARKERS = [
  "turns.jsonl",
  "ledger.jsonl",
  join("owner", "messages.jsonl"),
  "STATUS.md",
];

/** Имя задачи из пути: ближайшая папка, которая не служебная. */
function taskFromPath(file: string): string | undefined {
  const skip = /^(?:sessions?|events|run|runs|out|logs?|\d[\d-]*|--.*--)$/i;
  let dir = dirname(file);
  for (let i = 0; i < 3; i++) {
    const name = basename(dir);
    if (name && !skip.test(name)) return name;
    dir = dirname(dir);
  }
  return undefined;
}

export interface LoadOptions {
  surface?: Surface;
}

/** Сессии Pi под папкой. Файлы, которые не похожи на сессию (журналы событий, turns), пропускаются. */
export function loadSessions(root: string, options: LoadOptions = {}): Session[] {
  const out: Session[] = [];
  const turnsCache = new Map<string, OwnerTurn[]>();
  for (const file of findJsonl(root)) {
    if (/(?:^|[\\/])(?:turns|events|ledger|messages|owner-messages)\.jsonl$/.test(file)) continue;
    const entries = readJsonl(file);
    if (!isPiSession(entries)) continue;
    const turnsFile = nearby(file, "turns.jsonl");
    const surface =
      options.surface ?? (DESIGN_MARKERS.some((m) => nearby(file, m)) ? "design" : "code");
    const task = taskFromPath(file);
    const session = normalizePi(entries, { file, surface, ...(task ? { task } : {}) });
    if (turnsFile && surface === "design") {
      if (!turnsCache.has(turnsFile))
        turnsCache.set(turnsFile, parseOwnerTurns(readJsonl(turnsFile)));
      const owner = turnsCache.get(turnsFile)!;
      if (owner.length) session.owner = owner;
    }
    out.push(session);
  }
  applyBench(root, out);
  return out;
}

interface BenchFile {
  meta?: { model?: string };
  results?: { id?: string; task?: string; ok?: boolean | null }[];
}

/** bench-*.json рядом с `sessions/<задача>/`: исход check.mjs по задаче → benchOk (для D2). */
export function applyBench(root: string, sessions: Session[]): void {
  let files: string[] = [];
  try {
    files = findFiles(root, /^bench-.*\.json$/);
  } catch {
    return;
  }
  for (const file of files) {
    let data: BenchFile;
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as BenchFile;
    } catch {
      continue;
    }
    const dir = dirname(file);
    for (const r of data.results ?? []) {
      const task = r.id ?? r.task;
      if (!task || typeof r.ok !== "boolean") continue;
      const prefix = join(dir, "sessions", task);
      for (const s of sessions) {
        if (!s.file.startsWith(prefix)) continue;
        s.benchOk = r.ok;
        s.task = task;
        if (!s.model && data.meta?.model) s.model = data.meta.model;
      }
    }
  }
}

function findFiles(root: string, name: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      if (n === "node_modules" || n === ".git") continue;
      const p = join(dir, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.test(n)) out.push(p);
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  return out;
}
