/**
 * Pure rules for the «Код» preview frame: which URLs a subframe may load and which files
 * may be served. No Electron here, so the guard is unit-tested as is.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { insideRoot } from "./design/paths.ts";

/**
 * A subframe may show only http://127.0.0.1:<port> for a port the app serves or the owner
 * opened as a preview, plus the blank documents a frame starts with. No other host (not
 * even `localhost`), no https, no credentials, no custom or file schemes.
 */
export function isAllowedFrameUrl(raw: string, ports: ReadonlySet<number>): boolean {
  if (raw === "about:blank" || raw === "about:srcdoc") return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return false;
  if (url.username || url.password) return false;
  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 && ports.has(port);
}

export function isPreviewPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** A folder that is a project, not the home folder or a drive root served whole. */
export function previewWorkspace(raw: string | undefined): string | undefined {
  if (!raw || !isAbsolute(raw)) return undefined;
  const ws = resolve(raw);
  if (ws === resolve(homedir()) || ws === parse(ws).root) return undefined;
  try {
    return statSync(ws).isDirectory() ? ws : undefined;
  } catch {
    return undefined;
  }
}

export type PreviewFile =
  | { ok: true; rel: string; abs: string }
  | { ok: false; reason: "outside_workspace" | "missing" | "not_html" };

/** The page to preview, resolved inside the workspace (symlinks included); `.html`/`.htm` only. */
export function resolvePreviewFile(workspace: string, file: string): PreviewFile {
  if (!/\.html?$/iu.test(file)) return { ok: false, reason: "not_html" };
  const abs = insideRoot(workspace, file);
  if (!abs) return { ok: false, reason: "outside_workspace" };
  if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, reason: "missing" };
  let base = resolve(workspace);
  try {
    base = realpathSync.native(workspace);
  } catch {
    // insideRoot already resolved the file; a missing root cannot get here
  }
  const rel = relative(base, abs).split(sep).join("/");
  if (rel.split("/").some((part) => part.startsWith("."))) {
    return { ok: false, reason: "outside_workspace" };
  }
  return { ok: true, rel, abs };
}

/** URL path for a workspace-relative file, each segment encoded. */
export function previewPath(rel: string): string {
  return rel.split("/").map(encodeURIComponent).join("/");
}
