/**
 * OpenCode: synthetic databases built here with node:sqlite (never a real one in the repo), in a
 * folder with a Cyrillic name, chats about Windows project folders. Both known schemas, an unknown
 * one, a broken file, and a database another process holds open in WAL mode.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  opencodeCandidates,
  opencodeDatabases,
  readOpenCodeChat,
  releaseOpenCodeSnapshots,
} from "../src/adapters/opencode.ts";
import { sha256File } from "../src/read-lines.ts";
import { scanSources } from "../src/detect.ts";
import { emptyLedger } from "../src/ledger.ts";
import { importChats } from "../src/run.ts";
import { fakeMachine } from "./helpers.ts";
import { cleanTemp, tempDir } from "./helpers.ts";

const CWD = "C:\\Users\\Пётр\\Проекты\\заметки";
const T0 = Date.UTC(2026, 9, 20, 9, 0);

afterEach(async () => {
  releaseOpenCodeSnapshots();
  await cleanTemp();
});

type Row = { type: string; data: object; at: number };

/** The current schema (session_v2 + session_message), only the columns the adapter reads. */
function createV2(path: string, cwd = CWD, keepOpen = false) {
  const db = new DatabaseSync(path);
  if (keepOpen) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
      directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const session = db.prepare(
    "INSERT INTO session_v2 VALUES (?, 'prj', ?, 'slug', ?, ?, '1.0', ?, ?, NULL)",
  );
  const message = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  const add = (sessionId: string, rows: Row[]) =>
    rows.forEach((row, seq) =>
      message.run(
        `msg_${sessionId}_${seq}`,
        sessionId,
        row.type,
        seq,
        row.at,
        row.at,
        JSON.stringify(row.data),
      ),
    );
  session.run("ses_main", null, cwd, "Бот для заказов", T0, T0 + 60_000);
  add("ses_main", [
    { type: "user", data: { text: "Сделай бота для заказов", time: { created: T0 } }, at: T0 },
    { type: "model-switched", data: { model: { id: "x", providerID: "y" } }, at: T0 },
    {
      type: "assistant",
      at: T0 + 10_000,
      data: {
        agent: "build",
        model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
        content: [
          { type: "reasoning", text: "думаю" },
          { type: "text", text: "Создаю bot.py." },
          {
            type: "tool",
            id: "t1",
            name: "write",
            state: {
              status: "completed",
              input: { filePath: "bot.py", path: `${cwd}\\bot.py` },
              content: [{ type: "text", text: "ok" }],
            },
            time: { created: T0 },
          },
          {
            type: "tool",
            id: "t2",
            name: "bash",
            state: {
              status: "error",
              input: { command: "python bot.py" },
              error: { message: "ModuleNotFoundError: aiogram" },
            },
            time: { created: T0 },
          },
        ],
      },
    },
    { type: "synthetic", data: { text: "служебное" }, at: T0 + 20_000 },
    {
      type: "compaction",
      data: { status: "completed", reason: "auto", summary: "Сделан бот, нужен aiogram." },
      at: T0 + 30_000,
    },
    {
      type: "user",
      data: {
        text: "Поставь aiogram, ключ API_KEY=abcdefgh12345678",
        files: [{ mime: "image/png" }],
      },
      at: T0 + 40_000,
    },
    {
      type: "assistant",
      data: { model: { id: "claude-sonnet-4-5" }, content: [{ type: "text", text: "Поставил." }] },
      at: T0 + 50_000,
    },
  ]);
  // a placeholder title: the first request names the chat
  session.run("ses_second", null, cwd, "New session - 2026-10-20T09:00:00.000Z", T0, T0 + 1000);
  add("ses_second", [{ type: "user", data: { text: "Почини вёрстку" }, at: T0 }]);
  // a subagent's chat and an empty one are not offered
  session.run("ses_child", "ses_main", cwd, "подзадача", T0, T0);
  add("ses_child", [{ type: "user", data: { text: "подзадача" }, at: T0 }]);
  session.run("ses_empty", null, cwd, "пусто", T0, T0);
  if (!keepOpen) db.close();
  return db;
}

