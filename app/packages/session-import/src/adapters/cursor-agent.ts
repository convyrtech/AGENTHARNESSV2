/**
 * Cursor Agent / CLI chats: `~\.cursor\projects\<encoded project>\agent-transcripts\**\*.jsonl`
 * (`subagents` folders skipped). Lines are `{role, message: {content}, timestamp?}`; the person's
 * words are wrapped in `<user_query>`, sometimes after `<timestamp>` / `<cursor_commands>` context.
 * The project folder is a `cwd` field when a line has one, else only the folder name, encoded with
 * losses: path separators and the separators inside names both became `-` (`c-Users-Петр-
 * мой-сайт`). It is decoded by probing which candidate folders exist, at most 128 checks, and only
 * when exactly one fits. `empty-window` holds chats without a project and is skipped.
 *
 * Adapted from openai/codex (Apache-2.0, © 2025 OpenAI),
 * codex-rs/external-agent-migration/src/detect/sessions/cur.rs and sessions/records_cur.rs
 * @ 970111f (the folder decoding with its probe limit and separators, the `<user_query>` unwrap,
 * the record shape). Changed by PRSLOY: TypeScript, streamed, tool notes, secrets hidden.
 */
import { readdirSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join, posix, win32 } from "node:path";
import { isRecord, readJsonLines } from "../read-lines.ts";
import { toolFile, toolNote, truncate } from "../clean.ts";
import { pickTitle } from "../title.ts";
import {
  emptyDropped,
  type ChatCandidate,
  type ImportedChat,
  type ImportedTurn,
} from "../types.ts";
import type { SourceRoots } from "../paths.ts";
import { finishChat, pushTurn } from "./finish.ts";

export const MAX_PROJECT_PROBES = 128;
const SEPARATORS = ["-", "_", ".", " ", "--", "..", "__", "  ", "+", "@", "&"];
const NO_PROJECT = "empty-window";

export type CursorTranscript = { path: string; encodedProject: string };

