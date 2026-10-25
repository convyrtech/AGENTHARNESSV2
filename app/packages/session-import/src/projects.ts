/**
 * The project folder of an imported chat: the `cwd` its transcript recorded, resolved to the real
 * folder on this machine. A chat whose folder is gone, or was the home folder, a disk root or the
 * temp folder itself, is not tied to a project and is skipped (research/25 §4.3).
 */
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse, resolve } from "node:path";

function same(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function real(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

export function resolveProject(
  cwd: string,
  options: { home: string; platform?: NodeJS.Platform },
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (!cwd.trim()) return undefined;
  const path = real(resolve(cwd));
  if (!path) return undefined;
  try {
    if (!statSync(path).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const refused = [options.home, tmpdir()].map((p) => real(p) ?? resolve(p));
  if (same(parse(path).root, path, platform)) return undefined;
  if (refused.some((p) => same(p, path, platform))) return undefined;
  return path;
}