function createLegacy(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES ('ses_old', 'p', NULL, ?, 'Старый чат', ?, ?)").run(
    CWD,
    T0,
    T0 + 5000,
  );
  const message = db.prepare("INSERT INTO message VALUES (?, 'ses_old', ?, ?, ?)");
  const part = db.prepare("INSERT INTO part VALUES (?, ?, 'ses_old', ?, ?)");
  message.run("m1", T0, T0, JSON.stringify({ role: "user", time: { created: T0 } }));
  part.run("p1", "m1", T0, JSON.stringify({ type: "text", text: "Сделай лендинг" }));
  part.run(
    "p2",
    "m1",
    T0,
    JSON.stringify({ type: "text", text: "<file>вставлено</file>", synthetic: true }),
  );
  part.run(
    "p3",
    "m1",
    T0,
    JSON.stringify({ type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }),
  );
  message.run(
    "m2",
    T0 + 1000,
    T0 + 1000,
    JSON.stringify({ role: "assistant", modelID: "gpt-5", providerID: "openai" }),
  );
  part.run("p4", "m2", T0, JSON.stringify({ type: "reasoning", text: "хм" }));
  part.run("p5", "m2", T0, JSON.stringify({ type: "text", text: "Готово: index.html" }));
  part.run(
    "p6",
    "m2",
    T0,
    JSON.stringify({
      type: "tool",
      tool: "edit",
      state: { status: "completed", input: { filePath: "index.html" }, output: "ok" },
    }),
  );
  db.close();
}

