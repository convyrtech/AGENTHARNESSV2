/**
 * IPC of the «Код» features from open-source analogs (research 19 §1). Every handler
 * checks the sender first (main frame of our window only), then its arguments.
 */
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";
import type { ProjectZipResult } from "@zeno/contracts";
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { previewWorkspace } from "../code-preview-guard.ts";
import { listProjectFiles, zipName, zipProject } from "./project-zip.ts";

async function exportProjectZip(
  event: IpcMainInvokeEvent,
  workspacePath: unknown,
): Promise<ProjectZipResult> {
  const ws = previewWorkspace(typeof workspacePath === "string" ? workspacePath : undefined);
  if (!ws) return { ok: false, reason: "outside_workspace" };
  const listed = listProjectFiles(ws);
  if (!listed.ok) return listed;
  if (listed.files.length === 0) return { ok: false, reason: "empty" };
  let downloads = homedir();
  try {
    downloads = app.getPath("downloads");
  } catch {
    // no downloads folder known: home
  }
  const options = {
    defaultPath: join(downloads, zipName(basename(ws))),
    filters: [{ name: "ZIP", extensions: ["zip"] }],
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (res.canceled || !res.filePath) return { ok: false, reason: "canceled" };
  writeFileSync(res.filePath, zipProject(listed.files, basename(ws)));
  shell.showItemInFolder(res.filePath);
  return { ok: true, path: res.filePath, files: listed.files.length };
}

export function installFeatures(assertTrustedSender: (event: IpcMainInvokeEvent) => void): void {
  ipcMain.handle("prsloy:features:export-project-zip", (event, workspacePath: unknown) => {
    assertTrustedSender(event);
    return exportProjectZip(event, workspacePath);
  });
}
