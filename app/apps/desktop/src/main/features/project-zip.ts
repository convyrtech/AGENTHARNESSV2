/**
 * «Скачать архив» in «Код»: the whole project as one zip, without what is heavy, rebuilt or
 * secret — `node_modules`, Python environments, build output, git, `.env` and every other
 * dotfile. Symlinks are never followed, so nothing outside the project gets in.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zipFiles } from "../design/zip.ts";

/** Folders the archive never takes (dot folders are skipped as dotfiles). */
const SKIP_DIRS = new Set(["node_modules", "venv", "__pycache__", "dist"]);

export const PROJECT_ZIP_LIMITS = { files: 20_000, bytes: 200 * 1024 * 1024 };

export type ProjectFiles =
  | { ok: true; files: { rel: string; abs: string; size: number; mtime: Date }[] }
  | { ok: false; reason: "too_big" };

/** Files of the project, `/`-separated relative paths, sorted, within the limits. */
export function listProjectFiles(
  root: string,
  limits: { files: number; bytes: number } = PROJECT_ZIP_LIMITS,
): ProjectFiles {
  const files: { rel: string; abs: string; size: number; mtime: Date }[] = [];
  let bytes = 0;
  const walk = (dir: string, prefix: string): boolean => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return true;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (!walk(abs, rel)) return false;
      } else if (st.isFile()) {
        bytes += st.size;
        files.push({ rel, abs, size: st.size, mtime: st.mtime });
        if (files.length > limits.files || bytes > limits.bytes) return false;
      }
    }
    return true;
  };
  return walk(root, "") ? { ok: true, files } : { ok: false, reason: "too_big" };
}

/** The zip, every entry under `<prefix>/` so it unpacks into one folder. */
export function zipProject(files: { rel: string; abs: string; mtime: Date }[], prefix: string) {
  return zipFiles(
    files.map((file) => ({
      name: `${prefix}/${file.rel}`,
      data: readFileSync(file.abs),
      mtime: file.mtime,
    })),
  );
}

/** A file name Windows accepts, from the project folder's name. */
export function zipName(folder: string): string {
  const base = folder.replace(/[\\/:*?"<>|]+/gu, "-").replace(/^[.\s]+|[.\s]+$/gu, "");
  return `${base || "project"}.zip`;
}
