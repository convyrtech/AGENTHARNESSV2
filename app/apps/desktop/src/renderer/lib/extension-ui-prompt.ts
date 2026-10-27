/**
 * Promise bridge for extension UI dialogs (select / confirm / input / editor).
 *
 * Keeps the host event handler free of React state while App renders the dialogs.
 *
 * #83: the host may have several questions in flight at once — two parked chats, an
 * extension that asks twice, a question that arrives while another is on screen. A
 * single slot silently *cancelled* the earlier question, so its agent waited forever
 * with no window and no way out. The bridge therefore keeps a FIFO queue keyed by
 * `requestId`: the first request is on screen, the rest wait their turn, and every
 * answer is settled back to the request it belongs to.
 */
import type { HostEvent } from "@zeno/contracts";

export type ExtensionUiDialogRequest = Extract<HostEvent, { type: "extensionUi.request" }> & {
  method: "select" | "confirm" | "input" | "editor";
};

export type ExtensionUiDialogResult = {
  ok: boolean;
  value: unknown;
};

type Pending = {
  request: ExtensionUiDialogRequest;
  /** Everyone waiting for this question's answer — one per duplicate re-ask. */
  resolve: (result: ExtensionUiDialogResult) => void;
  resolveAll: Array<(result: ExtensionUiDialogResult) => void>;
};

const queue: Pending[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The request on screen now (the head of the queue), or null. */
export function getPendingExtensionUiDialog(): ExtensionUiDialogRequest | null {
  return queue[0]?.request ?? null;
}

/** Requests waiting behind the one on screen. */
export function getQueuedExtensionUiDialogs(): ExtensionUiDialogRequest[] {
  return queue.slice(1).map((item) => item.request);
}

/** How many dialog requests are in flight (0 = nothing to show). */
export function pendingExtensionUiDialogCount(): number {
  return queue.length;
}

export function subscribeExtensionUiDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isExtensionUiDialogMethod(
  method: string,
): method is ExtensionUiDialogRequest["method"] {
  return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

/** Same runtime, same method, same args: the same question asked twice. */
function isSameQuestion(a: ExtensionUiDialogRequest, b: ExtensionUiDialogRequest): boolean {
  if (a.requestId === b.requestId) return true;
  if (a.runtimeId !== b.runtimeId || a.method !== b.method) return false;
  try {
    return JSON.stringify(a.args) === JSON.stringify(b.args);
  } catch {
    return false;
  }
}

/**
 * Enqueue a dialog request and resolve with the user's answer.
 *
 * One question can arrive twice: the host re-emits on reconnect, and an extension whose
 * `session_start` runs twice asks again. Both mean the same question, so they share one
 * window and one answer — otherwise the answer closes one copy and the user is asked
 * again, which reads as «the window will not close» (#83).
 */
export function promptExtensionUiDialog(
  request: ExtensionUiDialogRequest,
): Promise<ExtensionUiDialogResult> {
  return new Promise((resolve) => {
    const existing = queue.find((item) => isSameQuestion(item.request, request));
    if (existing) {
      // Keep the newer request object (fresh requestId routes the answer), one window.
      existing.request = request;
      existing.resolveAll.push(resolve);
      notify();
      return;
    }
    queue.push({ request, resolve, resolveAll: [resolve] });
    notify();
  });
}

/** Hand one answer to everyone who asked the same question. */
function settlePending(item: Pending, result: ExtensionUiDialogResult): void {
  item.resolve(result);
  for (const extra of item.resolveAll) {
    if (extra !== item.resolve) extra(result);
  }
}

/** Answer the request on screen. */
export function settleExtensionUiDialog(result: ExtensionUiDialogResult): void {
  const current = queue.shift();
  if (!current) return;
  notify();
  settlePending(current, result);
}

/** Answer one specific request (used when an answer arrives for a queued one). */
export function settleExtensionUiDialogById(
  requestId: string,
  result: ExtensionUiDialogResult,
): boolean {
  const index = queue.findIndex((item) => item.request.requestId === requestId);
  if (index < 0) return false;
  const [current] = queue.splice(index, 1);
  notify();
  if (current) settlePending(current, result);
  return true;
}

/**
 * Settle every request with the same result: the agent was stopped, the window is
 * closing, or the host it belongs to is gone. Never leaves an agent waiting.
 */
export function cancelExtensionUiDialogs(
  result: ExtensionUiDialogResult = {
    ok: false,
    value: undefined,
  },
): number {
  if (queue.length === 0) return 0;
  const pending = queue.splice(0, queue.length);
  notify();
  for (const item of pending) settlePending(item, result);
  return pending.length;
}

/** Cancel the requests that belong to one runtime (its host was stopped/replaced). */
export function cancelExtensionUiDialogsForRuntime(
  runtimeId: string,
  result: ExtensionUiDialogResult = { ok: false, value: undefined },
): number {
  let cancelled = 0;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const item = queue[index];
    if (!item || item.request.runtimeId !== runtimeId) continue;
    queue.splice(index, 1);
    settlePending(item, result);
    cancelled += 1;
  }
  if (cancelled > 0) notify();
  return cancelled;
}

/** Parse portable select args: `{ title, options: string[] }`. */
export function parseSelectArgs(args: unknown): { title: string; options: string[] } {
  const record =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const title = typeof record.title === "string" ? record.title : "Select";
  const options = Array.isArray(record.options)
    ? record.options.filter((item): item is string => typeof item === "string")
    : [];
  return { title, options };
}

export function parseConfirmArgs(args: unknown): { title: string; message: string } {
  const record =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  return {
    title: typeof record.title === "string" ? record.title : "Confirm",
    message: typeof record.message === "string" ? record.message : "",
  };
}

export function parseInputArgs(
  args: unknown,
  method: "input" | "editor",
): { title: string; initial: string } {
  const record =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const title =
    typeof record.title === "string" ? record.title : method === "editor" ? "Editor" : "Input";
  const initial =
    method === "editor"
      ? typeof record.prefill === "string"
        ? record.prefill
        : ""
      : typeof record.placeholder === "string"
        ? record.placeholder
        : "";
  return { title, initial };
}
