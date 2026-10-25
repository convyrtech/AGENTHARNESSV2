// ADR-6 (research/00-synthesis.md): стоп-гейт «до зелёного» с капом продолжений — шаблон Stop-хука Claude Code.
// Harness² (research/06-harness2.md): их 43,1 → 77,8 — один разбор случая с четырьмя правками сразу (§4, рис. 9),
// а не эффект verify-скрипта; своей цифры у гейта нет, её даёт наш бенч. Когда ход в профиле «Код» заканчивается после
// правок, харнесс дёшево проверяет проект его же проверкой и, если красно, возвращает модель к работе — не больше
// двух раз за сообщение пользователя. Хук Pi 1.4: agent_before_settle (записи + одно продолжение).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BudgetHandle } from "./budget.ts";
import { sanitizedEnv, type ResolvedOptions } from "./options.ts";
import {
  changedLines,
  clipDiff,
  parseVerdict,
  REVIEW_PASS_CARD,
  reviewFailCard,
  reviewReportCard,
  reviewPrompt,
  reviewPushback,
  type ReviewVerdict,
} from "./second-opinion.ts";
import type { Reviewer } from "./reviewer.ts";
import { headTail, showCard } from "./text.ts";
import type { TurnChanges } from "./turn-changes.ts";
import { modelFamily, recordEvent } from "./learning-log.ts";
import { checkPagePaths, type PagePathReport, pagePathsMessage } from "./page-paths.ts";
import {
  checkPage,
  hasBlocking,
  type PageCheckResult,
  pageCheckMessage,
  pageFindings,
} from "./page-check.ts";
import {
  type CheckSnapshot,
  checkChange,
  gateSignals,
  packageScripts,
  parsePatch,
} from "./gate-signals.ts";
import type { HonestyState } from "./honest-exit.ts";
import type { TurnStatusState } from "./turn-status.ts";
import {
  guardPushback,
  oldTestChanges,
  rerunOldTests,
  signaturePushback,
  signatures,
  signatureSignals,
  signaturesWarrantPushback,
  userAskedToChange,
} from "./test-guard.ts";
import { intervene } from "./lessons.ts";

export interface ProjectCheck {
  /** Команда оболочки, из каталога проекта. */
  command: string;
  /** Что это за проверка — для сообщения модели. */
  label: string;
  /** Вывод, по которому видно, что проверять нечем (pytest не установлен и т. п.): тогда молчим. */
  missingTool?: RegExp;
  /** Добавки к окружению запуска (PATH с node_modules/.bin для исходных скриптов, H1). */
  env?: Record<string, string>;
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
      env: { ...sanitizedEnv(), CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", ...check.env },
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

export interface PushbackExtras {
  /** Инструмент report_blocker доступен модели (флаг honestExit): тогда T1 его называет. */
  blockerTool?: boolean;
  /** Команда проверки менялась в ходе: гейт прогнал исходную (H1). */
  checkChanged?: string | undefined;
}

/**
 * Возврат гейта — текст T1 (research/22 §6.4, research/24 §1): честный выход в каждой попытке, не только
 * в последней. Измерено: подгонка падает с 23,6 до 5,3% у 8 моделей (research/22 §3).
 */
export function pushbackMessage(
  check: ProjectCheck,
  run: CheckRun,
  attempt: number,
  extras: PushbackExtras = {},
): string {
  const output = headTail(
    run.output.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "").trim(),
    3_000,
  );
  const changed = extras.checkChanged
    ? `\nВ этом ходе ${extras.checkChanged}. Гейт прогнал проверку, которая была в начале хода.`
    : "";
  const last =
    attempt >= MAX_PUSHBACKS
      ? " Это последняя попытка: если не выйдет — прямо скажи пользователю, что проверка всё ещё не проходит."
      : "";
  return (
    `Проверка проекта не прошла (\`${check.label}\`, код ${run.code ?? "?"}):\n${output}${changed}\n` +
    "Почини код и проверь снова. Если проверка противоречит тому, что просил пользователь, задание важнее: не меняй, " +
    "не отключай и не ослабляй тест и не подгоняй код под него. Оставь тест красным и коротко объясни пользователю, " +
    `в чём противоречие${extras.blockerTool ? " (или вызови report_blocker)" : ""}. Это нормальный итог.${last}`
  );
}

/**
 * H1: проверка на конец хода, если на начале была другая — та, что была (исходные тела скриптов package.json,
 * `node_modules/.bin` в PATH, как у npm). Агент сменил `scripts.test` на `echo ok` — прогоняется прежняя.
 */
export function originalCheck(
  start: CheckSnapshot & { check?: ProjectCheck },
  cwd: string,
): ProjectCheck | undefined {
  if (!start.check) return undefined;
  const bodies = Object.values(start.scripts);
  if (/^(?:npm|pnpm|yarn) run /.test(start.check.command) && bodies.length) {
    const bin = join(cwd, "node_modules", ".bin");
    return {
      command: bodies.join(" && "),
      label: `исходная проверка: ${bodies.join(" && ")}`,
      env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
    };
  }
  return { ...start.check, label: `исходная проверка: ${start.check.label}` };
}

/** Для человека — без команд и вывода (они в details карточки). */
export const STILL_RED_NOTE =
  "Проверка проекта всё ещё не проходит. Я попробовал дважды и остановился, чтобы не подгонять код под неё. Напишите «попробуй ещё» — попробую по-другому.";

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
  /** Страница в браузере (файлом и через сервер, 390 и 1440); false — не проверять. undefined от функции — нечем. */
  pageCheck?: ((cwd: string) => Promise<PageCheckResult | undefined>) | false;
  /** Честный выход (флаг honestExit): общее с report_blocker состояние сообщения. */
  honesty?: HonestyState;
  /** Страж старых тестов (флаг testGuard, читается на каждом ходе). */
  testGuard?: () => boolean;
  /** Статус хода (H9): гейт пишет свой последний прогон и проверку страницы. */
  turnStatus?: TurnStatusState;
}

