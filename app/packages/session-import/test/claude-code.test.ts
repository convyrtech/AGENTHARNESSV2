import { afterEach, describe, expect, it } from "vite-plus/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claudeCodeCandidate,
  claudeCodeFiles,
  readClaudeCodeChat,
} from "../src/adapters/claude-code.ts";
import {
  CLAUDE_BASIC,
  CLAUDE_BRANCHES,
  CLAUDE_BROKEN,
  CLAUDE_CONTINUED,
  cleanTemp,
  FIXTURES,
  tempDir,
  WINDOWS_CWD,
} from "./helpers.ts";

afterEach(cleanTemp);

describe("Claude Code adapter", () => {
  it("lists session files and leaves subagent logs out", async () => {
    const files = await claudeCodeFiles(join(FIXTURES, "claude-code", "projects"));
    expect(files).toHaveLength(4);
    expect(files.some((f) => f.includes("subagents"))).toBe(false);
    expect(await claudeCodeFiles(join(FIXTURES, "нет-такой-папки"))).toEqual([]);
  });

  it("takes project, title and time from the file, not the folder name", async () => {
    const candidate = await claudeCodeCandidate(CLAUDE_BASIC);
    expect(candidate).toMatchObject({
      tool: "claude-code",
      sourceId: "5f0c2a8e-1b7d-4c3e-9a61-0d2f8e4b7c10",
      cwd: WINDOWS_CWD.claude,
      title: "Пекарня «Колосок»",
      updatedAt: Date.UTC(2026, 9, 1, 10, 7),
    });
  });

  it("skips a chat that continues in another one", async () => {
    expect(await claudeCodeCandidate(CLAUDE_CONTINUED)).toBeUndefined();
    expect(await readClaudeCodeChat(CLAUDE_CONTINUED)).toBeUndefined();
  });

  it("brings over text, one-line tool notes and a failed tool's error; drops the rest", async () => {
    const chat = await readClaudeCodeChat(CLAUDE_BASIC);
    expect(chat?.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Сделай сайт для пекарни «Колосок»"],
      [
        "assistant",
        `Начну с главной страницы.\n• Write: ${WINDOWS_CWD.claude}\\index.html\n• Bash: npm test\n• ошибка инструмента: npm ERR! missing script: test\nГотово: index.html создан.`,
      ],
      ["user", "Добавь страницу с ценами\n[картинка не перенесена]"],
      ["assistant", "Добавил prices.html."],
    ]);
    expect(chat?.model).toBe("claude-sonnet-4-5");
    expect(chat?.files).toEqual([`${WINDOWS_CWD.claude}\\index.html`]);
    expect(chat?.dropped).toMatchObject({ thinking: 1, toolResults: 2, images: 1, service: 1 });
    expect(chat?.startedAt).toBe(Date.UTC(2026, 9, 1, 10, 0));
  });

  it("follows the active branch after an edit", async () => {
    const chat = await readClaudeCodeChat(CLAUDE_BRANCHES);
    expect(chat?.turns.map((t) => t.text)).toEqual([
      "Какой цвет выбрать для кнопки?",
      "Синий или зелёный.",
      "вариант Б: зелёный",
      "Зелёный, ок.",
    ]);
    expect(chat?.title).toBe("Цвет кнопки");
  });

  it("counts broken and unfinished lines and keeps the rest", async () => {
    const chat = await readClaudeCodeChat(CLAUDE_BROKEN);
    expect(chat?.turns.map((t) => t.text)).toEqual(["Почини вёрстку", "Починил."]);
    expect(chat?.dropped.brokenLines).toBe(2);
    expect(chat?.title).toBe("Почини вёрстку");
  });

  it("hides secrets in the turns and the title", async () => {
    const dir = await tempDir();
    const file = join(dir, "s.jsonl");
    const key = `sk-proj-${"a1".repeat(16)}`;
    const named = `password: ${"x9".repeat(6)}`;
    const lines = [
      {
        type: "user",
        uuid: "1",
        parentUuid: null,
        cwd: "/p",
        message: { role: "user", content: `ключ ${key}` },
      },
      {
        type: "assistant",
        uuid: "2",
        parentUuid: "1",
        cwd: "/p",
        message: {
          id: "m",
          role: "assistant",
          model: "m",
          content: [{ type: "text", text: `запомнил, ${named}` }],
        },
      },
    ];
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    const chat = await readClaudeCodeChat(file);
    const all = JSON.stringify(chat);
    expect(all).not.toContain(key);
    expect(all).not.toContain("x9x9x9");
    expect(chat?.turns[0]?.text).toBe("ключ [СКРЫТО: sk-ключ]");
    expect(chat?.turns[1]?.text).toBe("запомнил, password: [СКРЫТО: секрет]");
    expect(chat?.secrets).toBeGreaterThanOrEqual(3); // two in the turns, one in the title
  });

  it("skips models named like <synthetic> and service lines", async () => {
    const dir = await tempDir();
    const file = join(dir, "syn.jsonl");
    const lines = [
      {
        type: "user",
        uuid: "1",
        parentUuid: null,
        cwd: "/p",
        message: { role: "user", content: "привет" },
      },
      {
        type: "assistant",
        uuid: "2",
        parentUuid: "1",
        cwd: "/p",
        message: {
          id: "m",
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        },
      },
    ];
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    const chat = await readClaudeCodeChat(file);
    expect(chat?.model).toBeUndefined();
  });
});
