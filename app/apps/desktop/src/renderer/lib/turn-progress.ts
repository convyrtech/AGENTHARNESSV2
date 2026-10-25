/**
 * The quiet progress line for long turns: what the agent is doing right now, in words, and
 * for how long. Casual users otherwise sat through 10–40 minutes with no sign of life.
 */
import type { MessageKey } from "./i18n.ts";
import { processToolView } from "./process-activity.ts";
import type { TimelineItem } from "./timeline.ts";

/** Show the line only once a turn has run this long. */
export const PROGRESS_LINE_DELAY_MS = 15_000;

export type ProgressAction = { key: MessageKey; vars?: Record<string, string> };

const DETAIL_MAX = 60;

function short(text: string): string {
  const line = text.trim().split(/\r?\n/u)[0] ?? "";
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
}

/** Items of the current turn: everything after the last user message. */
function currentTurn(items: readonly TimelineItem[]): readonly TimelineItem[] {
  const lastUser = items.findLastIndex((item) => item.kind === "user");
  return lastUser >= 0 ? items.slice(lastUser + 1) : items;
}

/** The latest step of the running turn as a human sentence. */
export function currentTurnAction(items: readonly TimelineItem[]): ProgressAction {
  const turn = currentTurn(items);
  const last = turn[turn.length - 1];
  if (!last || last.kind === "thinking") return { key: "progress.thinking" };
  if (last.kind === "assistant") return { key: "progress.answering" };
  // A finished tool means the model is deciding what to do next.
  if (last.kind !== "tool" || last.status !== "running") return { key: "progress.thinking" };

  const view = processToolView(
    last.toolName,
    last.args,
    last.output ? { output: last.output } : {},
  );
  // An unknown tool's "detail" is its raw arguments; its name says more.
  if (view.kind === "generic") return { key: "progress.generic", vars: { tool: last.toolName } };
  const detail = view.weak ? "" : short(view.preview || view.detail);
  if (!detail) {
    return view.kind === "run"
      ? { key: "progress.runOpen" }
      : { key: "progress.generic", vars: { tool: last.toolName } };
  }
  const vars = { detail };
  switch (view.kind) {
    case "run":
      return { key: "progress.run", vars };
    case "edit":
      return { key: "progress.edit", vars };
    case "write":
      return { key: "progress.write", vars };
    case "read":
      return { key: "progress.read", vars };
    case "search":
      return { key: "progress.search", vars };
    default:
      return { key: "progress.list", vars };
  }
}

/** When the running turn started: its user message time, else the fallback. */
export function turnStartedAt(items: readonly TimelineItem[], fallbackMs: number): number {
  const lastUser = items.findLast((item) => item.kind === "user");
  const at = lastUser?.timestamp ? Date.parse(lastUser.timestamp) : Number.NaN;
  return Number.isFinite(at) && at <= fallbackMs ? at : fallbackMs;
}

/** «40 с», «2 мин», «1 ч 5 мин»: coarse on purpose, the line updates every second. */
export function elapsedLabel(ms: number): ProgressAction {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return { key: "progress.elapsed.seconds", vars: { n: String(seconds) } };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { key: "progress.elapsed.minutes", vars: { n: String(minutes) } };
  return {
    key: "progress.elapsed.hours",
    vars: { h: String(Math.floor(minutes / 60)), m: String(minutes % 60) },
  };
}
