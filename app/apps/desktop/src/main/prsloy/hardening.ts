/**
 * Electron hardening (stage 6 audit). Pure rules here, wired up in main/index.ts and
 * hardening-electron.ts; each rule has a test in hardening.test.ts.
 *
 * - Navigation: a window may only (re)load its own page. Packaged builds used to accept
 *   any `file:` URL, so a link to a local .html would open it in the window that carries
 *   the preload — with the whole `window.zeno` IPC surface.
 * - Web permissions: deny by default; the renderer only uses the clipboard.
 * - IPC: every handler only answers the app's own windows (main frame), not just the 34
 *   that called assertTrustedSender themselves.
 * - Opening files: executables and scripts are revealed in the folder, never launched —
 *   a file link in an agent reply must not run code on click.
 */
import { extname } from "node:path";

/** Same page (ignoring query/hash) as the one the window was loaded with. */
export function isAppNavigation(
  url: string,
  options: { appFileUrl: string; devOrigin?: string | undefined },
): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (options.devOrigin) return target.origin === options.devOrigin;
  try {
    const app = new URL(options.appFileUrl);
    return target.protocol === "file:" && decodeURI(target.pathname) === decodeURI(app.pathname);
  } catch {
    return false;
  }
}

/** Web permissions the renderer actually uses (navigator.clipboard read/write). */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
]);

export function permissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}

/** Extensions the OS would execute (or hand to an interpreter) on «open». */
const EXECUTABLE_EXTENSIONS = new Set([
  // Windows
  ".exe", ".com", ".bat", ".cmd", ".msi", ".msp", ".msc", ".ps1", ".psm1", ".vbs", ".vbe",
  ".js", ".jse", ".wsf", ".wsh", ".hta", ".scr", ".pif", ".cpl", ".lnk", ".reg", ".jar",
  ".appref-ms", ".url", ".inf", ".application", ".gadget", ".settingcontent-ms",
  // macOS / Linux
  ".app", ".command", ".tool", ".sh", ".bash", ".zsh", ".csh", ".run", ".bin", ".desktop",
  ".appimage", ".pkg", ".dmg", ".deb", ".rpm",
  // interpreters
  ".py", ".pyw", ".pl", ".rb", ".php",
]); // prettier-ignore

/** "reveal" = show it in the folder instead of launching it. */
export function openPathAction(
  path: string,
  options: { isDirectory?: boolean; isExecutableFile?: boolean } = {},
): "open" | "reveal" {
  if (options.isDirectory) return "open";
  if (options.isExecutableFile) return "reveal";
  return EXECUTABLE_EXTENSIONS.has(extname(path).toLowerCase()) ? "reveal" : "open";
}

type IpcListener = (event: unknown, ...args: unknown[]) => unknown;
export type IpcLike = {
  handle(channel: string, listener: IpcListener): void;
  on(channel: string, listener: IpcListener): unknown;
};

/**
 * Wrap ipcMain.handle / ipcMain.on so every listener first checks the sender. Call once,
 * before any handler is registered. Untrusted invokes reject; untrusted sends are dropped.
 */
export function guardIpcMain(
  ipc: IpcLike,
  isTrusted: (event: unknown) => boolean,
  onReject: (channel: string) => void = () => undefined,
): void {
  const handle = ipc.handle.bind(ipc);
  const on = ipc.on.bind(ipc);
  ipc.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      if (!isTrusted(event)) {
        onReject(channel);
        throw new Error("Untrusted IPC sender");
      }
      return listener(event, ...args);
    });
  ipc.on = (channel, listener) =>
    on(channel, (event, ...args) => {
      if (!isTrusted(event)) {
        onReject(channel);
        return;
      }
      listener(event, ...args);
    });
}
