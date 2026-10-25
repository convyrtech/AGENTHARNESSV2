/**
 * Coalesce streamed text deltas into one store update per frame.
 *
 * A Kimi-style turn sends thousands of `message.delta` / `thinking.delta` events, each its
 * own IPC task. Applied one by one, every event forced a synchronous React render through
 * the zustand store, and with per-frame or timer updates always pending, no commit ever
 * finished clean. React counted them as nested updates and threw #185 («Maximum update
 * depth exceeded»). Deltas now wait in a queue for at most one frame. Any other event flushes
 * the queue first and then runs at once, so ordering and control flow are unchanged.
 */
import type { HostEvent } from "@zeno/contracts";

export const DELTA_FLUSH_MS = 16;

export function isStreamDelta(event: HostEvent): boolean {
  return (
    event.type === "runtime.event" &&
    (event.event.type === "message.delta" || event.event.type === "thinking.delta")
  );
}

export type HostEventBatcher = {
  push(event: HostEvent): void;
  /** Apply queued deltas now. */
  flush(): void;
  /** Drop the queue and the pending timer (unmount). */
  dispose(): void;
};

export function createHostEventBatcher(
  handle: (events: readonly HostEvent[]) => void,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): HostEventBatcher {
  let queue: HostEvent[] = [];
  let timer: unknown;

  function flush(): void {
    if (timer !== undefined) {
      timers.clear(timer);
      timer = undefined;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    handle(batch);
  }

  return {
    push(event) {
      if (isStreamDelta(event)) {
        queue.push(event);
        if (timer === undefined) timer = timers.set(flush, DELTA_FLUSH_MS);
        return;
      }
      flush();
      handle([event]);
    },
    flush,
    dispose() {
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      queue = [];
    },
  };
}