export function cursorTranscripts(roots: Pick<SourceRoots, "cursorDir">): CursorTranscript[] {
  const projects = join(roots.cursorDir, "projects");
  const out: CursorTranscript[] = [];
  let entries: string[];
  try {
    entries = readdirSync(projects);
  } catch {
    return [];
  }
  for (const encodedProject of entries) {
    if (encodedProject === NO_PROJECT) continue;
    const pending = [join(projects, encodedProject, "agent-transcripts")];
    while (pending.length) {
      const dir = pending.pop()!;
      let items;
      try {
        items = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const item of items) {
        const full = join(dir, item.name);
        if (item.isDirectory() && item.name !== "subagents") pending.push(full);
        else if (item.isFile() && item.name.endsWith(".jsonl"))
          out.push({ path: full, encodedProject });
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The project folder an encoded name stands for, when exactly one existing folder fits. The
 * name splits on `-`; every 2–4 last parts are tried joined by each separator, and every two
 * neighbouring parts higher up merged, within MAX_PROJECT_PROBES existence checks.
 */
export function decodeCursorProject(
  encoded: string,
  options: { platform?: NodeJS.Platform; isDir?: (path: string) => boolean } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const isDir = options.isDir ?? isDirectory;
  const path = platform === "win32" ? win32 : posix;
  let rest = encoded;
  let root = "/";
  if (platform === "win32") {
    const drive = /^([A-Za-z])-(.*)$/u.exec(encoded);
    if (!drive) return undefined;
    root = `${drive[1]!.toUpperCase()}:\\`;
    rest = drive[2]!;
  }
  rest = rest.replace(/^-/u, "");
  const parts = rest.split("-");
  if (parts.some((p) => !p || p === "." || p === ".." || /[/\\:]/u.test(p))) return undefined;

  let probes = 0;
  let matched: string | undefined;
  /** false: give up (over the limit, or two different folders fit). */
  const inspect = (candidate: string): boolean => {
    if (probes >= MAX_PROJECT_PROBES) return false;
    probes += 1;
    if (!isDir(candidate)) return true;
    if (matched !== undefined && matched !== candidate) return false;
    matched = candidate;
    return true;
  };

  const full = path.join(root, ...parts);
  if (!inspect(full)) return undefined;
  for (let length = 2; length <= 4 && length <= parts.length; length += 1) {
    const head = parts.slice(0, parts.length - length);
    const tail = parts.slice(parts.length - length);
    for (const separator of SEPARATORS) {
      if (!inspect(path.join(root, ...head, tail.join(separator)))) return undefined;
    }
  }
  // two neighbouring parts higher up that were one name: c-Users-Петр-Мои-документы-сайт
  for (let right = parts.length - 2; right >= 1; right -= 1) {
    const left = right - 1;
    for (const separator of SEPARATORS) {
      const merged = path.join(
        root,
        ...parts.slice(0, left),
        `${parts[left]}${separator}${parts[right]}`,
      );
      if (probes >= MAX_PROJECT_PROBES) return undefined;
      probes += 1;
      if (!isDir(merged)) continue;
      const candidate = path.join(merged, ...parts.slice(right + 1));
      if (probes >= MAX_PROJECT_PROBES) return undefined;
      probes += 1;
      if (!isDir(candidate) || (matched !== undefined && matched !== candidate)) return undefined;
      matched = candidate;
    }
  }
  return matched;
}

const USER_QUERY =
  /^\s*((?:<(timestamp|cursor_commands)>[\s\S]*?<\/\2>\s*)*)<user_query>([\s\S]*?)<\/user_query>\s*$/u;

/** The person's words out of Cursor's wrapper; unchanged when the text is not wrapped like that. */
export function unwrapUserQuery(text: string): string {
  const match = USER_QUERY.exec(text);
  return match ? match[3]!.trim() : text;
}

function lineTime(line: Record<string, unknown>): number | undefined {
  if (typeof line.timestamp === "string") {
    const t = Date.parse(line.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return typeof line.timestamp_ms === "number" ? line.timestamp_ms : undefined;
}

type Message = {
  role: "user" | "assistant";
  text: string;
  time?: number;
  toolOnly: boolean;
  files: string[];
};

function messageOf(
  line: Record<string, unknown>,
  counts: ImportedChat["dropped"],
): Message | undefined {
  if (line.role !== "user" && line.role !== "assistant") return undefined;
  if (line.isMeta === true || line.isSidechain === true) {
    counts.service += 1;
    return undefined;
  }
  const message = isRecord(line.message) ? line.message : undefined;
  const content = message?.content;
  const texts: string[] = [];
  const files: string[] = [];
  let toolOnly = Array.isArray(content) && content.length > 0;
  if (typeof content === "string") {
    texts.push(content);
    toolOnly = false;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
        toolOnly = false;
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const file = toolFile(block.input);
        if (file) files.push(file);
        texts.push(toolNote(block.name, block.input));
        toolOnly = false;
      } else if (block.type === "tool_result") {
        counts.toolResults += 1;
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        counts.thinking += 1;
      }
    }
  }
  const time = lineTime(line);
  const role = line.role === "user" && !toolOnly ? "user" : "assistant";
  const text = texts.join("\n");
  return {
    role,
    text: role === "user" ? unwrapUserQuery(text) : text,
    ...(time !== undefined ? { time } : {}),
    toolOnly,
    files,
  };
}

export async function cursorCandidate(
  transcript: CursorTranscript,
): Promise<ChatCandidate | undefined> {
  const info = await stat(transcript.path);
  const dropped = emptyDropped();
  let cwd: string | undefined;
  let firstRequest: string | undefined;
  let updatedAt: number | undefined;
  let any = false;
  for await (const line of readJsonLines(transcript.path)) {
    if (!cwd && typeof line.cwd === "string" && line.cwd) cwd = line.cwd;
    const message = messageOf(line, dropped);
    if (!message) continue;
    any = true;
    if (message.role === "user" && !firstRequest && message.text.trim())
      firstRequest = message.text;
    if (message.time !== undefined) updatedAt = Math.max(updatedAt ?? 0, message.time);
  }
  cwd ??= decodeCursorProject(transcript.encodedProject);
  if (!any || !cwd || !firstRequest) return undefined;
  return {
    tool: "cursor-agent",
    sourceId: basename(transcript.path, ".jsonl"),
    sourcePath: transcript.path,
    cwd,
    title: pickTitle({ firstRequest: truncate(firstRequest, 2000) }),
    updatedAt: updatedAt ?? info.mtimeMs,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

export async function readCursorChat(path: string, cwd: string): Promise<ImportedChat | undefined> {
  const dropped = emptyDropped();
  const stats = { broken: 0, tooLong: 0 };
  const turns: ImportedTurn[] = [];
  const files = new Set<string>();
  for await (const line of readJsonLines(path, stats)) {
    const message = messageOf(line, dropped);
    if (!message || message.toolOnly) continue;
    for (const file of message.files) files.add(file);
    pushTurn(turns, message.role, message.text, message.time);
  }
  dropped.brokenLines = stats.broken + stats.tooLong;
  return finishChat({
    tool: "cursor-agent",
    sourceId: basename(path, ".jsonl"),
    sourcePath: path,
    cwd,
    turns,
    titles: {},
    files,
    dropped,
    fallbackTime: (await stat(path)).mtimeMs,
  });
}
