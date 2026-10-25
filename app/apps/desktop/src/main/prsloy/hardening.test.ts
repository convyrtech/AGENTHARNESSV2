import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  guardIpcMain,
  isAppNavigation,
  openPathAction,
  permissionAllowed,
  type IpcLike,
} from "./hardening.ts";

const appFileUrl = pathToFileURL(
  join("/opt/PRSLOY/resources/app.asar/dist/renderer/index.html"),
).href;

describe("navigation stays on the app's own page", () => {
  it("packaged: only the same index.html, any query/hash", () => {
    expect(isAppNavigation(appFileUrl, { appFileUrl })).toBe(true);
    expect(isAppNavigation(`${appFileUrl}?x=1#/settings`, { appFileUrl })).toBe(true);
    // The old rule accepted every file: URL.
    expect(isAppNavigation("file:///C:/Users/me/Downloads/evil.html", { appFileUrl })).toBe(false);
    expect(isAppNavigation("file:///opt/PRSLOY/resources/app.asar/dist/renderer/pet.html", {
      appFileUrl,
    })).toBe(false); // prettier-ignore
    expect(isAppNavigation("https://example.com/", { appFileUrl })).toBe(false);
    expect(isAppNavigation("javascript:alert(1)", { appFileUrl })).toBe(false);
    expect(isAppNavigation("not a url", { appFileUrl })).toBe(false);
  });

  it("dev: only the dev server origin", () => {
    const devOrigin = "http://localhost:5173";
    expect(isAppNavigation("http://localhost:5173/#/x", { appFileUrl, devOrigin })).toBe(true);
    expect(isAppNavigation("http://localhost:5174/", { appFileUrl, devOrigin })).toBe(false);
    expect(isAppNavigation(appFileUrl, { appFileUrl, devOrigin })).toBe(false);
  });
});

describe("web permissions", () => {
  it("allow only the clipboard", () => {
    expect(permissionAllowed("clipboard-sanitized-write")).toBe(true);
    expect(permissionAllowed("clipboard-read")).toBe(true);
    for (const p of ["media", "geolocation", "notifications", "openExternal", "hid", "serial"]) {
      expect(permissionAllowed(p), p).toBe(false);
    }
  });
});

describe("opening files from agent replies", () => {
  it("documents open, executables and scripts are revealed", () => {
    expect(openPathAction("C:\\p\\report.docx")).toBe("open");
    expect(openPathAction("/p/index.html")).toBe("open");
    for (const f of ["setup.exe", "run.BAT", "x.cmd", "a.ps1", "b.vbs", "c.js", "d.lnk", "e.hta",
      "f.scr", "g.msi", "h.reg", "i.sh", "j.app", "k.py", "l.jar", "m.url"]) {
      expect(openPathAction(`/p/${f}`), f).toBe("reveal");
    } // prettier-ignore
    expect(openPathAction("/p/tool", { isExecutableFile: true })).toBe("reveal");
    expect(openPathAction("/p/folder.app", { isDirectory: true })).toBe("open");
  });
});

describe("IPC guard", () => {
  function fakeIpc() {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const listeners = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc: IpcLike = {
      handle: (channel, listener) => void handlers.set(channel, listener),
      on: (channel, listener) => listeners.set(channel, listener),
    };
    return { ipc, handlers, listeners };
  }

  it("handlers registered after the guard answer only trusted senders", () => {
    const { ipc, handlers, listeners } = fakeIpc();
    const rejected: string[] = [];
    guardIpcMain(
      ipc,
      (event) => (event as { trusted: boolean }).trusted,
      (c) => rejected.push(c),
    );
    ipc.handle("zeno:x", (_event, a) => `ok:${String(a)}`);
    const seen: unknown[] = [];
    ipc.on("zeno:y", (_event, a) => void seen.push(a));

    expect(handlers.get("zeno:x")!({ trusted: true }, 1)).toBe("ok:1");
    expect(() => handlers.get("zeno:x")!({ trusted: false }, 1)).toThrow("Untrusted IPC sender");
    listeners.get("zeno:y")!({ trusted: false }, "drop");
    listeners.get("zeno:y")!({ trusted: true }, "keep");
    expect(seen).toEqual(["keep"]);
    expect(rejected).toEqual(["zeno:x", "zeno:y"]);
  });
});

describe("renderer CSP", () => {
  const renderer = resolve(import.meta.dirname, "..", "..", "renderer");
  const csp = (file: string) =>
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u.exec(
      readFileSync(join(renderer, file), "utf8"),
    )?.[1] ?? "";
  const directive = (policy: string, name: string) =>
    policy
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith(`${name} `)) ?? "";

  it("main window: no inline/eval scripts, no network from the renderer", () => {
    const policy = csp("index.html");
    expect(directive(policy, "script-src")).not.toMatch(/'unsafe-inline'|'unsafe-eval'/u);
    expect(directive(policy, "connect-src")).not.toMatch(/https?:|wss?:/u);
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
  });

  it("pet window has a CSP too", () => {
    const policy = csp("pet.html");
    expect(directive(policy, "script-src")).toBe("script-src 'self'");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
  });
});
