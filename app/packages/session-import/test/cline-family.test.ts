/**
 * Cline, Roo Code and Kilo Code: a synthetic editor profile built here (never real tasks), in a
 * Cyrillic home folder, tasks about Windows project folders. Each index layout: Cline's
 * state/taskHistory.json, Roo's tasks/_index.json, Kilo's row in VS Code's state.vscdb, and the
 * newer ~/.cline/data.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  clineCandidate,
  clineTasks,
  readClineChat,
  replyText,
  unwrapUserText,
} from "../src/adapters/cline-family.ts";
import { scanSources } from "../src/detect.ts";
import { emptyLedger } from "../src/ledger.ts";
import { importChats } from "../src/run.ts";
import { emptyDropped } from "../src/types.ts";
import { cleanTemp, fakeMachine, tempDir } from "./helpers.ts";

afterEach(cleanTemp);

const SITE = "C:\\Users\\Пётр\\Проекты\\сайт";
const BOT = "C:\\Users\\Пётр\\Проекты\\бот";
const T = Date.UTC(2026, 9, 20, 12);

const clineHistory = [
  {
    role: "user",
    content: [
      { type: "text", text: "<task>\nСделай лендинг для студии йоги\n</task>" },
      {
        type: "text",
        text: "<environment_details>\n# VSCode Visible Files\nindex.html\n</environment_details>",
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "<thinking>план</thinking>\nСоздаю страницу.\n<write_to_file>\n<path>index.html</path>\n<content>\n<html></html>\n</content>\n</write_to_file>",
      },
    ],
  },
  {
    role: "user",
    content: [
      { type: "text", text: "[write_to_file for 'index.html'] Result:" },
      { type: "text", text: "The content was successfully saved to index.html." },
      { type: "text", text: "<environment_details>\n...\n</environment_details>" },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "<ask_followup_question>\n<question>Какие цвета?</question>\n</ask_followup_question>",
      },
    ],
  },
  {
    role: "user",
    content: [
      { type: "text", text: "[ask_followup_question for 'Какие цвета?'] Result:" },
      { type: "text", text: "<answer>\nЗелёный и белый, ключ API_KEY=abcdefgh12345678\n</answer>" },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "<attempt_completion>\n<result>Готово: зелёно-белый лендинг.</result>\n</attempt_completion>",
      },
    ],
  },
];

const rooHistory = [
  { role: "user", content: [{ type: "text", text: "<task>Напиши бота для записи</task>" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Пишу bot.py." },
      {
        type: "tool_use",
        id: "t1",
        name: "execute_command",
        input: { command: "pip install aiogram" },
      },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "t1", content: "Successfully installed" },
      { type: "text", text: "<user_message>\nДобавь отмену записи\n</user_message>" },
    ],
  },
  { role: "assistant", content: "Добавил /cancel." },
];

async function profile(home: string, cwds = { site: SITE, bot: BOT }) {
  const editorData = join(home, "AppData", "Roaming");
  const storage = join(editorData, "Code", "User", "globalStorage");
  // Cline: state/taskHistory.json
  const cline = join(storage, "saoudrizwan.claude-dev");
  await mkdir(join(cline, "state"), { recursive: true });
  await mkdir(join(cline, "tasks", "1729000000001"), { recursive: true });
  await writeFile(
    join(cline, "tasks", "1729000000001", "api_conversation_history.json"),
    JSON.stringify(clineHistory),
  );
  await writeFile(
    join(cline, "state", "taskHistory.json"),
    JSON.stringify([
      {
        id: "1729000000001",
        ts: T,
        task: "Сделай лендинг для студии йоги",
        cwdOnTaskInitialization: cwds.site,
      },
    ]),
  );
  // a task the index does not know: no project, not offered
  await mkdir(join(cline, "tasks", "1729000000002"), { recursive: true });
  await writeFile(
    join(cline, "tasks", "1729000000002", "api_conversation_history.json"),
    JSON.stringify(clineHistory),
  );
  // Roo Code in Cursor: tasks/_index.json with `workspace`
  const roo = join(editorData, "Cursor", "User", "globalStorage", "rooveterinaryinc.roo-cline");
  await mkdir(join(roo, "tasks", "roo-1"), { recursive: true });
  await writeFile(
    join(roo, "tasks", "roo-1", "api_conversation_history.json"),
    JSON.stringify(rooHistory),
  );
  await writeFile(
    join(roo, "tasks", "_index.json"),
    JSON.stringify({
      entries: [{ id: "roo-1", ts: T + 1000, task: "Напиши бота для записи", workspace: cwds.bot }],
    }),
  );
  // Kilo Code: the index only in VS Code's state.vscdb
  const kilo = join(storage, "kilocode.kilo-code");
  await mkdir(join(kilo, "tasks", "kilo-1"), { recursive: true });
  await writeFile(
    join(kilo, "tasks", "kilo-1", "api_conversation_history.json"),
    JSON.stringify(rooHistory),
  );
  const db = new DatabaseSync(join(storage, "state.vscdb"));
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(
    "kilocode.kilo-code",
    JSON.stringify({
      taskHistory: [{ id: "kilo-1", ts: T + 2000, task: "Бот на Kilo", workspace: cwds.bot }],
    }),
  );
  db.close();
  return { editorData, clineData: join(home, ".cline", "data") };
}

describe("Cline family adapter", () => {
  it("takes the person's words out of Cline's wrappers", () => {
    expect(
      unwrapUserText("<task>\nСделай сайт\n</task>\n<environment_details>x</environment_details>"),
    ).toBe("Сделай сайт");
    expect(unwrapUserText("<feedback>Поменяй цвет</feedback>")).toBe("Поменяй цвет");
    expect(unwrapUserText("обычный текст <environment_details>x</environment_details>")).toBe(
      "обычный текст",
    );
  });

  it("turns XML tool calls of older replies into notes, keeping questions and results", () => {
    const files = new Set<string>();
    const dropped = emptyDropped();
    expect(
      replyText(
        "<thinking>x</thinking>Делаю.\n<execute_command>\n<command>npm test</command>\n</execute_command>\n<attempt_completion><result>Готово.</result></attempt_completion>",
        files,
        dropped,
      ),
    ).toBe("Делаю.\n• execute_command: npm test\nГотово.");
    expect(dropped.thinking).toBe(1);
  });

  it("finds tasks of Cline, Roo and Kilo in every editor, with their project folders", async () => {
    const home = join(await tempDir(), "Пётр");
    const roots = await profile(home);
    const tasks = clineTasks(roots);
    expect(
      tasks
        .map((t) => [t.tool, t.id, t.cwd])
        .sort((a, b) => String(a.slice(0, 2)).localeCompare(String(b.slice(0, 2)))),
    ).toEqual([
      ["cline", "1729000000001", SITE],
      ["cline", "1729000000002", undefined],
      ["kilo-code", "kilo-1", BOT],
      ["roo-code", "roo-1", BOT],
    ]);
    const candidates = (await Promise.all(tasks.map(clineCandidate))).filter(
      (c) => c !== undefined,
    );
    expect(candidates.map((c) => c.title).sort((a, b) => a.localeCompare(b))).toEqual([
      "Бот на Kilo",
      "Напиши бота для записи",
      "Сделай лендинг для студии йоги",
    ]);
    expect(clineTasks({ editorData: join(home, "нет"), clineData: join(home, "нет") })).toEqual([]);
  });

  it("reads a Cline task: requests, answers, results; tool output and environment left", async () => {
    const home = join(await tempDir(), "Пётр");
    const roots = await profile(home);
    const task = clineTasks(roots).find((t) => t.id === "1729000000001")!;
    const chat = await readClineChat(task, SITE);
    expect(chat?.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Сделай лендинг для студии йоги"],
      ["assistant", "Создаю страницу.\n• write_to_file: index.html\nКакие цвета?"],
      ["user", "Зелёный и белый, ключ API_KEY=[СКРЫТО: секрет]"],
      ["assistant", "Готово: зелёно-белый лендинг."],
    ]);
    expect(chat).toMatchObject({
      tool: "cline",
      title: "Сделай лендинг для студии йоги",
      secrets: 1,
    });
    expect(chat?.dropped).toMatchObject({ thinking: 1, toolResults: 2 });
  });

  it("reads a Roo task with structured tool calls and a message inside a tool result", async () => {
    const home = join(await tempDir(), "Пётр");
    const roots = await profile(home);
    const task = clineTasks(roots).find((t) => t.id === "roo-1")!;
    const chat = await readClineChat(task, BOT);
    expect(chat?.turns.map((t) => t.text)).toEqual([
      "Напиши бота для записи",
      "Пишу bot.py.\n• execute_command: pip install aiogram",
      "Добавь отмену записи",
      "Добавил /cancel.",
    ]);
    expect(chat?.dropped.toolResults).toBe(1);
  });

  it("prefers the newer copy of a task migrated into ~/.cline/data", async () => {
    const home = join(await tempDir(), "Пётр");
    const roots = await profile(home);
    const dir = join(roots.clineData, "tasks", "1729000000001");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "api_conversation_history.json"), JSON.stringify(clineHistory));
    await writeFile(
      join(roots.clineData, "tasks", "taskHistory.json"),
      JSON.stringify([
        {
          id: "1729000000001",
          ts: T,
          task: "Сделай лендинг для студии йоги",
          cwdOnTaskInitialization: SITE,
        },
      ]),
    );
    const later = new Date(Date.now() + 60_000);
    await utimes(join(dir, "api_conversation_history.json"), later, later);
    const copies = clineTasks(roots).filter((t) => t.id === "1729000000001");
    expect(copies).toHaveLength(1);
    expect(copies[0]!.path.startsWith(roots.clineData)).toBe(true);
  });

  it("goes through scan and run into its real project folder", async () => {
    const machine = await fakeMachine();
    await profile(machine.home, { site: machine.projects.claude, bot: machine.projects.codex });
    const scan = await scanSources({
      roots: machine.roots,
      ledger: emptyLedger(),
      now: Date.UTC(2026, 9, 25),
    });
    expect(scan.counts).toMatchObject({
      cline: { chats: 1 },
      "roo-code": { chats: 1 },
      "kilo-code": { chats: 1 },
    });
    const family = scan.candidates.filter((c) =>
      ["cline", "roo-code", "kilo-code"].includes(c.tool),
    );
    const results = await importChats({
      candidates: family,
      roots: machine.roots,
      home: machine.home,
      sessionDir: machine.sessionDir,
      ledgerPath: machine.ledgerPath,
      target: { provider: "prsloy", modelId: "m" },
    });
    expect(results.map((r) => r.status)).toEqual(["imported", "imported", "imported"]);
  });
});
