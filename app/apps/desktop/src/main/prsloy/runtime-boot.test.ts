import { describe, expect, it } from "vite-plus/test";
import type { ProvisionedRuntimeLayout, ProvisionPlan } from "../runtime-provision.ts";
import { join } from "node:path";
import { expectedRuntimeEnv, RuntimeBoot, type RuntimeBootState } from "./runtime-boot.ts";

const layout = {
  roots: undefined,
  npmPrefix: "/ud/npm",
  pythonVenv: "/ud/venv",
  provisioned: true,
  source: "userData",
} as unknown as ProvisionedRuntimeLayout;

function boot(
  plan: ProvisionPlan,
  provision?: () => Promise<ProvisionedRuntimeLayout | undefined>,
) {
  return new RuntimeBoot({
    userDataPath: "/ud",
    prefs: { useBundledNode: true, useBundledPython: true },
    env: { PATH: "/usr/bin" },
    plan: () => plan,
    ...(provision ? { provision: provision as never } : {}),
  });
}

describe("RuntimeBoot (window first)", () => {
  it("second launch: ready synchronously, nothing in the background", async () => {
    let called = false;
    const b = boot({ kind: "ready", layout }, async () => {
      called = true;
      return layout;
    });
    expect(b.startSync().status).toBe("ready");
    expect((await b.startBackground()).status).toBe("ready");
    expect(called).toBe(false);
    expect(await b.whenReady(10)).toBe(true);
  });

  it("first launch: installing until the background unpack finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const b = boot({ kind: "extract" } as ProvisionPlan, async () => {
      await gate;
      return layout;
    });
    const seen: RuntimeBootState["status"][] = [];
    b.onChange((state) => seen.push(state.status));
    expect(b.startSync().status).toBe("installing");
    const running = b.startBackground();
    expect(b.startBackground()).toBe(running); // idempotent
    expect(await b.whenReady(5)).toBe(false); // bounded wait times out
    release();
    expect(await b.whenReady(1000)).toBe(true);
    expect(b.layout()).toBe(layout);
    expect(seen.at(-1)).toBe("ready");
  });

  it("a failed unpack reports failed instead of hanging the first turn", async () => {
    const b = boot({ kind: "extract" } as ProvisionPlan, async () => {
      throw new Error("tar exited with 2");
    });
    b.startSync();
    const state = await b.startBackground();
    expect(state).toMatchObject({ status: "failed", error: "tar exited with 2" });
    expect(await b.whenReady(10)).toBe(false);
  });
});

describe("expectedRuntimeEnv (host spawned during the unpack)", () => {
  const prefs = { useBundledNode: true, useBundledPython: true };

  it("Windows: npm prefix, venv Scripts, node, python — in managed PATH order", () => {
    const { binDirs, env } = expectedRuntimeEnv({ userDataPath: "U", prefs, platform: "win32" });
    const rt = join("U", "runtimes");
    expect(binDirs).toEqual([
      join(rt, "npm-prefix"),
      join(rt, "python-venv", "Scripts"),
      join(rt, "node"),
      join(rt, "python"),
    ]);
    expect(env.NODE_BINARY).toBe(join(rt, "node", "node.exe"));
    expect(env.VIRTUAL_ENV).toBeUndefined();
  });

  it("POSIX bins and prefs gating", () => {
    const { binDirs } = expectedRuntimeEnv({
      userDataPath: "U",
      prefs: { useBundledNode: false, useBundledPython: true },
      platform: "linux",
    });
    expect(binDirs).toEqual([
      join("U", "runtimes", "python-venv", "bin"),
      join("U", "runtimes", "python", "bin"),
    ]);
  });

  it("startSync on a first launch puts the future bins on PATH", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    new RuntimeBoot({
      userDataPath: "/ud",
      prefs,
      env,
      plan: () => ({ kind: "extract" }) as ProvisionPlan,
    }).startSync();
    expect(env.PATH).toContain(join("/ud", "runtimes", "python", "bin"));
    expect(env.NPM_CONFIG_PREFIX).toBe(join("/ud", "runtimes", "npm-prefix"));
  });
});
