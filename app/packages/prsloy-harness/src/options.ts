import { tmpdir } from "node:os";
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
  | "reusePrompt";

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

export function resolveOptions(options: HarnessOptions = {}): ResolvedOptions {
  return {
    profile: options.profile ?? envProfile() ?? "code",
    bashTimeoutSec: options.bashTimeoutSec ?? 120,
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
    disable: options.disable ?? {},
  };
}
