/**
 * One key for a session file in main and in the renderer, so the journal's paths and the chat
 * list's paths meet even when they differ in slashes, doubled separators or (on Windows) case.
 * Main resolves the path first; the renderer only has the path the chat list gave it.
 */
export function importOriginKey(path: string, foldCase: boolean): string {
  const key = path
    .replaceAll("\\", "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/$/u, "");
  return foldCase ? key.toLowerCase() : key;
}
