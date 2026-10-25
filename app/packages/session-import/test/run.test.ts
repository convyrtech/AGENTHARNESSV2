import { afterEach, describe, expect, it } from "vite-plus/test";
import { appendFile, readdir, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { scanSources } from "../src/detect.ts";
import { emptyLedger, readLedger } from "../src/ledger.ts";
import { sha256File } from "../src/read-lines.ts";
import { ImportBusyError, importChats, type ImportOptions } from "../src/run.ts";
import { cleanTemp, fakeMachine } from "./helpers.ts";

afterEach(cleanTemp);

const TARGET = { provider: "prsloy", modelId: "prsloy/auto" };
const NOW = Date.UTC(2026, 9, 25);

async function setup() {
  const machine = await fakeMachine();
  const scan = await scanSources({ roots: machine.roots, ledger: emptyLedger(), now: NOW });
  const options: ImportOptions = {
    candidates: scan.candidates,
    roots: machine.roots,
    home: machine.home,
    sessionDir: machine.sessionDir,
    ledgerPath: machine.ledgerPath,
    target: TARGET,
  };
  return { machine, scan, options };
}

describe("importChats", () => {
  it("brings every chat over into its real project folder and records it", async () => {
    const { machine, scan, options } = await setup();
    const before = await Promise.all(scan.candidates.map((c) => sha256File(c.sourcePath)));
    const progress: number[] = [];
    const results = await importChats({ ...options, onProgress: (done) => progress.push(done) });

    expect(results.map((r) => r.status)).toEqual(Array(5).fill("imported"));
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    const cwds = new Set(results.map((r) => (r.status === "imported" ? r.cwd : "")));
    expect(cwds).toEqual(
      new Set(Object.values(machine.projects).map((p) => realpathSync.native(p))),
    );
    expect(await readdir(machine.sessionDir)).toHaveLength(5);
    const ledger = await readLedger(machine.ledgerPath);
    expect(ledger.entries).toHaveLength(5);

    // the other agents' files are byte for byte what they were
    const after = await Promise.all(scan.candidates.map((c) => sha256File(c.sourcePath)));
    expect(after).toEqual(before);

    // every written session ends on PRSLOY's model
    for (const result of results) {
      if (result.status !== "imported") continue;
      const lines = (await readFile(result.piSession, "utf8")).trimEnd().split("\n");
      const types = lines.map((l) => JSON.parse(l).type as string);
      expect(types).toContain("model_change");
      const change = lines.map((l) => JSON.parse(l)).findLast((e) => e.type === "model_change");
      expect(change).toMatchObject(TARGET);
    }
  });

  it("does not bring the same chat twice, but does after it changes", async () => {
    const { machine, scan, options } = await setup();
    await importChats(options);
    const again = await importChats(options);
    expect(again.every((r) => r.status === "skipped" && r.reason === "already")).toBe(true);

    const pi = scan.candidates.find((c) => c.tool === "pi-cli")!;
    await appendFile(
      pi.sourcePath,
      `${JSON.stringify({ type: "session_info", id: "e0000099", parentId: "e0000005", timestamp: "2026-10-02T00:00:00.000Z", name: "Статья про чай, v2" })}\n`,
    );
    const third = await importChats({ ...options, candidates: [pi] });
    expect(third[0]).toMatchObject({ status: "imported", title: "Статья про чай, v2" });
    expect(await readdir(machine.sessionDir)).toHaveLength(6);
  });

  it("skips chats whose project folder is gone, and unreadable files", async () => {
    const { machine, scan, options } = await setup();
    await rm(machine.projects.codex, { recursive: true });
    const codex = scan.candidates.find((c) => c.tool === "codex")!;
    const missing = { ...scan.candidates[0]!, sourceId: "ghost", sourcePath: "/нет/файла.jsonl" };
    const results = await importChats({ ...options, candidates: [codex, missing] });
    expect(results).toEqual([
      { key: `codex:${codex.sourceId}`, status: "skipped", reason: "no-project" },
      { key: `${missing.tool}:ghost`, status: "skipped", reason: "unreadable" },
    ]);
    expect((await readLedger(machine.ledgerPath)).entries).toEqual([]);
  });

  it("runs one import at a time", async () => {
    const { options } = await setup();
    const first = importChats(options);
    await expect(importChats(options)).rejects.toBeInstanceOf(ImportBusyError);
    await first;
    await expect(importChats({ ...options, candidates: [] })).resolves.toEqual([]);
  });
});
