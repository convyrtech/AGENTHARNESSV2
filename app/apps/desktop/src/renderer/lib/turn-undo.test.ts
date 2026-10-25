import { describe, expect, it } from "vite-plus/test";
import type { PrsloyTurnSnapshot } from "@zeno/contracts";
import type { TimelineBlock, TimelineItem } from "./timeline.ts";
import {
  matchTurnSnapshots,
  promptPreview,
  timelineTurns,
  undoneFileCount,
  undoResultKey,
} from "./turn-undo.ts";

const user = (id: string, text: string, timestamp?: string): TimelineBlock => ({
  type: "item",
  item: { id, kind: "user", text, ...(timestamp ? { timestamp } : {}) },
});
const assistant = (id: string): TimelineBlock => ({
  type: "item",
  item: { id, kind: "assistant", text: "ok" },
});
const process = (id: string, ...tools: Array<[string, "running" | "completed" | "error"]>) =>
  ({
    type: "process",
    id,
    items: tools.map(
      ([toolName, status], i) =>
        ({ id: `${id}-${i}`, kind: "tool", toolName, status }) as Extract<
          TimelineItem,
          { kind: "tool" }
        >,
    ),
  }) satisfies TimelineBlock;

const snap = (id: string, prompt: string, createdAt: string, sessionId?: string) =>
  ({
    id,
    turn: 1,
    createdAt,
    prompt,
    kind: "turn",
    ...(sessionId ? { sessionId } : {}),
  }) satisfies PrsloyTurnSnapshot;

describe("timelineTurns", () => {
  it("splits on user messages and flags turns with edits or writes", () => {
    const turns = timelineTurns(
      [
        user("u1", "прочитай"),
        process("p1", ["read", "completed"]),
        assistant("a1"),
        user("u2", "поправь"),
        process("p2", ["read", "completed"], ["edit", "completed"]),
        assistant("a2"),
        user("u3", "создай"),
        process("p3", ["write", "error"]),
      ],
      false,
    );
    expect(turns.map((t) => [t.userId, t.changedFiles, t.lastBlockIndex])).toEqual([
      ["u1", false, 2],
      ["u2", true, 5],
      ["u3", true, 7],
    ]);
  });

  it("leaves out the running turn and tools still running", () => {
    const blocks = [
      user("u1", "a"),
      process("p1", ["edit", "completed"]),
      user("u2", "b"),
      process("p2", ["edit", "running"]),
    ];
    expect(timelineTurns(blocks, true).map((t) => t.userId)).toEqual(["u1"]);
    expect(timelineTurns(blocks, false)[1]?.changedFiles).toBe(false);
  });

  it("ignores blocks before the first user message", () => {
    expect(timelineTurns([assistant("a0"), process("p0", ["edit", "completed"])], false)).toEqual(
      [],
    );
  });
});

describe("matchTurnSnapshots", () => {
  const turns = timelineTurns(
    [
      user("u1", "сделай лендинг", "2026-10-25T10:00:05Z"),
      process("p1", ["write", "completed"]),
      user("u2", "сделай лендинг", "2026-10-25T10:05:05Z"),
      process("p2", ["edit", "completed"]),
    ],
    false,
  );

  it("pairs repeated prompts newest first without reusing a snapshot", () => {
    const matched = matchTurnSnapshots(turns, [
      snap("s1", "сделай лендинг", "2026-10-25T10:00:04Z"),
      snap("s2", "сделай лендинг", "2026-10-25T10:05:04Z", "sess"),
    ]);
    expect(matched.get("u2")).toBe("s2");
    expect(matched.get("u1")).toBe("s1");
  });

  it("skips undo backups, other sessions and snapshots taken after the message", () => {
    const matched = matchTurnSnapshots(
      turns,
      [
        { ...snap("b", "сделай лендинг", "2026-10-25T10:05:04Z"), kind: "undo-backup" },
        snap("other", "сделай лендинг", "2026-10-25T10:05:04Z", "another"),
        snap("late", "сделай лендинг", "2026-10-25T11:00:00Z"),
      ],
      "sess",
    );
    expect(matched.size).toBe(0);
  });

  it("matches on the first line, cut like main cuts it", () => {
    const long = "x".repeat(130);
    expect(promptPreview(`  ${long}\nвторая строка`)).toBe(`${"x".repeat(119)}…`);
    const [turn] = timelineTurns([user("u", `${long}\nещё`)], false);
    expect(
      matchTurnSnapshots([turn!], [snap("s", promptPreview(long), "2026-01-01T00:00:00Z")]),
    ).toEqual(new Map([["u", "s"]]));
  });
});

describe("undoneFileCount", () => {
  it("counts distinct files", () => {
    expect(undoneFileCount({ rewritten: ["a", "b"], removed: ["b", "c"] })).toBe(3);
    expect(undoneFileCount({ rewritten: [], removed: [] })).toBe(0);
  });
});

describe("undoResultKey", () => {
  it("picks the Russian plural form", () => {
    expect(undoResultKey("ru", 0)).toBe("prsloy.undo.result.none");
    expect(undoResultKey("ru", 1)).toBe("prsloy.undo.result.one");
    expect(undoResultKey("ru", 3)).toBe("prsloy.undo.result.few");
    expect(undoResultKey("ru", 5)).toBe("prsloy.undo.result.many");
    expect(undoResultKey("ru", 21)).toBe("prsloy.undo.result.one");
    expect(undoResultKey("ru", 12)).toBe("prsloy.undo.result.many");
  });

  it("collapses to one/other for English", () => {
    expect(undoResultKey("en", 1)).toBe("prsloy.undo.result.one");
    expect(undoResultKey("en", 3)).toBe("prsloy.undo.result.many");
  });
});
