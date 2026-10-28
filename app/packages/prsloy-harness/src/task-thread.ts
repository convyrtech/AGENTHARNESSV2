// Нить задачи (#64 п.1; #61, #62): после сжатия истории модель видит пересказ, а не саму работу, и на #50 начала
// задачу заново. Харнесс в момент сжатия собирает факты задачи не из памяти модели, а из записей сессии и git:
// просьбы пользователя дословно, файлы, которые агент правил, команды с кодом выхода, состояние git и коммиты
// за время задачи. Блок замораживается на это сжатие (кэш поставщика не ломается: текст на каждом запросе тот
// же), хранится записью сессии (переживает перезапуск хоста) и на каждом запросе встаёт сразу после пересказа.
// Флаг "taskThread", по умолчанию выкл. до замера.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFlags } from "./flags.ts";
import { recordEvent } from "./learning-log.ts";
import type { ResolvedOptions } from "./options.ts";
import { gitResolver } from "./turn-changes.ts";

export const TASK_THREAD_TYPE = "prsloy-harness.task-thread";

const LIMITS = {
  firstRequestChars: 1500,
  requestChars: 800,
  lastRequests: 3,
  commands: 15,
  commandChars: 200,
  edited: 40,
  statusLines: 30,
  commits: 15,
  gitTimeoutMs: 5000,
};

export interface ThreadCommand {
  command: string;
  /** Код выхода; undefined — не узнали (вызов упал до запуска или нет строки «exited with code»). */
  exit: number | undefined;
  /** Короткий текст ошибки последнего неудачного запуска, если Pi его сохранил. */
  error?: string;
}

export interface ThreadFacts {
  /** Сообщения пользователя по порядку, дословно. */
  requests: string[];
  /** Время первого сообщения пользователя (мс), для коммитов «за время задачи». */
  startedAt: number | undefined;
  commands: ThreadCommand[];
  /** Пути из edit/write, без повторов, в порядке первой правки. */
  edited: string[];
}

export interface GitFacts {
  branch: string;
  /** `git status --short`, строки как есть. */
  status: string[];
  /** Коммиты с начала задачи: `<hash> <тема>`. */
  commits: string[];
}

type Part = { type?: unknown; text?: unknown; name?: unknown; id?: unknown; arguments?: unknown };
type Msg = {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[])
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

function shortError(text: string): string | undefined {
  const value = text
    .replace(/^\[exit \d+[^\n]*\]\s*/i, "")
    .replace(/^Command exited with code \d+\s*/im, "")
    .replace(/\s*\n\s*/g, " ⏎ ")
    .replace(/\s*⏎\s*$/, "")
    .trim();
  if (!value) return undefined;
  return value.length <= 240 ? value : `${value.slice(0, 240)}…`;
}

// Код выхода: заголовок tool-output «[exit N · …]» или строка Pi «Command exited with code N».
const EXIT_LINE = /^\[exit (\d+)\b|exited with code (\d+)/im;

/**
 * Факты задачи из записей ветки сессии (getBranch: все записи от корня, сжатие их не удаляет). Чистая функция:
 * ни git, ни Pi.
 */
export function factsFromEntries(entries: readonly unknown[]): ThreadFacts {
  const requests: string[] = [];
  let startedAt: number | undefined;
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const commands: ThreadCommand[] = [];
  const edited: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = raw as { type?: unknown; message?: Msg };
    if (entry?.type !== "message" || !entry.message) continue;
    const m = entry.message;
    if (m.role === "user") {
      const text = textOf(m.content).trim();
      if (!text) continue;
      requests.push(text);
      if (startedAt === undefined && typeof m.timestamp === "number") startedAt = m.timestamp;
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content as Part[]) {
        if (p?.type !== "toolCall" || typeof p.id !== "string" || typeof p.name !== "string")
          continue;
        const args = (p.arguments && typeof p.arguments === "object" ? p.arguments : {}) as Record<
          string,
          unknown
        >;
        calls.set(p.id, { name: p.name, args });
      }
    } else if (m.role === "toolResult" && typeof m.toolCallId === "string") {
      const call = calls.get(m.toolCallId);
      const name = typeof m.toolName === "string" ? m.toolName : call?.name;
      if (!call || !name) continue;
      if (name === "bash" && typeof call.args.command === "string") {
        const output = textOf(m.content);
        const match = EXIT_LINE.exec(output);
        const code = match ? Number(match[1] ?? match[2]) : undefined;
        const command: ThreadCommand = {
          command: call.args.command,
          exit: code ?? (m.isError === true ? undefined : 0),
        };
        if (m.isError === true) {
          const error = shortError(output);
          if (error !== undefined) command.error = error;
        }
        commands.push(command);
      } else if ((name === "edit" || name === "write") && m.isError !== true) {
        const path = call.args.path ?? call.args.file_path;
        if (typeof path === "string" && !seen.has(path)) {
          seen.add(path);
          edited.push(path);
        }
      }
    }
  }
  return { requests, startedAt, commands, edited };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s*\n\s*/g, " ⏎ ").trim(), max);
}

