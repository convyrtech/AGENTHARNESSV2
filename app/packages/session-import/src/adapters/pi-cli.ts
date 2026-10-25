/**
 * Pi CLI chats: `~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`, already in our own session
 * format (v3, documented). They are copied entry by entry with secrets hidden in every string,
 * under a new session id; the project comes from the header's `cwd`.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { scrub } from "../clean.ts";
import { headAndTail, isRecord, type JsonRecord, readJsonLines } from "../read-lines.ts";
import { pickTitle } from "../title.ts";
import type { ChatCandidate } from "../types.ts";

export async function piCliFiles(sessionsDir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const full = join(sessionsDir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    else if (entry.isDirectory()) {
      try {
        for (const inner of await readdir(full, { withFileTypes: true })) {
          if (inner.isFile() && inner.name.endsWith(".jsonl")) files.push(join(full, inner.name));
        }
      } catch {
        // unreadable folder
      }
    }
  }
  return files;
}

function firstUserText(line: JsonRecord): string | undefined {
  const message = isRecord(line.message) ? line.message : undefined;
  if (line.type !== "message" || message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string")
        return block.text;
    }
  }
  return undefined;
}

export async function piCliCandidate(file: string): Promise<ChatCandidate | undefined> {
  const info = await stat(file);
  const { head, tail } = await headAndTail(file);
  const header = head[0];
  if (header?.type !== "session" || typeof header.cwd !== "string" || !header.cwd) return undefined;
  let name: string | undefined;
  let firstRequest: string | undefined;
  for (const line of [...head, ...tail]) {
    if (line.type === "session_info" && typeof line.name === "string") name = line.name;
    firstRequest ??= firstUserText(line);
  }
  if (!firstRequest && !name) return undefined;
  return {
    tool: "pi-cli",
    sourceId: typeof header.id === "string" ? header.id : basename(file, ".jsonl"),
    sourcePath: file,
    cwd: header.cwd,
    title: pickTitle({ customTitle: name, firstRequest }),
    updatedAt: info.mtimeMs,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

function scrubDeep(value: unknown, counter: { secrets: number }): unknown {
  if (typeof value === "string") {
    const result = scrub(value);
    counter.secrets += result.count;
    return result.text;
  }
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, counter));
  if (isRecord(value)) {
    const out: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubDeep(item, counter);
    return out;
  }
  return value;
}

export type PiCliCopy = {
  header: JsonRecord;
  entries: JsonRecord[];
  title: string;
  secrets: number;
  brokenLines: number;
};

/** The chat's entries with secrets hidden; undefined for a file that is not a Pi session. */
export async function readPiCliSession(file: string): Promise<PiCliCopy | undefined> {
  const stats = { broken: 0, tooLong: 0 };
  const counter = { secrets: 0 };
  let header: JsonRecord | undefined;
  const entries: JsonRecord[] = [];
  let name: string | undefined;
  let firstRequest: string | undefined;
  for await (const line of readJsonLines(file, stats)) {
    if (!header) {
      if (line.type !== "session" || typeof line.cwd !== "string") return undefined;
      header = line;
      continue;
    }
    if (typeof line.id !== "string") continue;
    const clean = scrubDeep(line, counter) as JsonRecord;
    if (clean.type === "session_info" && typeof clean.name === "string") name = clean.name;
    firstRequest ??= firstUserText(clean);
    entries.push(clean);
  }
  if (!header || entries.length === 0) return undefined;
  return {
    header,
    entries,
    title: pickTitle({ customTitle: name, firstRequest }),
    secrets: counter.secrets,
    brokenLines: stats.broken + stats.tooLong,
  };
}
