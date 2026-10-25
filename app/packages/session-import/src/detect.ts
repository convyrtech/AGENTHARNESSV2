/**
 * The cheap scan for the first-run screen (research/25 §4.1): which tools have chats here, how
 * many, which ones to tick by default. Only the head and tail of each file is read; nothing is
 * parsed in full and nothing is written. Default: chats from the last 30 days not yet brought
 * over, newest first, at most 50 (Codex's limits).
 */
import { claudeCodeCandidate, claudeCodeFiles } from "./adapters/claude-code.ts";
import { codexCandidate, codexFiles, codexTitles, richestPerChat } from "./adapters/codex.ts";
import { cursorCandidate, cursorTranscripts } from "./adapters/cursor-agent.ts";
import { geminiCandidate, geminiChatFiles, newestGeminiFile } from "./adapters/gemini.ts";
import {
  opencodeCandidates,
  opencodeDatabases,
  releaseOpenCodeSnapshots,
} from "./adapters/opencode.ts";
import { piCliCandidate, piCliFiles } from "./adapters/pi-cli.ts";
import { isImported, type Ledger } from "./ledger.ts";
import type { SourceRoots } from "./paths.ts";
import { IMPORT_TOOLS, type ChatCandidate, type ImportTool, type SourceSkip } from "./types.ts";

export const DEFAULT_DAYS = 30;
export const DEFAULT_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_CONCURRENCY = 8;

export type ToolCount = { chats: number; projects: number; recent: number };

export type ScanResult = {
  candidates: ChatCandidate[];
  counts: Record<ImportTool, ToolCount>;
  /** `candidateKey`s ticked by default. */
  selected: string[];
  /** Sources that could not be read at all, with the reason; the rest of the scan went on. */
  skipped: SourceSkip[];
};

export function candidateKey(candidate: Pick<ChatCandidate, "tool" | "sourceId">): string {
  return `${candidate.tool}:${candidate.sourceId}`;
}

async function mapLimited<T, R>(items: T[], map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, items.length) }, worker));
  return results;
}

async function safely<T>(look: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await look();
  } catch {
    return undefined; // unreadable file: not offered
  }
}

export async function scanSources(options: {
  roots: SourceRoots;
  ledger: Ledger;
  now?: number;
  days?: number;
  limit?: number;
}): Promise<ScanResult> {
  const { roots, ledger } = options;
  const now = options.now ?? Date.now();
  const since = now - (options.days ?? DEFAULT_DAYS) * DAY_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const [claudeFiles, codex, piFiles, titles] = await Promise.all([
    claudeCodeFiles(roots.claudeProjects),
    codexFiles(roots.codexHome),
    piCliFiles(roots.piSessions),
    codexTitles(roots.codexHome),
  ]);
  const found = await Promise.all([
    mapLimited(claudeFiles, (file) => safely(() => claudeCodeCandidate(file))),
    mapLimited(codex, (file) => safely(() => codexCandidate(file, titles))),
    mapLimited(piFiles, (file) => safely(() => piCliCandidate(file))),
    mapLimited(geminiChatFiles(roots), (file) => safely(() => geminiCandidate(file))),
    mapLimited(cursorTranscripts(roots), (file) => safely(() => cursorCandidate(file))),
  ]);
  const [claude, codexAll, pi, gemini, cursor] = found.map((list) =>
    list.filter((c): c is ChatCandidate => c !== undefined),
  ) as [ChatCandidate[], ChatCandidate[], ChatCandidate[], ChatCandidate[], ChatCandidate[]];
  const opencode: ChatCandidate[] = [];
  const skipped: SourceSkip[] = [];
  try {
    for (const db of opencodeDatabases(roots)) {
      const result = opencodeCandidates(db);
      opencode.push(...result.candidates);
      if (result.skip) skipped.push(result.skip);
    }
  } finally {
    releaseOpenCodeSnapshots();
  }
  const candidates = [
    ...claude,
    ...richestPerChat(codexAll),
    ...pi,
    ...opencode,
    ...newestGeminiFile(gemini),
    ...cursor,
  ]
    .map((c) => (isImported(ledger, c) ? { ...c, alreadyImported: true } : c))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const counts = Object.fromEntries(
    IMPORT_TOOLS.map((tool) => {
      const mine = candidates.filter((c) => c.tool === tool);
      return [
        tool,
        {
          chats: mine.length,
          projects: new Set(mine.map((c) => c.cwd)).size,
          recent: mine.filter((c) => c.updatedAt >= since && !c.alreadyImported).length,
        },
      ];
    }),
  ) as Record<ImportTool, ToolCount>;

  const selected = candidates
    .filter((c) => c.updatedAt >= since && !c.alreadyImported)
    .slice(0, limit)
    .map(candidateKey);
  return { candidates, counts, selected, skipped };
}
