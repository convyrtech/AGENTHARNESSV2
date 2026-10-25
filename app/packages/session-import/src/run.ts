/**
 * Bringing the chosen chats over (research/25 §4.3–4.4). One run at a time. For each chat: skip
 * it when the journal has it unchanged; read it in full; hide secrets (in the adapters); find
 * its project folder; check the source did not change while being read (the other agent may
 * still be writing it); write the Pi session; record it in the journal. Source files are only
 * read — their bytes are the same before and after.
 */
import { readClaudeCodeChat } from "./adapters/claude-code.ts";
import { codexTitles, readCodexChat } from "./adapters/codex.ts";
import { readOpenCodeChat, releaseOpenCodeSnapshots } from "./adapters/opencode.ts";
import { readPiCliSession } from "./adapters/pi-cli.ts";
import { candidateKey } from "./detect.ts";
import { isImported, readLedger, writeLedger } from "./ledger.ts";
import type { SourceRoots } from "./paths.ts";
import { resolveProject } from "./projects.ts";
import { sha256File } from "./read-lines.ts";
import {
  buildPiSession,
  copyPiCliSession,
  type PiSessionFile,
  type TargetModel,
  writePiSession,
} from "./to-pi.ts";
import type { ChatCandidate, ImportedChat, SkipReason } from "./types.ts";

export type ImportResult =
  | {
      key: string;
      status: "imported";
      piSession: string;
      cwd: string;
      title: string;
      secrets: number;
    }
  | { key: string; status: "skipped"; reason: SkipReason };

export type ImportOptions = {
  candidates: ChatCandidate[];
  roots: SourceRoots;
  home: string;
  /** Where PRSLOY keeps its sessions (agent-runtime's resolvePixSessionDir). */
  sessionDir: string;
  ledgerPath: string;
  target: TargetModel;
  onProgress?: (done: number, total: number, result: ImportResult) => void;
};

export class ImportBusyError extends Error {
  constructor() {
    super("an import is already running");
    this.name = "ImportBusyError";
  }
}

let running = false;

type Prepared = { file: PiSessionFile; cwd: string; title: string; secrets: number };

async function prepare(
  candidate: ChatCandidate,
  sha256: string,
  options: ImportOptions,
  titles: () => Promise<Map<string, string>>,
): Promise<Prepared | SkipReason> {
  const now = new Date();
  if (candidate.tool === "pi-cli") {
    const copy = await readPiCliSession(candidate.sourcePath);
    if (!copy) return "empty";
    const cwd = resolveProject(String(copy.header.cwd), { home: options.home });
    if (!cwd) return "no-project";
    const file = copyPiCliSession(
      { header: { ...copy.header, cwd }, entries: copy.entries },
      {
        target: options.target,
        record: {
          tool: "pi-cli",
          sourceId: candidate.sourceId,
          sha256,
          importedAt: now.toISOString(),
          secrets: copy.secrets,
        },
        now,
      },
    );
    return { file, cwd, title: copy.title, secrets: copy.secrets };
  }
  let chat: ImportedChat | undefined;
  if (candidate.tool === "claude-code") chat = await readClaudeCodeChat(candidate.sourcePath);
  else if (candidate.tool === "opencode")
    chat = readOpenCodeChat(candidate.sourcePath, candidate.sourceId);
  else chat = await readCodexChat(candidate.sourcePath, await titles());
  if (!chat || chat.turns.length === 0) return "empty";
  const cwd = resolveProject(chat.cwd, { home: options.home });
  if (!cwd) return "no-project";
  const file = buildPiSession({ ...chat, cwd }, { target: options.target, sha256, now });
  return { file, cwd, title: chat.title, secrets: chat.secrets };
}

export async function importChats(options: ImportOptions): Promise<ImportResult[]> {
  if (running) throw new ImportBusyError();
  running = true;
  try {
    const ledger = await readLedger(options.ledgerPath);
    let titleCache: Promise<Map<string, string>> | undefined;
    const titles = () => (titleCache ??= codexTitles(options.roots.codexHome));
    const results: ImportResult[] = [];
    const total = options.candidates.length;
    for (const candidate of options.candidates) {
      const key = candidateKey(candidate);
      let result: ImportResult;
      try {
        // a chat inside a shared database is versioned by its own fingerprint, read from a snapshot
        const version = () => candidate.fingerprint ?? sha256File(candidate.sourcePath);
        const before = await version();
        if (isImported(ledger, candidate, before)) {
          result = { key, status: "skipped", reason: "already" };
        } else {
          const prepared = await prepare(candidate, before, options, titles);
          const after = await version();
          if (typeof prepared === "string") result = { key, status: "skipped", reason: prepared };
          else if (after !== before) result = { key, status: "skipped", reason: "busy" };
          else {
            const piSession = await writePiSession(options.sessionDir, prepared.file);
            ledger.entries.push({
              tool: candidate.tool,
              sourceId: candidate.sourceId,
              sourcePath: candidate.sourcePath,
              size: candidate.size,
              mtimeMs: candidate.mtimeMs,
              sha256: before,
              piSession,
              importedAt: new Date().toISOString(),
            });
            // after every chat: a crash halfway does not bring the first ones over twice
            await writeLedger(options.ledgerPath, ledger);
            result = {
              key,
              status: "imported",
              piSession,
              cwd: prepared.cwd,
              title: prepared.title,
              secrets: prepared.secrets,
            };
          }
        }
      } catch {
        result = { key, status: "skipped", reason: "unreadable" };
      }
      results.push(result);
      options.onProgress?.(results.length, total, result);
    }
    return results;
  } finally {
    releaseOpenCodeSnapshots();
    running = false;
  }
}
