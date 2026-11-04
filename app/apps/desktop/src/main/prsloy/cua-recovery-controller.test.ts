import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { CuaRecoveryController } from "./cua-recovery-controller.ts";

const roots: string[] = [];

function setup(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "cua-recovery-controller-"));
  roots.push(root);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registerHandler: IpcMain["handle"] = (name, listener) => {
    handlers.set(name, listener as (...args: unknown[]) => unknown);
  };
  const controller = new CuaRecoveryController();
  let senderAccepted = true;
  controller.installIpc({ handle: registerHandler } as unknown as IpcMain, {
    userDataPath: () => root,
    enabled: () => enabled,
    assertTrustedSender: (_event: IpcMainInvokeEvent) => {
      if (!senderAccepted) throw new Error("untrusted sender");
    },
  });
  return {
    controller,
    handlers,
    root,
    event: {} as IpcMainInvokeEvent,
    rejectSender: () => {
      senderAccepted = false;
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Cua recovery IPC controller", () => {
  it("records host loss, issues a challenge, and resolves only the current action", async () => {
    const fixture = setup();
    const store = fixture.controller.ensureAvailable(fixture.root);
    const action = store.beginDispatch({
      profileId: "default",
      hostId: "host-1",
      sessionId: "session-1",
      pid: 1234,
      windowId: 5678,
      kind: "click",
    });
    fixture.controller.markHostLost("host-1");
    expect(store.getPending("default")).toMatchObject({
      actionId: action.actionId,
      status: "unknown",
    });

    const list = fixture.handlers.get("prsloy:cua-recovery:list")!;
    const items = (await list(fixture.event)) as Array<{ actionId: string; challenge: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ actionId: action.actionId });
    expect(items[0]!.challenge).toMatch(/^[0-9a-f]{64}$/u);

    const resolve = fixture.handlers.get("prsloy:cua-recovery:resolve")!;
    expect(() =>
      resolve(fixture.event, action.actionId, "0".repeat(64), "observed_not_applied"),
    ).toThrow(/Устаревший challenge/u);
    resolve(fixture.event, action.actionId, items[0]!.challenge, "observed_not_applied");
    expect(store.getPending("default")).toBeUndefined();
    expect(list(fixture.event)).toEqual([]);
    fixture.controller.close();
  });

  it("keeps the list empty when disabled and checks the trusted sender first", async () => {
    const fixture = setup(false);
    const list = fixture.handlers.get("prsloy:cua-recovery:list")!;
    expect(list(fixture.event)).toEqual([]);
    expect(fixture.controller.ensureAvailable(fixture.root).listPending()).toEqual([]);
    fixture.rejectSender();
    expect(() => list(fixture.event)).toThrow("untrusted sender");
    fixture.controller.close();
  });
});
