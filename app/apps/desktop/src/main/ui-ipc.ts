/**
 * The ui stream's IPC in main, registered with one call so main/index.ts (at its line budget)
 * does not grow with each: harness switches in settings, chats from other agents (#22).
 */
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { installHarnessFlags } from "./harness-flags.ts";
import { installSessionImport } from "./import/ipc.ts";

export function installUiIpc(
  assertTrustedSender: (event: IpcMainInvokeEvent) => void,
  getWindow: () => BrowserWindow | null | undefined,
): void {
  installHarnessFlags(assertTrustedSender);
  installSessionImport(assertTrustedSender, getWindow);
}
