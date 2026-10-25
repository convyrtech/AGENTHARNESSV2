import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { tailBytes } from "./text.ts";

export interface BackgroundProcess {
  id: string;
  pid: number | undefined;
  command: string;
  cwd: string;
  logPath: string;
  startedAt: number;
  exitCode: number | null | undefined;
  ports: number[];
}

interface Entry extends BackgroundProcess {
  child: ChildProcess;
  log: WriteStream;
  output: string;
}

const PORT_PATTERNS = [
  /(?:\blocalhost|\b127\.0\.0\.1|\b0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/g,
  /\bport\s*[:=]?\s*(\d{2,5})\b/gi,
];

export function detectPorts(text: string): number[] {
  const found = new Set<number>();
  for (const line of text.split("\n")) {
    // «Port 3000 is in use, trying another one…» — этот порт как раз не наш.
    if (/in use|already used|EADDRINUSE/i.test(line)) continue;
    for (const pattern of PORT_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const port = Number(match[1]);
        if (port >= 80 && port <= 65535) found.add(port);
      }
    }
  }
  return [...found];
}

/**
 * Долгоживущие команды: dev-серверы и вотчеры. Проверяем только начало каждой команды в цепочке
 * (после `&&`, `;`, `|`), чтобы `npm i -D vite` или `grep uvicorn` не считались сервером.
 */
const SERVER_START: RegExp[] = [
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)(?:\s|$)/,
  /^(?:vite)(?!\s+(?:build|optimize))(?:\s|$)/,
  /^(?:serve|http-server|live-server|nodemon|uvicorn|gunicorn|hypercorn|webpack-dev-server)(?:\s|$)/,
  /^next\s+(?:dev|start)(?:\s|$)/,
  /^python[0-9.]*\s+(?:-[uB]\s+)*(?:-m\s+http\.server|manage\.py\s+runserver)(?:\s|$)/,
  /^flask\s+run(?:\s|$)/,
  /^php\s+-S(?:\s|$)/,
  /^(?:bin\/)?rails\s+s(?:erver)?(?:\s|$)/,
  /^webpack\s+(?:serve|--watch)(?:\s|$)/,
  /^docker(?:\s+compose|-compose)\s+up(?![^|;&]*\s(?:-d|--detach)\b)(?:\s|$)/,
  /^cargo\s+watch(?:\s|$)/,
];
const WATCH_FLAG = /\s--watch(?![=\s]*false)(?:[=\s]|$)/;
/** Команды, которые только смотрят или ставят пакеты, даже если в них есть имя сервера. */
const INSPECT_WORD = /^(?:cat|less|head|tail|grep|rg|which|where|type|echo|man|ls)$/;
const PACKAGE_OP =
  /^(?:npm|pnpm|yarn|bun|pip3?|uv|poetry)\s+(?:i|install|add|ci|remove|rm|uninstall|ls|list|view|info|why)(?:\s|$)/;

function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((part) =>
      part
        .trim()
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "") // FOO=1 cmd
        .replace(/^(?:npx|pnpx|bunx|pnpm\s+dlx|pnpm\s+exec|yarn\s+dlx)\s+(?:-y\s+|--yes\s+)?/, ""),
    )
    .filter(Boolean);
}

export function looksLikeServer(command: string): boolean {
  const trimmed = command.trim();
  if (/&\s*$/.test(trimmed)) return false; // модель уже сама отправила в фон
  if (/^timeout\s/.test(trimmed)) return false; // модель сама ограничила время
  return commandSegments(trimmed).some((segment) => {
    if (INSPECT_WORD.test(segment.split(/\s+/)[0] ?? "") || PACKAGE_OP.test(segment)) return false;
    return SERVER_START.some((pattern) => pattern.test(segment)) || WATCH_FLAG.test(segment);
  });
}

function killTree(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // уже завершился
    }
  }
}

interface ExitEmitter {
  on(event: "exit", listener: () => void): unknown;
}

/** Эмиттер signal-exit, если его уже загрузил Pi: v3 — process.__signal_exit_emitter__, v4 — символ. */
function signalExitEmitter(): ExitEmitter | undefined {
  const proc = process as unknown as Record<string | symbol, unknown>;
  const candidate = proc.__signal_exit_emitter__ ?? proc[Symbol.for("signal-exit emitter")];
  return candidate && typeof (candidate as ExitEmitter).on === "function"
    ? (candidate as ExitEmitter)
    : undefined;
}

