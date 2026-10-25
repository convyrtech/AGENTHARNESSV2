/**
 * Claude Code chats: `<projects>/<slug>/<session-id>.jsonl`, an event log whose lines form a tree
 * by `parentUuid` (edits and retries branch it). The active conversation is the parent chain of
 * the file's last conversation line. One model reply streams as several lines; replies with no
 * request between them are joined back into one turn. The project folder comes from `cwd` inside the lines,
 * never from the folder name (Cyrillic names collapse to dashes, research/25 §2).
 *
 * Portions adapted from cline/cline (Apache-2.0, © 2026 Cline Bot Inc.),
 * sdk/packages/core/src/services/session-import/claude-code.ts @ 40c5d99 (branch reconstruction,
 * joining a reply's lines, skipping `<synthetic>` models, chats with nothing to import), and from
 * openai/codex (Apache-2.0, © 2025 OpenAI), codex-rs/external-agent-migration/src/sessions/
 * records_cla.rs @ 970111f (skipping `continued-in`, title order custom → ai → first request).
 * Changed by PRSLOY: streamed instead of readFileSync, plain text with tool notes instead of
 * provider blocks, secrets hidden, subagent folders skipped.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  cleanText,
  IMAGE_PLACEHOLDER,
  stripControlWrappers,
  toolErrorNote,
  toolFile,
  toolNote,
  truncate,
} from "../clean.ts";
import { headAndTail, isRecord, type JsonRecord, readJsonLines } from "../read-lines.ts";
import {
  emptyDropped,
  type ChatCandidate,
  type ImportedChat,
  type ImportedTurn,
} from "../types.ts";
import { pickTitle } from "../title.ts";

/** The newest turns kept from a very long chat (research/25 §5). */
export const MAX_TURNS = 300;

/** Session files directly in each project folder; `<session>/subagents/*` stay out. */
export async function claudeCodeFiles(projectsDir: string): Promise<string[]> {
  let projects;
  try {
    projects = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const dir = join(projectsDir, project.name);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
    }
  }
  return files;
}

function isContinued(line: JsonRecord): boolean {
  return (
    line.type === "continued-in" &&
    typeof line.continuedInSessionId === "string" &&
    line.continuedInSessionId.trim() !== ""
  );
}

function userTextOf(line: JsonRecord): string | undefined {
  const content = isRecord(line.message) ? line.message.content : undefined;
  if (typeof content === "string") return stripControlWrappers(content) || undefined;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      const text = stripControlWrappers(block.text);
      if (text) return text;
    }
  }
  return undefined;
}

