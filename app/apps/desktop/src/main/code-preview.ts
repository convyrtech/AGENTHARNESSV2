/**
 * «Код» tab preview. A page the agent wrote is served by a loopback static server over the
 * workspace (dotfiles hidden); a server the agent started is shown at http://127.0.0.1:<port>.
 * Every subframe of every window is held to those origins (`isAllowedFrameUrl`), so a
 * previewed page cannot navigate its frame anywhere else. The frame itself has no preload
 * and no IPC: `assertTrustedSender` accepts only the main frame.
 */
import { connect } from "node:net";
import type { CodePreviewResult, CodePreviewTarget } from "@zeno/contracts";
import {
  app,
  ipcMain,
  shell,
  webContents as allWebContents,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import {
  isAllowedFrameUrl,
  isPreviewPort,
  previewPath,
  previewWorkspace,
  resolvePreviewFile,
} from "./code-preview-guard.ts";
import {
  previewServerPorts,
  startPreviewServer,
  type PreviewServer,
} from "./design/preview-server.ts";

const servers = new Map<string, Promise<PreviewServer>>();
/** Ports of agent-started servers the owner opened; the frame may show only these and ours. */
const openedPorts = new Set<number>();

function allowedPorts(): Set<number> {
  return new Set([...previewServerPorts, ...openedPorts]);
}

function portIsUp(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (up: boolean) => {
      socket.destroy();
      done(up);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function asTarget(raw: unknown): CodePreviewTarget | undefined {
  const value = raw as { kind?: unknown; path?: unknown; port?: unknown } | null;
  if (value?.kind === "server" && isPreviewPort(value.port)) {
    return { kind: "server", port: value.port };
  }
  if (value?.kind === "file" && typeof value.path === "string" && value.path) {
    return { kind: "file", path: value.path };
  }
  return undefined;
}

async function open(raw: unknown, workspacePath: unknown): Promise<CodePreviewResult> {
  const target = asTarget(raw);
  if (!target) return { ok: false, reason: "bad_port" };
  if (target.kind === "server") {
    if (!(await portIsUp(target.port))) return { ok: false, reason: "down" };
    openedPorts.add(target.port);
    return { ok: true, url: `http://127.0.0.1:${target.port}/` };
  }
  const ws = previewWorkspace(typeof workspacePath === "string" ? workspacePath : undefined);
  if (!ws) return { ok: false, reason: "outside_workspace" };
  const file = resolvePreviewFile(ws, target.path);
  if (!file.ok) return file;
  let server = servers.get(ws);
  if (!server) {
    server = startPreviewServer(ws, { hideDotfiles: true });
    servers.set(ws, server);
    server.catch(() => servers.delete(ws));
  }
  return { ok: true, url: (await server).url + previewPath(file.rel) };
}

async function openExternal(raw: unknown, workspacePath: unknown): Promise<boolean> {
  const target = asTarget(raw);
  if (target?.kind === "server") {
    await shell.openExternal(`http://127.0.0.1:${target.port}/`);
    return true;
  }
  const ws = previewWorkspace(typeof workspacePath === "string" ? workspacePath : undefined);
  const file = target && ws ? resolvePreviewFile(ws, target.path) : undefined;
  if (!file?.ok) return false;
  return (await shell.openPath(file.abs)) === "";
}

function guardFrames(contents: WebContents): void {
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isAllowedFrameUrl(event.url, allowedPorts())) event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame && !isAllowedFrameUrl(event.url, allowedPorts())) event.preventDefault();
  });
}

/** Call once at app ready, before or after windows exist. */
export function installCodePreview(assertTrustedSender: (event: IpcMainInvokeEvent) => void): void {
  for (const contents of allWebContents.getAllWebContents()) guardFrames(contents);
  app.on("web-contents-created", (_event, contents) => guardFrames(contents));
  ipcMain.handle("prsloy:code-preview:open", (event, target: unknown, workspacePath: unknown) => {
    assertTrustedSender(event);
    return open(target, workspacePath);
  });
  ipcMain.handle(
    "prsloy:code-preview:open-external",
    (event, target: unknown, workspacePath: unknown) => {
      assertTrustedSender(event);
      return openExternal(target, workspacePath);
    },
  );
  app.on("will-quit", () => {
    for (const server of servers.values()) void server.then((s) => s.close()).catch(() => {});
    servers.clear();
  });
}
