import { isAbsolute } from "node:path";
import { CuaRecoveryStore } from "../main/prsloy/cua-recovery-store.ts";
import type { CuaRecoveryGate, MunimRecoveryGate } from "@prsloy/harness";

/** One shared durable gate per Electron profile, shared by all utility processes. */
export function createCuaRecoveryGate(
  userData: string,
  hostId: string,
  sessionId: string,
): {
  gate: CuaRecoveryGate;
  close: () => void;
} {
  if (!userData || !isAbsolute(userData))
    throw new Error("Cua recovery requires an absolute userData path");
  if (!hostId || !sessionId) throw new Error("Cua recovery requires a host and session identity");
  const store = CuaRecoveryStore.open(userData);
  return {
    gate: {
      beginAction(input) {
        return store.beginDispatch({
          profileId: "default",
          hostId,
          sessionId,
          pid: input.pid,
          windowId: input.windowId,
          kind: input.kind,
        }).actionId;
      },
      recordOutcome(actionId, outcome) {
        store.recordOutcome(actionId, hostId, outcome);
      },
      recordAbort(actionId) {
        store.recordAbort(actionId, hostId);
      },
    },
    close: () => store.close(),
  };
}

/** The same profile-wide gate, with an explicitly PID-only Munim target. */
export function createMunimRecoveryGate(
  userData: string,
  hostId: string,
  sessionId: string,
): {
  gate: MunimRecoveryGate;
  close: () => void;
} {
  if (!userData || !isAbsolute(userData))
    throw new Error("Munim recovery requires an absolute userData path");
  if (!hostId || !sessionId) throw new Error("Munim recovery requires a host and session identity");
  const store = CuaRecoveryStore.open(userData);
  return {
    gate: {
      beginAction(input) {
        return store.beginMunimDispatch({
          profileId: "default",
          hostId,
          sessionId,
          pid: input.pid,
          kind: input.kind,
        }).actionId;
      },
      recordOutcome(actionId) {
        store.recordOutcome(actionId, hostId, "ambiguous");
      },
      recordAbort(actionId) {
        store.recordAbort(actionId, hostId);
      },
    },
    close: () => store.close(),
  };
}