/** Пути и команды короче: папка задачи → «.», путь правки — относительный, `cd <папка> && ` в начале — вон. */
function shorteners(cwd: string | undefined): {
  path: (p: string) => string;
  command: (c: string) => string;
} {
  if (!cwd) return { path: (p) => p, command: (c) => c };
  const base = cwd.replace(/[\\/]+$/, "");
  const inside = (p: string) => p.startsWith(`${base}/`) || p.startsWith(`${base}\\`);
  return {
    path: (p) => (inside(p) ? p.slice(base.length + 1) : p),
    command: (c) =>
      c
        .split(base)
        .join(".")
        .replace(/^cd (?:"\."|'\.'|\.) && /, ""),
  };
}

/** Блок фактов для модели. Пусто (нет ни просьб, ни работы) — пустая строка. */
export function renderThread(facts: ThreadFacts, git: GitFacts | undefined, cwd?: string): string {
  const short = shorteners(cwd);
  const requests = facts.requests;
  const commands = facts.commands.map((c) => ({ ...c, command: short.command(c.command) }));
  const edited = facts.edited.map(short.path);
  if (requests.length === 0 && commands.length === 0 && edited.length === 0) return "";
  const lines: string[] = [
    "<task_thread>",
    "The conversation was compacted in the middle of this task. The facts below were recorded by the PRSLOY harness from the session itself and from git, not retold from memory. Where the summary above disagrees with them, trust these facts.",
    "Continue the task from where it stopped. Do not start over, do not repeat finished steps, and do not re-read files only to re-orient yourself: read a file again only when the next step needs its exact content. If the latest request is already done, check it against these facts and report.",
  ];
  if (requests.length > 0) {
    lines.push("", "User requests in this task, verbatim, oldest first:");
    const shown: Array<[number, string]> = [];
    shown.push([1, clip(requests[0]!, LIMITS.firstRequestChars)]);
    const tailFrom = Math.max(1, requests.length - LIMITS.lastRequests);
    if (tailFrom > 1) shown.push([0, `(${tailFrom - 1} more requests in between)`]);
    for (let i = tailFrom; i < requests.length; i++)
      shown.push([i + 1, clip(requests[i]!, LIMITS.requestChars)]);
    for (const [n, text] of shown) lines.push(n === 0 ? text : `[${n}] ${text}`);
  }
  if (edited.length > 0) {
    const more = edited.length - LIMITS.edited;
    lines.push(
      "",
      `Files you changed with edit/write in this task: ${edited.slice(0, LIMITS.edited).join(", ")}${more > 0 ? ` (+${more} more)` : ""}`,
    );
  }
  if (git) {
    lines.push("", `Git now (branch ${git.branch}):`);
    if (git.status.length === 0) lines.push("  working tree clean");
    else {
      lines.push("  uncommitted changes (git status --short):");
      for (const s of git.status.slice(0, LIMITS.statusLines)) lines.push(`    ${s}`);
      const more = git.status.length - LIMITS.statusLines;
      if (more > 0) lines.push(`    (+${more} more)`);
    }
    if (git.commits.length > 0) {
      lines.push("  commits made since this task started (newest first):");
      for (const c of git.commits.slice(0, LIMITS.commits)) lines.push(`    ${c}`);
    }
  }
  if (commands.length > 0) {
    const failed = commands.filter((c) => c.exit !== 0).length;
    lines.push(
      "",
      `Commands you ran: ${commands.length}, failed: ${failed}. The last ${Math.min(LIMITS.commands, commands.length)}, oldest first, exit code in brackets:`,
    );
    for (const c of commands.slice(-LIMITS.commands)) {
      const detail = c.error ? ` — ${oneLine(c.error, 180)}` : "";
      lines.push(`  [${c.exit ?? "?"}] ${oneLine(c.command, LIMITS.commandChars)}${detail}`);
    }
  }
  lines.push("</task_thread>");
  return lines.join("\n");
}

