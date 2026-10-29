/**
 * The project list the composer shows: the open folder first, then the recent ones, without
 * the same folder twice under two spellings (`C:\\proj`, `C:/proj/`). Extracted from
 * Composer.tsx, which is at its line budget (#56).
 */

/** One folder in any spelling: slashes, no trailing slash, case kept as the OS has it. */
export function projectPathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Open folder first, then recents, each folder once. The original spelling is what stays. */
export function uniqueProjectPaths(
  workspacePath: string | undefined,
  recent: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of workspacePath ? [workspacePath, ...recent] : recent) {
    const key = projectPathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}
