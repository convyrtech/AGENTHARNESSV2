/**
 * Gemini CLI chats: `<GEMINI_CLI_HOME or home>\.gemini\tmp\<project>\chats\session-<time>-<id>.jsonl`
 * (older ones `.json`, one ConversationRecord). The `.jsonl` is a log replayed in order:
 *
 *   {sessionId, projectHash, startTime, …}  metadata (first line)
 *   {id, type, content, …}                  a message; the same id again replaces it in place
 *   {$set: {…}}                             metadata update; `messages` in it replaces them all
 *   {$patch: {id?, content?, toolCalls?, updates?, removeIds?, orderIds?}}
 *   {$rewindTo: id}                         drop that message and everything after it
 *
 * The project folder is not in the chat: it is the `.project_root` file next to `chats`, else the
 * folder `projects.json` maps to that project id (or whose sha256 is the old folder name).
 * Message types: user / gemini / info / error / warning; only user and gemini are conversation.
 *
 * The record shapes and replay rules follow google-gemini/gemini-cli (Apache-2.0, © 2025 Google
 * LLC), packages/core/src/services/chatRecordingTypes.ts, chatRecordingService.ts and
 * config/projectRegistry.ts @ cd1b45c. Changed by PRSLOY: plain text with tool notes, read-only,
 * subagent chats skipped.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { IMAGE_PLACEHOLDER, toolErrorNote, toolFile, toolNote } from "../clean.ts";
import type { SourceRoots } from "../paths.ts";
import { headAndTail, isRecord, type JsonRecord, readJsonLines } from "../read-lines.ts";
import { pickTitle } from "../title.ts";
import {
  emptyDropped,
  type ChatCandidate,
  type ImportedChat,
  type ImportedTurn,
} from "../types.ts";
import { finishChat, pushTurn } from "./finish.ts";

const CHAT_FILE = /^session-.+\.jsonl?$/u;
/** An old whole-file `.json` larger than this is not read (the format is streamed only as .jsonl). */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

export type GeminiChatFile = { path: string; projectDir: string; cwd: string | undefined };

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Project id (folder name under tmp) → project folder, from `projects.json`. */
function registry(geminiDir: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const parsed = JSON.parse(readText(join(geminiDir, "projects.json")) ?? "{}") as unknown;
    const projects = isRecord(parsed) && isRecord(parsed.projects) ? parsed.projects : {};
    for (const [folder, id] of Object.entries(projects)) {
      if (typeof id !== "string") continue;
      map.set(id, folder);
      // folders made before the registry are named by the sha256 of the project path
      map.set(createHash("sha256").update(folder).digest("hex"), folder);
    }
  } catch {
    // no registry
  }
  return map;
}

export function geminiChatFiles(roots: Pick<SourceRoots, "geminiDir">): GeminiChatFile[] {
  const tmp = join(roots.geminiDir, "tmp");
  const projects = registry(roots.geminiDir);
  const files: GeminiChatFile[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(tmp);
  } catch {
    return [];
  }
  for (const id of dirs) {
    const projectDir = join(tmp, id);
    let names: string[];
    try {
      names = readdirSync(join(projectDir, "chats"));
    } catch {
      continue;
    }
    const marker = readText(join(projectDir, ".project_root"))?.trim();
    const cwd = marker || projects.get(id);
    for (const name of names) {
      if (CHAT_FILE.test(name))
        files.push({ path: join(projectDir, "chats", name), projectDir, cwd });
    }
  }
  return files;
}

type Conversation = { meta: JsonRecord; messages: JsonRecord[]; broken: number };

