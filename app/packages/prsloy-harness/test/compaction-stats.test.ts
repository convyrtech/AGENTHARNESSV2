import { describe, expect, it } from "vite-plus/test";
import { compactionStats } from "../bench/lib/compaction-stats.ts";

const call = (name: string, args: Record<string, unknown>) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id: "c", name, arguments: args }],
  },
});
const compaction = { type: "compaction", summary: "s", firstKeptEntryId: "x", tokensBefore: 1 };

describe("compactionStats", () => {
  it("no compaction: everything is before", () => {
    const s = compactionStats([call("read", { path: "a" }), call("read", { path: "a" })]);
    expect(s).toEqual({
      compactions: 0,
      callsBefore: 2,
      callsAfter: 0,
      rereadAfter: 0,
      rerunAfter: 0,
      docsAfter: false,
      thread: false,
    });
  });

  it("counts reread/rerun only across the first compaction", () => {
    const s = compactionStats([
      call("read", { path: "src/a.ts" }),
      call("bash", { command: "pnpm test" }),
      compaction,
      call("read", { path: "src/a.ts" }),
      call("read", { path: "src/b.ts" }),
      call("read", { path: "src/b.ts" }),
      call("bash", { command: "pnpm test" }),
      call("bash", { command: "pnpm check" }),
      compaction,
      call("bash", { command: "pnpm check" }),
    ]);
    expect(s.compactions).toBe(2);
    expect(s.callsBefore).toBe(2);
    expect(s.callsAfter).toBe(6);
    expect(s.rereadAfter).toBe(1);
    expect(s.rerunAfter).toBe(1);
    expect(s.docsAfter).toBe(false);
  });

  it("docsAfter via read (case-insensitive basename) and via bash", () => {
    expect(compactionStats([compaction, call("read", { path: "app/Agents.MD" })]).docsAfter).toBe(
      true,
    );
    expect(
      compactionStats([compaction, call("bash", { command: "cat README.md" })]).docsAfter,
    ).toBe(true);
    expect(compactionStats([call("read", { path: "AGENTS.md" }), compaction]).docsAfter).toBe(
      false,
    );
  });

  it("detects the task thread", () => {
    const s = compactionStats([
      { type: "custom", customType: "prsloy-harness.task-thread", data: { key: "k", block: "b" } },
    ]);
    expect(s.thread).toBe(true);
    expect(compactionStats([{ type: "custom", customType: "other" }]).thread).toBe(false);
  });

  it("ignores malformed entries and never throws", () => {
    const s = compactionStats([
      null,
      42,
      "x",
      [],
      { type: "message" },
      { type: "message", message: { role: "assistant", content: "nope" } },
      { type: "message", message: { role: "assistant", content: [null, { type: "toolCall" }] } },
      { type: "message", message: { role: "user", content: [{ type: "toolCall", name: "read" }] } },
      call("read", { path: 5 }),
      call("bash", null as unknown as Record<string, unknown>),
    ]);
    expect(s.callsBefore).toBe(2);
    expect(s.compactions).toBe(0);
    expect(compactionStats(undefined as unknown as unknown[]).callsBefore).toBe(0);
  });
});
