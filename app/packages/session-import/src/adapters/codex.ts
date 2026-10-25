/**
 * Codex chats: `<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl` (older ones `.jsonl.zst`), plus
 * `archived_sessions/`. Lines are `{timestamp, type, payload}`. The person's words come as
 * `event_msg.user_message`; user-role `response_item`s are mostly injected context and count only
 * when a file has no user_message at all. Resuming a chat writes a new file with the same id: the
 * richest one wins. Titles from `session_index.jsonl`.
 *
 * Portions adapted from cline/cline (Apache-2.0, © 2026 Cline Bot Inc.),
 * sdk/packages/core/src/services/session-import/codex.ts @ 40c5d99 (which items are the person's,
 * injected context, the richest file per id, titles from the index). Changed by PRSLOY: streamed,
 * `.zst` read, plain text with tool notes, reasoning and tool output left behind, secrets hidden.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanText,
  isInjectedContext,
  stripControlWrappers,
  toolFile,
  toolNote,
} from "../clean.ts";
import { headAndTail, isRecord, type JsonRecord, readJsonLines } from "../read-lines.ts";
import { pickTitle } from "../title.ts";
import {
  emptyDropped,
  type ChatCandidate,
  type ImportedChat,
  type ImportedTurn,
} from "../types.ts";
import { MAX_TURNS } from "./claude-code.ts";

const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/u;

export async function codexFiles(codexHome: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(full, depth + 1);
      else if (entry.isFile() && ROLLOUT.test(entry.name)) files.push(full);
    }
  };
  await walk(join(codexHome, "sessions"), 0);
  await walk(join(codexHome, "archived_sessions"), 0);
  return files;
}

/** thread_name by chat id, from Codex's own index; a missing index is fine. */
export async function codexTitles(codexHome: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    for await (const line of readJsonLines(join(codexHome, "session_index.jsonl"))) {
      if (
        typeof line.id === "string" &&
        typeof line.thread_name === "string" &&
        line.thread_name.trim()
      ) {
        titles.set(line.id, line.thread_name.trim());
      }
    }
  } catch {
    // no index
  }
  return titles;
}

function messageText(payload: JsonRecord): string {
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.trim())
    .join("\n");
}

function toolInput(payload: JsonRecord): unknown {
  if (typeof payload.arguments === "string") {
    let input: unknown;
    try {
      input = JSON.parse(payload.arguments) as unknown;
    } catch {
      return { command: payload.arguments };
    }
    // Codex's shell takes the command as an argv list
    if (isRecord(input) && Array.isArray(input.command)) {
      return { ...input, command: input.command.filter((a) => typeof a === "string").join(" ") };
    }
    return input;
  }
  if (typeof payload.input === "string") return { command: payload.input };
  return payload.input;
}

