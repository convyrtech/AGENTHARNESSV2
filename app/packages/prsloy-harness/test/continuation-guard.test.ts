import { describe, expect, it } from "vite-plus/test";
import { installContinuationGuard, MAX_AUTO_CONTINUATIONS } from "../src/continuation-guard.ts";
import { MockPi } from "./mock-pi.ts";

describe("continuation guard", () => {
  it("stops an unbounded chain while preserving the first requests", async () => {
    const pi = new MockPi();
    pi.api.on("agent_before_settle", () => ({ entries: [], continue: true }));
    installContinuationGuard(pi.api);
    await pi.userPrompt();

    for (let i = 0; i < MAX_AUTO_CONTINUATIONS; i++)
      expect((await pi.boundary("agent_before_settle")).continue).toBe(true);
    const stopped = await pi.boundary("agent_before_settle");
    expect(stopped.continue).toBe(false);
    expect(stopped.entries).toHaveLength(1);
    expect((stopped.entries[0] as { customType: string }).customType).toBe(
      "prsloy-harness.continuation-guard",
    );
  });

  it("resets only for a new user message", async () => {
    const pi = new MockPi();
    pi.api.on("agent_before_settle", () => ({ entries: [], continue: true }));
    installContinuationGuard(pi.api);
    await pi.userPrompt();
    for (let i = 0; i < MAX_AUTO_CONTINUATIONS + 1; i++) await pi.boundary("agent_before_settle");
    expect((await pi.boundary("agent_before_settle")).continue).toBe(false);
    await pi.userPrompt();
    expect((await pi.boundary("agent_before_settle")).continue).toBe(true);
  });

  it("allows one automatic compaction and cancels the next", async () => {
    const pi = new MockPi();
    pi.api.on("agent_before_settle", () => ({ entries: [], continue: true }));
    installContinuationGuard(pi.api);
    await pi.userPrompt();
    const first = await pi.emit("session_before_compact", {
      reason: "threshold",
      preparation: { firstKeptEntryId: "entry-1", tokensBefore: 500_000 },
    });
    expect(first[0]).toMatchObject({
      compaction: { firstKeptEntryId: "entry-1", tokensBefore: 500_000 },
    });
    expect(await pi.emit("session_before_compact", { reason: "threshold" })).toEqual([
      { cancel: true },
    ]);
    const stopped = await pi.boundary("agent_before_settle", { continue: true });
    expect(stopped.continue).toBe(false);
  });

  it("embeds session facts in the local summary without a model request", async () => {
    const pi = new MockPi("/work/project");
    installContinuationGuard(pi.api);
    await pi.userPrompt();
    const out = await pi.emit("session_before_compact", {
      reason: "threshold",
      preparation: { firstKeptEntryId: "entry-1", tokensBefore: 500_000 },
      branchEntries: [
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Почини compaction" }],
            timestamp: 1,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "b1", name: "bash", arguments: { command: "pnpm test" } },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "b1",
            toolName: "bash",
            content: [{ type: "text", text: "[exit 1 · 1 s]\nFAIL compaction" }],
            isError: true,
          },
        },
      ],
    });
    const summary = (out[0] as { compaction: { summary: string } }).compaction.summary;
    expect(summary).toContain("<task_thread>");
    expect(summary).toContain("[1] Почини compaction");
    expect(summary).toContain("[1] pnpm test — FAIL compaction");
  });
});
