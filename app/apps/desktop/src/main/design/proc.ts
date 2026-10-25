/**
 * Kill a harness process with everything it started (pi sessions, Python tools,
 * browsers). Windows: `taskkill /T /F`; POSIX: the child leads its own process group.
 */
import { type ChildProcess, execFile, execFileSync } from "node:child_process";

export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (platform === "win32") {
    execFile("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 3000);
  // Not cleared on the leader's exit: grandchildren that ignored SIGTERM still get this.
  timer.unref();
}

/** Spawn options so killTree reaches grandchildren. */
export function treeSpawnOptions(platform: NodeJS.Platform = process.platform): {
  detached: boolean;
  windowsHide: boolean;
} {
  return { detached: platform !== "win32", windowsHide: true };
}

/** Synchronous variant for process exit, when timers and callbacks no longer run. */
export function killTreeNow(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  try {
    if (platform === "win32") {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}
