/**
 * Bringing chats over from other agents (#22, research/25): main scans the other tools' folders
 * and copies the chosen chats into PRSLOY's own chat files. The renderer only ever names chats by
 * the keys main gave it, never by path: main reads nothing the scan did not find.
 */

export type ImportToolId = "claude-code" | "codex" | "pi-cli" | "opencode" | "gemini";

export type ImportToolCount = { chats: number; projects: number; recent: number };

export interface ImportChatSummary {
  /** `tool:sourceId`, the only handle the renderer has on a chat. */
  key: string;
  tool: ImportToolId;
  title: string;
  /** The project folder the other tool recorded. */
  project: string;
  /** Unix ms. */
  updatedAt: number;
  alreadyImported: boolean;
}

export interface ImportScanResult {
  counts: Record<ImportToolId, ImportToolCount>;
  /** Newest first, at most 500. */
  chats: ImportChatSummary[];
  /** Keys ticked by default: the last 30 days, not imported yet, at most 50. */
  selected: string[];
  /** Tools whose chats could not be read at all (an unknown database format, a broken file). */
  unreadable?: ImportToolId[];
}

export type ImportSkipReason =
  | "continued"
  | "empty"
  | "no-project"
  | "busy"
  | "unreadable"
  | "already";

export interface ImportRunResult {
  imported: number;
  skipped: Partial<Record<ImportSkipReason, number>>;
  /** Project folders of the imported chats, most chats first. */
  projects: string[];
}

export interface ImportProgress {
  done: number;
  total: number;
}

export interface SessionImportApi {
  scan(): Promise<ImportScanResult>;
  /** Unknown keys are ignored; rejects when an import is already running. */
  run(keys: string[]): Promise<ImportRunResult>;
  onProgress(listener: (progress: ImportProgress) => void): () => void;
}
