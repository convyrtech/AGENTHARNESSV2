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

let current: string | undefined;

/**
 * Every assignment of the supervisor's foreground session file goes through here (new chat, switch,
 * start, restore, a snapshot): when it moves from one file to another, the user left the first one.
 * Going through «no file» (a new chat before its first message) does not count as leaving twice.
 */
export function trackSessionFile<T extends string | undefined>(next: T): T {
  if (next && current && next !== current) emitSessionLeft(current);
  if (next) current = next;
  return next;
}

/** Tests: forget the last foreground file. */
export function resetSessionTracking(): void {
  current = undefined;
}
