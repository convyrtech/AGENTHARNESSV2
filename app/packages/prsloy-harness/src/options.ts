import type { PageCheckOptions } from "./page-check.ts";
import { tmpdir } from "node:os";
import type { FindReadyOptions } from "./find-ready.ts";
import type { ReliabilityOptions } from "./reliability-proxy.ts";
import { join } from "node:path";

/** Профиль агента. Раздел «поиск готового» добавляется только в «Код». */
export type HarnessProfile = "code" | "design" | "text" | "other";

export interface HarnessOptions {
  /** Профиль сессии. По умолчанию `code`. */
  profile?: HarnessProfile;
  /** Таймаут bash по умолчанию, секунды. */
  bashTimeoutSec?: number;
  /** Верхняя граница таймаута, который модель может попросить сама, секунды. */
  bashMaxTimeoutSec?: number;
  /** Сколько вызовов одного тула с одними аргументами и тем же результатом дают предупреждение. */
  loopWarnAt?: number;
  /** На каком повторе задача останавливается. */
  loopAbortAt?: number;
  /** Лимит вызовов тулов на задачу (одно сообщение пользователя). */
  maxToolCalls?: number;
  /** Лимит денег на задачу, доллары по ценам шлюза из таблицы моделей. */
  maxCostUsd?: number;
  /** Доля бюджета, на которой модель получает предупреждение. */
  budgetWarnRatio?: number;
  /** Сколько байт результата тула идёт в контекст как есть. */
  inlineLimitBytes?: number;
  /** Куда сохранять полный вывод, который не влез. */
  outputDir?: string;
  /** Python для проверки `.py`. Без него пробуем python3/python/py на PATH. */
  pythonPath?: string;
  /** Node для `node --check`. По умолчанию текущий процесс (Electron с ELECTRON_RUN_AS_NODE=1). */
  nodePath?: string;
  /** Путь к bash, как `shellPath` в настройках Pi. Нужен фоновым процессам, если Git Bash не на месте. */
  shellPath?: string;
  /** Окружение фоновых процессов. По умолчанию копия process.env без ключей машины. */
  backgroundEnv?: () => NodeJS.ProcessEnv;
  /** Провайдеры, чьи запросы идут через прокси надёжности. По умолчанию `prsloy` (env PRSLOY_RELIABILITY_PROVIDERS). */
  reliabilityProviders?: string[];
  /** Настройки прокси: ttft, idle, попытки. TTFT по умолчанию 60 с (env PRSLOY_PROXY_TTFT_SEC). */
  reliability?: ReliabilityOptions;
  /** Тул find_ready: таймаут, кэш, свой fetch (тесты). */
  findReady?: FindReadyOptions;
  /** Куда раскладывать навыки (по умолчанию `$PI_CODING_AGENT_DIR/prsloy-skills`). */
  skillsDir?: string;
  /** Проверка страницы в браузере: Python «Дизайна» (по умолчанию PRSLOY_DESIGN_PYTHON) или Node-Playwright. */
  pageCheck?: PageCheckOptions;
  /** Стоп-гейт «до зелёного»: таймаут проверки проекта, мс. По умолчанию 120 с (env PRSLOY_STOP_GATE_TIMEOUT_SEC). */
  stopGateTimeoutMs?: number;
  /** Ревью диффа моделью другой семьи: `провайдер/модель` вместо пары (env PRSLOY_REVIEW_MODEL), таймаут. */
  review?: { model?: string; timeoutMs?: number };
  /** Файл флагов приложения (`{"secondOpinion": false}`). По умолчанию `$PI_CODING_AGENT_DIR/prsloy-harness.json`. */
  settingsPath?: string;
  /** git для снимков хода. По умолчанию PRSLOY_GIT, git рядом с Git Bash, иначе `git` с PATH. */
  gitPath?: string;
  /** Папка памяти. По умолчанию `$PI_CODING_AGENT_DIR/prsloy-memory` (env PRSLOY_MEMORY_DIR). */
  memoryDir?: string;
  /** Файл уроков. По умолчанию lessons/code.json пакета. */
  lessonsPath?: string;
  /** Куда писать журнал событий (events.jsonl). По умолчанию `$PI_CODING_AGENT_DIR/prsloy-learning`. */
  learningDir?: string;
  /** Выключить отдельные практики. */
  disable?: Partial<Record<PracticeName, boolean>>;
}

export type PracticeName =
  | "bashTimeout"
  | "loopDetector"
  | "budget"
  | "toolOutput"
  | "postEditVerify"
  | "editRobustness"
  | "secretScrub"
  | "reusePrompt"
  | "reliabilityProxy"
  | "findReady"
  | "stopGate"
  | "toolLeak"
  | "argRepair"
  | "learningLog"
  | "lessons"
  | "memory"
  | "digest"
  | "secondOpinion"
  | "turnChanges"
  | "askUser"
  | "requestSecret"
  | "pagePaths"
  | "pageCheck"
  | "skills"
  | "vagueRequest";

