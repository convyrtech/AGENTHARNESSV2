import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export type DelegatedFiles = Record<string, string | null>;

/** Small text-only scope. No symlinks, junctions, hardlinks, binary or special files. */
export async function readDelegatedFiles(
  cwd: string,
  paths: readonly string[],
): Promise<DelegatedFiles> {
  const root = await realpath(cwd);
  const files: DelegatedFiles = {};
  let bytes = 0;
  for (const file of paths) {
    const parts = file.split("/");
    if (
      !parts.length ||
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[\\:]/.test(p) ||
          p.split("").some((c) => c.charCodeAt(0) < 32),
      ) ||
      resolve(root, file) === root
    )
      throw new Error("Invalid delegated file path");
    let path = root;
    let missing = false;
    for (let i = 0; i < parts.length; i++) {
      path = join(path, parts[i]!);
      try {
        const stat = await lstat(path);
        if (
          stat.isSymbolicLink() ||
          (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1)
        )
          throw new Error("Delegation requires plain project files");
        if (i === parts.length - 1 && stat.size > 200_000)
          throw new Error("Delegated file too large");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing = true;
        break;
      }
    }
    if (missing) {
      files[file] = null;
      continue;
    }
    const buffer = await readFile(path);
    bytes += buffer.length;
    if (bytes > 200_000 || buffer.includes(0))
      throw new Error("Delegated scope exceeds text limit");
    const text = buffer.toString("utf8");
    if (!Buffer.from(text).equals(buffer)) throw new Error("Delegation requires UTF-8 text");
    files[file] = text;
  }
  return files;
}

export function delegatedDigest(files: DelegatedFiles): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
}

/** Full hunks deliberately include all changed-file context, including untracked files. */
export function delegatedDiff(before: DelegatedFiles, after: DelegatedFiles): string {
  return Object.keys(before)
    .sort()
    .filter((file) => before[file] !== after[file])
    .map((file) => {
      const old = before[file];
      const current = after[file];
      const lines = (text: string | null | undefined) => (text == null ? [] : text.split("\n"));
      const a = lines(old),
        b = lines(current);
      return [
        `diff --git a/${file} b/${file}`,
        old == null ? "new file mode 100644" : "",
        `--- ${old == null ? "/dev/null" : `a/${file}`}`,
        `+++ ${current == null ? "/dev/null" : `b/${file}`}`,
        `@@ -${a.length ? 1 : 0},${a.length} +${b.length ? 1 : 0},${b.length} @@`,
        ...a.map((line) => `-${line}`),
        ...b.map((line) => `+${line}`),
      ].join("\n");
    })
    .join("\n");
}
