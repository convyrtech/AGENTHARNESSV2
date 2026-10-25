/**
 * Workspace path classification + default scratch folders (split out of index.ts).
 * Ephemeral (test/temp), auto-default (Documents/PRSLOY/YYYY-MM-DD) and conversation
 * homes are never treated as user projects.
 */
import { app } from "electron";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The app's own scratch / test dirs only. A user folder under any `tmp` path (e.g.
 * `D:\tmp\сайт`) is a real project and must not be refused.
 */
export function isEphemeralWorkspacePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/zeno-e2e-") ||
    normalized.includes("/zeno-fake-") ||
    normalized.includes("/zeno-test-") ||
    normalized.includes("/zeno-p0") ||
    normalized.includes("/fork-probe") ||
    normalized.includes("/recent-ws-") ||
    normalized.includes("/other-workspace") ||
    /\/t\/zeno-/.test(normalized)
  );
}

/**
 * Auto scratch from ensureDefault: …/PRSLOY/YYYY-MM-DD[ -N].
 * Not a user project — must not land in recent/last or the sidebar 项目 list.
 */
export function isAutoDefaultWorkspacePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /\/(?:Zeno|PRSLOY)\/\d{4}-\d{2}-\d{2}(-\d+)?$/i.test(normalized);
}

/** Pure-conversation home: …/PRSLOY/conversations[/…] — never a sidebar project. */
export function isConversationWorkspacePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /\/(?:Zeno|PRSLOY)\/conversations(?:\/|$)/i.test(normalized);
}

export function isNonProjectWorkspacePath(path: string): boolean {
  return (
    isEphemeralWorkspacePath(path) ||
    isAutoDefaultWorkspacePath(path) ||
    isConversationWorkspacePath(path)
  );
}

export function durableWorkspacePath(cwd: string | undefined): string | undefined {
  if (!cwd || typeof cwd !== "string") return undefined;
  if (isNonProjectWorkspacePath(cwd)) return undefined;
  try {
    if (!existsSync(cwd)) return undefined;
  } catch {
    return undefined;
  }
  return cwd;
}

/** Local calendar date as YYYY-MM-DD (no timezone suffix). */
export function localDateFolderName(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Default project root: Documents/PRSLOY/<YYYY-MM-DD>.
 * Reuses today's folder when it already exists as a directory.
 */
export function ensureDefaultWorkspacePath(): string {
  const root = join(app.getPath("documents"), "PRSLOY");
  mkdirSync(root, { recursive: true });
  const base = localDateFolderName();
  const path = join(root, base);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    return path;
  }
  try {
    if (lstatSync(path).isDirectory()) return path;
  } catch {
    // fall through to a unique suffix
  }
  let n = 2;
  while (existsSync(join(root, `${base}-${n}`))) n += 1;
  const unique = join(root, `${base}-${n}`);
  mkdirSync(unique, { recursive: true });
  return unique;
}

/**
 * Global「新建会话」home — pure conversations, never listed as a project.
 * Documents/PRSLOY/conversations
 */
export function ensureConversationWorkspacePath(): string {
  const path = join(app.getPath("documents"), "PRSLOY", "conversations");
  mkdirSync(path, { recursive: true });
  return path;
}
