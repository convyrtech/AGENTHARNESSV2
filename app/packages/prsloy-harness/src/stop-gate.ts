// ADR-6 (research/00-synthesis.md): стоп-гейт «до зелёного» с капом продолжений — шаблон Stop-хука Claude Code;
// Harness² (research/06-harness2.md): verify-скрипт 43 → 78. Когда ход в профиле «Код» заканчивается после
// правок, харнесс дёшево проверяет проект его же проверкой и, если красно, возвращает модель к работе — не больше
// двух раз за сообщение пользователя. Хук Pi 1.4: agent_before_settle (записи + одно продолжение).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BudgetHandle } from "./budget.ts";
import { sanitizedEnv, type ResolvedOptions } from "./options.ts";
import {
  changedLines,
  clipDiff,
  parseVerdict,
  REVIEW_PASS_CARD,
  reviewFailCard,
  reviewPrompt,
  reviewPushback,
  type ReviewVerdict,
} from "./second-opinion.ts";
import type { Reviewer } from "./reviewer.ts";
import { headTail, showCard } from "./text.ts";
import type { TurnChanges } from "./turn-changes.ts";
import { modelFamily, recordEvent } from "./learning-log.ts";
import { checkPagePaths, type PagePathReport, pagePathsMessage } from "./page-paths.ts";
import { intervene } from "./lessons.ts";

export interface ProjectCheck {
  /** Команда оболочки, из каталога проекта. */
  command: string;
  /** Что это за проверка — для сообщения модели. */
  label: string;
  /** Вывод, по которому видно, что проверять нечем (pytest не установлен и т. п.): тогда молчим. */
  missingTool?: RegExp;
}

export interface CheckRun {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export type CheckRunner = (
  check: ProjectCheck,
  cwd: string,
  timeoutMs: number,
) => Promise<CheckRun>;

// `npm init` кладёт заглушку test, которая всегда падает: это не проверка проекта.
const NPM_PLACEHOLDER_TEST = /no test specified/i;

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function onPath(binary: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [binary], { stdio: "ignore", windowsHide: true }).status === 0;
}

function hasPythonTests(cwd: string, depth = 3): boolean {
  if (depth < 0 || !existsSync(cwd)) return false;
  let entries: string[];
  try {
    entries = readdirSync(cwd);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (
      name === "node_modules" ||
      name.startsWith(".") ||
      name === "venv" ||
      name === "__pycache__"
    )
      continue;
    if (/^test_.*\.py$|_test\.py$/.test(name)) return true;
    const path = join(cwd, name);
    try {
      if (readdirSync(path) && hasPythonTests(path, depth - 1)) return true;
    } catch {
      // не каталог
    }
  }
  return false;
}

function packageManager(cwd: string): string {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

/**
 * Своя проверка проекта, по порядку: скрипты package.json (test, затем typecheck и lint, если есть), pytest,
 * cargo test, go test. undefined — проверять нечем (сайт из одного HTML, проект без тестов): гейт молчит.
 */
export function detectProjectCheck(
  cwd: string,
  hasBinary: (name: string) => boolean = onPath,
): ProjectCheck | undefined {
  const pkg = readJson(join(cwd, "package.json"));
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    const names = ["test", "typecheck", "lint"].filter((name) => {
      const script = scripts[name];
      return (
        typeof script === "string" &&
        script.trim() &&
        !(name === "test" && NPM_PLACEHOLDER_TEST.test(script))
      );
    });
    const deps = {
      ...(pkg.dependencies as object | undefined),
      ...(pkg.devDependencies as object | undefined),
    };
    // Зависимости не поставлены — дёшево проверить нельзя, а «почини» про npm install — не то, о чём гейт.
    const pm = packageManager(cwd);
    // Нет менеджера пакетов на PATH — «is not recognized» было бы не красным проектом, а нашей ошибкой.
    if (
      names.length > 0 &&
      hasBinary(pm) &&
      (Object.keys(deps).length === 0 || existsSync(join(cwd, "node_modules")))
    ) {
      return {
        command: names.map((name) => `${pm} run ${name}`).join(" && "),
        label: names.map((name) => `${pm} run ${name}`).join(" && "),
      };
    }
  }
  const python = process.platform === "win32" ? "python" : "python3";
  if (hasPythonTests(cwd) && hasBinary(python)) {
    return {
      command: `${python} -m pytest -q -x`,
      label: "pytest",
      missingTool:
        /No module named pytest|python3?: (?:command )?not found|is not recognized as an internal or external command/i,
    };
  }
  if (existsSync(join(cwd, "Cargo.toml")) && hasBinary("cargo"))
    return { command: "cargo test -q", label: "cargo test" };
  if (existsSync(join(cwd, "go.mod")) && hasBinary("go"))
    return { command: "go test ./...", label: "go test" };
  return undefined;
}

