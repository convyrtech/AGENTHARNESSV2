/**
 * Reading other agents' JSONL without loading the file: a stream through readline (zstd for
 * Codex's `.jsonl.zst`), broken and oversized lines skipped and counted, an unfinished last line
 * skipped like any other broken one. Files are only ever opened for reading.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";

/** A single line longer than this is not a chat message worth bringing over. */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;

export type LineStats = { broken: number; tooLong: number };

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonLine(line: string, stats?: LineStats): JsonRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_LINE_CHARS) {
    if (stats) stats.tooLong += 1;
    return undefined;
  }
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (isRecord(value)) return value;
  } catch {
    // counted below
  }
  if (stats) stats.broken += 1;
  return undefined;
}

export async function* readJsonLines(
  path: string,
  stats: LineStats = { broken: 0, tooLong: 0 },
): AsyncGenerator<JsonRecord> {
  const raw = createReadStream(path);
  const input = path.endsWith(".zst") ? raw.pipe(createZstdDecompress()) : raw;
  raw.on("error", (error) => input.destroy(error));
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const record = parseJsonLine(line, stats);
      if (record) yield record;
    }
  } finally {
    lines.close();
    raw.destroy();
  }
}

/**
 * The cheap look for the scan: whole lines from the first and the last `bytes` of a file (a cut
 * line at either edge is dropped). A compressed file is read from the start only.
 */
export async function headAndTail(
  path: string,
  bytes = 64 * 1024,
): Promise<{ head: JsonRecord[]; tail: JsonRecord[] }> {
  if (path.endsWith(".zst")) {
    const head: JsonRecord[] = [];
    let seen = 0;
    const stats = { broken: 0, tooLong: 0 };
    const raw = createReadStream(path);
    const input = raw.pipe(createZstdDecompress());
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    try {
      for await (const line of lines) {
        seen += line.length + 1;
        const record = parseJsonLine(line, stats);
        if (record) head.push(record);
        if (seen >= bytes) break;
      }
    } finally {
      lines.close();
      raw.destroy();
    }
    return { head, tail: [] };
  }
  const size = (await stat(path)).size;
  const handle = await open(path, "r");
  try {
    const read = async (from: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, from);
      return buffer.subarray(0, bytesRead).toString("utf8");
    };
    const headText = await read(0, Math.min(bytes, size));
    const headLines = headText.split("\n");
    if (size > bytes) headLines.pop();
    const head = headLines.map((line) => parseJsonLine(line)).filter(isRecord);
    if (size <= bytes) return { head, tail: [] };
    const from = Math.max(bytes, size - bytes);
    const tailLines = (await read(from, size - from)).split("\n");
    tailLines.shift();
    const tail = tailLines.map((line) => parseJsonLine(line)).filter(isRecord);
    return { head, tail };
  } finally {
    await handle.close();
  }
}

/** sha256 of the file's bytes as stored (compressed for `.zst`), for the import journal. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
