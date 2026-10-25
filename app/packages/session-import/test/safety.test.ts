/**
 * research/25 §5: the import only reads other tools' files and never runs their programs.
 */
import { describe, expect, it } from "vite-plus/test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

async function sources(): Promise<{ path: string; text: string }[]> {
  const out = [];
  for (const entry of await readdir(SRC, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      const path = join(entry.parentPath, entry.name);
      out.push({ path, text: await readFile(path, "utf8") });
    }
  }
  return out;
}

describe("session-import safety", () => {
  it("starts no processes", async () => {
    for (const { path, text } of await sources()) {
      expect(text, path).not.toMatch(
        /child_process|worker_threads|(?<!\.)\b(?:spawn|spawnSync|execFile|execSync|exec|fork)\(/,
      );
    }
  });

  it("writes only through the session writer and the journal", async () => {
    const writers = [];
    for (const { path, text } of await sources()) {
      if (/\b(writeFile|appendFile|createWriteStream|unlink|rename|rm)\(/.test(text)) {
        writers.push(path.slice(SRC.length + 1).replaceAll("\\", "/"));
      }
    }
    expect(writers.sort()).toEqual(["ledger.ts", "to-pi.ts"]);
  });
});
