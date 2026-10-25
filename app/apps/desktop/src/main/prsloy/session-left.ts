/**
 * «The user left this chat»: the foreground moved to another session file (a new chat, a
 * switch, a park). The memory extractor (research/24 §3.3) runs then, outside any turn.
 * The supervisor emits; nothing here knows about hosts.
 */
type Listener = (sessionFile: string) => void;
const listeners = new Set<Listener>();

export function onSessionLeft(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSessionLeft(sessionFile: string): void {
  for (const listener of listeners) {
    try {
      listener(sessionFile);
    } catch (error) {
      console.warn("[prsloy] session-left listener failed:", error);
    }
  }
}
