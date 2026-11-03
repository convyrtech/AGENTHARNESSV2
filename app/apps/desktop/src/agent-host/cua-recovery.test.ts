import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCuaRecoveryGate, createMunimRecoveryGate } from "./cua-recovery.ts";
import { CuaRecoveryStore } from "../main/prsloy/cua-recovery-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("desktop Cua recovery adapter", () => {
  it("shares unresolved Munim actions with the Cua gate without inventing an HWND", () => {
    const root = mkdtempSync(join(tmpdir(), "munim-host-gate-"));
    roots.push(root);
    const munim = createMunimRecoveryGate(root, "munim-host", "session-a");
    const cua = createCuaRecoveryGate(root, "cua-host", "session-b");
    const action = munim.gate.beginAction({ operationId: "a", pid: 42, kind: "click" });
    expect(() =>
      cua.gate.beginAction({ operationId: "b", pid: 42, windowId: 2, kind: "click" }),
    ).toThrow(/CUA_RECOVERY_BLOCKED/);
    munim.gate.recordOutcome(action, "unknown");
    const observer = CuaRecoveryStore.open(root);
    expect(observer.getPending("default")).toMatchObject({
      actionId: action,
      backend: "munim",
      windowId: null,
      status: "unknown",
    });
    observer.close();
    munim.close();
    cua.close();
  });
  it("shares a profile-wide gate across independent hosts and keeps uncertain effects blocked", () => {
    const root = mkdtempSync(join(tmpdir(), "cua-host-gate-"));
    roots.push(root);
    const a = createCuaRecoveryGate(root, "host-a", "session-a");
    const b = createCuaRecoveryGate(root, "host-b", "session-b");
    const action = a.gate.beginAction({ operationId: "a", pid: 42, windowId: 2, kind: "click" });
    expect(() =>
      b.gate.beginAction({ operationId: "b", pid: 42, windowId: 2, kind: "click" }),
    ).toThrow(/CUA_RECOVERY_BLOCKED/);
    a.gate.recordOutcome(action, "ambiguous");
    const observer = CuaRecoveryStore.open(root);
    expect(observer.getPending("default")).toMatchObject({
      actionId: action,
      status: "unknown",
      hostId: "host-a",
    });
    expect(() =>
      b.gate.beginAction({ operationId: "c", pid: 42, windowId: 2, kind: "click" }),
    ).toThrow(/CUA_RECOVERY_BLOCKED/);
    observer.close();
    a.close();
    b.close();
  });
  it("rejects an absent or relative profile path rather than silently skipping persistence", () => {
    expect(() => createCuaRecoveryGate("", "host", "session")).toThrow(/absolute/);
    expect(() => createCuaRecoveryGate("relative", "host", "session")).toThrow(/absolute/);
  });
});
