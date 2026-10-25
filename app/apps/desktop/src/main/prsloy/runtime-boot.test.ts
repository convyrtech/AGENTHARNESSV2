import { describe, expect, it } from "vite-plus/test";
import type { ProvisionedRuntimeLayout, ProvisionPlan } from "../runtime-provision.ts";
import { RuntimeBoot, type RuntimeBootState } from "./runtime-boot.ts";

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
    expect(b.generation()).toBe(0);
    expect(await b.whenReady(10)).toBe(true);
  });

  it("first launch: installing until the background unpack finishes, then bumps generation", async () => {
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
    expect(b.generation()).toBe(1);
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
