import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  buildSnippet,
  fold,
  normalizeQueryTerms,
  resetChatSearchCaches,
  searchChats,
  stripAttachedPaths,
} from "./session-search.ts";

const line = (value: unknown) => JSON.stringify(value);
const message = (role: string, text: string) =>
  line({ type: "message", message: { role, content: [{ type: "text", text }] } });

function agentDir() {
  const dir = mkdtempSync(join(tmpdir(), "features-search-"));
  const write = (folder: string, file: string, lines: string[], mtime: number) => {
    mkdirSync(join(dir, "sessions", folder), { recursive: true });
    const path = join(dir, "sessions", folder, file);
    writeFileSync(path, `${lines.join("\n")}\n`);
    utimesSync(path, mtime, mtime);
    return path;
  };
  const delivery = write(
    "--home-u-bot--",
    "a.jsonl",
    [
      line({ type: "session", id: "11111111-1111-4111-8111-111111111111", cwd: "/home/u/bot" }),
      message(
        "user",
        "Сделай бота для доставки ёлок\n\n<attached-paths>\n<path>/tmp/секрет-доставки.png</path>\n</attached-paths>",
      ),
      line({ type: "message", message: { role: "toolResult", content: "доставка доставка" } }),
      message("assistant", "Готово: бот принимает заказы на доставку елок по городу."),
    ],
    1_700_000_000,
  );
  const site = write(
    "--home-u-site--",
    "b.jsonl",
    [
      line({ type: "session", id: "22222222-2222-4222-8222-222222222222", cwd: "/home/u/site" }),
      line({ type: "session_info", name: "Сайт кофейни" }),
      message("user", "Сделай сайт для кофейни, доставка не нужна"),
    ],
    1_800_000_000,
  );
  write("--broken--", "c.jsonl", ["не json", line({ type: "message" })], 1_600_000_000);
  // A plain conversation sits right in sessions/, with pi's time-ordered id.
  const talk = write(
    "",
    "2026-10-25T10-26-47Z_01a17299-3aed-754a-9861-1bb366ea86bb.jsonl",
    [
      line({ type: "session", id: "01a17299-3aed-754a-9861-1bb366ea86bb", cwd: "/home/u/chats" }),
      message("user", "Как сварить кофе в турке"),
    ],
    1_750_000_000,
  );
  return { dir, delivery, site, talk };
}

beforeEach(resetChatSearchCaches);

describe("chat search", () => {
  it("finds chats where every word occurs, «ё» as «е», newest first", async () => {
    const { dir, delivery, site } = agentDir();
    const found = await searchChats({ agentDir: dir, query: "доставк" });
    expect(found.map((r) => r.path)).toEqual([site, delivery]);
    expect(found[1]).toMatchObject({
      cwd: "/home/u/bot",
      title: "Сделай бота для доставки ёлок",
      matchCount: 2,
    });
    expect(found[0]?.title).toBe("Сайт кофейни");
    const tree = await searchChats({ agentDir: dir, query: "ЕЛОК доставк" });
    expect(tree.map((r) => r.path)).toEqual([delivery]);
    expect(tree[0]?.matches.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("does not search attached file names, tool output or nothing", async () => {
    const { dir } = agentDir();
    expect(await searchChats({ agentDir: dir, query: "секрет" })).toEqual([]);
    expect(await searchChats({ agentDir: dir, query: "   " })).toEqual([]);
    expect(await searchChats({ agentDir: join(dir, "нет"), query: "сайт" })).toEqual([]);
  });

  it("finds plain conversations right in sessions/", async () => {
    const { dir, talk } = agentDir();
    expect((await searchChats({ agentDir: dir, query: "турке" })).map((r) => r.path)).toEqual([
      talk,
    ]);
  });

  it("finds a chat by its name", async () => {
    const { dir, site } = agentDir();
    expect((await searchChats({ agentDir: dir, query: "кофейни" })).map((r) => r.path)).toEqual([
      site,
    ]);
  });
});

describe("helpers", () => {
  it("fold, terms, snippet, attached paths", () => {
    expect(fold("Ёлка ЁЖ")).toBe("елка еж");
    expect(normalizeQueryTerms("  Бот  бот доставка ")).toEqual(["бот", "доставка"]);
    const long = `${"а ".repeat(60)}нужное место ${"б ".repeat(100)}`;
    const snippet = buildSnippet(long, "нужное");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("нужное место");
    expect(stripAttachedPaths("текст\n<attached-paths><path>/a</path></attached-paths>")).toBe(
      "текст",
    );
  });
});
