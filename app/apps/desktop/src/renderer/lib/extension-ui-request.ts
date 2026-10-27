/**
 * Sidebar state around an extension's question: the asking chat is marked «waiting for
 * you» while the window is open, and put back to «running» once it is answered.
 *
 * Lives here rather than inline in `renderer/main.tsx` (over its line budget), and it
 * keys on the runtime that asked instead of the chat on screen — a question from a
 * background chat must mark *that* row, not the open one (#83).
 */
import type { HostEvent } from "@zeno/contracts";
import { sessionKeyFromSnapshot, useShellStore } from "../store/shell-store.ts";

type ShellState = ReturnType<typeof useShellStore.getState>;
type DialogRequest = Extract<HostEvent, { type: "extensionUi.request" }>;

function keyForRuntime(store: ShellState, runtimeId: string): string {
  return store.sessionKeyForRuntime(runtimeId) ?? sessionKeyFromSnapshot(store.snapshot);
}

/** The agent is blocked until the user answers: show that on its row. */
export function markExtensionUiWaiting(store: ShellState, event: DialogRequest): void {
  const key = keyForRuntime(store, event.runtimeId);
  if (!key || !store.runningSessions[key]) return;
  store.setSessionMarker(key, "waiting", { runtimeId: event.runtimeId, reason: event.method });
}

/** Answered (or dismissed): the turn goes on, so the row leaves the waiting state. */
export function clearExtensionUiWaiting(runtimeId: string): void {
  const store = useShellStore.getState();
  const key = keyForRuntime(store, runtimeId);
  if (!key || !store.runningSessions[key]) return;
  store.setSessionMarker(key, "running", { runtimeId });
}
