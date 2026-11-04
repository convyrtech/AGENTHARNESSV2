import { randomBytes } from "node:crypto";
import type { CuaOwnerResolution } from "@zeno/contracts";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { CuaRecoveryStore } from "./cua-recovery-store.ts";

export type CuaRecoveryControllerOptions = {
  userDataPath: () => string;
  enabled: () => boolean;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
};

/** Owns the durable action gate, host-loss transition, and trusted owner-resolution IPC. */
export class CuaRecoveryController {
  #store: CuaRecoveryStore | undefined;
  #challenges = new Map<string, string>();

  #storeFor(userDataPath: string): CuaRecoveryStore {
    this.#store ??= CuaRecoveryStore.open(userDataPath);
    return this.#store;
  }

  ensureAvailable(userDataPath: string): CuaRecoveryStore {
    return this.#storeFor(userDataPath);
  }

  markHostLost(hostId: string): void {
    if (!this.#store) return;
    try {
      const pending = this.#store.getPending("default");
      if (pending?.status === "dispatching" && pending.hostId === hostId) {
        this.#store.markUnknownAfterHostLoss(pending.actionId, hostId);
      }
    } catch (error) {
      // Keep the durable gate closed if loss recording fails; never treat this as success.
      console.error("[prsloy] failed to persist Cua host-loss state:", error);
    }
  }

  close(): void {
    this.#store?.close();
    this.#store = undefined;
  }

  installIpc(ipcMain: IpcMain, options: CuaRecoveryControllerOptions): void {
    const assertSender = options.assertTrustedSender;
    ipcMain.handle("prsloy:cua-recovery:list", (event) => {
      assertSender(event);
      if (!options.enabled()) return [];
      const store = this.#storeFor(options.userDataPath());
      const items = store.listPending().filter((item) => item.profileId === "default");
      const currentIds = new Set(items.map((item) => item.actionId));
      for (const id of this.#challenges.keys()) {
        if (!currentIds.has(id)) this.#challenges.delete(id);
      }
      return items.map((item) => {
        let challenge = this.#challenges.get(item.actionId);
        if (!challenge) {
          challenge = randomBytes(32).toString("hex");
          this.#challenges.set(item.actionId, challenge);
        }
        return {
          actionId: item.actionId,
          challenge,
          pid: item.pid,
          windowId: item.windowId,
          ...("backend" in item ? { backend: item.backend } : {}),
          kind: item.kind,
          status: item.status,
          createdAt: item.createdAt,
        };
      });
    });
    ipcMain.handle(
      "prsloy:cua-recovery:resolve",
      (event, actionId: string, challenge: string, resolution: CuaOwnerResolution) => {
        assertSender(event);
        if (!this.#store) throw new Error("Cua recovery is not enabled");
        if (
          typeof actionId !== "string" ||
          !/^[0-9a-f-]{36}$/iu.test(actionId) ||
          typeof challenge !== "string" ||
          !/^[0-9a-f]{64}$/iu.test(challenge) ||
          !["observed_completed", "observed_not_applied", "accept_unknown"].includes(resolution)
        ) {
          throw new Error("Некорректное решение Cua recovery");
        }
        const issued = this.#challenges.get(actionId);
        if (!issued || issued !== challenge) throw new Error("Устаревший challenge Cua recovery");
        this.#store.resolveUnknown(
          actionId,
          resolution,
          (pending) =>
            pending.actionId === actionId && this.#challenges.get(actionId) === challenge,
        );
        this.#challenges.delete(actionId);
      },
    );
    ipcMain.handle(
      "prsloy:cua-recovery:accept-in-flight",
      (event, actionId: string, challenge: string) => {
        assertSender(event);
        if (!this.#store) throw new Error("Cua recovery is not enabled");
        if (
          typeof actionId !== "string" ||
          !/^[0-9a-f-]{36}$/iu.test(actionId) ||
          typeof challenge !== "string" ||
          !/^[0-9a-f]{64}$/iu.test(challenge)
        )
          throw new Error("Некорректное решение Cua recovery");
        const issued = this.#challenges.get(actionId);
        if (!issued || issued !== challenge) throw new Error("Устаревший challenge Cua recovery");
        this.#store.acceptDispatchingRisk(
          actionId,
          (pending) =>
            pending.actionId === actionId && this.#challenges.get(actionId) === challenge,
        );
        this.#challenges.delete(actionId);
      },
    );
  }
}