describe("OpenCode adapter", () => {
  it("finds opencode.db and channel databases, or the one OPENCODE_DB names", async () => {
    const dir = join(await tempDir(), "данные", "opencode");
    await mkdir(dir, { recursive: true });
    for (const name of ["opencode.db", "opencode-beta.db", "other.db", "opencode.db-wal"]) {
      await writeFile(join(dir, name), "");
    }
    expect(
      opencodeDatabases({ opencodeData: dir })
        .map((p) => p.slice(dir.length + 1))
        .sort(),
    ).toEqual(["opencode-beta.db", "opencode.db"]);
    expect(opencodeDatabases({ opencodeData: dir, opencodeDb: join(dir, "other.db") })).toEqual([
      join(dir, "other.db"),
    ]);
    expect(opencodeDatabases({ opencodeData: join(dir, "нет") })).toEqual([]);
  });

  it("lists top-level chats of the current schema with a per-chat version", async () => {
    const db = join(await tempDir(), "Пётр", "opencode.db");
    await mkdir(join(db, ".."), { recursive: true });
    createV2(db);
    const { candidates, skip } = opencodeCandidates(db);
    expect(skip).toBeUndefined();
    expect(
      candidates
        .map((c) => [c.sourceId, c.title, c.size])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["ses_main", "Бот для заказов", 7],
      ["ses_second", "Почини вёрстку", 1],
    ]);
    const main = candidates.find((c) => c.sourceId === "ses_main")!;
    expect(main).toMatchObject({ cwd: CWD, updatedAt: T0 + 60_000, mtimeMs: T0 + 60_000 });
    expect(main.fingerprint).toBe(`opencode:v2:${T0 + 60_000}:7`);
  });

  it("brings over text and tool notes, leaves thinking and service messages, hides secrets", async () => {
    const db = join(await tempDir(), "Пётр", "opencode.db");
    await mkdir(join(db, ".."), { recursive: true });
    createV2(db);
    const chat = readOpenCodeChat(db, "ses_main");
    expect(chat?.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Сделай бота для заказов"],
      [
        "assistant",
        `Создаю bot.py.\n• write: ${CWD}\\bot.py\n• bash: python bot.py\n• ошибка инструмента: ModuleNotFoundError: aiogram\n(OpenCode сократил разговор)\nСделан бот, нужен aiogram.`,
      ],
      ["user", "Поставь aiogram, ключ API_KEY=[СКРЫТО: секрет]\n[картинка не перенесена]"],
      ["assistant", "Поставил."],
    ]);
    expect(chat).toMatchObject({
      tool: "opencode",
      cwd: CWD,
      title: "Бот для заказов",
      model: "claude-sonnet-4-5",
      secrets: 1,
    });
    expect(chat?.dropped).toMatchObject({ thinking: 1, toolResults: 2, images: 1, service: 2 });
    expect(chat?.files).toEqual([`${CWD}\\bot.py`]);
  });

  it("reads the older session / message / part schema", async () => {
    const db = join(await tempDir(), "старый", "opencode.db");
    await mkdir(join(db, ".."), { recursive: true });
    createLegacy(db);
    const { candidates } = opencodeCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceId: "ses_old",
      title: "Старый чат",
      cwd: CWD,
      size: 2,
    });
    expect(candidates[0]!.fingerprint).toContain("opencode:legacy:");
    const chat = readOpenCodeChat(db, "ses_old");
    expect(chat?.turns.map((t) => t.text)).toEqual([
      "Сделай лендинг\n[картинка не перенесена]",
      "Готово: index.html\n• edit",
    ]);
    expect(chat?.model).toBe("gpt-5");
    expect(chat?.dropped).toMatchObject({ thinking: 1, images: 1, service: 1, toolResults: 1 });
  });

  it("skips an unknown schema or a broken file with a reason instead of failing", async () => {
    const dir = await tempDir();
    const unknown = join(dir, "opencode.db");
    const other = new DatabaseSync(unknown);
    other.exec("CREATE TABLE session_v3 (id TEXT); CREATE TABLE something (x TEXT)");
    other.close();
    expect(opencodeCandidates(unknown)).toEqual({
      candidates: [],
      skip: { tool: "opencode", path: unknown, reason: "unknown-schema" },
    });
    const broken = join(dir, "opencode-broken.db");
    await writeFile(broken, "это не база данных".repeat(100));
    expect(opencodeCandidates(broken).skip).toEqual({
      tool: "opencode",
      path: broken,
      reason: "unreadable",
    });
  });

  it("reads rows still in the WAL of a database another process holds open, and never changes it", async () => {
    const db = join(await tempDir(), "Пётр", "opencode.db");
    await mkdir(join(db, ".."), { recursive: true });
    const live = createV2(db, CWD, true);
    try {
      expect(existsSync(`${db}-wal`)).toBe(true);
      const before = await Promise.all([sha256File(db), sha256File(`${db}-wal`)]);
      const { candidates } = opencodeCandidates(db);
      expect(candidates.map((c) => c.sourceId).sort()).toEqual(["ses_main", "ses_second"]);
      expect(readOpenCodeChat(db, "ses_main")?.turns).toHaveLength(4);
      releaseOpenCodeSnapshots();
      expect(await Promise.all([sha256File(db), sha256File(`${db}-wal`)])).toEqual(before);
    } finally {
      live.close();
    }
  });

  it("reads the Kilo CLI database (OpenCode's schema) as Kilo Code", async () => {
    const machine = await fakeMachine();
    const kiloDb = join(machine.root, "данные", "kilo", "kilo.db");
    await mkdir(join(kiloDb, ".."), { recursive: true });
    createV2(kiloDb, machine.projects.codex);
    const roots = { ...machine.roots, kiloDb };
    const scan = await scanSources({ roots, ledger: emptyLedger(), now: Date.UTC(2026, 9, 25) });
    const kilo = scan.candidates.filter((c) => c.tool === "kilo-code");
    expect(kilo.map((c) => c.title).sort((a, b) => a.localeCompare(b))).toEqual([
      "Бот для заказов",
      "Почини вёрстку",
    ]);
    expect(kilo[0]!.fingerprint).toMatch(/^kilo-code:v2:/u);
    const main = kilo.find((c) => c.sourceId === "ses_main")!;
    const [result] = await importChats({
      candidates: [main],
      roots,
      home: machine.home,
      sessionDir: machine.sessionDir,
      ledgerPath: machine.ledgerPath,
      target: { provider: "prsloy", modelId: "m" },
    });
    expect(result).toMatchObject({ status: "imported", title: "Бот для заказов" });
    expect(readOpenCodeChat(kiloDb, "ses_main", "kilo-code")?.turns[1]?.text).toContain(
      "(Kilo Code сократил разговор)",
    );
  });
});
