import { markUnreadOnAgentSettle } from "../lib/project-prefs.ts";
import { sessionKeyFromSnapshot, useShellStore } from "./shell-store.ts";

/**
 * Mark sidebar session unread when a turn settles and the user is not currently
 * reading that transcript (other session, settings, packages, …).
 * Must run before settleSessionByRuntime drops the runtime→session binding.
 */
export function maybeMarkUnreadForRuntime(runtimeId: string): void {
  const store = useShellStore.getState();
  const sessionKey = store.sessionKeyForRuntime(runtimeId);
  if (!sessionKey) return;
  markUnreadOnAgentSettle(sessionKey, {
    activeSessionKey: sessionKeyFromSnapshot(store.snapshot),
    view: store.view,
  });
}
