/**
 * Cline, Roo Code and Kilo Code chats (one lineage, the same per-task files):
 *
 *   <editor data>\<Code|Code - Insiders|Cursor|VSCodium|Codium|Windsurf>\User\globalStorage\<extension>\
 *     tasks\<id>\api_conversation_history.json   Anthropic-style messages
 *   ~\.cline\data\tasks\…                         newer Cline (VS Code, CLI and JetBrains share it)
 *
 * The task index names each task's project folder (`cwdOnTaskInitialization`, `workspace` in the
 * Roo / Kilo line): `state/taskHistory.json` (Cline), `tasks/_index.json` (Roo), `~/.cline/data/
 * tasks/taskHistory.json`, else VS Code's own `state.vscdb` (ItemTable row keyed by the extension
 * id, read from a snapshot). A task the index gives no folder for is not offered.
 *
 * The person's words sit in `<task>`, `<feedback>`, `<user_message>` or `<answer>`; the agent's
 * environment (`<environment_details>`) and thinking are dropped. Older versions write tool calls
 * as XML in the reply text (`<write_to_file><path>…`); they become one-line notes like the
 * structured `tool_use` blocks of newer ones.
 *
 * Locations and index files follow jhlee0409/claude-code-history-viewer (MIT),
 * src-tauri/src/providers/cline.rs (no code copied) and cline/cline (Apache-2.0)
 * apps/vscode/src/core/storage and src/shared/HistoryItem.ts @ 40c5d99.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { IMAGE_PLACEHOLDER, toolFile, toolNote } from "../clean.ts";
import type { SourceRoots } from "../paths.ts";
import { isRecord, type JsonRecord } from "../read-lines.ts";
import { openSnapshot } from "../sqlite-snapshot.ts";
import { pickTitle } from "../title.ts";
import {
  emptyDropped,
  type ChatCandidate,
  type ImportedChat,
  type ImportedTurn,
  type ImportTool,
} from "../types.ts";
import { finishChat, pushTurn } from "./finish.ts";

const EDITORS = ["Code", "Code - Insiders", "Cursor", "VSCodium", "Codium", "Windsurf"];
const EXTENSIONS: Record<string, ImportTool> = {
  "saoudrizwan.claude-dev": "cline",
  "rooveterinaryinc.roo-cline": "roo-code",
  "kilocode.kilo-code": "kilo-code",
};
const HISTORY_FILE = "api_conversation_history.json";
/** A conversation file larger than this is not read whole. */
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

export type ClineTask = {
  tool: ImportTool;
  id: string;
  path: string;
  cwd: string | undefined;
  title: string | undefined;
  updatedAt: number | undefined;
};

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** VS Code's globalState row of one extension, from a snapshot of `state.vscdb`. */
function globalStateHistory(globalStorage: string, extensionId: string): unknown[] {
  const db = join(globalStorage, "state.vscdb");
  if (!existsSync(db)) return [];
  let snapshot;
  try {
    snapshot = openSnapshot(db);
  } catch {
    return [];
  }
  try {
    if (!snapshot.tables.has("ItemTable")) return [];
    const row = snapshot.db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(extensionId) as { value: string | Uint8Array } | undefined;
    if (!row) return [];
    const text =
      typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) && Array.isArray(parsed.taskHistory) ? parsed.taskHistory : [];
  } catch {
    return [];
  } finally {
    snapshot.dispose();
  }
}

/** The task index of one extension folder (Cline, then Roo layout, then VS Code's globalState). */
function taskIndex(
  extensionDir: string,
  globalStorage: string | undefined,
  extensionId: string,
): unknown[] {
  const cline = readJson(join(extensionDir, "state", "taskHistory.json"));
  if (Array.isArray(cline) && cline.length) return cline;
  const roo = readJson(join(extensionDir, "tasks", "_index.json"));
  if (isRecord(roo) && Array.isArray(roo.entries) && roo.entries.length) return roo.entries;
  const shared = readJson(join(extensionDir, "tasks", "taskHistory.json"));
  if (Array.isArray(shared) && shared.length) return shared;
  return globalStorage ? globalStateHistory(globalStorage, extensionId) : [];
}