/** Живые реестры процесса: если Pi упадёт или выйдет без session_shutdown, фон всё равно гасится. */
const liveRegistries = new Set<ProcessRegistry>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const killAll = () => {
    for (const registry of liveRegistries) registry.killAllNow();
  };
  process.once("exit", killAll);
  // «exit» не приходит, если процесс убили сигналом. Pi держит сигналы через signal-exit: свой
  // обработчик сломал бы его повтор сигнала, поэтому подписываемся на его общий эмиттер — ровно это
  // делает onExit(). Сам пакет signal-exit не импортируем: это CommonJS, и в ESM-бандле хоста
  // его require("assert") роняет хост при старте.
  const emitter = signalExitEmitter();
  if (emitter) {
    emitter.on("exit", killAll);
    return;
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    if (process.platform === "win32" && signal === "SIGHUP") continue;
    if (process.listenerCount(signal) > 0) continue; // чужой обработчик хоста не перебиваем
    process.once(signal, () => {
      killAll();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}

export class ProcessRegistry {
  readonly #entries = new Map<string, Entry>();
  #next = 1;

  // Поля без parameter properties: модуль грузится и через `node` со снятием типов (scripts/bench.mts).
  private readonly logDir: string;
  private readonly env: () => NodeJS.ProcessEnv;
  /** Путь к bash из настроек Pi (`shellPath`), иначе поиск как у bash-тула Pi. */
  private readonly shellPath: () => string | undefined;

  constructor(
    logDir: string,
    env: () => NodeJS.ProcessEnv,
    shellPath: () => string | undefined = () => undefined,
  ) {
    this.logDir = logDir;
    this.env = env;
    this.shellPath = shellPath;
    liveRegistries.add(this);
    installExitHook();
  }

  /** Запускает команду в фоне и ждёт первые `waitMs` (или пока не появится порт). */
  async start(
    command: string,
    cwd: string,
    waitMs = 4000,
  ): Promise<BackgroundProcess & { output: string }> {
    mkdirSync(this.logDir, { recursive: true });
    const id = `bg${this.#next++}`;
    const logPath = join(this.logDir, `${id}.log`);
    const log = createWriteStream(logPath);
    const shell = getShellConfig(this.shellPath());
    const viaStdin = shell.commandTransport === "stdin";
    const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, command], {
      cwd,
      detached: process.platform !== "win32",
      // Без этого python в трубу буферизует вывод, и баннер с портом не виден.
      env: { ...this.env(), PYTHONUNBUFFERED: "1" },
      stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (viaStdin) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(command);
    }
    const entry: Entry = {
      id,
      pid: child.pid,
      command,
      cwd,
      logPath,
      startedAt: Date.now(),
      exitCode: undefined,
      ports: [],
      child,
      log,
      output: "",
    };
    this.#entries.set(id, entry);

    let wake: (() => void) | undefined;
    const onData = (data: Buffer) => {
      log.write(data);
      entry.output = tailBytes(entry.output + data.toString("utf8"), 64 * 1024);
      const ports = detectPorts(entry.output);
      if (ports.length > 0) {
        entry.ports = ports;
        wake?.();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      onData(Buffer.from(`\n${error.message}\n`));
      entry.exitCode = entry.exitCode ?? 127;
      wake?.();
    });
    child.on("exit", (code, signal) => {
      entry.exitCode = code ?? (signal ? 128 : 1);
      log.end();
      wake?.();
    });
    child.unref();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      wake = () => {
        clearTimeout(timer);
        // Даём серверу дописать баннер после строки с портом.
        setTimeout(resolve, 150);
      };
    });
    return { ...this.#public(entry), output: entry.output };
  }

  list(): BackgroundProcess[] {
    return [...this.#entries.values()].map((entry) => this.#public(entry));
  }

  get(id: string): BackgroundProcess | undefined {
    const entry = this.#entries.get(id);
    return entry ? this.#public(entry) : undefined;
  }

  logs(id: string, bytes = 8 * 1024): string | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    try {
      return tailBytes(readFileSync(entry.logPath, "utf8"), bytes);
    } catch {
      return tailBytes(entry.output, bytes);
    }
  }

  /** Работающие процессы реестра, которые подходят под шаблон pkill/killall: по команде или порту. */
  matching(pattern: string): BackgroundProcess[] {
    let re: RegExp | undefined;
    try {
      re = new RegExp(pattern);
    } catch {
      re = undefined;
    }
    // Порт — только в виде «:8099» (например, `pkill -f ":8099"`); голые числа в шаблоне — не порты.
    const ports = [...pattern.matchAll(/:(\d{2,5})\b/g)].map((m) => Number(m[1]));
    return [...this.#entries.values()]
      .filter((entry) => entry.exitCode === undefined)
      .filter(
        (entry) =>
          entry.command.includes(pattern) ||
          (re?.test(entry.command) ?? false) ||
          entry.ports.some((port) => ports.includes(port)),
      )
      .map((entry) => this.#public(entry));
  }

  byPort(port: number): BackgroundProcess | undefined {
    const entry = [...this.#entries.values()].find(
      (e) => e.exitCode === undefined && e.ports.includes(port),
    );
    return entry ? this.#public(entry) : undefined;
  }

  /** SIGTERM, до 2 с ожидания, потом SIGKILL — чтобы порт точно освободился до ответа модели. */
  async stop(id: string): Promise<BackgroundProcess | undefined> {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    await this.#stopEntry(entry);
    return this.#public(entry);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((entry) => this.#stopEntry(entry)));
    liveRegistries.delete(this);
  }

  /** Синхронно, для process.on("exit"). */
  killAllNow(): void {
    for (const entry of this.#entries.values()) {
      if (entry.exitCode === undefined && entry.pid) killTree(entry.pid, "SIGKILL");
    }
  }

  async #stopEntry(entry: Entry): Promise<void> {
    if (entry.exitCode !== undefined || !entry.pid) return;
    killTree(entry.pid, "SIGTERM");
    if (await this.#waitExit(entry, 2000)) return;
    killTree(entry.pid, "SIGKILL");
    await this.#waitExit(entry, 1000);
  }

  async #waitExit(entry: Entry, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (entry.exitCode === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return entry.exitCode !== undefined;
  }

  #public(entry: Entry): BackgroundProcess {
    return {
      id: entry.id,
      pid: entry.pid,
      command: entry.command,
      cwd: entry.cwd,
      logPath: entry.logPath,
      startedAt: entry.startedAt,
      exitCode: entry.exitCode,
      ports: entry.ports,
    };
  }
}

