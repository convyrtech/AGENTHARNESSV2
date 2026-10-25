/**
 * Search over old chats (research 19 §1.6): straight over pi's JSONL sessions in
 * `<agentDir>/sessions/` and its per-project folders, no index of our own. Every word must match;
 * «ё» counts as «е». Parsed files are cached by mtime and size.
 *
 * Adapted from PiCove (PiDeck) `packages/pi-host/src/session-search.ts` (commit 102d9e1).
 * MIT License, Copyright (c) 2026 PiDeck contributors.
 * Changed by PRSLOY: ё→е, our `<attached-paths>` blocks stripped, the chat's first request
 * as its title, no archive folder, results capped at 30.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ChatSearchMatch, ChatSearchResult } from "@zeno/contracts";

const DEFAULT_RESULT_LIMIT = 30;
const MAX_MATCHES_PER_SESSION = 3;
const MAX_QUERY_TERMS = 8;
const MAX_BLOCKS_PER_SESSION = 5000;
/** Long assistant messages are truncated for search; snippets stay early-anchored. */
const MAX_BLOCK_CHARS = 20_000;
/** Total searchable text cached per session file; bounds memory. */
const MAX_DOC_CHARS = 262_144;
const SNIPPET_BEFORE_CHARS = 40;
const SNIPPET_AFTER_CHARS = 120;
const STAT_TTL_MS = 2_000;

type SearchBlock = { role: "user" | "assistant"; text: string; lower: string };
type SearchDoc = {
  sessionId: string;
  name?: string;
  nameLower?: string;
  firstPrompt?: string;
  cwd: string;
  blocks: SearchBlock[];
};

const docCache = new Map<string, { mtimeMs: number; size: number; doc: SearchDoc | null }>();
const statCache = new Map<string, { atMs: number; mtimeMs: number; size: number }>();
const listingCache = new Map<string, { atMs: number; files: string[] }>();

/** Test hook: the next scan reflects the disk at once. */
export function resetChatSearchCaches(): void {
  docCache.clear();
  statCache.clear();
  listingCache.clear();
}

/** Lower case, «ё» as «е»: «Ёлка» finds «елка» and back. */
export function fold(text: string): string {
  return text.toLocaleLowerCase("ru").replaceAll("ё", "е");
}

async function statWithTtl(path: string): Promise<{ mtimeMs: number; size: number }> {
  const now = Date.now();
  const cached = statCache.get(path);
  if (cached && now - cached.atMs <= STAT_TTL_MS) return cached;
  const fileStat = await stat(path);
  const entry = { atMs: now, mtimeMs: fileStat.mtimeMs, size: fileStat.size };
  statCache.set(path, entry);
  return entry;
}

/** pi writes a UUID, but a caller may pick its own id: any short non-empty string. */
function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function textBlocksOf(content: unknown): string[] {
  if (typeof content === "string") return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string" && block.text) {
      texts.push(block.text);
    }
  }
  return texts;
}

/** The composer appends attached files as `<attached-paths>…</attached-paths>`: not words. */
export function stripAttachedPaths(text: string): string {
  return text.replace(/<attached-paths>[\s\S]*?<\/attached-paths>/gu, "").trim();
}

/**
 * Cheap pre-filter before JSON.parse: tool results and bookkeeping, which dominate file
 * size, never contain these literals. A false positive costs one harmless parse.
 */
function mayContainSearchableEntry(line: string): boolean {
  return (
    line.includes('"role":"user"') ||
    line.includes('"role":"assistant"') ||
    line.includes('"type":"session"') ||
    line.includes('"type":"session_info"')
  );
}

async function parseSearchDoc(sessionPath: string): Promise<SearchDoc | null> {
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let name: string | undefined;
  let firstPrompt: string | undefined;
  let totalChars = 0;
  const blocks: SearchBlock[] = [];
  const lines = createInterface({
    input: createReadStream(sessionPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!mayContainSearchableEntry(line)) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session" && sessionId === null && isSessionId(entry.id)) {
      sessionId = entry.id;
      cwd = typeof entry.cwd === "string" ? entry.cwd : null;
      continue;
    }
    if (entry.type === "session_info") {
      name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
      continue;
    }
    if (
      entry.type !== "message" ||
      blocks.length >= MAX_BLOCKS_PER_SESSION ||
      totalChars >= MAX_DOC_CHARS
    ) {
      continue;
    }
    if (!entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) {
      continue;
    }
    const message = entry.message as Record<string, unknown>;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    for (const rawText of textBlocksOf(message.content)) {
      const stripped = role === "user" ? stripAttachedPaths(rawText) : rawText;
      if (!stripped.trim()) continue;
      if (role === "user" && firstPrompt === undefined) {
        firstPrompt = stripped.replace(/\s+/gu, " ").trim().slice(0, 120);
      }
      const text = stripped.slice(0, Math.min(MAX_BLOCK_CHARS, MAX_DOC_CHARS - totalChars));
      if (!text) break;
      totalChars += text.length;
      blocks.push({ role, text, lower: fold(text) });
      if (blocks.length >= MAX_BLOCKS_PER_SESSION || totalChars >= MAX_DOC_CHARS) break;
    }
  }
  if (!sessionId || !cwd) return null;
  return {
    sessionId,
    ...(name ? { name, nameLower: fold(name) } : {}),
    ...(firstPrompt ? { firstPrompt } : {}),
    cwd,
    blocks,
  };
}