/** Replays a `.jsonl` log (or reads an old `.json`) into metadata and the current messages. */
export async function replayGeminiChat(path: string): Promise<Conversation | undefined> {
  if (path.endsWith(".json")) {
    if ((await stat(path)).size > MAX_JSON_BYTES) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isRecord(parsed)) return undefined;
      const { messages, ...meta } = parsed;
      return {
        meta,
        messages: Array.isArray(messages) ? messages.filter(isRecord) : [],
        broken: 0,
      };
    } catch {
      return undefined;
    }
  }
  const stats = { broken: 0, tooLong: 0 };
  let meta: JsonRecord = {};
  const messages = new Map<string, JsonRecord>();
  const patch = (update: unknown) => {
    if (!isRecord(update) || typeof update.id !== "string") return;
    const message = messages.get(update.id);
    if (!message) return;
    if (update.content !== undefined) message.content = update.content;
    if (Array.isArray(update.toolCalls) && Array.isArray(message.toolCalls)) {
      for (const callPatch of update.toolCalls) {
        if (!isRecord(callPatch)) continue;
        const call = message.toolCalls.find((c) => isRecord(c) && c.id === callPatch.id);
        if (isRecord(call) && "result" in callPatch) call.result = callPatch.result;
      }
    }
  };
  for await (const record of readJsonLines(path, stats)) {
    if (typeof record.$rewindTo === "string") {
      let found = false;
      // deleting while iterating a Map is safe: later keys are still visited
      for (const id of messages.keys()) {
        if (id === record.$rewindTo) found = true;
        if (found) messages.delete(id);
      }
      if (!found) messages.clear();
    } else if (isRecord(record.$patch)) {
      const p = record.$patch;
      patch(p);
      if (Array.isArray(p.updates)) p.updates.forEach(patch);
      if (Array.isArray(p.removeIds))
        for (const id of p.removeIds) if (typeof id === "string") messages.delete(id);
      if (Array.isArray(p.orderIds)) {
        const ordered = p.orderIds
          .filter((id): id is string => typeof id === "string" && messages.has(id))
          .map((id) => [id, messages.get(id)!] as const);
        const orderedIds = new Set(ordered.map(([id]) => id));
        const rest = [...messages.entries()].filter(([id]) => !orderedIds.has(id));
        messages.clear();
        for (const [id, message] of [...rest, ...ordered]) messages.set(id, message);
      }
    } else if (typeof record.id === "string") {
      messages.set(record.id, record);
    } else if (isRecord(record.$set)) {
      const { messages: replaced, ...rest } = record.$set;
      if (Array.isArray(replaced)) {
        messages.clear();
        for (const message of replaced)
          if (isRecord(message) && typeof message.id === "string")
            messages.set(message.id, message);
      }
      meta = { ...meta, ...rest };
    } else if (typeof record.sessionId === "string") {
      const { messages: initial, ...rest } = record;
      meta = { ...meta, ...rest };
      if (Array.isArray(initial)) {
        for (const message of initial)
          if (isRecord(message) && typeof message.id === "string")
            messages.set(message.id, message);
      }
    }
  }
  return { meta, messages: [...messages.values()], broken: stats.broken + stats.tooLong };
}

/** Text of a Gemini PartListUnion: a string, one part, or a list of parts. */
function partsText(content: unknown, counts?: { images: number }): string {
  const parts = Array.isArray(content) ? content : [content];
  const out: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") out.push(part);
    else if (isRecord(part)) {
      if (typeof part.text === "string" && part.thought !== true) out.push(part.text);
      else if (isRecord(part.inlineData) || isRecord(part.fileData)) {
        if (counts) counts.images += 1;
        out.push(IMAGE_PLACEHOLDER);
      }
    }
  }
  return out.join("\n").trim();
}

