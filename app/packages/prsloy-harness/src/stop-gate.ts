// ADR-6 (research/00-synthesis.md): стоп-гейт «до зелёного» с капом продолжений — шаблон Stop-хука Claude Code;
// Harness² (research/06-harness2.md): verify-скрипт 43 → 78. Когда ход в профиле «Код» заканчивается после
// правок, харнесс дёшево проверяет проект его же проверкой и, если красно, возвращает модель к работе — не больше
// двух раз за сообщение пользователя. Хук Pi 1.4: agent_before_settle (записи + одно продолжение).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizedEnv, type ResolvedOptions } from "./options.ts";
import { headTail } from "./text.ts";

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

export function stillRedNote(check: ProjectCheck, run: CheckRun): string {
  const output = headTail(run.output.trim(), 1_200);
  return `Проверка проекта всё ещё не проходит (\`${check.label}\`) — после ${MAX_PUSHBACKS} попыток исправить я остановился.\n${output}`;
}

export function installStopGate(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
  runner: CheckRunner = runProjectCheck,
): void {
  if (opts.profile !== "code") return;
  let changed = false;
  let pushbacks = 0;
  let gaveUp = false;

  pi.on("before_agent_start", (event) => {
    if (event.messageType !== "user") return;
    changed = false;
    pushbacks = 0;
    gaveUp = false;
  });

  pi.on("tool_result", (event) => {
    if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) changed = true;
    return undefined;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed" || gaveUp) return undefined;
    // Бюджет задачи исчерпан (его итог уже в записях) — тулы запрещены, возвращать к работе нельзя.
    if (event.entries.some((e) => "customType" in e && e.customType === "prsloy-harness.budget"))
      return undefined;
    // После возврата проверяем снова, даже если модель ничего не правила: «готово» на словах — не зелёный.
    if (!changed && pushbacks === 0) return undefined;
    const check = detectProjectCheck(ctx.cwd);
    if (!check) return undefined;
    changed = false;
    const run = await runner(check, ctx.cwd, opts.stopGateTimeoutMs);
    // Зелёное, таймаут или нечем проверять — молчим: не пилим казуала за отсутствие тестов.
    if (run.timedOut || run.code === 0) return undefined;
    if (check.missingTool?.test(run.output)) return undefined;
    if (pushbacks >= MAX_PUSHBACKS) {
      gaveUp = true;
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "prsloy-harness.stop-gate",
            content: stillRedNote(check, run),
            display: true,
          },
        ],
      };
    }
    pushbacks += 1;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "prsloy-harness.stop-gate",
          content: pushbackMessage(check, run, pushbacks),
          display: false,
        },
      ],
      continue: true,
    };
  });
}
