// S0 из research/18-memory-self-learning.md (§6.2, §6.3, §10): журнал событий вмешательств харнесса — сырьё для
// уроков. Одна строка JSON на событие в `<папка агента>/prsloy-learning/events.jsonl`, ротация на 5 МБ (.1).
// Ни текста пользователя, ни путей, ни содержимого файлов: вид события, инструмент, подпись из имени команды и
// расширения файла, семейство модели, хэш папки проекта. Вся строка ещё раз проходит scrubSecrets.
// Поведение агента журнал не меняет: ошибка записи молча пропускается.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { scrubSecrets } from "./secret-scrub.ts";

/** Виды событий. Новые — только рядом с вмешательством харнесса (custom_message, карточка, счётчик). */
export type LearningKind =
  | "loop.warn"
  | "loop.stop"
  | "length.block"
  | "length.stop"
  | "pseudo.call"
  | "budget.warn"
  | "budget.stop"
  | "bash.timeout"
  | "server.bg"
  | "shell.block"
  | "secret.placeholder"
  | "gate.green"
  | "gate.red"
  | "gate.gaveup"
  | "gate.paths"
  | "gate.page"
  | "review.pass"
  | "review.fail"
  | "leak"
  | "leak.gaveup"
  | "repair"
  | "validation.error"
  | "lessons.active"
  | "memory.used"
  | "memory.saved"
  | "memory.forget"
  | "memory.refused"
  | "ask"
  | "secret.saved"
  | "secret.declined"
  | "install.offline"
  | "vague.nudge"
  | "stale_docs.armed"
  | "stale_docs.read_note"
  | "stale_docs.nudge"
  | "skill.loaded"
  | "skill.used"
  | "skill.routed"
  // Трубы research/24 §2: виды заведены заранее, чтобы core (память), harness (честность) и ci (разборщик) не
  // правили общий файл. Подпись `sig` — без текста пользователя, как у остальных.
  // Память сама (core, §3): кандидат экстрактора, запись, отказ проверки кодом, усиление, замена, откат, забывание.
  | "memory.auto.candidate"
  | "memory.auto.saved"
  | "memory.auto.refused"
  | "memory.auto.reinforced"
  | "memory.auto.superseded"
  | "memory.auto.reverted"
  | "memory.auto.expired"
  // Страж старых тестов (harness, §4.1 H1–H3): тронуты старые тесты, команда проверки изменилась, прогнана
  // исходная команда, сигнатура подмены (process.env.CI и т. п.), правка по просьбе пользователя (§4.3).
  | "test_guard.touched"
  | "test_guard.command_changed"
  | "test_guard.original_rerun"
  | "test_guard.signature"
  | "test_guard.allowed"
  | "test_quality.weak"
  | "test_quality.fail_to_pass"
  // Слова и факты (harness, §4.1 H-2): «проверил» без прогона харнесса, заглушки, «готово» при красном.
  | "claim.unverified"
  | "claim.stub"
  | "claim.false_done"
  | "claim.same_red"
  // Честный выход (harness, §4.2): блокер заявлен, принят кодом, отклонён.
  | "blocker.reported"
  | "blocker.accepted"
  | "blocker.rejected"
  // Разборщик сессий (ci, §6): находка детектора, прогон разбора.
  | "audit.finding"
  | "audit.run"
  | "turn.end";

export type TurnOutcome = "green" | "red" | "budget" | "aborted" | "error";

export interface LearningEvent {
  kind: LearningKind;
  /** Имя инструмента. */
  tool?: string;
  /** Подпись без путей и текста: `bash:npm test`, `write:.html`, `repair:wrapper`. */
  sig?: string;
  /** Число (замечаний ревью, вызовов за ход). */
  n?: number;
  outcome?: TurnOutcome;
  /** id уроков, которые действовали (раздел) или были дописаны к этому возврату. */
  lessons?: string[];
}

type Listener = (session: string, event: LearningEvent) => void;
const listeners = new Set<Listener>();

/** Подписка на события (уроки считают повторы подписи после совета и итог хода). */
export function onLearningEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const LEARNING_MAX_BYTES = 5 * 1024 * 1024;

let dir: string | undefined;
let enabled = true;
let maxBytes = LEARNING_MAX_BYTES;

/** Куда писать: PRSLOY_LEARN_DIR, иначе `$PI_CODING_AGENT_DIR/prsloy-learning`, иначе временная папка. */
export function learningDir(): string {
  if (dir) return dir;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  return (
    process.env.PRSLOY_LEARN_DIR ??
    (agentDir
      ? join(agentDir, "prsloy-learning")
      : join(tmpdir(), "prsloy-harness", "prsloy-learning"))
  );
}

export function configureLearning(options: {
  dir?: string | undefined;
  enabled?: boolean;
  /** Порог ротации (тесты). */
  maxBytes?: number;
}): void {
  if (options.dir !== undefined) dir = options.dir;
  if (options.enabled !== undefined) enabled = options.enabled;
  if (options.maxBytes !== undefined) maxBytes = options.maxBytes;
}

