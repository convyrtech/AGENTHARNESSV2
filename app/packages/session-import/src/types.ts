/**
 * Chats from other agents, normalized: who wrote them, where they lived, the turns as plain text.
 * Only text crosses over (research/25 §3.2): tool calls become one-line notes, tool output,
 * thinking and pictures stay behind and are only counted.
 */

export const IMPORT_TOOLS = ["claude-code", "codex", "pi-cli", "opencode", "gemini"] as const;
export type ImportTool = (typeof IMPORT_TOOLS)[number];

export const IMPORT_TOOL_LABELS: Record<ImportTool, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "pi-cli": "Pi",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
};

export type ImportedTurn = {
  role: "user" | "assistant";
  text: string;
  /** Unix ms, from the original. */
  timestamp?: number;
};

/** What did not cross over, for the import record and the owner's summary line. */
export type DroppedCounts = {
  thinking: number;
  toolResults: number;
  images: number;
  brokenLines: number;
  service: number;
};

export type ImportedChat = {
  tool: ImportTool;
  sourceId: string;
  sourcePath: string;
  /** The project folder as the transcript recorded it (never guessed from folder names). */
  cwd: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  /** The model the other agent used, kept only in the import record. */
  model?: string;
  turns: ImportedTurn[];
  /** Files named in tool notes, for the summary. */
  files: string[];
  dropped: DroppedCounts;
  /** Secrets hidden while cleaning. */
  secrets: number;
};

/** One chat found by the cheap scan: enough to count and list it, nothing parsed yet. */
export type ChatCandidate = {
  tool: ImportTool;
  sourceId: string;
  sourcePath: string;
  cwd: string;
  title: string;
  updatedAt: number;
  size: number;
  mtimeMs: number;
  /** Already brought over and unchanged since (by the import journal). */
  alreadyImported?: boolean;
  /**
   * For chats inside a shared database (OpenCode): what identifies this chat's version, used
   * by the journal instead of the file's sha256 (the file changes with every other chat).
   */
  fingerprint?: string;
};

/** A source the scan could not read at all (an unknown database schema, a broken file). */
export type SourceSkip = {
  tool: ImportTool;
  path: string;
  reason: "unknown-schema" | "unreadable";
};

export type SkipReason = "continued" | "empty" | "no-project" | "busy" | "unreadable" | "already";

export function emptyDropped(): DroppedCounts {
  return { thinking: 0, toolResults: 0, images: 0, brokenLines: 0, service: 0 };
}
