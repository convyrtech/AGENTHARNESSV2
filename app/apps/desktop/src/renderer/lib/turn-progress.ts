/**
 * The quiet progress line for long turns: what the agent is doing right now, in words, and
 * for how long. Casual users otherwise sat through 10–40 minutes with no sign of life.
 */
import type { MessageKey } from "./i18n.ts";
import { processToolView } from "./process-activity.ts";
import type { TimelineItem } from "./timeline.ts";

/** Show the line only once a turn has run this long. */
export const PROGRESS_LINE_DELAY_MS = 15_000;

/** The model has sent nothing for this long while the agent waits for it: say it is slow, not stuck. */
export const SLOW_MODEL_HINT_MS = 30_000;

/** The quiet «отвечает медленно» hint: waiting on the model (not a tool) and silent long enough. */
export function showSlowModelHint(action: ProgressAction, silentMs: number): boolean {
  return action.key === "progress.thinking" && silentMs >= SLOW_MODEL_HINT_MS;
}

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
      return summarizeCommand(view.detail);
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

const SHELL_NOISE = /^(cd|export|set|source|\.|true|:|echo)$/u;
const MAX_COMMAND_DETAIL = 40;

function basename(path: string): string {
  return (
    path
      .replace(/^["']|["']$/gu, "")
      .split(/[\\/]/u)
      .pop() ?? path
  );
}

/**
 * A shell line in plain words: the program or the intent, never the raw line. Agents chain
 * `cd /long/path && …`, pass heredocs and env assignments; a casual reader needs «Запускаю
 * тесты», not «cd /dev/shm/…/проект && npm test -- --run».
 */
export function summarizeCommand(command: string): ProgressAction {
  const firstLine = command.trim().split(/\r?\n/u)[0] ?? "";
  // A heredoc writing a file: «Пишу index.html».
  const heredoc =
    /(?:^|\s)(?:cat|tee)\s+>{1,2}?\s*(\S+)\s*<<|>{1,2}\s*(\S+)\s*<<|<<-?\s*['"]?\w+['"]?\s*>{1,2}\s*(\S+)/u.exec(
      firstLine,
    );
  const target = heredoc?.[1] ?? heredoc?.[2] ?? heredoc?.[3];
  if (target) return { key: "progress.write", vars: { detail: basename(target) } };

  const segments = firstLine
    .split(/&&|\|\||;|\|/u)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const segment of segments) {
    const words = segment.split(/\s+/u).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(w));
    const program = basename(words[0] ?? "");
    if (!program || SHELL_NOISE.test(program)) continue;
    const rest = words.slice(1).join(" ");
    if (/^(npm|pnpm|yarn|bun|npx|vp)$/u.test(program)) {
      if (/\b(test|vitest|jest)\b/u.test(rest)) return { key: "progress.runTests" };
      if (/\b(install|add|ci|i)\b/u.test(rest)) return { key: "progress.runInstall" };
      if (/\b(build|compile)\b/u.test(rest)) return { key: "progress.runBuild" };
      if (/\b(dev|start|serve|preview)\b/u.test(rest)) return { key: "progress.runServer" };
    }
    if (/^(pytest|vitest|jest|mocha)$/u.test(program)) return { key: "progress.runTests" };
    if (/^(pip|pip3|uv|poetry)$/u.test(program) && /\binstall|add|sync\b/u.test(rest)) {
      return { key: "progress.runInstall" };
    }
    if (/^python[\d.]*$|^node$/u.test(program)) {
      // The script says what it does better than the interpreter: check_page.py → проверка.
      const script = words.slice(1).find((w) => !w.startsWith("-"));
      if (script && /(check|verify|lint|test|shot|screen|audit|gate|judge)/iu.test(script)) {
        return { key: script.match(/test/iu) ? "progress.runTests" : "progress.runCheck" };
      }
      return { key: "progress.runProgram", vars: { program } };
    }
    if (/^(playwright|lighthouse)$/u.test(program)) return { key: "progress.runCheck" };
    if (/^(ls|cat|head|tail|find|grep|rg|fd|tree|wc|stat|file)$/u.test(program)) {
      return { key: "progress.runLook" };
    }
    if (/^(mkdir|cp|mv|rm|touch|chmod|ln|unzip|tar)$/u.test(program)) {
      return { key: "progress.runFiles" };
    }
    if (/^(curl|wget)$/u.test(program)) return { key: "progress.runDownload" };
    if (program === "git") return { key: "progress.runGit" };
    return program.length <= MAX_COMMAND_DETAIL
      ? { key: "progress.runProgram", vars: { program } }
      : { key: "progress.runOpen" };
  }
  return { key: "progress.runOpen" };
}
