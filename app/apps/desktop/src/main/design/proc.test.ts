import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { killTree, treeSpawnOptions } from "./proc.ts";

/** Running, not a zombie: in a container PID 1 may never reap the orphaned grandchild. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

describe.skipIf(process.platform === "win32")("killTree", () => {
  it("stops the child and the processes it started", async () => {
    // sh starts a grandchild sleep and prints its pid
    const child = spawn("sh", ["-c", "sleep 60 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
      ...treeSpawnOptions(),
    });
    const grandchild = await new Promise<number>((resolve) =>
      child.stdout.once("data", (b: Buffer) => resolve(Number(b.toString().trim()))),
    );
    expect(alive(grandchild)).toBe(true);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    killTree(child);
    await exited;
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(grandchild)).toBe(false);
  });
});
