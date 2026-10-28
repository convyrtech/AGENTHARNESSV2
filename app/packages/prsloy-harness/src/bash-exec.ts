// #82: bash-тул не должен висеть дольше своего таймаута и должен отменяться.
//
// Pi (1.4.0) ждёт конца команды так (`utils/child-process.js` → `waitForChildProcess`): после
// `exit` ждёт, пока оба пайпа замолчат на 100 мс, и **перевзводит эти 100 мс на каждом чанке**
// (исправление earendil-works/pi#5303: иначе терялся хвост). Хорошо для хвоста, плохо для
// фонового потомка: если команда вышла, а её потомок продолжает писать в тот же stdout чаще,
// чем раз в 100 мс, пайп не закрывается никогда — и вызов тула не завершается. Таймаут зовёт
// `killProcessTree(pid)`, но это убивает только группу процессов (`kill(-pid)`), а потомок из
// `setsid` / демонизированной программы в группу не входит и продолжает держать пайп. Отмена
// (abort) идёт тем же путём и тоже не помогает.
//
// Замер до правки (завиток: `setsid` потомок пишет 20 Гц, timeout=5): вызов закончился на 15.4 с,
// abort на 2.5 с — тоже 15.4 с. Отсюда и «висит 20 минут без статуса» из issue: пока потомок
// пишет, тул не возвращается ни по таймауту, ни по отмене.
//
// Поэтому здесь свои `operations` для bash/powershell (это официальная точка расширения Pi:
// `BashToolOptions.operations`). Всё остальное — описание тула, обрезка вывода, structuredContent,
// рендер — остаётся от Pi (`createBashToolDefinition`). Меняется только ожидание процесса:
//   1. после `exit` даём выводу ещё не больше `drainAfterExitMs` и закрываем пайпы сами;
//   2. после kill (таймаут или отмена) ждём закрытия не дольше `killSettleMs` и закрываем пайпы сами.
// Оба числа — границы ожидания, а не игровые числа; их видно в журнале (`tool.watch`).
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import type { BashOperations, PowerShellOperations } from "@earendil-works/pi-coding-agent";

/** Молчание пайпов, после которого вывод считаем законченным (как у Pi). */
export const DRAIN_IDLE_MS = 100;
/** Сколько ещё читаем вывод после выхода оболочки, даже если потомок не замолкает. */
export const DRAIN_AFTER_EXIT_MS = 1_500;
/** Сколько ждём закрытия пайпов после kill по таймауту или отмене. */
export const KILL_SETTLE_MS = 1_500;

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Куда сообщить, что сработала граница ожидания (для журнала; без текста команды). */
export interface ExecBoundary {
  reason: "abort" | "timeout" | "drain";
  /** Сколько длился вызов к этому моменту. */
  elapsedMs: number;
}

export interface BoundedExecOptions {
  drainAfterExitMs?: number;
  drainIdleMs?: number;
  killSettleMs?: number;
  onBoundary?: (event: ExecBoundary) => void;
  /**
   * Каталог, в котором на самом деле выполнять команду. Нужен для метки
   * `SESSION_CWD_SENTINEL`: Pi отдаёт определение без контекста, и путь надо взять из сессии.
   */
  resolveCwd?: (cwd: string) => string;
}

export interface BoundedWaitOptions extends BoundedExecOptions {
  /**
   * Жёсткая граница от начала ожидания: закрыть пайпы, даже если процесс ещё не вышел.
   * Нужна на пути kill: убийство могло не достать до потомка, а статус всё равно должен быть.
   */
  hardCapMs?: number;
}

/**
 * Ожидание, которому можно поставить границу задним числом.
 *
 * Граница нужна именно в момент kill, а не в момент старта ожидания: таймаут и отмена случаются
 * позже. Раньше признак `aborted || timedOut` вычислялся до старта ожидания и всегда был false,
 * поэтому после kill ожидание оставалось бесконечным (#82, ревью).
 */
export interface BoundedWaitHandle extends Promise<BoundedWait> {
  /** Поставить жёсткую границу с текущего момента (таймаут или отмена уже случились). */
  armHardCap: (ms: number) => void;
}

/**
 * Метка вместо каталога в определении тула (#82, ревью).
 *
 * Pi берёт рабочий каталог из контекста вызова (`ctx?.cwd || cwd`) и только при его отсутствии —
 * из определения. Программный вызов без контекста уходил бы в `process.cwd()` приложения, то есть
 * в чужой каталог. Метка вместо пути заставляет наши операции взять каталог последней сессии.
 */
export const SESSION_CWD_SENTINEL = "\u0000prsloy:session-cwd";

export interface ShellConfigLike {
  shell: string;
  args: string[];
  commandTransport?: "argv" | "stdin" | undefined;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  }
  return timeoutMs;
}

/**
 * Убить дерево процессов оболочки. Своя копия, потому что `killProcessTree` в Pi не экспортируется:
 * на Unix — SIGKILL группе (оболочка запущена detached, значит она лидер группы), на Windows — taskkill /T.
 */
export function killShellTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const taskkill = spawn(
        join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", detached: true, windowsHide: true },
      );
      taskkill.once("error", () => {});
      taskkill.unref();
    } catch {
      // уже завершился
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // уже завершился
    }
  }
}

interface BoundedWait {
  /** Вышел ли процесс и с каким кодом. */
  exitCode: number | null;
  /** Труба была закрыта нами по границе, а не процессом. */
  forced: boolean;
  drainMs: number;
}

/**
 * Дождаться выхода процесса, но не бесконечно: после `exit` пайпы закрываются нами, если потомок
 * продолжает в них писать. Возвращает код выхода и признак того, что трубу закрыли мы.
 */
