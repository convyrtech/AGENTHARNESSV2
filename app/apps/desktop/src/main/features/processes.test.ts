import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  harnessOutputDir,
  hostPidOfLog,
  isAlive,
  mayStop,
  parentPid,
  readLogTail,
  stopTree,
} from "./processes.ts";

function logIn(hostPid: number, body: string) {
  const dir = join(harnessOutputDir(), `bg-${hostPid}-abc123`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "bg1.log");
  writeFileSync(path, body);
  return path;
}

describe("background processes seen from main", () => {
  it("knows the harness's logs and nothing else", () => {
    const root = harnessOutputDir();
    expect(hostPidOfLog(join(root, "bg-4242-k3x9", "bg1.log"))).toBe(4242);
    expect(hostPidOfLog(join(root, "bg-4242-k3x9", "secret.txt"))).toBeUndefined();
    expect(hostPidOfLog(join(root, "bg-4242-k3x9", "..", "..", "bg1.log"))).toBeUndefined();
    expect(hostPidOfLog(join(root, "other", "bg1.log"))).toBeUndefined();
    expect(hostPidOfLog(join(mkdtempSync(join(root, "..", "x-")), "bg1.log"))).toBeUndefined();
    expect(hostPidOfLog(42)).toBeUndefined();
  });

  it("reads the last 200 lines with secrets scrubbed", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `строка ${i}`);
    lines.push("token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789");
    const tail = readLogTail(logIn(9_000_001, lines.join("\n")));
    const out = tail?.split("\n") ?? [];
    expect(out).toHaveLength(201);
    expect(out[0]).toBe("строка 100");
    expect(tail).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(readLogTail("/etc/passwd")).toBeUndefined();
  });

  it("stops only what our host started", () => {
    const log = join(harnessOutputDir(), "bg-500-abc", "bg1.log");
    const deps = (tree: Record<number, number>) => ({
      parentOf: (pid: number) => tree[pid],
      mainPid: 100,
      alive: () => true,
    });
    expect(mayStop(777, log, deps({ 777: 500, 500: 100 }))).toEqual({ ok: true });
    expect(mayStop(777, log, deps({ 777: 1, 500: 100 }))).toEqual({
      ok: false,
      reason: "not_ours",
    });
    expect(mayStop(777, log, deps({ 777: 500, 500: 1 }))).toEqual({
      ok: false,
      reason: "not_ours",
    });
    expect(mayStop(777, "/tmp/x.log", deps({ 777: 500, 500: 100 }))).toMatchObject({ ok: false });
    expect(mayStop("777", log, deps({}))).toMatchObject({ ok: false });
    expect(mayStop(777, log, { ...deps({}), alive: () => false })).toEqual({
      ok: false,
      reason: "gone",
    });
  });

  it.skipIf(process.platform === "win32")(
    "stops a real process tree and sees it gone",
    async () => {
      const child = spawn("sh", ["-c", "sleep 30 & sleep 30"], { detached: true, stdio: "ignore" });
      const pid = child.pid!;
      expect(isAlive(pid)).toBe(true);
      expect(parentPid(pid)).toBe(process.pid);
      expect(await stopTree(pid)).toBe(true);
      expect(isAlive(pid)).toBe(false);
      expect(parentPid(pid)).toBeUndefined();
    },
  );
});
