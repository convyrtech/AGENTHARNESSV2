import { afterEach, describe, expect, it } from "vite-plus/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  emptyLedger,
  isImported,
  readLedger,
  writeLedger,
  type LedgerEntry,
} from "../src/ledger.ts";
import type { ChatCandidate } from "../src/types.ts";
import { cleanTemp, tempDir } from "./helpers.ts";

afterEach(cleanTemp);

const entry: LedgerEntry = {
  tool: "claude-code",
  sourceId: "s1",
  sourcePath: "/a.jsonl",
  size: 10,
  mtimeMs: 100,
  sha256: "aaa",
  piSession: "/sessions/x.jsonl",
  importedAt: "2026-10-25T00:00:00.000Z",
};
const candidate: ChatCandidate = {
  tool: "claude-code",
  sourceId: "s1",
  sourcePath: "/a.jsonl",
  cwd: "/p",
  title: "t",
  updatedAt: 100,
  size: 10,
  mtimeMs: 100,
};

describe("ledger", () => {
  it("reads a missing or damaged journal as empty", async () => {
    const dir = await tempDir();
    expect(await readLedger(join(dir, "нет.json"))).toEqual(emptyLedger());
    await writeFile(join(dir, "bad.json"), "{не json");
    expect(await readLedger(join(dir, "bad.json"))).toEqual(emptyLedger());
    await writeFile(join(dir, "odd.json"), JSON.stringify({ entries: [entry, { tool: 1 }] }));
    expect((await readLedger(join(dir, "odd.json"))).entries).toEqual([entry]);
  });

  it("round-trips through a new folder", async () => {
    const dir = await tempDir();
    const path = join(dir, "prsloy", "import-ledger.json");
    await writeLedger(path, { version: 1, entries: [entry] });
    expect(await readLedger(path)).toEqual({ version: 1, entries: [entry] });
  });

  it("knows an unchanged chat and offers a changed one again", async () => {
    const ledger = { version: 1 as const, entries: [entry] };
    expect(isImported(ledger, candidate)).toBe(true);
    expect(isImported(ledger, { ...candidate, size: 11 })).toBe(false);
    expect(isImported(ledger, candidate, "aaa")).toBe(true);
    expect(isImported(ledger, candidate, "bbb")).toBe(false);
    expect(isImported(ledger, { ...candidate, tool: "codex" })).toBe(false);
    // the latest record wins
    const later = { ...entry, size: 20 };
    expect(isImported({ version: 1, entries: [entry, later] }, candidate)).toBe(false);
  });
});
