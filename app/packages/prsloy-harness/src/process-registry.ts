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
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::):(\d{2,5})\b/g,
  /\bport\s*[:=]?\s*(\d{2,5})\b/gi,
];

export function detectPorts(text: string): number[] {
  const found = new Set<number>();
  for (const pattern of PORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const port = Number(match[1]);
      if (port >= 80 && port <= 65535) found.add(port);
    }
  }
  return [...found];
}

/** Долгоживущие команды: dev-серверы и вотчеры. Они никогда не завершаются сами. */
const SERVER_COMMAND =
  /(^|[;&|]\s*|\s)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b|npx\s+(?:-y\s+)?(?:serve|http-server|live-server|vite(?!\s+build))\b|vite(?:\s+(?:dev|serve|preview))?\s*$|next\s+(?:dev|start)\b|python[0-9.]*\s+-m\s+http\.server\b|http-server\b|live-server\b|uvicorn\b|flask\s+run\b|gunicorn\b|php\s+-S\b|rails\s+s(?:erver)?\b|webpack(?:-dev-server|\s+serve)\b|\S*\s--watch\b|nodemon\b)/;

export function looksLikeServer(command: string): boolean {
  const trimmed = command.trim();
  if (/&\s*$/.test(trimmed)) return false; // модель уже сама отправила в фон
  if (/^timeout\s/.test(trimmed)) return false; // модель сама ограничила время
  return SERVER_COMMAND.test(trimmed);
}

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // уже завершился
    }
  }
}

export class ProcessRegistry {
  readonly #entries = new Map<string, Entry>();
  #next = 1;

  constructor(
    private readonly logDir: string,
    private readonly env: () => NodeJS.ProcessEnv,
  ) {}

  /** Запускает команду в фоне и ждёт первые `waitMs` (или пока не появится порт). */
  async start(command: string, cwd: string, waitMs = 4000): Promise<BackgroundProcess & { output: string }> {
    mkdirSync(this.logDir, { recursive: true });
    const id = `bg${this.#next++}`;
    const logPath = join(this.logDir, `${id}.log`);
    const log = createWriteStream(logPath);
    const shell = getShellConfig();
    const viaStdin = shell.commandTransport === "stdin";
    const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, command], {
      cwd,
      detached: process.platform !== "win32",
      env: this.env(),
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

  stop(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    if (entry.exitCode === undefined && entry.pid) killTree(entry.pid);
    return true;
  }

  stopAll(): void {
    for (const entry of this.#entries.values()) {
      if (entry.exitCode === undefined && entry.pid) killTree(entry.pid);
    }
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
