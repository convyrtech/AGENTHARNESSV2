/**
 * Which chats were brought over from other agents (#22), for the sidebar badge and the notice in
 * the chat. Main answers from the import journal; the answer is shared by every caller and asked
 * again after an import (refreshImportOrigins). An older main without it: nothing is marked.
 */
import { useEffect, useState } from "react";
import type { ImportOrigins, ImportToolId } from "@zeno/contracts";
import { importOriginKey } from "../../shared/import-origin.ts";

let current: ImportOrigins = { origins: {}, foldCase: false };
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

export function refreshImportOrigins(): Promise<void> {
  const api = window.zeno?.sessionImport;
  if (!api?.origins) return Promise.resolve();
  loading = api
    .origins()
    .then((next) => {
      current = next;
      for (const listener of listeners) listener();
    })
    .catch(() => undefined);
  return loading;
}

export function importOriginOf(
  origins: ImportOrigins,
  path: string | undefined,
): ImportToolId | undefined {
  if (!path) return undefined;
  return origins.origins[importOriginKey(path, origins.foldCase)];
}

/** The tool a session file was brought over from, or undefined. */
export function useImportOrigins(): (path: string | undefined) => ImportToolId | undefined {
  const [origins, setOrigins] = useState(current);
  useEffect(() => {
    const update = () => setOrigins(current);
    listeners.add(update);
    if (!loading) void refreshImportOrigins();
    else update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  return (path) => importOriginOf(origins, path);
}

/** Tests only: forget the shared answer. */
export function resetImportOriginsForTest(): void {
  current = { origins: {}, foldCase: false };
  loading = undefined;
  listeners.clear();
}
