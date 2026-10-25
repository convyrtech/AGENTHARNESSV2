/**
 * OpenCode chats: one SQLite database, `<data>/opencode.db` (and `opencode-<channel>.db`), data
 * folder `%XDG_DATA_HOME%\opencode` or `~\.local\share\opencode`, or `OPENCODE_DB`. Read from a
 * snapshot (sqlite-snapshot.ts). Two schemas are known (research/25 §2):
 *
 *   current: `session_v2` (directory, title, parent_id, time_*) + `session_message` (type, seq,
 *            data JSON: user text / assistant content[text, reasoning, tool] / compaction / …)
 *   older:   `session` + `message` (data JSON with role) + `part` (data JSON: text, reasoning,
 *            tool, file)
 *
 * Anything else is an unknown schema: the database is skipped with that reason, the scan goes on.
 * One database holds many chats, so a chat's version for the journal is its update time and
 * message count, not the file's hash.
 *
 * Older-schema reading adapted from cline/cline (Apache-2.0, © 2026 Cline Bot Inc.),
 * sdk/packages/core/src/services/session-import/opencode.ts @ 40c5d99 (sessions without a parent,
 * placeholder «New session» titles, user parts marked synthetic). The current schema follows
 * OpenCode's own definitions (sst/opencode, MIT, packages/core/src/session/sql.ts and
 * packages/schema/src/session-message.ts @ 450e7b9); no OpenCode code is copied.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_PLACEHOLDER, toolErrorNote, toolFile, toolNote } from "../clean.ts";
import type { SourceRoots } from "../paths.ts";
import { isRecord, type JsonRecord } from "../read-lines.ts";
import { columnsOf, openSnapshot, type Snapshot } from "../sqlite-snapshot.ts";
import { pickTitle } from "../title.ts";
import {
  emptyDropped,
  type ChatCandidate,
  type ImportedChat,
  type ImportedTurn,
  type SourceSkip,
} from "../types.ts";
import { finishChat, pushTurn } from "./finish.ts";

export type OpenCodeSchema = "v2" | "legacy";

const DB_FILE = /^opencode(-[\w.-]+)?\.db$/u;
const PLACEHOLDER_TITLE = /^New session\b/u;

const V2 = {
  session_v2: ["id", "directory", "title", "parent_id", "time_created", "time_updated"],
  session_message: ["session_id", "type", "seq", "data"],
};
const LEGACY = {
  session: ["id", "directory", "title", "parent_id", "time_created", "time_updated"],
  message: ["id", "session_id", "data", "time_created"],
  part: ["id", "message_id", "data"],
};

export function opencodeDatabases(
  roots: Pick<SourceRoots, "opencodeData" | "opencodeDb">,
): string[] {
  if (roots.opencodeDb) return existsSync(roots.opencodeDb) ? [roots.opencodeDb] : [];
  try {
    return readdirSync(roots.opencodeData)
      .filter((name) => DB_FILE.test(name))
      .map((name) => join(roots.opencodeData, name))
      .filter((path) => statSync(path).isFile());
  } catch {
    return [];
  }
}

function hasSchema(snapshot: Snapshot, shape: Record<string, string[]>): boolean {
  return Object.entries(shape).every(([table, columns]) => {
    if (!snapshot.tables.has(table)) return false;
    const have = columnsOf(snapshot.db, table);
    return columns.every((column) => have.has(column));
  });
}

export function detectOpenCodeSchema(snapshot: Snapshot): OpenCodeSchema | undefined {
  if (hasSchema(snapshot, V2)) return "v2";
  if (hasSchema(snapshot, LEGACY)) return "legacy";
  return undefined;
}

/** Snapshots kept for one scan or run (a database is copied once, not once per chat). */
const open = new Map<string, { snapshot: Snapshot; schema: OpenCodeSchema | undefined }>();

function snapshotOf(dbPath: string) {
  let entry = open.get(dbPath);
  if (!entry) {
    const snapshot = openSnapshot(dbPath);
    entry = { snapshot, schema: detectOpenCodeSchema(snapshot) };
    open.set(dbPath, entry);
  }
  return entry;
}

