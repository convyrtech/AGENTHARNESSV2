import { afterEach, describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { headAndTail, parseJsonLine, readJsonLines, sha256File } from "../src/read-lines.ts";
import { cleanTemp, tempDir } from "./helpers.ts";

afterEach(cleanTemp);

async function collect(path: string, stats = { broken: 0, tooLong: 0 }) {
  const out = [];
  for await (const line of readJsonLines(path, stats)) out.push(line);
  return out;
}

describe("read-lines", () => {
  it("parses objects, counts broken lines, ignores blanks", () => {
    const stats = { broken: 0, tooLong: 0 };
    expect(parseJsonLine('{"a":1}', stats)).toEqual({ a: 1 });
    expect(parseJsonLine("   ", stats)).toBeUndefined();
    expect(parseJsonLine("[1]", stats)).toBeUndefined();
    expect(parseJsonLine("{oops", stats)).toBeUndefined();
    expect(stats.broken).toBe(2);
  });

  it("streams plain and zstd files with CRLF endings", async () => {
    const dir = await tempDir();
    const text = '{"n":1}\r\n{"n":2}\r\n{bad\r\n{"n":3}';
    await writeFile(join(dir, "a.jsonl"), text);
    await writeFile(join(dir, "a.jsonl.zst"), zstdCompressSync(Buffer.from(text)));
    const stats = { broken: 0, tooLong: 0 };
    expect(await collect(join(dir, "a.jsonl"), stats)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(stats.broken).toBe(1);
    expect(await collect(join(dir, "a.jsonl.zst"))).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("reads only whole lines from the head and tail of a big file", async () => {
    const dir = await tempDir();
    const lines = Array.from({ length: 2000 }, (_, i) =>
      JSON.stringify({ i, pad: "ы".repeat(40) }),
    );
    await writeFile(join(dir, "big.jsonl"), lines.join("\n"));
    const { head, tail } = await headAndTail(join(dir, "big.jsonl"), 8 * 1024);
    expect(head[0]).toMatchObject({ i: 0 });
    expect(tail.at(-1)).toMatchObject({ i: 1999 });
    expect(head.length + tail.length).toBeLessThan(500);
    const small = await headAndTail(join(dir, "big.jsonl"), 10 * 1024 * 1024);
    expect(small.head).toHaveLength(2000);
    expect(small.tail).toEqual([]);
  });

  it("hashes the bytes as stored", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "h.jsonl"), "привет");
    const expected = createHash("sha256")
      .update(await readFile(join(dir, "h.jsonl")))
      .digest("hex");
    expect(await sha256File(join(dir, "h.jsonl"))).toBe(expected);
  });
});