function tasksOf(tool: ImportTool, extensionDir: string, index: unknown[]): ClineTask[] {
  const byId = new Map<string, JsonRecord>();
  for (const item of index)
    if (isRecord(item) && typeof item.id === "string") byId.set(item.id, item);
  let ids: string[];
  try {
    ids = readdirSync(join(extensionDir, "tasks"));
  } catch {
    return [];
  }
  const tasks: ClineTask[] = [];
  for (const id of ids) {
    const path = join(extensionDir, "tasks", id, HISTORY_FILE);
    if (!existsSync(path)) continue;
    const item = byId.get(id);
    const cwd = item?.cwdOnTaskInitialization ?? item?.workspace;
    tasks.push({
      tool,
      id,
      path,
      cwd: typeof cwd === "string" && cwd ? cwd : undefined,
      title: typeof item?.task === "string" ? item.task : undefined,
      updatedAt: typeof item?.ts === "number" ? item.ts : undefined,
    });
  }
  return tasks;
}

export function clineTasks(roots: Pick<SourceRoots, "editorData" | "clineData">): ClineTask[] {
  const tasks: ClineTask[] = [];
  for (const editor of EDITORS) {
    const globalStorage = join(roots.editorData, editor, "User", "globalStorage");
    if (!isDir(globalStorage)) continue;
    for (const [extensionId, tool] of Object.entries(EXTENSIONS)) {
      const dir = join(globalStorage, extensionId);
      if (isDir(dir)) tasks.push(...tasksOf(tool, dir, taskIndex(dir, globalStorage, extensionId)));
    }
  }
  if (isDir(roots.clineData))
    tasks.push(...tasksOf("cline", roots.clineData, taskIndex(roots.clineData, undefined, "")));
  // the same task migrated into ~/.cline/data: one copy (the newer file) wins
  const best = new Map<string, ClineTask>();
  for (const task of tasks) {
    const key = `${task.tool}:${task.id}`;
    const current = best.get(key);
    if (!current || statSync(task.path).mtimeMs > statSync(current.path).mtimeMs)
      best.set(key, task);
  }
  return [...best.values()];
}