/** Closes and removes every snapshot; called at the end of each scan and run. */
export function releaseOpenCodeSnapshots(): void {
  for (const { snapshot } of open.values()) snapshot.dispose();
  open.clear();
}

function parse(value: unknown): JsonRecord | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function ms(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

type SessionRow = {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
  n: number;
};

function firstUserText(
  schema: OpenCodeSchema,
  snapshot: Snapshot,
  sessionId: string,
): string | undefined {
  if (schema === "v2") {
    const rows = snapshot.db
      .prepare(
        "SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT 5",
      )
      .all(sessionId) as { data: string }[];
    for (const row of rows) {
      const text = parse(row.data)?.text;
      if (typeof text === "string" && text.trim()) return text;
    }
    return undefined;
  }
  const messages = snapshot.db
    .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT 10")
    .all(sessionId) as { id: string; data: string }[];
  for (const message of messages) {
    if (parse(message.data)?.role !== "user") continue;
    for (const part of snapshot.db
      .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id LIMIT 10")
      .all(message.id) as { data: string }[]) {
      const data = parse(part.data);
      if (
        data?.type === "text" &&
        data.synthetic !== true &&
        typeof data.text === "string" &&
        data.text.trim()
      ) {
        return data.text;
      }
    }
  }
  return undefined;
}

/** The chats of one database, or why it was skipped. */
export function opencodeCandidates(dbPath: string): {
  candidates: ChatCandidate[];
  skip?: SourceSkip;
} {
  let entry;
  try {
    entry = snapshotOf(dbPath);
  } catch {
    return { candidates: [], skip: { tool: "opencode", path: dbPath, reason: "unreadable" } };
  }
  const { snapshot, schema } = entry;
  if (!schema)
    return { candidates: [], skip: { tool: "opencode", path: dbPath, reason: "unknown-schema" } };
  const sql =
    schema === "v2"
      ? `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, COUNT(m.session_id) AS n
           FROM session_v2 s JOIN session_message m ON m.session_id = s.id
          WHERE s.parent_id IS NULL GROUP BY s.id`
      : `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated, COUNT(m.id) AS n
           FROM session s JOIN message m ON m.session_id = s.id
          WHERE s.parent_id IS NULL GROUP BY s.id`;
  const candidates: ChatCandidate[] = [];
  for (const row of snapshot.db.prepare(sql).all() as SessionRow[]) {
    if (!row.directory || !row.n) continue;
    const updatedAt = ms(row.time_updated) ?? ms(row.time_created) ?? 0;
    const title =
      row.title?.trim() && !PLACEHOLDER_TITLE.test(row.title.trim()) ? row.title : undefined;
    candidates.push({
      tool: "opencode",
      sourceId: row.id,
      sourcePath: dbPath,
      cwd: row.directory,
      title: pickTitle({
        customTitle: title,
        firstRequest: title ? undefined : firstUserText(schema, snapshot, row.id),
      }),
      updatedAt,
      size: row.n,
      mtimeMs: updatedAt,
      fingerprint: `opencode:${schema}:${updatedAt}:${row.n}`,
    });
  }
  return { candidates };
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    for (const key of ["message", "data"]) {
      const value = error[key];
      if (typeof value === "string") return value;
      if (isRecord(value) && typeof value.message === "string") return value.message;
    }
    return JSON.stringify(error);
  }
  return "error";
}

/** Text of one tool use: the note, and the error when it failed. */
function toolText(
  name: string,
  state: JsonRecord,
  files: Set<string>,
  dropped: ImportedChat["dropped"],
): string {
  const input = typeof state.input === "string" ? { command: state.input } : state.input;
  const file = toolFile(input);
  if (file) files.add(file);
  const lines = [toolNote(name, input)];
  if (state.status === "completed" || state.status === "error") dropped.toolResults += 1;
  if (state.status === "error") lines.push(toolErrorNote(errorText(state.error)));
  return lines.join("\n");
}

