import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPrsloyHarness } from "../src/index.ts";
import { normalizeWindowsShellPath, resolveToolPath } from "../src/paths.ts";
import { MockPi } from "./mock-pi.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("tool paths like Pi resolves them", () => {
  it("Git Bash / WSL drive paths on Windows", () => {
    expect(normalizeWindowsShellPath("/c/Users/me/app/index.html")).toBe(
      "C:\\Users\\me\\app\\index.html",
    );
    expect(normalizeWindowsShellPath("/mnt/d/x")).toBe("D:\\x");
    expect(normalizeWindowsShellPath("/usr/lib")).toBe("/usr/lib");
    expect(resolveToolPath("/c/proj/a.ts", "C:\\work", "win32")).toBe("C:\\proj\\a.ts");
    expect(resolveToolPath("src/a.ts", "C:\\work", "win32")).toBe("C:\\work\\src\\a.ts");
  });

  it("strips @, expands ~, resolves relative to cwd", () => {
    expect(resolveToolPath("@src/a.ts", "/w", "linux")).toBe("/w/src/a.ts");
    expect(resolveToolPath("~/x.ts", "/w", "linux", "/home/u")).toBe("/home/u/x.ts");
    expect(resolveToolPath("/abs/x", "/w", "linux")).toBe("/abs/x");
  });
});

describe("handler order in createPrsloyHarness", () => {
  it("the budget warning survives the 30 KB cut of a large read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prsloy-order-"));
    dirs.push(dir);
    const pi = new MockPi(dir);
    createPrsloyHarness({ maxToolCalls: 5, outputDir: dir, profile: "other" })(pi.api);
    for (let i = 0; i < 3; i++) await pi.call("read", { path: `f${i}` }, "ok");
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const { result } = await pi.call("read", { path: "big.txt" }, big);
    expect(result?.text).toContain("[Бюджет задачи: 80%");
    expect(result?.text).toContain("Дальше: read с offset=");
  });
});

describe("options from env (loading by path, smoke)", () => {
  it("PRSLOY_BASH_TIMEOUT_SEC sets the default bash timeout; explicit options win", async () => {
    const { resolveOptions } = await import("../src/options.ts");
    const before = process.env.PRSLOY_BASH_TIMEOUT_SEC;
    try {
      process.env.PRSLOY_BASH_TIMEOUT_SEC = "5";
      expect(resolveOptions().bashTimeoutSec).toBe(5);
      expect(resolveOptions({ bashTimeoutSec: 30 }).bashTimeoutSec).toBe(30);
      process.env.PRSLOY_BASH_TIMEOUT_SEC = "nope";
      expect(resolveOptions().bashTimeoutSec).toBe(120);
    } finally {
      if (before === undefined) delete process.env.PRSLOY_BASH_TIMEOUT_SEC;
      else process.env.PRSLOY_BASH_TIMEOUT_SEC = before;
    }
  });
});