export interface ResolvedOptions {
  profile: HarnessProfile;
  bashTimeoutSec: number;
  bashMaxTimeoutSec: number;
  loopWarnAt: number;
  loopAbortAt: number;
  maxToolCalls: number;
  maxCostUsd: number;
  budgetWarnRatio: number;
  inlineLimitBytes: number;
  outputDir: string;
  pythonPath: string | undefined;
  nodePath: string | undefined;
  shellPath: string | undefined;
  backgroundEnv: () => NodeJS.ProcessEnv;
  reliabilityProviders: string[];
  reliability: ReliabilityOptions;
  findReady: FindReadyOptions;
  pageCheck: PageCheckOptions;
  skillsDir: string | undefined;
  stopGateTimeoutMs: number;
  review: { model?: string; timeoutMs: number };
  settingsPath: string | undefined;
  gitPath: string | undefined;
  learningDir: string | undefined;
  lessonsPath: string | undefined;
  memoryDir: string | undefined;
  disable: Partial<Record<PracticeName, boolean>>;
}

/** Переменные, которые агенту не отдаём (CONTEXT.md: «агентам не отдавать ключи машины»). */
const MACHINE_SECRET_ENV =
  /^(AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$|GH_TOKEN$|GITHUB_TOKEN$|NPM_TOKEN$|.*_API_KEY$|.*_SECRET(_ACCESS_KEY)?$|.*_TOKEN$)/i;

export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!MACHINE_SECRET_ENV.test(key)) out[key] = value;
  }
  return out;
}

const PROFILES: readonly HarnessProfile[] = ["code", "design", "text", "other"];

/** При загрузке по пути (extensionPaths) настроек нет — профиль можно передать через PRSLOY_PROFILE. */
function envProfile(): HarnessProfile | undefined {
  const value = process.env.PRSLOY_PROFILE;
  return PROFILES.find((profile) => profile === value);
}

/**
 * Таймаут bash из PRSLOY_BASH_TIMEOUT_SEC (секунды). Нужен там, где настроек нет: загрузка по пути и
 * smoke-проверка установленного приложения с коротким таймаутом.
 */
function envBashTimeout(): number | undefined {
  const value = Number(process.env.PRSLOY_BASH_TIMEOUT_SEC);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function envProviders(): string[] | undefined {
  const value = process.env.PRSLOY_RELIABILITY_PROVIDERS;
  if (value === undefined) return undefined;
  if (value.trim() === "0") return [];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function envTtftMs(): number | undefined {
  const value = Number(process.env.PRSLOY_PROXY_TTFT_SEC);
  return Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
}

function reliabilityOptions(given: ReliabilityOptions | undefined): ReliabilityOptions {
  const ttftMs = envTtftMs();
  return ttftMs === undefined ? { ...given } : { ttftMs, ...given };
}

function reviewOptions(given: HarnessOptions["review"]): ResolvedOptions["review"] {
  const model = given?.model ?? process.env.PRSLOY_REVIEW_MODEL;
  const timeoutMs =
    given?.timeoutMs ?? (Number(process.env.PRSLOY_REVIEW_TIMEOUT_SEC) * 1000 || 120_000);
  return model ? { model, timeoutMs } : { timeoutMs };
}

function defaultSettingsPath(): string | undefined {
  const dir = process.env.PI_CODING_AGENT_DIR;
  return dir ? join(dir, "prsloy-harness.json") : undefined;
}

export function resolveOptions(options: HarnessOptions = {}): ResolvedOptions {
  return {
    profile: options.profile ?? envProfile() ?? "code",
    bashTimeoutSec: options.bashTimeoutSec ?? envBashTimeout() ?? 120,
    bashMaxTimeoutSec: options.bashMaxTimeoutSec ?? 600,
    loopWarnAt: options.loopWarnAt ?? 3,
    loopAbortAt: options.loopAbortAt ?? 5,
    maxToolCalls: options.maxToolCalls ?? 150,
    maxCostUsd: options.maxCostUsd ?? 0.5,
    budgetWarnRatio: options.budgetWarnRatio ?? 0.8,
    inlineLimitBytes: options.inlineLimitBytes ?? 30 * 1024,
    outputDir: options.outputDir ?? join(tmpdir(), "prsloy-harness"),
    pythonPath: options.pythonPath ?? process.env.PRSLOY_PYTHON,
    nodePath: options.nodePath,
    shellPath: options.shellPath,
    backgroundEnv: options.backgroundEnv ?? (() => sanitizedEnv()),
    reliabilityProviders: options.reliabilityProviders ?? envProviders() ?? ["prsloy"],
    reliability: reliabilityOptions(options.reliability),
    findReady: options.findReady ?? {},
    pageCheck: options.pageCheck ?? {},
    skillsDir: options.skillsDir,
    stopGateTimeoutMs:
      options.stopGateTimeoutMs ??
      (Number(process.env.PRSLOY_STOP_GATE_TIMEOUT_SEC) * 1000 || 120_000),
    review: reviewOptions(options.review),
    settingsPath: options.settingsPath ?? defaultSettingsPath(),
    gitPath: options.gitPath ?? process.env.PRSLOY_GIT,
    learningDir: options.learningDir,
    lessonsPath: options.lessonsPath,
    memoryDir: options.memoryDir,
    disable: options.disable ?? {},
  };
}
