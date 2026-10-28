/**
 * Tool-call states the timeline can *prove* from what it already has (#82).
 *
 * A hung bash call used to look like «Выполняется» forever: the card had no clock and no
 * distinction between a fast `ls` and a command stuck on an inherited pipe. The renderer
 * only knows start (`timestamp`), end (`endedAt`), args, output and the error text, so every
 * state below is derived from those — no new IPC, no guessing about the process.
 *
 * - `waiting`  — the tool itself asks the user (`ask_user` / `request_secret` / `ask`).
 * - `stalled`  — running with no end for longer than `TOOL_STALL_MS`. Called "зависло", not
 *                "ошибка": the call may still finish, and the Stop button is the way out.
 * - `timeout`  — finished with an error whose text says the timeout fired.
 * - `aborted`  — finished with an error whose text says it was aborted (user pressed Stop).
 */

export type ToolCallState =
  | "running"
  | "waiting"
  | "stalled"
  | "timeout"
  | "aborted"
  | "error"
  | "completed";

/** No end and no new output for this long → the call is shown as stalled. */
export const TOOL_STALL_MS = 30_000;

/** Tools that block on a person, not on a process. */
const ASK_TOOLS = new Set(["ask_user", "request_secret", "ask"]);

/** Error texts that mean "the harness stopped it", in Pi's words and in the harness note. */
const TIMEOUT_TEXT = /Command timed out after|остановлен по таймауту|\[таймаут/i;
const ABORT_TEXT = /Command aborted|остановлено|\[отменено\]|was aborted/i;

export interface ToolCallInput {
  toolName: string;
  status: "running" | "completed" | "error";
  /** ISO start. */
  timestamp?: string | undefined;
  /** ISO end. */
  endedAt?: string | undefined;
  output?: string | undefined;
  args?: unknown;
}

export interface ToolCallStateInfo {
  state: ToolCallState;
  /** Wall-clock milliseconds since start, or the measured span once finished. */
  elapsedMs: number | undefined;
  /** True when the state is live (the call is still open). */
  live: boolean;
  /**
   * The declared timeout from the tool args, in seconds, when there is one.
   * Lets the card say «таймаут 120 с» instead of an unexplained wait.
   */
  timeoutSec: number | undefined;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function declaredTimeout(args: unknown): number | undefined {
  if (!args || typeof args !== "object") return undefined;
  const raw = (args as { timeout?: unknown }).timeout;
  return typeof raw === "number" && raw > 0 ? raw : undefined;
}

export function toolCallState(
  item: ToolCallInput,
  now: number,
  options: { stallMs?: number } = {},
): ToolCallStateInfo {
  const stallMs = options.stallMs ?? TOOL_STALL_MS;
  const startedAt = parseTime(item.timestamp);
  const endedAt = parseTime(item.endedAt);
  const timeoutSec = declaredTimeout(item.args);
  const elapsedMs = startedAt === undefined ? undefined : Math.max(0, (endedAt ?? now) - startedAt);

  if (item.status === "running") {
    const state: ToolCallState = ASK_TOOLS.has(item.toolName)
      ? "waiting"
      : (elapsedMs ?? 0) >= stallMs
        ? "stalled"
        : "running";
    return { state, elapsedMs, live: true, timeoutSec };
  }

  const text = item.output ?? "";
  if (item.status === "error") {
    const state: ToolCallState = TIMEOUT_TEXT.test(text)
      ? "timeout"
      : ABORT_TEXT.test(text)
        ? "aborted"
        : "error";
    return { state, elapsedMs, live: false, timeoutSec };
  }
  return { state: "completed", elapsedMs, live: false, timeoutSec };
}