export function waitForBoundedExit(
  child: ReturnType<typeof spawn>,
  options: BoundedWaitOptions = {},
): BoundedWaitHandle {
  const drainAfterExitMs = options.drainAfterExitMs ?? DRAIN_AFTER_EXIT_MS;
  const drainIdleMs = options.drainIdleMs ?? DRAIN_IDLE_MS;
  const hardCapMs = options.hardCapMs;
  let armHardCapRef: (ms: number) => void = () => {};
  const promise = new Promise<BoundedWait>((resolve, reject) => {
    let settled = false;
    let exited = false;
    let forced = false;
    let exitCode: number | null = null;
    let exitAt = 0;
    let idleTimer: NodeJS.Timeout | undefined;
    let capTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null || child.stdout === undefined;
    let stderrEnded = child.stderr === null || child.stderr === undefined;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (capTimer) clearTimeout(capTimer);
      idleTimer = undefined;
      capTimer = undefined;
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Трубу закрываем сами: держать её открытой дальше незачем, а живой потомок не даст ей закрыться.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ exitCode: code, forced, drainMs: exitAt ? Date.now() - exitAt : 0 });
    };

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finalize(exitCode), drainIdleMs);
    };

    const armCap = () => {
      if (capTimer) return;
      capTimer = setTimeout(() => {
        forced = true;
        finalize(exitCode);
      }, drainAfterExitMs);
    };

    if (hardCapMs !== undefined) {
      capTimer = setTimeout(() => {
        forced = true;
        finalize(exitCode);
      }, hardCapMs);
    }

    /** Граница с текущего момента: перекрывает уже поставленную (например, от выхода оболочки). */
    armHardCapRef = (ms: number) => {
      if (settled) return;
      if (capTimer) clearTimeout(capTimer);
      capTimer = setTimeout(() => {
        forced = true;
        finalize(exitCode);
      }, ms);
    };

    const onData = () => {
      // Вывод ещё идёт после выхода оболочки — продлеваем тишину, но не бесконечно (cap).
      if (exited && !settled) armIdle();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      exitAt = Date.now();
      if (stdoutEnded && stderrEnded) {
        finalize(code);
        return;
      }
      armIdle();
      armCap();
    };
    const onClose = (code: number | null) => {
      finalize(code ?? exitCode);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
  // Метод вешаем на сам промис: он нужен уже после создания ожидания.
  (promise as BoundedWaitHandle).armHardCap = (ms: number) => armHardCapRef(ms);
  return promise as BoundedWaitHandle;
}

/** Общая часть bash и powershell: различаются только именем и тем, как искать оболочку. */
function createBoundedOperations(
  shellName: string,
  resolveShellConfig: () => ShellConfigLike,
  options: BoundedExecOptions,
): BashOperations {
  const drainAfterExitMs = options.drainAfterExitMs ?? DRAIN_AFTER_EXIT_MS;
  const drainIdleMs = options.drainIdleMs ?? DRAIN_IDLE_MS;
  const killSettleMs = options.killSettleMs ?? KILL_SETTLE_MS;

  return {
    exec: async (command, rawCwd, { onData, signal, timeout, env }) => {
      const cwd = options.resolveCwd?.(rawCwd) ?? rawCwd;
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error("aborted");
      const config = resolveShellConfig();
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(
          `Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`,
        );
      }

      const commandFromStdin = config.commandTransport === "stdin";
      const child = spawn(
        config.shell,
        commandFromStdin ? config.args : [...config.args, command],
        {
          cwd,
          detached: process.platform !== "win32",
          env: env ?? process.env,
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }

      const startedAt = Date.now();
      let timedOut = false;
      let aborted = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      // Ставится после создания ожидания: граница нужна в момент kill, а он случается позже старта.
      let armHardCap: (ms: number) => void = () => {};
      const killTree = (reason: ExecBoundary["reason"]) => {
        options.onBoundary?.({ reason, elapsedMs: Date.now() - startedAt });
        if (child.pid) killShellTree(child.pid);
        armHardCap(killSettleMs);
      };
      const onAbort = () => {
        aborted = true;
        killTree("abort");
      };

      try {
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            killTree("timeout");
          }, timeoutMs);
        }
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        // Ждём выхода; после kill пайпы закрываем не позже killSettleMs от момента kill,
        // после обычного `exit` — не позже drainAfterExitMs от выхода оболочки.
        const waitHandle = waitForBoundedExit(child, { drainAfterExitMs, drainIdleMs });
        armHardCap = (ms) => waitHandle.armHardCap(ms);
        if (aborted || timedOut) armHardCap(killSettleMs);
        const wait = await waitHandle;
        if (wait.forced && !aborted && !timedOut) {
          // Оболочка вышла, а пайп держит потомок: добиваем дерево, чтобы оно не жило после тулы.
          if (child.pid) killShellTree(child.pid);
          options.onBoundary?.({ reason: "drain", elapsedMs: Date.now() - startedAt });
        }
        if (aborted || signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        const signalCode = child.signalCode;
        return {
          exitCode:
            wait.exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1),
        };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** `operations` для bash-тула: как у Pi, но с границей ожидания (см. шапку файла). */
export function boundedBashOperations(
  resolveShellConfig: () => ShellConfigLike,
  options: BoundedExecOptions = {},
): BashOperations {
  return createBoundedOperations("bash", resolveShellConfig, options);
}

/** То же для powershell (Windows). */
export function boundedPowerShellOperations(
  resolveShellConfig: () => ShellConfigLike,
  options: BoundedExecOptions = {},
): PowerShellOperations {
  return createBoundedOperations("powershell", resolveShellConfig, options);
}
