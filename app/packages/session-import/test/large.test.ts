/**
 * A long-lived chat can be hundreds of megabytes, mostly tool output (research/25 §5). It is
 * read as a stream: tool output is counted, not kept, and only the newest 300 turns cross over.
 * The file is generated here, never stored in the repo.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { MAX_TURNS, readClaudeCodeChat } from "../src/adapters/claude-code.ts";
import { cleanTemp, tempDir } from "./helpers.ts";

afterEach(cleanTemp);

describe("a very large chat", () => {
  it("streams 120 MB without keeping tool output and keeps the newest turns", async () => {
    const dir = await tempDir();
    const file = join(dir, "big.jsonl");
    const out = createWriteStream(file);
    const output = "вывод ".repeat(10_000); // ~120 KB of tool output per round
    let parent: string | null = null;
    let round = 0;
    const write = async (line: object) => {
      if (!out.write(`${JSON.stringify(line)}\n`)) await once(out, "drain");
    };
    while (out.bytesWritten + out.writableLength < 120 * 1024 * 1024) {
      const u = `u${round}`;
      const a = `a${round}`;
      const r = `r${round}`;
      await write({
        type: "user",
        uuid: u,
        parentUuid: parent,
        cwd: "/p",
        message: { role: "user", content: `просьба ${round}` },
      });
      await write({
        type: "assistant",
        uuid: a,
        parentUuid: u,
        cwd: "/p",
        message: {
          id: a,
          role: "assistant",
          model: "m",
          content: [
            { type: "tool_use", id: `t${round}`, name: "Bash", input: { command: `ls ${round}` } },
          ],
        },
      });
      await write({
        type: "user",
        uuid: r,
        parentUuid: a,
        cwd: "/p",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `t${round}`, content: output }],
        },
      });
      parent = r;
      round += 1;
    }
    out.end();
    await once(out, "finish");
    expect((await stat(file)).size).toBeGreaterThan(120 * 1024 * 1024);

    const heapBefore = process.memoryUsage().heapUsed;
    const chat = await readClaudeCodeChat(file);
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

    expect(chat?.turns).toHaveLength(MAX_TURNS);
    expect(chat?.turns.at(-1)?.text).toBe(`• Bash: ls ${round - 1}`);
    expect(chat?.dropped.toolResults).toBe(round);
    expect(JSON.stringify(chat)).not.toContain("вывод вывод");
    // the file is 120 MB; what stays in memory is a small fraction of it
    expect(heapGrowth).toBeLessThan(100 * 1024 * 1024);
  }, 120_000);
});
