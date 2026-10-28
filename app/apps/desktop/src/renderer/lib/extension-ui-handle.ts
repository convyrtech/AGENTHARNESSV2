/**
 * Everything an `extensionUi.request` does to the window, in one place.
 *
 * Lives here rather than inline in `renderer/main.tsx` (over its line budget). Two rules
 * matter and both were wrong before (#83):
 *
 * - A *dialog* (question) is shown no matter which chat is on screen — the agent that asked
 *   is blocked until it is answered, and its sidebar row is marked «waiting for you». The
 *   answer is routed back by `runtimeId`, so switching chats does not lose it.
 * - Portable chrome (notifications, status, widgets, title, editor draft) belongs to the chat
 *   on screen only; a background chat must not write into the user's open composer.
 */
import type { HostEvent } from "@zeno/contracts";
import {
  applyExtensionUiFireForget,
  isExtensionUiFireForgetMethod,
  type ExtensionNotifyTone,
  type ExtensionUiPortableState,
} from "./extension-ui-state.ts";
import { isExtensionUiDialogMethod } from "./extension-ui-prompt.ts";
import { clearExtensionUiWaiting, markExtensionUiWaiting } from "./extension-ui-request.ts";
import type { useShellStore } from "../store/shell-store.ts";

type ShellState = ReturnType<typeof useShellStore.getState>;
type ExtensionUiRequest = Extract<HostEvent, { type: "extensionUi.request" }>;

export function handleExtensionUiRequest(input: {
  event: ExtensionUiRequest;
  store: ShellState;
  state: ExtensionUiPortableState;
  /** Called only when the portable state actually changed. */
  setState: (state: ExtensionUiPortableState) => void;
  setPrompt: (text: string) => void;
  applyNotify: (notice: { message: string; type: ExtensionNotifyTone } | undefined) => void;
  respond: (event: ExtensionUiRequest) => Promise<void>;
}): void {
  const { event, store } = input;
  // Allow through when runtimeId is not set yet (session_start can race host.ready).
  const isActiveRuntime = !store.runtimeId || event.runtimeId === store.runtimeId;

  if (isExtensionUiFireForgetMethod(event.method)) {
    if (!isActiveRuntime) return;
    const result = applyExtensionUiFireForget(input.state, {
      runtimeId: event.runtimeId,
      method: event.method,
      args: event.args,
    });
    input.setState(result.state);
    if (result.editorText !== undefined) input.setPrompt(result.editorText);
    input.applyNotify(result.notify);
    return;
  }

  if (!isExtensionUiDialogMethod(event.method)) return;
  markExtensionUiWaiting(store, event);
  void input.respond(event).finally(() => {
    clearExtensionUiWaiting(event.runtimeId);
  });
}