/** `prsloy/deepseek-v4.1-flash-1017` → `deepseek-v4.1-flash`: без поставщика и номера сборки. */
export function modelFamily(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.replace(/^[^/]*\//, "").replace(/-\d{3,}$/, "");
}

/**
 * Хэш папки проекта — тот же, что у теневых снимков ядра (`workspaceKey` в main/prsloy/turn-snapshots.ts):
 * sha256(resolve(путь) без хвостового слэша)[:16], на Windows без учёта регистра. Main находит ту же папку памяти.
 */
export function projectKey(cwd: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = resolve(cwd).replace(/[\\/]+$/u, "");
  const keyed = platform === "win32" ? normalized.toLowerCase() : normalized;
  return createHash("sha256").update(keyed).digest("hex").slice(0, 16);
}

const PACKAGE_TOOLS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "pip",
  "pip3",
  "git",
  "cargo",
  "go",
  "uv",
]);

/**
 * Подпись вызова без путей и текста пользователя: имя программы (без папки и `.exe`) и для менеджеров пакетов —
 * подкоманда (`npm test`); у файловых инструментов — только расширение (`write:.html`).
 */
export function callSignature(tool: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  if (
    (tool === "bash" || tool === "bash_background" || tool === "powershell") &&
    typeof args.command === "string"
  ) {
    const tokens = args.command
      .trim()
      .split(/\s+/)
      .filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    const program = (tokens[0] ?? "")
      .replace(/^["'(]+/, "")
      .split(/[\\/]/)
      .pop()!
      .replace(/\.exe$/i, "")
      .toLowerCase();
    const safe = /^[a-z0-9][a-z0-9._+-]{0,23}$/.test(program) ? program : "?";
    const sub = tokens[1] ?? "";
    return PACKAGE_TOOLS.has(safe) && /^[a-z][a-z-]{1,15}$/.test(sub)
      ? `${tool}:${safe} ${sub}`
      : `${tool}:${safe}`;
  }
  const path =
    typeof args.path === "string"
      ? args.path
      : typeof args.file_path === "string"
        ? args.file_path
        : "";
  if (path) {
    const ext = /\.([A-Za-z0-9]{1,6})$/.exec(path)?.[1]?.toLowerCase();
    return `${tool}:${ext ? `.${ext}` : "-"}`;
  }
  return tool;
}

interface TurnTrack {
  calls: number;
  red: boolean;
  gaveUp: boolean;
  budget: boolean;
  settleOutcome: string | undefined;
}

const turns = new Map<string, TurnTrack>();

function sessionOf(ctx: ExtensionContext | undefined): string {
  try {
    return ctx?.sessionManager.getSessionId() ?? "";
  } catch {
    return "";
  }
}

function track(session: string): TurnTrack {
  let t = turns.get(session);
  if (!t) {
    t = { calls: 0, red: false, gaveUp: false, budget: false, settleOutcome: undefined };
    turns.set(session, t);
  }
  return t;
}

function rotate(file: string, incoming: number): void {
  try {
    if (statSync(file).size + incoming > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // файла ещё нет
  }
}

/** Пишет событие. Не бросает: журнал не должен ломать ход. */
export function recordEvent(ctx: ExtensionContext | undefined, event: LearningEvent): void {
  const session = sessionOf(ctx);
  const t = track(session);
  if (event.kind === "gate.red") t.red = true;
  if (event.kind === "gate.green") t.red = false;
  if (event.kind === "gate.gaveup" || event.kind === "leak.gaveup") t.gaveUp = true;
  if (event.kind === "budget.stop") t.budget = true;
  for (const listener of listeners) {
    try {
      listener(session, event);
    } catch {
      // слушатель — не повод ронять ход
    }
  }
  if (!enabled) return;
  try {
    const line = {
      ts: new Date().toISOString(),
      surface: "code",
      ...(process.env.PRSLOY_APP_VERSION ? { app: process.env.PRSLOY_APP_VERSION } : {}),
      session,
      ...(ctx?.cwd ? { project: projectKey(ctx.cwd) } : {}),
      ...(modelFamily(ctx?.model?.id) ? { model: modelFamily(ctx?.model?.id) } : {}),
      profile: process.env.PRSLOY_PROFILE ?? "code",
      ...event,
    };
    const text = `${scrubSecrets(JSON.stringify(line)).text}\n`;
    const folder = learningDir();
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "events.jsonl");
    rotate(file, Buffer.byteLength(text));
    appendFileSync(file, text);
  } catch {
    // журнал — не повод ронять ход
  }
}

/** Итог хода по тому, что харнесс видел: стоп пользователя, бюджет, красная проверка, ошибка, иначе зелёный. */
export function turnOutcome(t: TurnTrack, aborted: boolean): TurnOutcome {
  if (aborted) return "aborted";
  if (t.budget) return "budget";
  if (t.gaveUp || t.red) return "red";
  if (t.settleOutcome && t.settleOutcome !== "completed")
    return t.settleOutcome === "aborted" ? "aborted" : "error";
  return "green";
}

/** Счёт хода и `turn.end`. Ставится первым, чтобы видеть все вызовы. */
export function installLearningLog(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "user") return;
    turns.set(sessionOf(ctx), {
      calls: 0,
      red: false,
      gaveUp: false,
      budget: false,
      settleOutcome: undefined,
    });
  });
  pi.on("tool_call", (event, ctx) => {
    if (!event.parentToolCallId) track(sessionOf(ctx)).calls += 1;
    return undefined;
  });
  pi.on("agent_before_settle", (event, ctx) => {
    track(sessionOf(ctx)).settleOutcome = event.outcome;
    return undefined;
  });
  pi.on("agent_settled", (event, ctx) => {
    const t = track(sessionOf(ctx));
    recordEvent(ctx, { kind: "turn.end", outcome: turnOutcome(t, event.aborted), n: t.calls });
  });
}
