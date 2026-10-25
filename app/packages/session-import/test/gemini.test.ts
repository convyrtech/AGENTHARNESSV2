import { afterEach, describe, expect, it } from "vite-plus/test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  geminiCandidate,
  geminiChatFiles,
  newestGeminiFile,
  readGeminiChat,
  replayGeminiChat,
} from "../src/adapters/gemini.ts";
import { scanSources } from "../src/detect.ts";
import { emptyLedger, readLedger } from "../src/ledger.ts";
import { sha256File } from "../src/read-lines.ts";
import { importChats } from "../src/run.ts";
import { cleanTemp, FIXTURES, fakeMachine } from "./helpers.ts";

afterEach(cleanTemp);

const GEMINI = join(FIXTURES, "gemini", ".gemini");
const LANDING = "c:\\users\\пётр\\проекты\\лендинг";
const NOTES = "C:\\Users\\Пётр\\Проекты\\заметки";
const MAIN = join(GEMINI, "tmp", "lending", "chats", "session-2026-10-22T10-00-8f1e2d3c.jsonl");

describe("Gemini CLI adapter", () => {
  it("finds chats and their project folders from .project_root and projects.json", () => {
    const files = geminiChatFiles({ geminiDir: GEMINI });
    const byFolder = new Map(files.map((f) => [f.path.split(/[\\/]/u).at(-3), f.cwd]));
    expect(byFolder.get("lending")).toBe(LANDING);
    expect(byFolder.get("zametki")).toBe(NOTES);
    // an old folder named by the sha256 of the project path
    expect([...byFolder.entries()].find(([k]) => k?.length === 64)?.[1]).toBe(
      "c:\\users\\пётр\\проекты\\бот",
    );
    expect(byFolder.get("unknown")).toBeUndefined();
    expect(files).toHaveLength(6);
    expect(geminiChatFiles({ geminiDir: join(GEMINI, "нет") })).toEqual([]);
  });

  it("replays the log: rewinds drop a branch, patches change messages in place", async () => {
    const conversation = await replayGeminiChat(MAIN);
    expect(conversation?.messages.map((m) => m.id)).toEqual([
      "u1",
      "g1",
      "i1",
      "u3",
      "g3",
      "u4",
      "u5",
    ]);
    expect(conversation?.meta).toMatchObject({
      summary: "Лендинг кофейни",
      lastUpdated: "2026-10-22T10:02:00.000Z",
    });
    expect(conversation?.broken).toBe(1);
  });

  it("brings over text, tool notes and failed-tool errors; leaves thoughts, info and commands", async () => {
    const chat = await readGeminiChat(MAIN, LANDING);
    expect(chat?.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Сделай лендинг для кофейни"],
      [
        "assistant",
        `Начинаю.\n• WriteFile: ${NOTES}\\index.html\n• Shell: npm run build\n• ошибка инструмента: npm ERR! missing script: build`,
      ],
      ["user", "Сделай фон бежевым"],
      ["assistant", "Бежевый фон готов.\n• replace: style.css"],
      ["user", "Спасибо, вот картинка\n[картинка не перенесена]"],
    ]);
    expect(chat).toMatchObject({
      tool: "gemini",
      title: "Лендинг кофейни",
      model: "gemini-3-pro",
      cwd: LANDING,
    });
    expect(chat?.dropped).toMatchObject({
      thinking: 1,
      toolResults: 2,
      images: 1,
      service: 2,
      brokenLines: 1,
    });
    expect(JSON.stringify(chat)).not.toContain("Красный");
  });

  it("lists one candidate per chat: the .jsonl over a migrated .json, no subagents, no unplaceable folders", async () => {
    const files = geminiChatFiles({ geminiDir: GEMINI });
    const candidates = (await Promise.all(files.map((f) => geminiCandidate(f)))).filter(
      (c) => c !== undefined,
    );
    const chats = newestGeminiFile(candidates);
    expect(chats.map((c) => c.title).sort()).toEqual([
      "Лендинг кофейни",
      "Напиши телеграм-бота",
      "Собери заметки",
    ]);
    expect(chats.find((c) => c.title === "Лендинг кофейни")?.sourcePath.endsWith(".jsonl")).toBe(
      true,
    );
  });

  it("reads an old whole-file .json chat", async () => {
    const files = geminiChatFiles({ geminiDir: GEMINI }).filter((f) =>
      f.path.endsWith("0a1b2c3d.json"),
    );
    const chat = await readGeminiChat(files[0]!.path, files[0]!.cwd!);
    expect(chat?.turns.map((t) => t.text)).toEqual(["Напиши телеграм-бота", "Готово: bot.py"]);
    expect(chat?.model).toBe("gemini-2.5-pro");
  });

  it("goes through scan and run into its real project folder, files untouched", async () => {
    const machine = await fakeMachine();
    await cp(GEMINI, machine.roots.geminiDir, { recursive: true });
    // point the notes project at a real folder here (Cyrillic name kept)
    await writeFile(
      join(machine.roots.geminiDir, "tmp", "zametki", ".project_root"),
      machine.projects.pi,
    );
    const scan = await scanSources({
      roots: machine.roots,
      ledger: emptyLedger(),
      now: Date.UTC(2026, 9, 25),
    });
    expect(scan.counts.gemini).toMatchObject({ chats: 3 });
    const notes = scan.candidates.filter(
      (c) => c.tool === "gemini" && c.title === "Собери заметки",
    );
    const before = await sha256File(notes[0]!.sourcePath);
    const results = await importChats({
      candidates: notes,
      roots: machine.roots,
      home: machine.home,
      sessionDir: machine.sessionDir,
      ledgerPath: machine.ledgerPath,
      target: { provider: "prsloy", modelId: "m" },
    });
    expect(results[0]).toMatchObject({ status: "imported", title: "Собери заметки" });
    expect(await sha256File(notes[0]!.sourcePath)).toBe(before);
    expect((await readLedger(machine.ledgerPath)).entries[0]).toMatchObject({ tool: "gemini" });
    const written = await readFile((results[0] as { piSession: string }).piSession, "utf8");
    expect(written).toContain("Перенесённый чат из Gemini CLI");
    // a chat whose project folder is not on this machine is skipped
    const landing = scan.candidates.filter((c) => c.title === "Лендинг кофейни");
    await mkdir(machine.sessionDir, { recursive: true });
    expect(
      (
        await importChats({
          candidates: landing,
          roots: machine.roots,
          home: machine.home,
          sessionDir: machine.sessionDir,
          ledgerPath: machine.ledgerPath,
          target: { provider: "prsloy", modelId: "m" },
        })
      )[0],
    ).toMatchObject({ status: "skipped", reason: "no-project" });
  });
});
