/**
 * Turning an imported chat into an ordinary Pi session file (format v3, research/25 §4.3), so
 * the chat list, search and «Продолжить» work with no special cases:
 *
 *   header (cwd = the project folder from the transcript)
 *   message × N — the whole history as plain text, original times
 *   custom `prsloy.import` — where it came from (not sent to the model)
 *   compaction — a summary written by code + the last few turns kept as they are
 *   model_change — to PRSLOY's model, so «Продолжить» does not ask for the other agent's
 *   session_info — the title
 *
 * The model sees only the summary and the tail; the person sees everything. A Pi CLI chat is
 * already in this format: it is copied under a new id, with the import record and model_change
 * appended. In both, everything before the `prsloy.import` record is the other agent's
 * history — never the person's words here (core's memory relies on it, #13). Files are written
 * next to the target and renamed into place.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, type JsonRecord } from "./read-lines.ts";
import { buildSummary } from "./summary.ts";
import type { DroppedCounts, ImportedChat, ImportTool } from "./types.ts";

export const IMPORT_CUSTOM_TYPE = "prsloy.import";
/** The API name on imported replies: no real provider, never re-sent as provider blocks. */
export const IMPORTED_API = "imported";
export const TAIL_TURNS = 6;
export const TAIL_CHARS = 32_000;

export type TargetModel = { provider: string; modelId: string };

export type ImportRecord = {
  tool: ImportTool;
  sourceId: string;
  sha256: string;
  sourceModel?: string;
  importedAt: string;
  dropped?: DroppedCounts;
  secrets: number;
};

export type PiSessionFile = { id: string; header: JsonRecord; entries: JsonRecord[] };

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entryIds() {
  const used = new Set<string>();
  return () => {
    let id: string;
    do id = randomBytes(4).toString("hex");
    while (used.has(id));
    used.add(id);
    return id;
  };
}

/**
 * Tool notes («• Bash: npm test») as their own paragraphs: the chat shows replies as markdown,
 * where single line breaks merge lines into one.
 */
export function noteParagraphs(text: string): string {
  const lines = text.split("\n");
  let out = lines[0] ?? "";
  for (let i = 1; i < lines.length; i += 1) {
    const aroundNote = lines[i - 1]!.startsWith("• ") || lines[i]!.startsWith("• ");
    out += (aroundNote ? "\n\n" : "\n") + lines[i];
  }
  return out;
}

/** Index of the first kept turn: the last ≤6 within 32 000 characters, starting at a request. */
export function tailStart(turns: ImportedChat["turns"]): number {
  let start = turns.length;
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && turns.length - i <= TAIL_TURNS; i -= 1) {
    chars += turns[i]!.text.length;
    if (chars > TAIL_CHARS) break;
    start = i;
  }
  // the kept part opens with the person's words when the window has any
  while (start < turns.length && turns[start]!.role !== "user") start += 1;
  return start;
}

function roughTokens(turns: ImportedChat["turns"]): number {
  return Math.ceil(turns.reduce((sum, turn) => sum + turn.text.length, 0) / 4);
}

