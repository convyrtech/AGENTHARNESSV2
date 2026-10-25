import { afterEach, describe, expect, it } from "vite-plus/test";
import { appendFile, readdir, readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("brings an OpenCode chat over, versioned by its own update time, not the database's hash", async () => {
    const { machine, options } = await setup();
    await mkdir(machine.roots.opencodeData, { recursive: true });
    const dbPath = join(machine.roots.opencodeData, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT,
        time_created INTEGER, time_updated INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, data TEXT);
    `);
    const t = Date.UTC(2026, 9, 21);
    db.prepare("INSERT INTO session_v2 VALUES ('ses_1', NULL, ?, 'Заметки', ?, ?)").run(
      machine.projects.pi,
      t,
      t,
    );
    const add = db.prepare("INSERT INTO session_message VALUES (?, 'ses_1', ?, ?, ?, ?)");
    add.run("m0", "user", 0, t, JSON.stringify({ text: "Собери заметки в файл" }));
    add.run(
      "m1",
      "assistant",
      1,
      t,
      JSON.stringify({ content: [{ type: "text", text: "Собрал." }] }),
    );
    // another chat in the same database changes the file, not this chat's version
    db.prepare("INSERT INTO session_v2 VALUES ('ses_2', NULL, ?, 'Другое', ?, ?)").run(
      machine.projects.pi,
      t,
      t,
    );

    const scan = await scanSources({ roots: machine.roots, ledger: emptyLedger(), now: NOW });
    const chat = scan.candidates.filter((c) => c.tool === "opencode");
    expect(chat.map((c) => c.sourceId)).toEqual(["ses_1"]);
    const first = await importChats({ ...options, candidates: chat });
    expect(first[0]).toMatchObject({ status: "imported", title: "Заметки" });
    const entry = (await readLedger(machine.ledgerPath)).entries.at(-1)!;
    expect(entry).toMatchObject({
      tool: "opencode",
      sourceId: "ses_1",
      sha256: `opencode:v2:${t}:2`,
    });

    db.prepare("INSERT INTO session_message VALUES ('m2', 'ses_2', 'user', 0, ?, ?)").run(
      t,
      JSON.stringify({ text: "другой чат" }),
    );
    const again = await scanSources({
      roots: machine.roots,
      ledger: await readLedger(machine.ledgerPath),
      now: NOW,
    });
    expect(again.candidates.find((c) => c.sourceId === "ses_1")?.alreadyImported).toBe(true);
    expect((await importChats({ ...options, candidates: chat }))[0]).toMatchObject({
      reason: "already",
    });

    // the chat itself goes on: a new version is offered and brought over as a new chat
    add.run("m3", "user", 3, t + 1000, JSON.stringify({ text: "Добавь оглавление" }));
    db.prepare("UPDATE session_v2 SET time_updated = ? WHERE id = 'ses_1'").run(t + 1000);
    db.close();
    const changed = await scanSources({
      roots: machine.roots,
      ledger: await readLedger(machine.ledgerPath),
      now: NOW,
    });
    const next = changed.candidates.filter((c) => c.sourceId === "ses_1");
    expect(next[0]?.alreadyImported).toBeUndefined();
    expect((await importChats({ ...options, candidates: next }))[0]).toMatchObject({
      status: "imported",
    });
  });
});
