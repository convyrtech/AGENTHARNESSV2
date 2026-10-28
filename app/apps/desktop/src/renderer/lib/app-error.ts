/**
 * App-level error reporting: a modal for failures that are not part of a chat
 * (trust, snapshot, send, abort…). Moved out of `renderer/main.tsx`, which is over its
 * line budget — this is the same function, byte for byte, plus the import it needs.
 */
import { unwrapRemoteIpcError } from "../../shared/ipc-error.ts";
import { errorMessageOrFallback } from "./host-signals.ts";
import { useShellStore } from "../store/shell-store.ts";

/** Surface app-level errors as a modal (agent timeline errors stay in-chat). */
export function reportAppError(error: unknown, fallback: string): string {
  const message = unwrapRemoteIpcError(errorMessageOrFallback(error, fallback));
  useShellStore.getState().showAppError(message);
  return message;
}
