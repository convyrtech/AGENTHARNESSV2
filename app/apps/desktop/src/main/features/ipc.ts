/**
 * IPC of the «Код» features from open-source analogs (research 19 §1). Every handler
 * checks the sender first (main frame of our window only), then its arguments.
 */
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import type { PreviewCaptureResult, ProjectZipResult } from "@zeno/contracts";
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { previewWorkspace } from "../code-preview-guard.ts";
import { captureRect } from "./capture-rect.ts";
import { listProjectFiles, zipName, zipProject } from "./project-zip.ts";
import { isAlive, mayStop, parentPid, readLogTail, stopTree } from "./processes.ts";
import { searchChats } from "./session-search.ts";

/** Main exports `PI_CODING_AGENT_DIR` before app ready (prsloy/agent-home.ts). */
function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(app.getPath("userData"), "agent");
}

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

/**
 * «Снять часть страницы»: a PNG of the selected part of our own window (no screen-sharing
 * prompt), saved where pasted pictures go, so the composer shows it like any attachment.
 */
async function capturePreview(
  event: IpcMainInvokeEvent,
  raw: unknown,
): Promise<PreviewCaptureResult> {
  const contents = event.sender;
  const win = BrowserWindow.fromWebContents(contents);
  if (!win) return { ok: false };
  const [width, height] = win.getContentSize();
  const rect = captureRect(raw, contents.getZoomFactor(), {
    width: width ?? 0,
    height: height ?? 0,
  });
  if (!rect) return { ok: false };
  const image = await contents.capturePage(rect);
  if (image.isEmpty()) return { ok: false };
  // Same folder as pasted pictures: the attachment preview reads only from there.
  const dir = join(app.getPath("temp"), "zeno-attachments");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `preview-${Date.now()}.png`);
  writeFileSync(path, image.toPNG());
  return { ok: true, path };
}

export function installFeatures(assertTrustedSender: (event: IpcMainInvokeEvent) => void): void {
  ipcMain.handle("prsloy:features:export-project-zip", (event, workspacePath: unknown) => {
    assertTrustedSender(event);
    return exportProjectZip(event, workspacePath);
  });
  ipcMain.handle("prsloy:features:capture-preview", (event, rect: unknown) => {
    assertTrustedSender(event);
    return capturePreview(event, rect);
  });
  ipcMain.handle("prsloy:features:proc-status", (event, pids: unknown) => {
    assertTrustedSender(event);
    if (!Array.isArray(pids)) return [];
    return pids
      .filter((pid): pid is number => Number.isInteger(pid) && pid > 0)
      .slice(0, 50)
      .map((pid) => ({ pid, alive: isAlive(pid) }));
  });
  ipcMain.handle("prsloy:features:proc-log", (event, logPath: unknown) => {
    assertTrustedSender(event);
    return readLogTail(logPath);
  });
  ipcMain.handle("prsloy:features:proc-stop", async (event, pid: unknown, logPath: unknown) => {
    assertTrustedSender(event);
    const check = mayStop(pid, logPath, {
      parentOf: parentPid,
      mainPid: process.pid,
      alive: isAlive,
    });
    if (!check.ok) return check;
    return (await stopTree(pid as number)) ? { ok: true } : { ok: false, reason: "still_running" };
  });
  ipcMain.handle("prsloy:features:search-chats", (event, query: unknown) => {
    assertTrustedSender(event);
    if (typeof query !== "string") return [];
    return searchChats({ agentDir: agentDir(), query: query.slice(0, 200) });
  });
}