export function normalizeQueryTerms(query: string): string[] {
  const terms = fold(query.trim()).split(/\s+/u).filter(Boolean);
  return [...new Set(terms)].slice(0, MAX_QUERY_TERMS);
}

function matchesAllTerms(lowerText: string, terms: string[]): boolean {
  return terms.every((term) => lowerText.includes(term));
}

/** 40 characters before the first word, 120 after. Folding keeps indexes: «ё» and «е» are one char. */
export function buildSnippet(text: string, firstTerm: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  const index = fold(collapsed).indexOf(firstTerm);
  const start = index < 0 ? 0 : Math.max(0, index - SNIPPET_BEFORE_CHARS);
  const end =
    index < 0
      ? SNIPPET_AFTER_CHARS
      : Math.min(collapsed.length, index + firstTerm.length + SNIPPET_AFTER_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < collapsed.length ? "…" : "";
  return `${prefix}${collapsed.slice(start, end)}${suffix}`;
}

function matchDoc(
  doc: SearchDoc,
  terms: string[],
): { matchCount: number; matches: ChatSearchMatch[] } | null {
  const nameMatched = doc.nameLower !== undefined && matchesAllTerms(doc.nameLower, terms);
  let matchCount = 0;
  const matches: ChatSearchMatch[] = [];
  for (const block of doc.blocks) {
    if (!matchesAllTerms(block.lower, terms)) continue;
    matchCount += 1;
    if (matches.length < MAX_MATCHES_PER_SESSION) {
      matches.push({ role: block.role, snippet: buildSnippet(block.text, terms[0] ?? "") });
    }
  }
  if (!nameMatched && matchCount === 0) return null;
  return { matchCount, matches };
}

async function readDirs(root: string, kind: "dir" | "jsonl"): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) =>
      kind === "dir" ? e.isDirectory() : e.isFile() && e.name.toLowerCase().endsWith(".jsonl"),
    )
    .map((e) => join(root, e.name));
}

async function listSessionFiles(root: string): Promise<string[]> {
  const now = Date.now();
  const cached = listingCache.get(root);
  if (cached && now - cached.atMs <= STAT_TTL_MS) return cached.files;
  // A project's chats sit in a folder per project; plain conversations right in `sessions/`.
  const dirs = await readDirs(root, "dir");
  const nested = await Promise.all(dirs.map((dir) => readDirs(dir, "jsonl")));
  const files = [...(await readDirs(root, "jsonl")), ...nested.flat()];
  listingCache.set(root, { atMs: now, files });
  return files;
}

async function loadDoc(path: string): Promise<{ doc: SearchDoc | null; mtimeMs: number }> {
  let fileStat;
  try {
    fileStat = await statWithTtl(path);
  } catch {
    docCache.delete(path);
    statCache.delete(path);
    return { doc: null, mtimeMs: 0 };
  }
  const cached = docCache.get(path);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return { doc: cached.doc, mtimeMs: fileStat.mtimeMs };
  }
  const doc = await parseSearchDoc(path);
  docCache.set(path, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, doc });
  return { doc, mtimeMs: fileStat.mtimeMs };
}

/** Chats where every word of `query` occurs, newest first. */
export async function searchChats(args: {
  agentDir: string;
  query: string;
  limit?: number;
}): Promise<ChatSearchResult[]> {
  const terms = normalizeQueryTerms(args.query);
  if (terms.length === 0) return [];
  const limit = args.limit ?? DEFAULT_RESULT_LIMIT;
  const files = await listSessionFiles(join(args.agentDir, "sessions"));
  const items: ChatSearchResult[] = [];
  for (let offset = 0; offset < files.length; offset += 8) {
    const batch = await Promise.all(
      files.slice(offset, offset + 8).map(async (path) => {
        const { doc, mtimeMs } = await loadDoc(path);
        if (!doc) return null;
        const matched = matchDoc(doc, terms);
        if (!matched) return null;
        return {
          path,
          cwd: doc.cwd,
          title: doc.name ?? doc.firstPrompt ?? "",
          updatedAt: mtimeMs,
          matchCount: matched.matchCount,
          matches: matched.matches,
        } satisfies ChatSearchResult;
      }),
    );
    for (const item of batch) if (item) items.push(item);
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items.slice(0, limit);
}
