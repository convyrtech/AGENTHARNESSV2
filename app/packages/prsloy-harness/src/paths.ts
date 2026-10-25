// Пути тулов разрешаем так же, как Pi (dist/utils/paths.js resolveToCwd), иначе на Windows с Git Bash
// путь вида /c/proj/a.ts Pi правит, а мы читаем C:\c\proj\a.ts и молча пропускаем проверку.
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Git Bash / MSYS / Cygwin / WSL: /c/x, /mnt/c/x, /cygdrive/c/x → C:\x. */
export function normalizeWindowsShellPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
  if (!match) return path;
  return `${(match[1] ?? "").toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

export function resolveToolPath(
  path: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  let p = path.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (platform === "win32") p = normalizeWindowsShellPath(p);
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\")))
    return join(home, p.slice(2));
  if (p.startsWith("file://")) return fileURLToPath(p);
  if (platform === "win32") return win32.isAbsolute(p) ? win32.resolve(p) : win32.resolve(cwd, p);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}