export function readOpenCodeChat(dbPath: string, sessionId: string): ImportedChat | undefined {
  const { snapshot, schema } = snapshotOf(dbPath);
  if (!schema) return undefined;
  const table = schema === "v2" ? "session_v2" : "session";
  const session = snapshot.db
    .prepare(`SELECT id, title, directory, time_created, time_updated FROM ${table} WHERE id = ?`)
    .get(sessionId) as Omit<SessionRow, "n"> | undefined;
  if (!session?.directory) return undefined;

  const turns: ImportedTurn[] = [];
  const files = new Set<string>();
  const dropped = emptyDropped();
  let model: string | undefined;

  if (schema === "v2") {
    const rows = snapshot.db
      .prepare(
        "SELECT type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId) as { type: string; data: string; time_created: number | null }[];
    for (const row of rows) {
      const data = parse(row.data);
      if (!data) {
        dropped.brokenLines += 1;
        continue;
      }
      const ts = ms(row.time_created) ?? ms(isRecord(data.time) ? data.time.created : undefined);
      if (row.type === "user") {
        const images = Array.isArray(data.files) ? data.files.length : 0;
        dropped.images += images;
        const text = typeof data.text === "string" ? data.text : "";
        pushTurn(turns, "user", images ? `${text}\n${IMAGE_PLACEHOLDER}` : text, ts);
      } else if (row.type === "assistant") {
        if (isRecord(data.model) && typeof data.model.id === "string") model = data.model.id;
        const parts: string[] = [];
        for (const block of Array.isArray(data.content) ? data.content : []) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
          else if (block.type === "reasoning") dropped.thinking += 1;
          else if (block.type === "tool" && isRecord(block.state)) {
            parts.push(
              toolText(
                typeof block.name === "string" ? block.name : "tool",
                block.state,
                files,
                dropped,
              ),
            );
          }
        }
        pushTurn(turns, "assistant", parts.join("\n"), ts);
      } else if (row.type === "compaction") {
        const summary = typeof data.summary === "string" ? data.summary.trim() : "";
        if (summary) pushTurn(turns, "assistant", `(OpenCode сократил разговор)\n${summary}`, ts);
      } else {
        // synthetic, system, skill, shell, agent/model/location switches
        dropped.service += 1;
      }
    }
  } else {
    const messages = snapshot.db
      .prepare(
        "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id",
      )
      .all(sessionId) as { id: string; data: string; time_created: number | null }[];
    const partsOf = snapshot.db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id");
    for (const message of messages) {
      const data = parse(message.data);
      if (!data) {
        dropped.brokenLines += 1;
        continue;
      }
      const ts =
        ms(message.time_created) ?? ms(isRecord(data.time) ? data.time.created : undefined);
      const parts = (partsOf.all(message.id) as { data: string }[])
        .map((row) => parse(row.data))
        .filter((part): part is JsonRecord => part !== undefined);
      const texts: string[] = [];
      if (data.role === "user") {
        for (const part of parts) {
          if (part.synthetic === true) {
            dropped.service += 1;
          } else if (part.type === "text" && typeof part.text === "string") {
            texts.push(part.text);
          } else if (
            part.type === "file" &&
            typeof part.mime === "string" &&
            part.mime.startsWith("image/")
          ) {
            dropped.images += 1;
            texts.push(IMAGE_PLACEHOLDER);
          }
        }
        pushTurn(turns, "user", texts.join("\n"), ts);
        continue;
      }
      if (typeof data.modelID === "string") model = data.modelID;
      for (const part of parts) {
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
        else if (part.type === "reasoning") dropped.thinking += 1;
        else if (part.type === "tool" && isRecord(part.state)) {
          texts.push(
            toolText(
              typeof part.tool === "string" ? part.tool : "tool",
              part.state,
              files,
              dropped,
            ),
          );
        }
      }
      pushTurn(turns, "assistant", texts.join("\n"), ts);
    }
  }

  const title =
    session.title?.trim() && !PLACEHOLDER_TITLE.test(session.title.trim())
      ? session.title
      : undefined;
  return finishChat({
    tool: "opencode",
    sourceId: sessionId,
    sourcePath: dbPath,
    cwd: session.directory,
    turns,
    titles: { customTitle: title },
    model,
    files,
    dropped,
    fallbackTime: ms(session.time_updated) ?? ms(session.time_created) ?? Date.now(),
  });
}
