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
});
