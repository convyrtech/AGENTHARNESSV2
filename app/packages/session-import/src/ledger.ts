/**
 * The import journal (research/25 §4.4, after Codex's): which source files were brought over,
 * with their size, time and sha256, and the Pi session each became. A chat is offered again only
 * when its file changed; a re-import makes a new session and never touches the old one. The
 * journal lives in PRSLOY's own data folder, never next to the other agent's files.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "./read-lines.ts";
import type { ChatCandidate, ImportTool } from "./types.ts";

export type LedgerEntry = {
  tool: ImportTool;
  sourceId: string;
  sourcePath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  piSession: string;
  importedAt: string;
};

export type Ledger = { version: 1; entries: LedgerEntry[] };

export function emptyLedger(): Ledger {
  return { version: 1, entries: [] };
}

function isEntry(value: unknown): value is LedgerEntry {
  return (
    isRecord(value) &&
    typeof value.tool === "string" &&
    typeof value.sourceId === "string" &&
    typeof value.sourcePath === "string" &&
    typeof value.size === "number" &&
    typeof value.mtimeMs === "number" &&
    typeof value.sha256 === "string" &&
    typeof value.piSession === "string"
  );
}

/** A missing or damaged journal reads as empty: the worst case is a chat offered twice. */
export async function readLedger(path: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.entries)) {
      return { version: 1, entries: parsed.entries.filter(isEntry) };
    }
  } catch {
    // no journal yet
  }
  return emptyLedger();
}

function latest(ledger: Ledger, tool: ImportTool, sourceId: string): LedgerEntry | undefined {
  return ledger.entries.findLast((e) => e.tool === tool && e.sourceId === sourceId);
}

/** Brought over before and the file has not changed since (size and time; sha when given). */
export function isImported(ledger: Ledger, candidate: ChatCandidate, sha256?: string): boolean {
  const entry = latest(ledger, candidate.tool, candidate.sourceId);
  if (!entry) return false;
  if (sha256) return entry.sha256 === sha256;
  return entry.size === candidate.size && entry.mtimeMs === candidate.mtimeMs;
}

export async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
