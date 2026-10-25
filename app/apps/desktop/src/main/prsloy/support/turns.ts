/**
 * The last turns of the newest conversation, as metadata only: when, how long, which model,
 * which tools with exit codes and durations, how the model's answer ended. No prompt, reply,
 * tool argument or tool output text goes into the report.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { classifyModelError } from "@zeno/agent-runtime/model-error";

export type TurnSummary = {
  startedAt?: string;
  durationMs?: number;
  models: string[];
  tools: { name: string; exitCode?: number; isError: boolean; durationMs?: number }[];
  /** How each model response ended (stop, toolUse, error, aborted, …). */
  stopReasons: string[];
  /** Stable codes of failed responses (network, auth, model_unavailable, …). */
  errorCodes: string[];
  outputTokens: number;
};

type Message = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: { output?: number };
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

/** Newest `*.jsonl` under the sessions dir (one level of subfolders, as pi stores them). */
export function newestSessionFile(sessionsDir: string): string | undefined {
  let best: { path: string; mtime: number } | undefined;
  const visit = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.isDirectory() && depth > 0) visit(path, depth - 1);
      else if (name.endsWith(".jsonl") && (!best || stat.mtimeMs > best.mtime)) {
        best = { path, mtime: stat.mtimeMs };
      }
    }
  };
  visit(sessionsDir, 2);
  return best?.path;
}

function exitCodeOf(content: unknown): number | undefined {
  const first = Array.isArray(content)
    ? (content as { type?: string; text?: string }[]).find((c) => c.type === "text")?.text
    : typeof content === "string"
      ? content
      : undefined;
  // Harness header on bash results: `[exit 0 · 0,3 с · 349 Б]`.
  const match = /^\s*\[exit (-?\d+)/u.exec(first ?? "");
  return match ? Number(match[1]) : undefined;
}

export function summarizeTurns(jsonl: string, count = 3): TurnSummary[] {
  const messages: Message[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: Message };
      if (entry.type === "message" && entry.message) messages.push(entry.message);
    } catch {
      // a torn last line
    }
  }
  const turns: TurnSummary[] = [];
  let current: (TurnSummary & { last?: number; calls: Map<string, number> }) | undefined;
  const finish = () => {
    if (!current) return;
    const { last, calls: _calls, ...turn } = current;
    if (turn.startedAt && last) turn.durationMs = last - Date.parse(turn.startedAt);
    turns.push(turn);
  };
  for (const m of messages) {
    if (m.role === "user") {
      finish();
      current = {
        ...(m.timestamp ? { startedAt: new Date(m.timestamp).toISOString() } : {}),
        models: [],
        tools: [],
        stopReasons: [],
        errorCodes: [],
        outputTokens: 0,
        calls: new Map(),
        ...(m.timestamp ? { last: m.timestamp } : {}),
      };
      continue;
    }
    if (!current) continue;
    if (m.timestamp) current.last = m.timestamp;
    if (m.role === "assistant") {
      if (m.model && !current.models.includes(m.model)) current.models.push(m.model);
      if (m.stopReason) current.stopReasons.push(m.stopReason);
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        current.errorCodes.push(classifyModelError(m.errorMessage, m.stopReason));
      }
      current.outputTokens += m.usage?.output ?? 0;
      if (Array.isArray(m.content)) {
        for (const block of m.content as { type?: string; id?: string }[]) {
          if (block.type === "toolCall" && block.id && m.timestamp) {
            current.calls.set(block.id, m.timestamp);
          }
        }
      }
    } else if (m.role === "toolResult") {
      const startedAt = m.toolCallId ? current.calls.get(m.toolCallId) : undefined;
      const exitCode = exitCodeOf(m.content);
      current.tools.push({
        name: m.toolName ?? "?",
        isError: Boolean(m.isError),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(startedAt && m.timestamp ? { durationMs: m.timestamp - startedAt } : {}),
      });
    }
  }
  finish();
  return turns.slice(-count);
}

export function lastTurns(sessionsDir: string, count = 3): TurnSummary[] {
  const file = newestSessionFile(sessionsDir);
  if (!file) return [];
  try {
    return summarizeTurns(readFileSync(file, "utf8"), count);
  } catch {
    return [];
  }
}
