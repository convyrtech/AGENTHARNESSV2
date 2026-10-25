// M-sp: память пишут несколько процессов сразу (агент-хост и main) — ни одной потерянной записи.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { concurrentMemoryWrites } from "../src/memory-lock-check.ts";
import { MemoryStore, withMemoryLock } from "../src/memory-store.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-mem-lock-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("memory files under a lock", () => {
  it("four processes adding at once: every entry and every journal line is there", async () => {
    const result = await concurrentMemoryWrites({
      dir: join(root, "mem"),
      cwd: join(root, "project"),
    });
    expect(result.failures).toEqual([]);
    expect(result.entries).toBe(result.expected);
    expect(result.remembered).toBe(result.expected);
  }, 60_000);

  it("a lock left by a crashed writer is taken over", () => {
    const dir = join(root, "stale");
    const store = new MemoryStore(dir);
    store.add("user", root, { text: "Люблю чай", quote: "люблю чай" });
    // A lock file from a process that died 20 s ago.
    writeFileSync(join(dir, ".lock"), "999999");
    const old = new Date(Date.now() - 20_000);
    utimesSync(join(dir, ".lock"), old, old);
    const started = Date.now();
    expect(store.add("user", root, { text: "Люблю джаз", quote: "люблю джаз" }).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("re-entrant in one process (add → migrate → write)", () => {
    const dir = join(root, "nested");
    expect(withMemoryLock(dir, () => withMemoryLock(dir, () => 42))).toBe(42);
  });
});