export function buildPiSession(
  chat: ImportedChat,
  options: { target: TargetModel; sha256: string; now?: Date; id?: string },
): PiSessionFile {
  const now = options.now ?? new Date();
  const nextId = entryIds();
  const sessionId = options.id ?? randomUUID();
  const stamp = (ms?: number) => new Date(ms ?? now.getTime()).toISOString();
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: stamp(chat.startedAt),
    cwd: chat.cwd,
  };
  const entries: JsonRecord[] = [];
  let parentId: string | null = null;
  const push = (entry: JsonRecord, timestamp: string) => {
    const id = nextId();
    entries.push({ ...entry, id, parentId, timestamp });
    parentId = id;
    return id;
  };

  const record: ImportRecord = {
    tool: chat.tool,
    sourceId: chat.sourceId,
    sha256: options.sha256,
    ...(chat.model ? { sourceModel: chat.model } : {}),
    importedAt: now.toISOString(),
    dropped: chat.dropped,
    secrets: chat.secrets,
  };
  const keepFrom = tailStart(chat.turns);
  let firstKept: string | undefined;
  let lastTime = chat.startedAt;
  chat.turns.forEach((turn, index) => {
    const time = Math.max(turn.timestamp ?? lastTime, lastTime);
    lastTime = time;
    const message =
      turn.role === "user"
        ? { role: "user", content: turn.text, timestamp: time }
        : {
            role: "assistant",
            content: [{ type: "text", text: noteParagraphs(turn.text) }],
            api: IMPORTED_API,
            provider: IMPORTED_API,
            model: chat.model ?? chat.tool,
            usage: ZERO_USAGE,
            stopReason: "stop",
            timestamp: time,
          };
    const id = push({ type: "message", message }, stamp(time));
    if (index === keepFrom) firstKept = id;
  });
  // after the history: what follows is written here
  push({ type: "custom", customType: IMPORT_CUSTOM_TYPE, data: record }, stamp(lastTime));

  const after = stamp(Math.max(now.getTime(), lastTime));
  const compactionId = nextId();
  entries.push({
    type: "compaction",
    id: compactionId,
    parentId,
    timestamp: after,
    summary: buildSummary(chat),
    // nothing fits the tail → only the summary goes to the model
    firstKeptEntryId: firstKept ?? compactionId,
    tokensBefore: roughTokens(chat.turns),
    fromHook: true,
  });
  parentId = compactionId;
  push(
    { type: "model_change", provider: options.target.provider, modelId: options.target.modelId },
    after,
  );
  push({ type: "session_info", name: chat.title }, after);
  return { id: sessionId, header, entries };
}

/**
 * A Pi CLI chat copied under a new id: its own entries unchanged (secrets already hidden), then
 * the import record and the switch to PRSLOY's model on the active leaf.
 */
export function copyPiCliSession(
  copy: { header: JsonRecord; entries: JsonRecord[] },
  options: { target: TargetModel; record: ImportRecord; now?: Date; id?: string },
): PiSessionFile {
  const now = (options.now ?? new Date()).toISOString();
  const sessionId = options.id ?? randomUUID();
  const used = new Set(copy.entries.map((e) => e.id as string));
  const nextId = () => {
    let id: string;
    do id = randomBytes(4).toString("hex");
    while (used.has(id));
    used.add(id);
    return id;
  };
  const header: JsonRecord = { ...copy.header, id: sessionId, version: 3 };
  delete header.parentSession;
  const entries = [...copy.entries];
  // the leaf is the last entry, as Pi reads it
  let parentId = (entries.at(-1)?.id as string | undefined) ?? null;
  for (const entry of [
    { type: "custom", customType: IMPORT_CUSTOM_TYPE, data: options.record },
    { type: "model_change", provider: options.target.provider, modelId: options.target.modelId },
  ]) {
    const id = nextId();
    entries.push({ ...entry, id, parentId, timestamp: now });
    parentId = id;
  }
  return { id: sessionId, header, entries };
}

export function sessionFileName(id: string, created: Date): string {
  return `${created.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`;
}

function serialize(file: PiSessionFile): string {
  return [file.header, ...file.entries].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

async function renameRetrying(from: string, to: string): Promise<void> {
  // Windows: an antivirus or indexer can hold a fresh file for a moment
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = isRecord(error) ? error.code : undefined;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Writes the session into `sessionDir` under a fresh name and returns its path. */
export async function writePiSession(
  sessionDir: string,
  file: PiSessionFile,
  created = new Date(),
): Promise<string> {
  await mkdir(sessionDir, { recursive: true });
  const target = join(sessionDir, sessionFileName(file.id, created));
  const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, serialize(file), { encoding: "utf8", flag: "wx" });
    await renameRetrying(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return target;
}
