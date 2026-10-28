import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { installBashTimeout } from "../src/bash-timeout.ts";
import { resolveOptions } from "../src/options.ts";
import { MockPi } from "./mock-pi.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("bash shellPath lazy resolution", () => {
  it("reads shellPath from Pi settings at call time, not extension load time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prsloy-shell-"));
    dirs.push(dir);
    const pi = new MockPi(dir);
    let loaded = false;
    const api = Object.assign(pi.api, {
      getSettings: () => {
        if (!loaded) throw new Error("Extension runtime not initialized");
        return { shellPath: "/nonexistent" };
      },
    });
    installBashTimeout(api, resolveOptions({ outputDir: join(dir, ".harness-out") }));
    loaded = true;
    const result = pi.tools
      .get("bash")!
      .execute("t", { command: "echo hi" }, undefined, undefined, pi.ctx as never);
    await expect(result).rejects.toThrow(/Custom shell path not found/);
  });
});
