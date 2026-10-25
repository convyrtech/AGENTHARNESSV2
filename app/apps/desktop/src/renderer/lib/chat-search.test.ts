import type { ChatSearchResult } from "@zeno/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  chatResultSnippet,
  chatResultTitle,
  searchChats,
  shouldSearchChats,
} from "./chat-search.ts";

const result: ChatSearchResult = {
  path: "/a.jsonl",
  cwd: "/p",
  title: "",
  updatedAt: 1,
  matchCount: 1,
  matches: [{ role: "user", snippet: "…бот для доставки…" }],
};

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("chat search in the palette", () => {
  it("waits for two letters", () => {
    expect(shouldSearchChats(" д ")).toBe(false);
    expect(shouldSearchChats("до")).toBe(true);
  });

  it("reads a result", () => {
    expect(chatResultTitle("ru", result)).toBe("Чат без названия");
    expect(chatResultTitle("ru", { ...result, title: "Бот доставки" })).toBe("Бот доставки");
    expect(chatResultSnippet(result)).toBe("…бот для доставки…");
    expect(chatResultSnippet({ ...result, matches: [] })).toBe("");
    expect(
      chatResultSnippet({
        ...result,
        title: "Сделай бота",
        matches: [{ role: "user", snippet: "Сделай бота" }],
      }),
    ).toBe("");
  });

  it("asks main with the trimmed query; a failure is no results", async () => {
    const search = vi.fn().mockResolvedValue([result]);
    (globalThis as { window?: unknown }).window = { zeno: { features: { searchChats: search } } };
    expect(await searchChats("  доставк ")).toEqual([result]);
    expect(search).toHaveBeenCalledWith("доставк");
    expect(await searchChats("д")).toEqual([]);
    search.mockRejectedValue(new Error("ipc"));
    expect(await searchChats("доставк")).toEqual([]);
  });
});
