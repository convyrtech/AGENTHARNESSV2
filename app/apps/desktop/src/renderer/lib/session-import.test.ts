// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import type { ImportChatSummary, ImportScanResult } from "@zeno/contracts";
import { t } from "./i18n.ts";
import {
  countText,
  expandIfImported,
  IMPORT_MAX_CHATS,
  importKeys,
  importToolRows,
  mergeRecentFolders,
  pluralKey,
  readImportedProjects,
  saveImportedProjects,
} from "./session-import.ts";

function chat(key: string, overrides: Partial<ImportChatSummary> = {}): ImportChatSummary {
  const [tool] = key.split(":") as [ImportChatSummary["tool"]];
  return {
    key,
    tool,
    title: key,
    project: "/p",
    updatedAt: 0,
    alreadyImported: false,
    ...overrides,
  };
}

function scan(chats: ImportChatSummary[], selected: string[]): ImportScanResult {
  const zero = { chats: 0, projects: 0, recent: 0 };
  return { counts: { "claude-code": zero, codex: zero, "pi-cli": zero }, chats, selected };
}

describe("session-import helpers", () => {
  const found = scan(
    [
      chat("claude-code:a", { project: "/сайт" }),
      chat("codex:b", { project: "/бот" }),
      chat("claude-code:c", { project: "/сайт" }),
      chat("claude-code:d", { project: "/другой" }),
      chat("codex:old", { project: "/бот" }),
      chat("pi-cli:x", { alreadyImported: true }),
    ],
    ["claude-code:a", "claude-code:c", "claude-code:d"],
  );

  it("offers tools with something new, ticked when they have recent chats", () => {
    expect(importToolRows(found)).toEqual([
      { tool: "claude-code", name: "Claude Code", chats: 3, projects: 2, recommended: true },
      { tool: "codex", name: "Codex", chats: 2, projects: 1, recommended: false },
    ]);
  });

  it("brings the recent chats of a ticked tool, or its newest when none are recent", () => {
    expect(importKeys(found, new Set(["claude-code"]))).toEqual([
      "claude-code:a",
      "claude-code:c",
      "claude-code:d",
    ]);
    expect(importKeys(found, new Set(["codex", "claude-code"]))).toEqual([
      "claude-code:a",
      "codex:b",
      "claude-code:c",
      "claude-code:d",
      "codex:old",
    ]);
    expect(importKeys(found, new Set())).toEqual([]);
  });

  it("never brings more than 50 at once", () => {
    const many = scan(
      Array.from({ length: 80 }, (_, i) => chat(`codex:${i}`)),
      [],
    );
    expect(importKeys(many, new Set(["codex"]))).toHaveLength(IMPORT_MAX_CHATS);
  });

  it("reads counts with the right plural form", () => {
    expect(pluralKey("ru", 1, "prsloy.import.chats")).toBe("prsloy.import.chats.one");
    expect(pluralKey("ru", 3, "prsloy.import.chats")).toBe("prsloy.import.chats.few");
    expect(pluralKey("ru", 11, "prsloy.import.chats")).toBe("prsloy.import.chats.many");
    const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string | number>) =>
      t("ru", key, vars && { count: String(vars.count) });
    expect(countText(tr, "ru", 21, "prsloy.import.chats")).toBe("21 чат");
    expect(countText(tr, "ru", 3, "prsloy.import.projects")).toBe(" в 3 проектах");
    expect(countText(tr, "ru", 5, "prsloy.import.imported")).toBe("Перенёс 5 чатов");
  });

  it("remembers imported projects for the folder step, first and without repeats", () => {
    localStorage.clear();
    expect(readImportedProjects()).toEqual([]);
    saveImportedProjects(["/a", "/b", "/c", "/d", "/e", "/f"]);
    expect(readImportedProjects()).toEqual(["/a", "/b", "/c", "/d", "/e"]);
    expect(mergeRecentFolders(["/b", "/a"], ["/a", "/z"], 3)).toEqual(["/b", "/a", "/z"]);
    localStorage.setItem("prsloy.import.projects", "{oops");
    expect(readImportedProjects()).toEqual([]);
  });

  it("opens the sidebar card of a project chats were brought into", () => {
    localStorage.clear();
    saveImportedProjects(["C:\\Проекты\\сайт"]);
    expect(expandIfImported("C:\\Проекты\\другой")).toBe(false);
    expect(localStorage.getItem("zeno.projects.expanded")).toBeNull();
    expect(expandIfImported("C:\\Проекты\\сайт")).toBe(true);
    expect(JSON.parse(localStorage.getItem("zeno.projects.expanded")!)).toHaveLength(1);
    // already open: stays open (toggling twice would close it)
    expect(expandIfImported("C:\\Проекты\\сайт")).toBe(true);
    expect(JSON.parse(localStorage.getItem("zeno.projects.expanded")!)).toHaveLength(1);
  });
});