function runGit(git: string, cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      git,
      ["-c", "core.quotepath=off", ...args],
      {
        cwd,
        timeout: LIMITS.gitTimeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        // Только чтение: не берём index.lock, чтобы не мешать git агента и снимкам хода.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => resolve(error ? undefined : String(stdout)),
    );
  });
}

/** Состояние git папки задачи; undefined — не репозиторий или git недоступен. */
export async function gitFacts(
  git: string,
  cwd: string,
  since: number | undefined,
): Promise<GitFacts | undefined> {
  const inside = await runGit(git, cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return undefined;
  // Папка задачи внутри чужого репо, где она игнорируется (папка проекта в домашнем репо-настройках, стенд в
  // bench-out/): git этого репо — не факты задачи. Код 0 у check-ignore — папка игнорируется.
  if ((await runGit(git, cwd, ["check-ignore", "-q", "."])) !== undefined) return undefined;
  const [branch, status, log] = await Promise.all([
    runGit(git, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(git, cwd, ["status", "--short"]),
    since === undefined
      ? Promise.resolve("")
      : runGit(git, cwd, [
          "log",
          `--since=@${Math.floor(since / 1000)}`,
          "--oneline",
          "--no-decorate",
          `-n${LIMITS.commits}`,
        ]),
  ]);
  const lines = (s: string | undefined) => (s ?? "").split("\n").filter((l) => l.trim() !== "");
  return { branch: branch?.trim() || "?", status: lines(status), commits: lines(log) };
}

export function summaryKey(summary: string): string {
  return createHash("sha1").update(summary).digest("hex");
}

type ContextMessage = { role?: unknown; summary?: unknown; timestamp?: unknown };

/** Вставляет замороженный блок сразу после пересказа сжатия. Нет пересказа или блока — undefined. */
export function withThread(
  messages: readonly unknown[],
  blocks: ReadonlyMap<string, string>,
): unknown[] | undefined {
  const at = messages.findIndex((m) => (m as ContextMessage)?.role === "compactionSummary");
  if (at < 0) return undefined;
  const summary = (messages[at] as ContextMessage).summary;
  if (typeof summary !== "string") return undefined;
  // Local compaction already embeds the immutable facts block. Do not append a
  // second copy when the optional task-thread extension also has a stored one.
  if (summary.includes("<task_thread>")) return undefined;
  const block = blocks.get(summaryKey(summary));
  if (!block) return undefined;
  const timestamp = (messages[at] as ContextMessage).timestamp;
  const thread = {
    role: "custom",
    customType: TASK_THREAD_TYPE,
    content: block,
    display: false,
    timestamp: typeof timestamp === "number" ? timestamp : Date.now(),
  };
  return [...messages.slice(0, at + 1), thread, ...messages.slice(at + 1)];
}

export function installTaskThread(pi: ExtensionAPI, opts: ResolvedOptions): void {
  if (opts.profile !== "code") return;
  const git = gitResolver(pi, opts.gitPath);
  // ключ пересказа (sha1) → блок; восстанавливается из записей сессии
  const blocks = new Map<string, string>();

  pi.on("session_start", (_event, ctx) => {
    blocks.clear();
    for (const raw of ctx.sessionManager.getEntries()) {
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry.type !== "custom" || entry.customType !== TASK_THREAD_TYPE) continue;
      const data = entry.data as { key?: unknown; block?: unknown } | undefined;
      if (typeof data?.key === "string" && typeof data.block === "string")
        blocks.set(data.key, data.block);
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!readFlags(opts.settingsPath).taskThread) return;
    const facts = factsFromEntries(ctx.sessionManager.getBranch());
    const block = renderThread(facts, await gitFacts(git(), ctx.cwd, facts.startedAt), ctx.cwd);
    if (!block) return;
    const key = summaryKey(event.compactionEntry.summary);
    blocks.set(key, block);
    pi.appendEntry(TASK_THREAD_TYPE, { key, block });
    recordEvent(ctx, { kind: "thread.built", n: block.length });
  });

  pi.on("context", (event) => {
    if (blocks.size === 0) return undefined;
    const messages = withThread(event.messages, blocks);
    return messages ? { messages: messages as typeof event.messages } : undefined;
  });
}