/** The cheap look: id, project and first request from the head of the file. */
export async function codexCandidate(
  file: string,
  titles: Map<string, string>,
): Promise<ChatCandidate | undefined> {
  const info = await stat(file);
  const { head } = await headAndTail(file);
  let id: string | undefined;
  let cwd: string | undefined;
  let firstRequest: string | undefined;
  for (const line of head) {
    const payload = isRecord(line.payload) ? line.payload : undefined;
    if (!payload) continue;
    if (line.type === "session_meta") {
      if (typeof payload.id === "string") id = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
    } else if (line.type === "turn_context" && !cwd && typeof payload.cwd === "string") {
      cwd = payload.cwd;
    } else if (line.type === "event_msg" && payload.type === "user_message" && !firstRequest) {
      const text = typeof payload.message === "string" ? payload.message.trim() : "";
      if (text) firstRequest = text;
    }
  }
  if (!id || !cwd) return undefined;
  return {
    tool: "codex",
    sourceId: id,
    sourcePath: file,
    cwd,
    title: pickTitle({ customTitle: titles.get(id), firstRequest }),
    updatedAt: info.mtimeMs,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

/** Of several files with one chat id, the one that will import the most. */
export function richestPerChat(candidates: ChatCandidate[]): ChatCandidate[] {
  const best = new Map<string, ChatCandidate>();
  for (const candidate of candidates) {
    const current = best.get(candidate.sourceId);
    if (
      !current ||
      candidate.size > current.size ||
      (candidate.size === current.size && candidate.mtimeMs > current.mtimeMs)
    ) {
      best.set(candidate.sourceId, candidate);
    }
  }
  return [...best.values()];
}

export async function readCodexChat(
  file: string,
  titles: Map<string, string> = new Map(),
): Promise<ImportedChat | undefined> {
  const dropped = emptyDropped();
  const stats = { broken: 0, tooLong: 0 };
  // first pass: does this file have the person's own messages?
  let id: string | undefined;
  let cwd: string | undefined;
  let hasUserMessages = false;
  for await (const line of readJsonLines(file)) {
    const payload = isRecord(line.payload) ? line.payload : undefined;
    if (!payload) continue;
    if (line.type === "session_meta" && typeof payload.id === "string") {
      id = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
    }
    if (line.type === "turn_context" && !cwd && typeof payload.cwd === "string") cwd = payload.cwd;
    if (line.type === "event_msg" && payload.type === "user_message") hasUserMessages = true;
  }
  if (!id || !cwd) return undefined;

  const turns: ImportedTurn[] = [];
  const files = new Set<string>();
  let model: string | undefined;
  let firstRequest: string | undefined;
  const pushUser = (text: string, ts: number) => {
    const clean = stripControlWrappers(text);
    if (!clean) return;
    firstRequest ??= clean;
    turns.push({ role: "user", text: clean, ...(Number.isFinite(ts) ? { timestamp: ts } : {}) });
  };
  const addAssistant = (text: string, ts: number) => {
    const last = turns.at(-1);
    if (last?.role === "assistant") last.text = `${last.text}\n${text}`;
    else turns.push({ role: "assistant", text, ...(Number.isFinite(ts) ? { timestamp: ts } : {}) });
  };
  for await (const line of readJsonLines(file, stats)) {
    const payload = isRecord(line.payload) ? line.payload : undefined;
    if (!payload) continue;
    const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
    if (line.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      continue;
    }
    if (line.type === "event_msg") {
      if (payload.type === "user_message" && typeof payload.message === "string") {
        pushUser(payload.message, ts);
      }
      continue;
    }
    if (line.type === "compacted") {
      const summary = typeof payload.message === "string" ? payload.message.trim() : "";
      if (summary) addAssistant(`(Codex сократил разговор)\n${summary}`, ts);
      continue;
    }
    if (line.type !== "response_item") continue;
    switch (payload.type) {
      case "message": {
        const text = messageText(payload);
        if (!text.trim()) break;
        if (payload.role === "assistant") addAssistant(text.trim(), ts);
        else if (payload.role === "user") {
          if (hasUserMessages || isInjectedContext(text)) dropped.service += 1;
          else pushUser(text, ts);
        }
        break;
      }
      case "reasoning":
        dropped.thinking += 1;
        break;
      case "function_call":
      case "custom_tool_call": {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        const input = toolInput(payload);
        const file = toolFile(input);
        if (file) files.add(file);
        addAssistant(toolNote(name, input), ts);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
        dropped.toolResults += 1;
        break;
      default:
        break;
    }
  }
  dropped.brokenLines = stats.broken + stats.tooLong;
  if (!turns.some((t) => t.role === "user")) return undefined;

  let secrets = 0;
  const kept = turns.slice(-MAX_TURNS).map((turn) => {
    const cleaned = cleanText(turn.text);
    secrets += cleaned.secrets;
    return { ...turn, text: cleaned.text };
  });
  const title = cleanText(pickTitle({ customTitle: titles.get(id), firstRequest }));
  secrets += title.secrets;
  const times = kept.map((t) => t.timestamp).filter((t): t is number => t !== undefined);
  const info = await stat(file);
  return {
    tool: "codex",
    sourceId: id,
    sourcePath: file,
    cwd,
    title: title.text,
    startedAt: times[0] ?? info.mtimeMs,
    updatedAt: times.at(-1) ?? info.mtimeMs,
    ...(model ? { model } : {}),
    turns: kept.filter((t) => t.text),
    files: [...files].slice(0, 50),
    dropped,
    secrets,
  };
}
