import { describe, expect, it } from "vite-plus/test";
import type { TimelineItem } from "./timeline.ts";
import { currentTurnAction, summarizeCommand, turnStartedAt } from "./turn-progress.ts";

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
      key: "progress.runTests",
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

  it("falls back for unknown tools", () => {
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

describe("summarizeCommand", () => {
  it.each([
    ["cd /dev/shm/prsloy/проект && npm test -- --run", "progress.runTests", undefined],
    ["cd /tmp/x && python3 -I build.py --out site", "progress.runProgram", { program: "python3" }],
    ["python3 -I tools/check_page.py site/landing", "progress.runCheck", undefined],
    ["FOO=1 BAR=2 node scripts/gen.mjs", "progress.runProgram", { program: "node" }],
    ["pnpm install", "progress.runInstall", undefined],
    ["npm run build", "progress.runBuild", undefined],
    ["pip install pillow", "progress.runInstall", undefined],
    ["ls -la && cat README.md", "progress.runLook", undefined],
    ["mkdir -p site && cp a b", "progress.runFiles", undefined],
    ["git status", "progress.runGit", undefined],
    ["/usr/local/bin/ffmpeg -i in.mp4 out.webm", "progress.runProgram", { program: "ffmpeg" }],
  ])("%s", (command, key, vars) => {
    expect(summarizeCommand(command)).toEqual(vars ? { key, vars } : { key });
  });

  it("turns a heredoc into the file it writes", () => {
    expect(summarizeCommand("cat > /home/u/site/index.html <<'EOF'\n<!doctype html>\nEOF")).toEqual(
      {
        key: "progress.write",
        vars: { detail: "index.html" },
      },
    );
  });

  it("never shows a raw line", () => {
    const long = `cd /a && ${"x".repeat(80)} --flag`;
    expect(summarizeCommand(long)).toEqual({ key: "progress.runOpen" });
    expect(summarizeCommand("cd /only/dir")).toEqual({ key: "progress.runOpen" });
  });
});
