import { afterEach, describe, expect, it } from "vite-plus/test";
import { readdir, readFile } from "node:fs/promises";
import {
  buildPiSession,
  copyPiCliSession,
  IMPORT_CUSTOM_TYPE,
  sessionFileName,
  tailStart,
  TAIL_CHARS,
  writePiSession,
} from "../src/to-pi.ts";
import { emptyDropped, type ImportedChat, type ImportedTurn } from "../src/types.ts";
import { cleanTemp, tempDir } from "./helpers.ts";

afterEach(cleanTemp);

const TARGET = { provider: "prsloy", modelId: "prsloy/auto" };
const turn = (role: ImportedTurn["role"], text: string, timestamp?: number): ImportedTurn => ({
  role,
  text,
  ...(timestamp ? { timestamp } : {}),
});

function chat(turns: ImportedTurn[]): ImportedChat {
  return {
    tool: "codex",
    sourceId: "id-1",
    sourcePath: "/r.jsonl",
    cwd: "/проект",
    title: "Бот",
    startedAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 2),
    model: "gpt-5-codex",
    turns,
    files: [],
    dropped: emptyDropped(),
    secrets: 2,
  };
}

describe("to-pi", () => {
  it("keeps the last turns, starting at a request, within the size limit", () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn(i % 2 ? "assistant" : "user", `t${i}`));
    expect(tailStart(turns)).toBe(4);
    expect(tailStart([turn("assistant", "a"), turn("user", "u"), turn("assistant", "b")])).toBe(1);
    expect(tailStart([turn("user", "x".repeat(TAIL_CHARS + 1))])).toBe(1);
    expect(tailStart([])).toBe(0);
  });

  it("writes header, import record, history, compaction, model change and title in a chain", () => {
    const file = buildPiSession(
      chat([turn("user", "Сделай бота", Date.UTC(2026, 9, 1, 10)), turn("assistant", "Готово")]),
      { target: TARGET, sha256: "abc", now: new Date(Date.UTC(2026, 9, 25)), id: "sess-1" },
    );
    expect(file.header).toEqual({
      type: "session",
      version: 3,
      id: "sess-1",
      timestamp: "2026-10-01T00:00:00.000Z",
      cwd: "/проект",
    });
    expect(file.entries.map((e) => e.type)).toEqual([
      "custom",
      "message",
      "message",
      "compaction",
      "model_change",
      "session_info",
    ]);
    file.entries.forEach((entry, i) => {
      expect(entry.id).toMatch(/^[0-9a-f]{8}$/);
      expect(entry.parentId).toBe(i === 0 ? null : file.entries[i - 1]!.id);
    });
    expect(file.entries[0]).toMatchObject({
      customType: IMPORT_CUSTOM_TYPE,
      data: {
        tool: "codex",
        sourceId: "id-1",
        sha256: "abc",
        sourceModel: "gpt-5-codex",
        secrets: 2,
      },
    });
    expect(file.entries[1]).toMatchObject({
      timestamp: "2026-10-01T10:00:00.000Z",
      message: { role: "user", content: "Сделай бота", timestamp: Date.UTC(2026, 9, 1, 10) },
    });
    expect(file.entries[2]).toMatchObject({
      message: { role: "assistant", api: "imported", provider: "imported", stopReason: "stop" },
    });
    expect(file.entries[3]).toMatchObject({
      firstKeptEntryId: file.entries[1]!.id,
      fromHook: true,
    });
    expect(file.entries[4]).toMatchObject({ provider: "prsloy", modelId: "prsloy/auto" });
    expect(file.entries[5]).toMatchObject({ name: "Бот" });
  });

  it("points the compaction at itself when no turn fits the tail", () => {
    const file = buildPiSession(chat([turn("user", "x".repeat(TAIL_CHARS + 10))]), {
      target: TARGET,
      sha256: "s",
    });
    const compaction = file.entries.find((e) => e.type === "compaction")!;
    expect(compaction.firstKeptEntryId).toBe(compaction.id);
  });

  it("never lets times go backwards", () => {
    const file = buildPiSession(
      chat([turn("user", "a", Date.UTC(2026, 9, 2)), turn("assistant", "b", Date.UTC(2026, 9, 1))]),
      { target: TARGET, sha256: "s" },
    );
    const [first, second] = file.entries.filter((e) => e.type === "message");
    expect(String(second!.timestamp) >= String(first!.timestamp)).toBe(true);
  });

  it("copies a Pi CLI chat under a new id and appends to its last entry", () => {
    const entries = [
      { type: "message", id: "aaaaaaaa", parentId: null, timestamp: "t" },
      { type: "message", id: "bbbbbbbb", parentId: "aaaaaaaa", timestamp: "t" },
    ];
    const file = copyPiCliSession(
      { header: { type: "session", id: "old", cwd: "/p", parentSession: "/x" }, entries },
      {
        target: TARGET,
        record: { tool: "pi-cli", sourceId: "old", sha256: "s", importedAt: "", secrets: 0 },
        id: "new",
      },
    );
    expect(file.header).toEqual({ type: "session", id: "new", cwd: "/p", version: 3 });
    expect(file.entries.slice(2).map((e) => [e.type, e.parentId])).toEqual([
      ["custom", "bbbbbbbb"],
      ["model_change", file.entries[2]!.id],
    ]);
  });

  it("writes one JSON line per entry under Pi's file name, with nothing left behind", async () => {
    const dir = await tempDir();
    const file = buildPiSession(chat([turn("user", "привет")]), {
      target: TARGET,
      sha256: "s",
      id: "abc",
    });
    const created = new Date(Date.UTC(2026, 9, 25, 12, 30));
    const path = await writePiSession(dir, file, created);
    expect(path.endsWith(sessionFileName("abc", created))).toBe(true);
    expect(sessionFileName("abc", created)).toBe("2026-10-25T12-30-00-000Z_abc.jsonl");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.map((l) => JSON.parse(l).type)[0]).toBe("session");
    expect(lines).toHaveLength(1 + file.entries.length);
    expect(await readdir(dir)).toHaveLength(1);
  });
});