/** Запуск проверки: оболочка ОС, окружение без ключей машины, таймаут с остановкой дерева процессов. */
export const runProjectCheck: CheckRunner = (check, cwd, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(check.command, {
      cwd,
      shell: true,
      env: { ...sanitizedEnv(), CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      if (output.length < 2_000_000) output += d.toString("utf8");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32")
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });

export const MAX_PUSHBACKS = 2;

export function pushbackMessage(check: ProjectCheck, run: CheckRun, attempt: number): string {
  const output = headTail(
    run.output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").trim(),
    3_000,
  );
  const last =
    attempt >= MAX_PUSHBACKS
      ? " Это последняя попытка: если не выйдет — прямо скажи пользователю, что проверка всё ещё не проходит."
      : "";
  return `Проверка проекта не прошла (\`${check.label}\`, код ${run.code ?? "?"}):\n${output}\nПочини и проверь снова.${last}`;
}

/** Для человека — без команд и вывода (они в details карточки). */
export const STILL_RED_NOTE =
  "Проверка проекта всё ещё не проходит. Я дважды пытался исправить и остановился — посмотрите, пожалуйста, или попросите меня попробовать ещё раз.";

export function stillRedDetails(check: ProjectCheck, run: CheckRun) {
  return { command: check.label, code: run.code, output: headTail(run.output.trim(), 1_200) };
}

export interface StopGateDeps {
  runner?: CheckRunner;
  /** Изменения хода по теневому git (видит и `sed -i`, и генераторы). Без него — только edit/write. */
  changes?: TurnChanges;
  /** Второе мнение модели другой семьи; без него ревью нет. */
  reviewer?: Reviewer;
  /** Бюджет хода: ревью пропускаем, когда он почти исчерпан, и добавляем к нему цену ревью. */
  budget?: BudgetHandle;
  /** Включено ли ревью прямо сейчас (флаг «Проверка второй моделью» читается на каждом ходе). */
  reviewEnabled?: () => boolean;
  /** Пути от корня в страницах (откроется ли двойным кликом); false — не проверять. */
  pagePaths?: ((cwd: string) => PagePathReport) | false;
}

/** Ревью не нужно, если поменялось меньше строк. */
export const MIN_REVIEW_LINES = 5;

function checksSummary(check: ProjectCheck | undefined, run: CheckRun | undefined): string {
  if (!check || !run)
    return "своей проверки у проекта нет; синтаксис правленых файлов проверен после каждой правки";
  if (run.timedOut) return `\`${check.label}\`: не успела закончиться`;
  return `\`${check.label}\`: прошла (код ${run.code ?? "?"})\n${headTail(run.output.trim(), 1_500)}`;
}

export function installStopGate(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
  deps: StopGateDeps | CheckRunner = {},
): void {
  if (opts.profile !== "code") return;
  const {
    runner = runProjectCheck,
    changes,
    reviewer,
    budget,
    reviewEnabled = () => true,
    pagePaths = checkPagePaths,
  } = typeof deps === "function" ? { runner: deps } : deps;
  let edited = false;
  let pushbacks = 0;
  let gaveUp = false;
  let reviewed = false;
  let task = "";

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    edited = false;
    pushbacks = 0;
    gaveUp = false;
    reviewed = false;
    task = event.prompt;
  });

  pi.on("tool_result", (event) => {
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) edited = true;
    return undefined;
  });

  async function review(
    patch: string,
    checks: string,
    ctx: ExtensionContext,
  ): Promise<{ verdict: ReviewVerdict; model: string; costUsd: number } | undefined> {
    if (!reviewer || reviewed || pushbacks >= MAX_PUSHBACKS || !reviewEnabled()) return undefined;
    if (changedLines(patch) < MIN_REVIEW_LINES) return undefined;
    if (budget && budget.ratio() >= opts.budgetWarnRatio) return undefined;
    if (ctx.signal?.aborted) return undefined;
    reviewed = true;
    const diff = clipDiff(patch);
    const reply = await reviewer(reviewPrompt({ task, diff, checks }), ctx);
    if (!reply) return undefined;
    budget?.spend(reply.costUsd);
    // Пользователь нажал «стоп», пока ждали проверяющего, или ответа нет: молчим.
    if (ctx.signal?.aborted || reply.error) return undefined;
    return { verdict: parseVerdict(reply.text, diff), model: reply.model, costUsd: reply.costUsd };
  }

  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || gaveUp) return undefined;
    // Ход уже продолжается (например, вызов инструмента пришёл текстом и модель повторяет его) — гейт подождёт.
    if (event.continue) return undefined;
    // Бюджет задачи исчерпан — тулы запрещены, возвращать к работе нельзя.
    if (budget?.state().exhausted) return undefined;
    const diff = await changes?.current();
    const touched = edited || (diff?.files.length ?? 0) > 0;
    // После возврата проверяем снова, даже если модель ничего не правила: «готово» на словах — не зелёный.
    if (!touched && pushbacks === 0) return undefined;
    edited = false;
    const check = detectProjectCheck(ctx.cwd);
    const run = check ? await runner(check, ctx.cwd, opts.stopGateTimeoutMs) : undefined;
    // Зелёное, таймаут или нечем проверять — не красное: не пилим казуала за отсутствие тестов.
    const red =
      check && run && !run.timedOut && run.code !== 0 && !check.missingTool?.test(run.output);
    const gateSig = check
      ? `gate:${check.label.split(/\s+/)[0]?.replace(/[^a-z0-9._-]/gi, "") ?? "?"}`
      : undefined;
    if (check && run && red) {
      if (pushbacks >= MAX_PUSHBACKS) {
        gaveUp = true;
        recordEvent(ctx, { kind: "gate.gaveup", ...(gateSig ? { sig: gateSig } : {}) });
        await showCard(pi, "prsloy-harness.stop-gate", STILL_RED_NOTE, stillRedDetails(check, run));
        return undefined;
      }
      pushbacks += 1;
      const tip = intervene(ctx, {
        kind: "gate.red",
        ...(gateSig ? { sig: gateSig } : {}),
        n: pushbacks,
      });
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "prsloy-harness.stop-gate",
            content: `${pushbackMessage(check, run, pushbacks)}${tip}`,
            display: false,
          },
        ],
        continue: true,
      };
    }

    if (check && run && !run.timedOut && !check.missingTool?.test(run.output))
      recordEvent(ctx, { kind: "gate.green", ...(gateSig ? { sig: gateSig } : {}) });
    // Проект зелёный (или проверять нечем) — смотрим, откроется ли страница двойным кликом.
    const paths = pagePaths ? pagePaths(ctx.cwd) : undefined;
    if (paths && (paths.issues.length > 0 || paths.viteBase) && pushbacks < MAX_PUSHBACKS) {
      pushbacks += 1;
      const tip = intervene(ctx, { kind: "gate.paths", sig: "gate:paths", n: pushbacks });
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "prsloy-harness.stop-gate",
            content: `${pagePathsMessage(paths, pushbacks, MAX_PUSHBACKS)}${tip}`,
            display: false,
          },
        ],
        continue: true,
      };
    }
    if (!diff?.patch) return undefined;
    const result = await review(diff.patch, checksSummary(check, run), ctx);
    if (!result) return undefined;
    const { verdict, model, costUsd } = result;
    const data = { model, costUsd, ...verdict };
    // Ответ не разобран — карточку «замечаний нет» не показываем: проверки по сути не было.
    // Данные ревью — в details карточки: отдельная запись custom показалась бы в чате сырым JSON.
    if (verdict.invalid) return undefined;
    if (verdict.verdict === "PASS") {
      recordEvent(ctx, {
        kind: "review.pass",
        sig: `review:${modelFamily(model) ?? "?"}`,
        n: verdict.rejected,
      });
      await showCard(pi, "prsloy-harness.second-opinion", REVIEW_PASS_CARD, data);
      return undefined;
    }
    pushbacks += 1;
    const tip = intervene(ctx, {
      kind: "review.fail",
      sig: `review:${modelFamily(model) ?? "?"}`,
      n: verdict.items.length,
    });
    await showCard(pi, "prsloy-harness.second-opinion", reviewFailCard(verdict.items.length), data);
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "prsloy-harness.second-opinion",
          content: `${reviewPushback(verdict.items)}${tip}`,
          display: false,
        },
      ],
      continue: true,
    };
  });
}
