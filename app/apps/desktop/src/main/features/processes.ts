/**
 * «Бот работает · Остановить · Журнал» (research/19 §1.10): the agent's background processes
 * (the harness's `bash_background`), seen from main. The renderer knows them from the
 * tool results ({id, pid, logPath, ports}); main answers whether each still runs, reads the
 * tail of its log (secrets scrubbed) and stops it the way the harness's `process stop` does:
 * the process tree, TERM, then KILL after 2 s.
 *
 * Main stops only what our own agent host started: the log lies in the harness's folder
 * `<tmp>/prsloy-harness/bg-<host pid>-<…>/bg<N>.log`, that host is a child of this main
 * process, and the pid is a child of that host.
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { scrubSecrets } from "@prsloy/harness";

export const LOG_LINES = 200;
const LOG_TAIL_BYTES = 64 * 1024;

/** The harness's default `outputDir` (options.ts): logs of background processes go below it. */
export function harnessOutputDir(): string {
  return join(tmpdir(), "prsloy-harness");
}

/** Host pid from a log path inside the harness folder, else undefined (not ours). */
export function hostPidOfLog(logPath: unknown, root = harnessOutputDir()): number | undefined {
  if (typeof logPath !== "string" || !logPath) return undefined;
  const abs = resolve(logPath);
  const rel = relative(resolve(root), abs);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) return undefined;
  const parts = rel.split(sep);
  if (parts.length !== 2 || !/^bg\d+\.log$/u.test(basename(abs))) return undefined;
  const match = /^bg-(\d+)-[a-z0-9]+$/u.exec(basename(dirname(abs)));
  return match ? Number(match[1]) : undefined;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parent pid, or undefined when the process is gone or the system cannot tell. */
export function parentPid(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const r =
    process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
          ],
          { encoding: "utf8", windowsHide: true, timeout: 8000 },
        )
      : spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
  const value = Number((r.stdout ?? "").trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The last lines of a log, secrets scrubbed; only logs of the harness's folder. */
export function readLogTail(logPath: unknown, lines = LOG_LINES): string | undefined {
  if (hostPidOfLog(logPath) === undefined) return undefined;
  const path = resolve(logPath as string);
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fd = openSync(path, "r");
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const tail = text
      .split(/\r?\n/u)
      .slice(-lines - 1)
      .join("\n")
      .trimEnd();
    return scrubSecrets(tail).text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type StopCheck = { ok: true } | { ok: false; reason: "not_ours" | "gone" };

/** Whether main may stop `pid`: see the module comment. */
export function mayStop(
  pid: unknown,
  logPath: unknown,
  deps: {
    parentOf: (pid: number) => number | undefined;
    mainPid: number;
    alive: (pid: number) => boolean;
  },
): StopCheck {
  const host = hostPidOfLog(logPath);
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || host === undefined) {
    return { ok: false, reason: "not_ours" };
  }
  if (!deps.alive(pid)) return { ok: false, reason: "gone" };
  if (deps.parentOf(host) !== deps.mainPid) return { ok: false, reason: "not_ours" };
  if (deps.parentOf(pid) !== host) return { ok: false, reason: "not_ours" };
  return { ok: true };
}

/** The harness's killTree: the group on POSIX (it starts them detached), the tree on Windows. */
function killTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  return !isAlive(pid);
}

/** TERM, up to 2 s, then KILL, up to 1 s more: as the harness's ProcessRegistry.stop. */
export async function stopTree(pid: number): Promise<boolean> {
  killTree(pid, "SIGTERM");
  if (await waitGone(pid, 2000)) return true;
  killTree(pid, "SIGKILL");
  return waitGone(pid, 1000);
}
