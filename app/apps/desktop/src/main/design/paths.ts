/**
 * Where design workspaces live and how their files are addressed from the renderer.
 *
 * Files are served through `prsloy-design://ws/<workspace id>/<relative path>`. The id is
 * a hash of the workspace root, so a URL never carries an absolute path, and every lookup
 * is resolved back against a workspace main registered and checked for containment.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { DesignFile } from "@zeno/contracts";
import { fileKind } from "./events.ts";

export const DESIGN_SCHEME = "prsloy-design";
export const DESIGN_PAGE = "landing";
/** Folder name inside the owner's project. */
export const DESIGN_DIR = "prsloy-design";

export const DESIGN_SCHEME_PRIVILEGES = {
  scheme: DESIGN_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
} as const;

export function workspaceFor(projectPath: string | undefined, fallbackRoot: string): string {
  return projectPath ? join(resolve(projectPath), DESIGN_DIR) : join(fallbackRoot, DESIGN_DIR);
}

export function workspaceId(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
}

/**
 * Where run.py keeps its state for `workspace` (state.json, ledger, sessions, judge
 * transcripts, our event log): under `stateRoot`, outside the agent's folder, so the agent
 * never reads it and nothing hidden lands next to the owner's project. A workspace from
 * before the move keeps `<ws>/harness` (run.py would ignore it if HARNESS_STATE_DIR is set).
 */
export function harnessStateDir(
  workspace: string,
  stateRoot: string,
): { dir: string; legacy: boolean } {
  const legacy = join(resolve(workspace), "harness");
  if (existsSync(join(legacy, "state.json"))) return { dir: legacy, legacy: true };
  return { dir: join(stateRoot, workspaceId(workspace)), legacy: false };
}

function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** `child` (absolute or relative to root) resolved inside `root`, or undefined. Follows symlinks. */
export function insideRoot(root: string, child: string): string | undefined {
  const base = real(root);
  const target = real(isAbsolute(child) ? child : join(base, normalize(child)));
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    return undefined;
  }
  return target;
}

export function fileUrl(workspace: string, relPath: string): string {
  const parts = relPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(encodeURIComponent);
  return `${DESIGN_SCHEME}://ws/${workspaceId(workspace)}/${parts.join("/")}`;
}

/** Absolute harness path → served file, when it is a regular path inside the workspace. */
export function toDesignFile(workspace: string, absPath: string): DesignFile | undefined {
  const inside = insideRoot(workspace, absPath);
  if (!inside) return undefined;
  const rel = relative(real(workspace), inside).split(sep).join("/");
  return { path: rel, url: fileUrl(workspace, rel), kind: fileKind(rel) };
}

/** Parse `prsloy-design://ws/<id>/<rel>` → { id, rel } (rel decoded, `/`-joined). */
export function parseDesignUrl(url: string): { id: string; rel: string } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== `${DESIGN_SCHEME}:` || u.hostname !== "ws") return undefined;
  const segs = u.pathname.split("/").filter(Boolean);
  const id = segs.shift();
  if (!id || !/^[0-9a-f]{16}$/.test(id) || segs.length === 0) return undefined;
  try {
    const rel = segs.map((s) => decodeURIComponent(s));
    if (rel.some((s) => s === ".." || s === "." || s.includes("/") || s.includes("\\"))) {
      return undefined;
    }
    return { id, rel: rel.join("/") };
  } catch {
    return undefined;
  }
}

export const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

export function mimeFor(path: string): string {
  return MIME[path.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";
}
