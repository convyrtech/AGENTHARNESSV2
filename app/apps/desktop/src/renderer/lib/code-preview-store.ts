/**
 * Which preview the «Код» side panel shows. A turn's «Открыть превью» sets it; the panel
 * (mounted beside the chat) reads it and closes it when the chat changes.
 */
import { useSyncExternalStore } from "react";
import type { CodePreviewTarget } from "@zeno/contracts";

export type CodePreviewState = {
  target: CodePreviewTarget;
  workspacePath: string | undefined;
  /** Bumped on every open, so reopening the same target reloads it. */
  nonce: number;
} | null;

let state: CodePreviewState = null;
let nonce = 0;
const listeners = new Set<() => void>();

function emit(next: CodePreviewState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function openCodePreview(target: CodePreviewTarget, workspacePath: string | undefined) {
  emit({ target, workspacePath, nonce: ++nonce });
}

export function closeCodePreview(): void {
  if (state) emit(null);
}

export function getCodePreview(): CodePreviewState {
  return state;
}

export function useCodePreview(): CodePreviewState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
