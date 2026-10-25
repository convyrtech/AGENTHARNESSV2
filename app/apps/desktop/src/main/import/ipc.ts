/**
 * `prsloy:import:*` — chats from other agents (#22 I1). Paths follow the rest of main: the agent
 * and chat folders main exported at startup (prsloy/context.ts), the journal next to PRSLOY's own
 * state in `<userData>/prsloy`. The other tools' folders come from the user's environment
 * (packages/session-import `sourceRoots`). The run is async in main: files are streamed line by
 * line, so the window stays responsive.
 */
import { join } from "node:path";
import { homeDir, sourceRoots } from "@prsloy/session-import";
import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IMPORT_LEDGER_FILE, type ImportPaths, SessionImportService } from "./service.ts";

export const IMPORT_PROGRESS_CHANNEL = "prsloy:import:progress";

function importPaths(): ImportPaths {
  const userData = app.getPath("userData");
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(userData, "agent");
  return {
    roots: sourceRoots(process.env),
    home: homeDir(process.env),
    agentDir,
    sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || join(agentDir, "sessions"),
    ledgerPath: join(userData, "prsloy", IMPORT_LEDGER_FILE),
  };
}

export function installSessionImport(
  assertTrustedSender: (event: IpcMainInvokeEvent) => void,
  getWindow: () => BrowserWindow | null | undefined,
): void {
  const service = new SessionImportService(importPaths);
  ipcMain.handle("prsloy:import:scan", async (event) => {
    assertTrustedSender(event);
    return service.scan();
  });
  ipcMain.handle("prsloy:import:run", async (event, keys: unknown) => {
    assertTrustedSender(event);
    return service.run(keys, (progress) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(IMPORT_PROGRESS_CHANNEL, progress);
    });
  });
}