function ts(value: unknown): number | undefined {
  const t = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** The cheap look: session id and first request from the head, the summary from the tail. */
export async function geminiCandidate(file: GeminiChatFile): Promise<ChatCandidate | undefined> {
  if (!file.cwd) return undefined;
  const info = await stat(file.path);
  let meta: JsonRecord = {};
  let firstRequest: string | undefined;
  let summary: string | undefined;
  if (file.path.endsWith(".json")) {
    const conversation = await replayGeminiChat(file.path);
    if (!conversation) return undefined;
    meta = conversation.meta;
    firstRequest =
      partsText(conversation.messages.find((m) => m.type === "user")?.content) || undefined;
  } else {
    const { head, tail } = await headAndTail(file.path);
    for (const line of [...head, ...tail]) {
      if (typeof line.sessionId === "string" && !("id" in line)) meta = { ...meta, ...line };
      if (isRecord(line.$set) && typeof line.$set.summary === "string") summary = line.$set.summary;
      if (!firstRequest && line.type === "user")
        firstRequest = partsText(line.displayContent ?? line.content) || undefined;
    }
  }
  if (meta.kind === "subagent" || typeof meta.sessionId !== "string") return undefined;
  summary ??= typeof meta.summary === "string" ? meta.summary : undefined;
  return {
    tool: "gemini",
    sourceId: meta.sessionId,
    sourcePath: file.path,
    cwd: file.cwd,
    title: pickTitle({ aiTitle: summary, firstRequest }),
    updatedAt: ts(meta.lastUpdated) ?? info.mtimeMs,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

/** Of a `.json` and a `.jsonl` with one session id (a migrated chat), the `.jsonl` wins. */
export function newestGeminiFile(candidates: ChatCandidate[]): ChatCandidate[] {
  const best = new Map<string, ChatCandidate>();
  for (const candidate of candidates) {
    const current = best.get(candidate.sourceId);
    const rank = (c: ChatCandidate) => (c.sourcePath.endsWith(".jsonl") ? 1 : 0);
    if (
      !current ||
      rank(candidate) > rank(current) ||
      (rank(candidate) === rank(current) && candidate.size > current.size)
    ) {
      best.set(candidate.sourceId, candidate);
    }
  }
  return [...best.values()];
}

export async function readGeminiChat(path: string, cwd: string): Promise<ImportedChat | undefined> {
  const conversation = await replayGeminiChat(path);
  if (!conversation || conversation.meta.kind === "subagent") return undefined;
  const { meta, messages } = conversation;
  const dropped = emptyDropped();
  dropped.brokenLines = conversation.broken;
  const turns: ImportedTurn[] = [];
  const files = new Set<string>();
  let model: string | undefined;
  for (const message of messages) {
    const time = ts(message.timestamp);
    if (message.type === "user") {
      const text = partsText(message.displayContent ?? message.content, dropped);
      // slash commands are instructions to Gemini CLI itself, not to the model
      if (text.startsWith("/")) dropped.service += 1;
      else pushTurn(turns, "user", text, time);
    } else if (message.type === "gemini") {
      if (typeof message.model === "string") model = message.model;
      if (Array.isArray(message.thoughts)) dropped.thinking += message.thoughts.length;
      const lines = [partsText(message.content)];
      for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
        if (!isRecord(call)) continue;
        const name =
          typeof call.displayName === "string"
            ? call.displayName
            : typeof call.name === "string"
              ? call.name
              : "tool";
        const file = toolFile(call.args);
        if (file) files.add(file);
        lines.push(toolNote(name, call.args));
        if (call.result !== undefined && call.result !== null) dropped.toolResults += 1;
        if (call.status === "error") {
          const display =
            typeof call.resultDisplay === "string"
              ? call.resultDisplay
              : JSON.stringify(call.result ?? "");
          lines.push(toolErrorNote(display));
        }
      }
      pushTurn(turns, "assistant", lines.filter(Boolean).join("\n"), time);
    } else {
      dropped.service += 1;
    }
  }
  return finishChat({
    tool: "gemini",
    sourceId: typeof meta.sessionId === "string" ? meta.sessionId : basename(path),
    sourcePath: path,
    cwd,
    turns,
    titles: { aiTitle: typeof meta.summary === "string" ? meta.summary : undefined },
    model,
    files,
    dropped,
    fallbackTime: ts(meta.lastUpdated) ?? statSync(path).mtimeMs,
  });
}