export function describeProcess(proc: BackgroundProcess): string {
  const status = proc.exitCode === undefined ? "работает" : `завершён (код ${proc.exitCode})`;
  const ports = proc.ports.length > 0 ? `, порт ${proc.ports.join(", ")}` : "";
  return `${proc.id}: ${status}, pid ${proc.pid ?? "?"}${ports}, лог ${proc.logPath}\n  $ ${proc.command}`;
}

/** PID процессов, которые слушают TCP-порт (lsof/ss на POSIX, netstat на Windows). Без своего PID. */
export function pidsListeningOn(port: number): number[] {
  const pids = new Set<number>();
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
    return r.status === 0 || r.stdout ? (r.stdout ?? "") : "";
  };
  if (process.platform === "win32") {
    for (const line of run("netstat", ["-ano", "-p", "tcp"]).split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (
        cols.length >= 5 &&
        /LISTEN/i.test(cols[3] ?? "") &&
        (cols[1] ?? "").endsWith(`:${port}`)
      ) {
        pids.add(Number(cols[4]));
      }
    }
  } else {
    for (const pid of run("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]).split(/\s+/)) {
      if (/^\d+$/.test(pid)) pids.add(Number(pid));
    }
    if (pids.size === 0) {
      for (const m of run("ss", ["-ltnpH", `sport = :${port}`]).matchAll(/pid=(\d+)/g)) {
        pids.add(Number(m[1]));
      }
    }
  }
  pids.delete(process.pid);
  pids.delete(0);
  return [...pids].filter((pid) => Number.isFinite(pid));
}

/** Чужой процесс (не из реестра): не лидер группы, поэтому без kill(-pid). */
export function killPid(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // уже завершился или не наш
  }
}