export async function clineCandidate(task: ClineTask): Promise<ChatCandidate | undefined> {
  if (!task.cwd) return undefined;
  const info = await stat(task.path);
  return {
    tool: task.tool,
    sourceId: task.id,
    sourcePath: task.path,
    cwd: task.cwd,
    title: pickTitle({ firstRequest: task.title ? unwrapUserText(task.title) : undefined }),
    updatedAt: task.updatedAt ?? info.mtimeMs,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

const PERSON_TAGS = /<(task|feedback|user_message|answer)>([\s\S]*?)<\/\1>/gu;
const DROPPED_TAGS =
  /<(environment_details|thinking|file_content|slash-command|explicit_instructions)>[\s\S]*?<\/\1>/gu;

/** The person's words from a user block: wrapped words if any, else the text without the agent's context. */
export function unwrapUserText(text: string): string {
  const wrapped = [...text.matchAll(PERSON_TAGS)].map((m) => m[2]!.trim()).filter(Boolean);
  if (wrapped.length) return wrapped.join("\n");
  return text.replace(DROPPED_TAGS, "").trim();
}

/** Tool calls written as XML in older replies, by their own name. */
const XML_TOOLS = [
  "write_to_file",
  "replace_in_file",
  "apply_diff",
  "insert_content",
  "search_and_replace",
  "read_file",
  "list_files",
  "search_files",
  "list_code_definition_names",
  "codebase_search",
  "execute_command",
  "browser_action",
  "use_mcp_tool",
  "access_mcp_resource",
  "new_task",
  "switch_mode",
  "update_todo_list",
  "ask_followup_question",
  "attempt_completion",
  "plan_mode_respond",
];
const XML_TOOL = new RegExp(`<(${XML_TOOLS.join("|")})>([\\s\\S]*?)</\\1>`, "gu");

function child(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(body);
  return match?.[1]?.trim() || undefined;
}

/** A reply's text with XML tool calls turned into notes; the words of questions and results kept. */
export function replyText(
  text: string,
  files: Set<string>,
  dropped: ImportedChat["dropped"],
): string {
  const thinking = text.match(/<thinking>[\s\S]*?<\/thinking>/gu);
  if (thinking) dropped.thinking += thinking.length;
  return (
    text
      .replace(/<thinking>[\s\S]*?<\/thinking>/gu, "")
      .replace(XML_TOOL, (_whole, name: string, body: string) => {
        if (name === "attempt_completion") return child(body, "result") ?? "";
        if (name === "ask_followup_question") return child(body, "question") ?? "";
        if (name === "plan_mode_respond") return child(body, "response") ?? "";
        const input = {
          command: child(body, "command"),
          path: child(body, "path"),
          query: child(body, "query") ?? child(body, "regex"),
          url: child(body, "url"),
        };
        const file = toolFile(input);
        if (file) files.add(file);
        return `\n${toolNote(name, input)}\n`;
      })
      // a note sits on its own line, without blank lines around it
      .replace(/\n+(• )/gu, "\n$1")
      .replace(/^(• [^\n]*)\n+/gmu, "$1\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim()
  );
}

/** Older versions report a tool's result as a user text: «[write_to_file for 'a.html'] Result:». */
const TEXT_TOOL_RESULT = /^\s*\[[\w-]+(?: for [^\]]*)?\] Result:/u;

export async function readClineChat(
  task: Pick<ClineTask, "tool" | "id" | "path" | "title">,
  cwd: string,
): Promise<ImportedChat | undefined> {
  const info = await stat(task.path);
  if (info.size > MAX_HISTORY_BYTES) return undefined;
  const messages = readJson(task.path);
  if (!Array.isArray(messages)) return undefined;
  const dropped = emptyDropped();
  const turns: ImportedTurn[] = [];
  const files = new Set<string>();
  let model: string | undefined;
  for (const message of messages) {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) continue;
    const ts = typeof message.ts === "number" ? message.ts : undefined;
    if (
      typeof message.modelInfo === "object" &&
      isRecord(message.modelInfo) &&
      typeof message.modelInfo.modelId === "string"
    ) {
      model = message.modelInfo.modelId;
    }
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    if (!Array.isArray(blocks)) continue;
    const texts: string[] = [];
    const resultMessage =
      message.role === "user" &&
      blocks.some(
        (b) =>
          isRecord(b) &&
          b.type === "text" &&
          typeof b.text === "string" &&
          TEXT_TOOL_RESULT.test(b.text),
      );
    if (resultMessage) dropped.toolResults += 1;
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        if (resultMessage) {
          // only the person's answer or feedback inside a tool result crosses over
          texts.push(
            ...[...block.text.matchAll(PERSON_TAGS)].map((m) => m[2]!.trim()).filter(Boolean),
          );
          continue;
        }
        texts.push(
          message.role === "user"
            ? unwrapUserText(block.text)
            : replyText(block.text, files, dropped),
        );
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const file = toolFile(block.input);
        if (file) files.add(file);
        texts.push(toolNote(block.name, block.input));
      } else if (block.type === "tool_result") {
        dropped.toolResults += 1;
        // the person's answer to a question arrives inside a tool result
        const inner = Array.isArray(block.content) ? block.content : [block.content];
        for (const part of inner) {
          const text =
            typeof part === "string"
              ? part
              : isRecord(part) && typeof part.text === "string"
                ? part.text
                : "";
          const words = [...text.matchAll(PERSON_TAGS)].map((m) => m[2]!.trim()).filter(Boolean);
          texts.push(...words);
        }
      } else if (block.type === "image") {
        dropped.images += 1;
        texts.push(IMAGE_PLACEHOLDER);
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        dropped.thinking += 1;
      }
    }
    const text = texts.filter(Boolean).join("\n");
    if (!text) {
      if (message.role === "user") dropped.service += 1;
      continue;
    }
    pushTurn(turns, message.role, text, ts);
  }
  return finishChat({
    tool: task.tool,
    sourceId: task.id,
    sourcePath: task.path,
    cwd,
    turns,
    titles: {},
    model,
    files,
    dropped,
    fallbackTime: info.mtimeMs,
  });
}
