import { describe, expect, it } from "vite-plus/test";
import type { TimelineItem } from "./timeline.ts";
import { currentTurnAction, elapsedLabel, turnStartedAt } from "./turn-progress.ts";

const user = (text: string, timestamp?: string): TimelineItem => ({
  id: `u-${text}`,
  kind: "user",
  text,
  ...(timestamp ? { timestamp } : {}),
});
const tool = (toolName: string, args: unknown, status: "running" | "completed" = "running") =>
  ({ id: `t-${toolName}`, kind: "tool", toolName, args, status }) as TimelineItem;

describe("currentTurnAction", () => {
  it("names the running command and the file being edited", () => {
    expect(currentTurnAction([user("go"), tool("bash", { command: "npm test" })])).toEqual({
      key: "progress.run",
      vars: { detail: "npm test" },
    });
    expect(
      currentTurnAction([user("go"), tool("edit", { path: "/home/u/site/index.html" })]),
    ).toEqual({ key: "progress.edit", vars: { detail: "index.html" } });
    expect(currentTurnAction([user("go"), tool("write", { path: "a/b.css" })]).key).toBe(
      "progress.write",
    );
  });

  it("says thinking or answering between tools", () => {
    expect(currentTurnAction([user("go")]).key).toBe("progress.thinking");
    expect(currentTurnAction([user("go"), { id: "th", kind: "thinking", text: "hm" }]).key).toBe(
      "progress.thinking",
    );
    expect(
      currentTurnAction([user("go"), { id: "a", kind: "assistant", text: "Сейчас…" }]).key,
    ).toBe("progress.answering");
  });

  it("thinks once the last tool has finished", () => {
    expect(currentTurnAction([user("go"), tool("bash", { command: "ls" }, "completed")]).key).toBe(
      "progress.thinking",
    );
  });

  it("only looks at the current turn", () => {
    expect(
      currentTurnAction([user("one"), tool("bash", { command: "ls" }, "completed"), user("two")])
        .key,
    ).toBe("progress.thinking");
  });

  it("cuts long commands and falls back for unknown tools", () => {
    const long = `npm run ${"x".repeat(100)}`;
    const action = currentTurnAction([user("go"), tool("bash", { command: long })]);
    expect(action.vars?.detail).toHaveLength(60);
    expect(action.vars?.detail?.endsWith("…")).toBe(true);
    expect(currentTurnAction([user("go"), tool("bash", {})]).key).toBe("progress.runOpen");
    expect(currentTurnAction([user("go"), tool("mystery", {})])).toEqual({
      key: "progress.generic",
      vars: { tool: "mystery" },
    });
  });
});

describe("turnStartedAt", () => {
  it("uses the user message time, never one in the future", () => {
    const now = Date.parse("2026-10-25T10:00:00Z");
    expect(turnStartedAt([user("go", "2026-10-25T09:58:00Z")], now)).toBe(now - 120_000);
    expect(turnStartedAt([user("go", "2026-10-25T10:05:00Z")], now)).toBe(now);
    expect(turnStartedAt([user("go")], now)).toBe(now);
  });
});

describe("elapsedLabel", () => {
  it("is coarse: seconds, then minutes, then hours", () => {
    expect(elapsedLabel(40_500)).toEqual({ key: "progress.elapsed.seconds", vars: { n: "40" } });
    expect(elapsedLabel(150_000)).toEqual({ key: "progress.elapsed.minutes", vars: { n: "2" } });
    expect(elapsedLabel(65 * 60_000)).toEqual({
      key: "progress.elapsed.hours",
      vars: { h: "1", m: "5" },
    });
    expect(elapsedLabel(-5).vars?.n).toBe("0");
  });
});