/** Правки, после которых стоит открыть страницу в браузере. */
const WEB_FILE = /\.(?:html?|css|m?js|jsx|tsx?|vue|svelte)$/i;

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
    pageCheck = (cwd: string) => checkPage(cwd),
    honesty,
    testGuard = () => false,
    turnStatus,
  } = typeof deps === "function" ? { runner: deps } : deps;
  /** Блокер принят кодом (research/24 §4.2): возвратов «почини» больше нет, отчёты остаются. */
  const blocked = () => !!honesty?.accepted;
  const capped = () => pushbacks >= MAX_PUSHBACKS || blocked();
  let edited = false;
  let webEdited = false;
  let pushbacks = 0;
  let gaveUp = false;
  let reviewed = false;
  /** Страж вернул ход в этом сообщении: T2 — один раз, дальше только сигналы ревьюеру. */
  let guarded = false;
  let task = "";
  /** H1: проверка проекта на начало хода (сообщения пользователя). */
  let start: (CheckSnapshot & { check?: ProjectCheck }) | undefined;

  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType !== "user") return;
    edited = false;
    webEdited = false;
    pushbacks = 0;
    gaveUp = false;
    reviewed = false;
    guarded = false;
    task = event.prompt;
    const check = detectProjectCheck(ctx.cwd);
    start = {
      command: check?.command,
      scripts: packageScripts(ctx.cwd),
      ...(check ? { check } : {}),
    };
  });

  pi.on("tool_result", (event) => {
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
      edited = true;
      const path = (event.input as { path?: unknown }).path;
      if (typeof path === "string" && WEB_FILE.test(path)) webEdited = true;
    }
    return undefined;
  });

  async function review(
    patch: string,
    checks: string,
    ctx: ExtensionContext,
    signals: string[] = [],
    reportOnly = false,
  ): Promise<{ verdict: ReviewVerdict; model: string; costUsd: number } | undefined> {
    if (!reviewer || reviewed || !reviewEnabled()) return undefined;
    // После капа возвратов ревьюер зовётся только «отчётом» (research/24 §1): возвращать к работе уже нельзя.
    if (capped() && !reportOnly) return undefined;
    // Особый случай под тест — часто одна строка: при сигналах подгонки мелкий дифф тоже смотрим.
    if (changedLines(patch) < MIN_REVIEW_LINES && !signals.length) return undefined;
    if (budget && budget.ratio() >= opts.budgetWarnRatio) return undefined;
    if (ctx.signal?.aborted) return undefined;
    reviewed = true;
    const diff = clipDiff(patch);
    const reply = await reviewer(reviewPrompt({ task, diff, checks, signals }), ctx);
    if (!reply) return undefined;
    budget?.spend(reply.costUsd);
    // Пользователь нажал «стоп», пока ждали проверяющего, или ответа нет: молчим.
    if (ctx.signal?.aborted || reply.error) return undefined;
    return { verdict: parseVerdict(reply.text, diff), model: reply.model, costUsd: reply.costUsd };
  }

  /** Ревьюер «только отчёт»: карточка и данные, без возврата к работе (research/24 §1). */
  async function reportOnlyReview(
    patch: string,
    check: ProjectCheck | undefined,
    run: CheckRun | undefined,
    signals: string[],
    ctx: ExtensionContext,
  ): Promise<void> {
    const result = await review(patch, checksSummary(check, run), ctx, signals, true);
    if (!result || result.verdict.invalid) return;
    const { verdict, model, costUsd } = result;
    const pass = verdict.verdict === "PASS";
    recordEvent(ctx, {
      kind: pass ? "review.pass" : "review.fail",
      sig: "review:report",
      n: verdict.items.length,
    });
    await showCard(
      pi,
      "prsloy-harness.second-opinion",
      pass ? REVIEW_PASS_CARD : reviewReportCard(verdict.items.length),
      { model, costUsd, reportOnly: true, signals, ...verdict },
    );
  }

  /**
   * Страж (флаг testGuard): старые тесты на новом коде (H2), затем сигнатуры (H3). Возврат T2 — запись для
   * продолжения хода; undefined — возвращать не за что (или уже нельзя).
   */
  async function guardTurn(
    patch: string,
    check: ProjectCheck | undefined,
    ctx: ExtensionContext,
  ): Promise<
    { type: "custom_message"; customType: string; content: string; display: false } | undefined
  > {
    const entry = (content: string) => ({
      type: "custom_message" as const,
      customType: "prsloy-harness.test-guard",
      content,
      display: false as const,
    });
    const touched = oldTestChanges(patch);
    if (touched.length) {
      recordEvent(ctx, { kind: "test_guard.touched", n: touched.length });
      if (userAskedToChange(task)) {
        // Пользователь сам просил поменять поведение или проверки (research/24 §4.3): не возврат.
        recordEvent(ctx, { kind: "test_guard.allowed", n: touched.length });
      } else if (check && changes && !capped() && !guarded) {
        const startCheck = start;
        const rerun = await rerunOldTests({
          cwd: ctx.cwd,
          patch,
          check: (dir) => (startCheck?.check ? originalCheck(startCheck, dir) : undefined) ?? check,
          fileAtStart: (path) => changes.fileAtStart(path),
          runner,
          outputDir: opts.outputDir,
          timeoutMs: opts.stopGateTimeoutMs,
        });
        if (rerun) {
          recordEvent(ctx, {
            kind: "test_guard.original_rerun",
            sig: rerun.red ? "guard:red" : "guard:green",
          });
          if (rerun.red) {
            pushbacks += 1;
            guarded = true;
            const tip = intervene(ctx, { kind: "gate.red", sig: "gate:guard", n: pushbacks });
            return entry(`${guardPushback(rerun, check.label)}${tip}`);
          }
        }
      }
    }
    const found = signatures(parsePatch(patch));
    if (found.length) {
      recordEvent(ctx, {
        kind: "test_guard.signature",
        sig: `guard:${[...new Set(found.map((f) => f.kind))].sort().join("+")}`,
        n: found.length,
      });
      if (signaturesWarrantPushback(found) && !capped() && !guarded) {
        pushbacks += 1;
        guarded = true;
        return entry(signaturePushback(found));
      }
    }
    return undefined;
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
    // H1: если проверка за ход пропала или поменялась (`scripts.test` → `echo ok`), прогоняется та, что была.
    const now = detectProjectCheck(ctx.cwd);
    const changed = start ? checkChange(start, now?.command, packageScripts(ctx.cwd)) : undefined;
    const check = (changed && start ? originalCheck(start, ctx.cwd) : undefined) ?? now;
    if (changed) recordEvent(ctx, { kind: "test_guard.command_changed" });
    const guardOn = testGuard();
    const found = guardOn ? signatures(parsePatch(diff?.patch ?? "")) : [];
    let signalsCache: string[] | undefined;
    // Находки проверки страницы с селекторами (нажатия, ссылки, axe, клавиатура) — ревьюеру как факты.
    let pageSignals: string[] = [];
    const signals = () =>
      (signalsCache ??= [
        ...pageSignals,
        ...gateSignals({
          checkChanged: changed,
          patch: diff?.patch ?? "",
          cwd: ctx.cwd,
          task,
        }),
        ...signatureSignals(found),
      ].slice(0, 8));
    const run = check ? await runner(check, ctx.cwd, opts.stopGateTimeoutMs) : undefined;
    // Зелёное, таймаут или нечем проверять — не красное: не пилим казуала за отсутствие тестов.
    const red =
      check && run && !run.timedOut && run.code !== 0 && !check.missingTool?.test(run.output);
    if (turnStatus && check && run && !run.timedOut && !check.missingTool?.test(run.output)) {
      turnStatus.gate = red ? "red" : "green";
      turnStatus.hasCheck = true;
    }
    const gateSig = check
      ? `gate:${check.label.split(/\s+/)[0]?.replace(/[^a-z0-9._-]/gi, "") ?? "?"}`
      : undefined;
    if (check && run && red) {
      if (honesty) honesty.redSeen = true;
      if (capped()) {
        gaveUp = true;
        recordEvent(ctx, {
          kind: "gate.gaveup",
          ...(blocked() ? { sig: "gate:blocker" } : gateSig ? { sig: gateSig } : {}),
        });
        // Блокер принят — его карточка уже говорит, что не вышло; «всё ещё не проходит» не дублируем.
        if (!blocked())
          await showCard(
            pi,
            "prsloy-harness.stop-gate",
            STILL_RED_NOTE,
            stillRedDetails(check, run),
          );
        // Сдался, а признаки подгонки есть — ревьюер «только отчёт»: человек узнаёт, что тест могли подогнать.
        if (diff?.patch && signals().length)
          await reportOnlyReview(diff.patch, check, run, signals(), ctx);
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
            content: `${pushbackMessage(check, run, pushbacks, {
              blockerTool: pi.getActiveTools().includes("report_blocker"),
              checkChanged: changed,
            })}${tip}`,
            display: false,
          },
        ],
        continue: true,
      };
    }

    if (check && run && !run.timedOut && !check.missingTool?.test(run.output))
      recordEvent(ctx, { kind: "gate.green", ...(gateSig ? { sig: gateSig } : {}) });
    // Страж старых тестов (H2, H3): проверка зелёная — а не потому ли, что тесты поменяли?
    if (guardOn && diff?.patch) {
      const guard = await guardTurn(diff.patch, check, ctx);
      if (guard) return { entries: [...event.entries, guard], continue: true };
    }
    // Проект зелёный (или проверять нечем) — смотрим, откроется ли страница двойным кликом.
    const paths = pagePaths ? pagePaths(ctx.cwd) : undefined;
    if (paths && paths.issues.length > 0 && !capped()) {
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
    // Страница в браузере — только если ход трогал файлы страницы (по edit/write или по теневому git).
    const web = webEdited || (diff?.files ?? []).some((f) => WEB_FILE.test(f));
    webEdited = false;
    if (pageCheck && web && !capped() && !ctx.signal?.aborted) {
      const page = await pageCheck(ctx.cwd);
      if (turnStatus && page && !page.skipped) {
        turnStatus.page = !hasBlocking(page);
        turnStatus.pageIssues = pageFindings(page);
      }
      if (page && !page.skipped)
        pageSignals = pageFindings(page).map((l) => `Проверка страницы: ${l}`);
      if (page && !page.skipped && hasBlocking(page)) {
        pushbacks += 1;
        const tip = intervene(ctx, { kind: "gate.page", sig: "gate:page", n: pushbacks });
        return {
          entries: [
            ...event.entries,
            {
              type: "custom_message",
              customType: "prsloy-harness.stop-gate",
              content: `${pageCheckMessage(page, pushbacks, MAX_PUSHBACKS)}${tip}`,
              display: false,
            },
          ],
          continue: true,
        };
      }
    }
    if (!diff?.patch) return undefined;
    // Кап исчерпан, а проверка позеленела (красно, красно, «особый случай») — только отчёт ревьюера, без возврата.
    // Так же после принятого блокера.
    if (capped()) {
      if (signals().length) await reportOnlyReview(diff.patch, check, run, signals(), ctx);
      return undefined;
    }
    const result = await review(diff.patch, checksSummary(check, run), ctx, signals());
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