/** The cheap look: project, title and time from the head and tail of the file. */
export async function claudeCodeCandidate(file: string): Promise<ChatCandidate | undefined> {
  const info = await stat(file);
  const { head, tail } = await headAndTail(file);
  let cwd: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let firstRequest: string | undefined;
  let updatedAt: number | undefined;
  for (const line of [...head, ...tail]) {
    if (isContinued(line)) return undefined;
    if (!cwd && typeof line.cwd === "string" && line.cwd) cwd = line.cwd;
    if (line.type === "custom-title" && typeof line.customTitle === "string") {
      customTitle = line.customTitle;
    }
    if (line.type === "ai-title" && typeof line.aiTitle === "string") aiTitle = line.aiTitle;
    if (
      line.type === "user" &&
      line.isMeta !== true &&
      line.isSidechain !== true &&
      !firstRequest
    ) {
      firstRequest = userTextOf(line);
    }
    const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
    if (Number.isFinite(ts)) updatedAt = Math.max(updatedAt ?? 0, ts);
  }
  if (!cwd) return undefined;
  return {
    tool: "claude-code",
    sourceId: basename(file, ".jsonl"),
    sourcePath: file,
    cwd,
    title: pickTitle({ customTitle, aiTitle, firstRequest }),
    updatedAt: updatedAt ?? info.mtimeMs,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

type Part = { kind: "text" | "tool" | "error" | "image"; text: string; file?: string };

type Node = {
  uuid: string;
  parent?: string;
  role: "user" | "assistant";
  conversation: boolean;
  timestamp?: number;
  model?: string;
  parts: Part[];
};

function partsOf(
  content: unknown,
  role: "user" | "assistant",
  dropped: ImportedChat["dropped"],
): Part[] {
  if (typeof content === "string") {
    const text = role === "user" ? stripControlWrappers(content) : content.trim();
    return text ? [{ kind: "text", text: truncate(text, 20_000) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      const text = role === "user" ? stripControlWrappers(block.text) : block.text.trim();
      if (text) parts.push({ kind: "text", text: truncate(text, 20_000) });
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      const file = toolFile(block.input);
      parts.push({
        kind: "tool",
        text: toolNote(block.name, block.input),
        ...(file ? { file } : {}),
      });
    } else if (block.type === "tool_result") {
      dropped.toolResults += 1;
      if (block.is_error === true) {
        const output =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
                  .join("\n")
              : "";
        if (output.trim()) parts.push({ kind: "error", text: toolErrorNote(output) });
      }
    } else if (block.type === "thinking" || block.type === "redacted_thinking") {
      dropped.thinking += 1;
    } else if (block.type === "image") {
      dropped.images += 1;
      parts.push({ kind: "image", text: IMAGE_PLACEHOLDER });
    }
  }
  return parts;
}

/** The whole chat, read as a stream; undefined when there is nothing to bring over. */
export async function readClaudeCodeChat(file: string): Promise<ImportedChat | undefined> {
  const dropped = emptyDropped();
  const stats = { broken: 0, tooLong: 0 };
  const nodes = new Map<string, Node>();
  let lastConversation: string | undefined;
  let cwd: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  for await (const line of readJsonLines(file, stats)) {
    if (isContinued(line)) return undefined;
    if (!cwd && typeof line.cwd === "string" && line.cwd) cwd = line.cwd;
    if (line.type === "custom-title" && typeof line.customTitle === "string") {
      customTitle = line.customTitle;
    }
    if (line.type === "ai-title" && typeof line.aiTitle === "string") aiTitle = line.aiTitle;
    if (typeof line.uuid !== "string" || line.isSidechain === true) continue;
    const role = line.type === "assistant" ? "assistant" : "user";
    const message = isRecord(line.message) ? line.message : undefined;
    const service = line.isMeta === true || line.isCompactSummary === true;
    const conversation = (line.type === "user" || line.type === "assistant") && !!message;
    if (conversation && service) dropped.service += 1;
    const ts = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN;
    const model =
      typeof message?.model === "string" && !message.model.startsWith("<")
        ? message.model
        : undefined;
    nodes.set(line.uuid, {
      uuid: line.uuid,
      ...(typeof line.parentUuid === "string" ? { parent: line.parentUuid } : {}),
      role,
      conversation: conversation && !service,
      ...(Number.isFinite(ts) ? { timestamp: ts } : {}),
      ...(model ? { model } : {}),
      parts: conversation && !service ? partsOf(message?.content, role, dropped) : [],
    });
    if (conversation) lastConversation = line.uuid;
  }
  dropped.brokenLines = stats.broken + stats.tooLong;
  if (!cwd || !lastConversation) return undefined;

  // the active branch: from the last conversation line back to the root
  const thread: Node[] = [];
  const seen = new Set<string>();
  for (let node = nodes.get(lastConversation); node && !seen.has(node.uuid); ) {
    seen.add(node.uuid);
    thread.push(node);
    node = node.parent ? nodes.get(node.parent) : undefined;
  }
  thread.reverse();

  const turns: ImportedTurn[] = [];
  const files = new Set<string>();
  let model: string | undefined;
  let secrets = 0;
  let firstRequest: string | undefined;
  for (const node of thread) {
    if (!node.conversation || node.parts.length === 0) continue;
    if (node.model) model = node.model;
    for (const part of node.parts) if (part.file) files.add(part.file);
    const errors = node.parts.filter((p) => p.kind === "error");
    const visible = node.parts.filter((p) => p.kind !== "error");
    const previous = turns.at(-1);
    // a failed tool's note belongs to the reply that called it
    if (errors.length && previous?.role === "assistant") {
      previous.text = `${previous.text}\n${errors.map((p) => p.text).join("\n")}`;
    }
    if (visible.length === 0) continue;
    const text = visible.map((p) => p.text).join("\n");
    // one reply streams as several lines, and tool results between replies are not shown:
    // replies with no request between them are one turn
    if (node.role === "assistant" && previous?.role === "assistant") {
      previous.text = `${previous.text}\n${text}`;
      continue;
    }
    if (node.role === "user" && !firstRequest && visible.some((p) => p.kind === "text")) {
      firstRequest = visible.find((p) => p.kind === "text")!.text;
    }
    turns.push({ role: node.role, text, ...(node.timestamp ? { timestamp: node.timestamp } : {}) });
  }
  const hasUserText = turns.some((t) => t.role === "user");
  const hasReply = turns.some((t) => t.role === "assistant");
  if (!hasReply && !hasUserText) return undefined;

  const kept = turns.slice(-MAX_TURNS).map((turn) => {
    const cleaned = cleanText(turn.text);
    secrets += cleaned.secrets;
    return { ...turn, text: cleaned.text };
  });
  const title = cleanText(pickTitle({ customTitle, aiTitle, firstRequest }));
  secrets += title.secrets;
  const times = kept.map((t) => t.timestamp).filter((t): t is number => t !== undefined);
  const info = await stat(file);
  return {
    tool: "claude-code",
    sourceId: basename(file, ".jsonl"),
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
