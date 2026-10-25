import { afterEach, describe, expect, it } from "vite-plus/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  codexCandidate,
  codexFiles,
  codexTitles,
  readCodexChat,
  richestPerChat,
} from "../src/adapters/codex.ts";
import {
  cleanTemp,
  CODEX_FIRST,
  CODEX_ID,
  CODEX_RESUMED,
  FIXTURES,
  tempDir,
  WINDOWS_CWD,
} from "./helpers.ts";

afterEach(cleanTemp);
const HOME = join(FIXTURES, "codex");

describe("Codex adapter", () => {
  it("finds rollouts and titles from the index", async () => {
    expect(await codexFiles(HOME)).toHaveLength(2);
    expect((await codexTitles(HOME)).get(CODEX_ID)).toBe("Телеграм-бот для заказов");
    expect((await codexTitles(join(HOME, "нет"))).size).toBe(0);
  });

  it("keeps the richest of the files a resumed chat left", async () => {
    const titles = await codexTitles(HOME);
    const candidates = await Promise.all(
      (await codexFiles(HOME)).map((f) => codexCandidate(f, titles)),
    );
    const best = richestPerChat(candidates.filter((c) => c !== undefined));
    expect(best).toHaveLength(1);
    expect(best[0]).toMatchObject({
      sourcePath: CODEX_RESUMED,
      cwd: WINDOWS_CWD.codex,
      title: "Телеграм-бот для заказов",
    });
  });

  it("takes the person's words from user_message, not the injected context", async () => {
    const chat = await readCodexChat(CODEX_FIRST);
    expect(chat?.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "Напиши телеграм-бота для заказов"],
      [
        "assistant",
        "• shell: bash -lc pip install aiogram\n• apply_patch: *** Begin Patch *** Add File: bot.py *** End Patch\nБот готов, файл bot.py.",
      ],
    ]);
    expect(chat?.model).toBe("gpt-5-codex");
    expect(chat?.title).toBe("Напиши телеграм-бота для заказов");
    expect(chat?.dropped).toMatchObject({ thinking: 1, toolResults: 2, service: 2 });
  });

  it("keeps Codex's own compaction as a note and continues after it", async () => {
    const chat = await readCodexChat(CODEX_RESUMED, await codexTitles(HOME));
    expect(chat?.title).toBe("Телеграм-бот для заказов");
    expect(chat?.turns.slice(-2).map((t) => t.text)).toEqual([
      "Добавь команду /cancel",
      "Добавил /cancel.",
    ]);
    expect(chat?.turns.at(-3)?.text).toContain(
      "\n(Codex сократил разговор)\nСделан бот на aiogram",
    );
  });

  it("reads a .jsonl.zst rollout the same way", async () => {
    const dir = await tempDir();
    const zst = join(dir, `rollout-old-${CODEX_ID}.jsonl.zst`);
    await writeFile(zst, zstdCompressSync(await readFile(CODEX_FIRST)));
    const plain = await readCodexChat(CODEX_FIRST);
    const packed = await readCodexChat(zst);
    expect(packed?.turns).toEqual(plain?.turns);
    expect((await codexCandidate(zst, new Map()))?.cwd).toBe(WINDOWS_CWD.codex);
  });

  it("uses user-role items when an old file has no user_message", async () => {
    const dir = await tempDir();
    const file = join(dir, "rollout-x.jsonl");
    const lines = [
      { type: "session_meta", payload: { id: "x", cwd: "/p" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<user_instructions>x</user_instructions>" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "старый формат" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ок" }],
        },
      },
    ];
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    const chat = await readCodexChat(file);
    expect(chat?.turns.map((t) => t.text)).toEqual(["старый формат", "ок"]);
  });

  it("returns nothing for a file with no session id or no request", async () => {
    const dir = await tempDir();
    const file = join(dir, "rollout-empty.jsonl");
    await writeFile(
      file,
      JSON.stringify({ type: "session_meta", payload: { id: "e", cwd: "/p" } }),
    );
    expect(await readCodexChat(file)).toBeUndefined();
    await writeFile(file, JSON.stringify({ type: "turn_context", payload: { cwd: "/p" } }));
    expect(await codexCandidate(file, new Map())).toBeUndefined();
  });
});
