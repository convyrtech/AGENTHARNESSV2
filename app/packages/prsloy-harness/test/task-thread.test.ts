// Нить задачи (#64 п.1): факты задачи из записей сессии и git; блок после пересказа сжатия, «продолжай, не
// начинай заново». За флагом "taskThread" (по умолчанию выкл.), блок заморожен на сжатие и переживает перезапуск.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { readFlags } from "../src/flags.ts";
import { resolveOptions } from "../src/options.ts";
import {
  factsFromEntries,
  gitFacts,
  installTaskThread,
  renderThread,
  summaryKey,
  TASK_THREAD_TYPE,
  withThread,
} from "../src/task-thread.ts";
import { MockPi } from "./mock-pi.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-task-thread-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const msg = (message: Record<string, unknown>) => ({ type: "message", message });
const user = (text: string, timestamp = 1_000_000) =>
  msg({ role: "user", content: [{ type: "text", text }], timestamp });
const calls = (...parts: Array<[string, string, Record<string, unknown>]>) =>
  msg({
    role: "assistant",
    content: parts.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
  });
const result = (id: string, toolName: string, text: string, isError = false) =>
  msg({ role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }], isError });

const ENTRIES = [
  { type: "session" },
  user("Почини тесты на Windows, задача #50", 1_700_000_000_000),
  calls(["c1", "bash", { command: "pnpm test" }], ["c2", "edit", { path: "src/a.ts" }]),
  result("c1", "bash", "[exit 1 · 3,2 с · 1 КБ]\nFAIL a.test.ts", true),
  result("c2", "edit", "ok"),
  calls(["c3", "bash", { command: "git push origin main" }]),
  result("c3", "bash", "rejected\nCommand exited with code 128", true),
  calls(["c4", "write", { path: "src/b.ts" }], ["c5", "edit", { path: "src/a.ts" }]),
  result("c4", "write", "ok"),
  result("c5", "edit", "ok"),
  calls(["c6", "edit", { path: "src/broken.ts" }], ["c7", "bash", { command: "ls" }]),
  result("c6", "edit", "Could not find oldText", true),
  result("c7", "bash", "[exit 0 · 0,0 с · 10 Б]\na.ts"),
  { type: "compaction", summary: "old summary" },
  user("Дождись зелёного CI перед мержем"),
  { type: "custom", customType: "something", data: {} },
];

describe("factsFromEntries", () => {
  it("collects verbatim requests, commands with exit codes and edited files", () => {
    const facts = factsFromEntries(ENTRIES);
    expect(facts.requests).toEqual([
      "Почини тесты на Windows, задача #50",
      "Дождись зелёного CI перед мержем",
    ]);
    expect(facts.startedAt).toBe(1_700_000_000_000);
    expect(facts.commands).toEqual([
      { command: "pnpm test", exit: 1, error: "FAIL a.test.ts" },
      { command: "git push origin main", exit: 128, error: "rejected" },
      { command: "ls", exit: 0 },
    ]);
    // failed edit is not a change; a path is listed once
    expect(facts.edited).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("an error without an exit line has an unknown code, not 0", () => {
    const facts = factsFromEntries([
      calls(["x", "bash", { command: "sleep 999" }]),
      result("x", "bash", "timed out after 120 s", true),
    ]);
    expect(facts.commands).toEqual([
      { command: "sleep 999", exit: undefined, error: "timed out after 120 s" },
    ]);
  });
});

describe("renderThread", () => {
  it("says to continue, not restart, and lists the facts", () => {
    const text = renderThread(factsFromEntries(ENTRIES), {
      branch: "work/win-tests",
      status: [" M src/a.ts", "?? src/b.ts"],
      commits: ["abc1234 fix: tests"],
    });
    expect(text.startsWith("<task_thread>")).toBe(true);
    expect(text.endsWith("</task_thread>")).toBe(true);
    expect(text).toContain("Do not start over");
    expect(text).toContain("trust these facts");
    expect(text).toContain("[1] Почини тесты на Windows, задача #50");
    expect(text).toContain("[2] Дождись зелёного CI перед мержем");
    expect(text).toContain("Files you changed with edit/write in this task: src/a.ts, src/b.ts");
    expect(text).toContain("Git now (branch work/win-tests):");
    expect(text).toContain("     M src/a.ts");
    expect(text).toContain("abc1234 fix: tests");
    expect(text).toContain("Commands you ran: 3, failed: 2.");
    expect(text).toContain("[128] git push origin main");
    expect(text).toContain("— rejected");
    expect(text).toContain("[0] ls");
  });

  it("keeps the first request and the last three, clipped; multi-line commands stay on one line", () => {
    const entries = [
      user("A".repeat(2000)),
      ...["второй", "третий", "четвёртый", "пятый", "шестой"].map((t) => user(t)),
      calls(["m", "bash", { command: "echo 1\necho 2" }]),
      result("m", "bash", "[exit 0 · 0 с · 4 Б]"),
    ];
    const text = renderThread(factsFromEntries(entries), undefined);
    expect(text).toContain(`[1] ${"A".repeat(1500)}… [+500 chars]`);
    expect(text).toContain("(2 more requests in between)");
    expect(text).not.toContain("второй");
    expect(text).toContain("[4] четвёртый");
    expect(text).toContain("[6] шестой");
    expect(text).toContain("[0] echo 1 ⏎ echo 2");
    expect(text).not.toContain("Git now");
  });

  it("paths are relative to the task folder; `cd <folder> &&` is dropped, ./ in commands stays", () => {
    const cwd = "/w/proj";
    const entries = [
      user("сделай"),
      calls(
        ["p", "edit", { path: "/w/proj/src/a.ts" }],
        ["q", "write", { path: "/elsewhere/b.ts" }],
      ),
      result("p", "edit", "ok"),
      result("q", "write", "ok"),
      calls(["r", "bash", { command: "cd /w/proj && ./run.sh /w/proj/x" }]),
      result("r", "bash", "[exit 0 · 0 с · 1 Б]"),
    ];
    const text = renderThread(factsFromEntries(entries), undefined, cwd);
    expect(text).toContain("this task: src/a.ts, /elsewhere/b.ts");
    expect(text).toContain("[0] ./run.sh ./x");
  });

  it("nothing happened yet — no block", () => {
    expect(renderThread(factsFromEntries([{ type: "session" }]), undefined)).toBe("");
  });
});

describe("withThread", () => {
  const summary = { role: "compactionSummary", summary: "S1", timestamp: 5 };
  const blocks = new Map([[summaryKey("S1"), "<task_thread>x</task_thread>"]]);

  it("puts the frozen block right after the compaction summary", () => {
    const out = withThread([summary, { role: "user", content: "next" }], blocks)!;
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({
      role: "custom",
      customType: TASK_THREAD_TYPE,
      content: "<task_thread>x</task_thread>",
      display: false,
      timestamp: 5,
    });
    // same input → same messages (provider cache keeps working)
    expect(withThread([summary, { role: "user", content: "next" }], blocks)).toEqual(out);
  });

  it("no summary, or a block for another summary — untouched", () => {
    expect(withThread([{ role: "user", content: "hi" }], blocks)).toBeUndefined();
    expect(withThread([{ ...summary, summary: "S2" }], blocks)).toBeUndefined();
  });

  it("does not duplicate facts already embedded by local compaction", () => {
    const embedded = { ...summary, summary: "local summary\n<task_thread>facts</task_thread>" };
    expect(withThread([embedded, { role: "user", content: "next" }], blocks)).toBeUndefined();
  });
});

function gitRepo(): string {
  const dir = mkdtempSync(join(root, "repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  git("init", "-q", "-b", "work/x");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "1\n");
  git("add", ".");
  git("commit", "-q", "-m", "fix: first");
  writeFileSync(join(dir, "a.ts"), "2\n");
  return dir;
}

describe("gitFacts", () => {
  it("branch, short status and commits since the task started", async () => {
    const dir = gitRepo();
    const facts = await gitFacts("git", dir, Date.now() - 3_600_000);
    expect(facts?.branch).toBe("work/x");
    expect(facts?.status).toEqual([" M a.ts"]);
    expect(facts?.commits).toHaveLength(1);
    expect(facts?.commits[0]).toMatch(/^[0-9a-f]+ fix: first$/);
    // a task that started later has no commits of its own
    expect((await gitFacts("git", dir, Date.now() + 3_600_000))?.commits).toEqual([]);
  });

  it("a folder ignored by the repo it sits in — not that repo's facts", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, ".gitignore"), "out/\n");
    const nested = join(dir, "out", "task");
    mkdirSync(nested, { recursive: true });
    expect(await gitFacts("git", nested, 0)).toBeUndefined();
  });

  it("not a repository — undefined", async () => {
    expect(await gitFacts("git", mkdtempSync(join(root, "plain-")), 0)).toBeUndefined();
  });
});

function setup(flags: Record<string, unknown>, cwd: string, entries: unknown[]) {
  const settingsPath = join(root, `s${n++}.json`);
  writeFileSync(settingsPath, JSON.stringify(flags));
  const pi = new MockPi(cwd);
  const stored: Array<{ type: string; customType: string; data: unknown }> = [];
  const sm = pi.ctx.sessionManager as unknown as Record<string, unknown>;
  sm.getBranch = () => entries;
  sm.getEntries = () => [...entries, ...stored];
  const api = pi.api;
  (api as unknown as { appendEntry: (t: string, d: unknown) => void }).appendEntry = (
    customType,
    data,
  ) => {
    stored.push({ type: "custom", customType, data });
  };
  installTaskThread(api, resolveOptions({ profile: "code", settingsPath }));
  return { pi, stored };
}

async function compact(pi: MockPi, summary: string) {
  await pi.emit("session_compact", {
    compactionEntry: { type: "compaction", summary },
    fromExtension: false,
    reason: "threshold",
    willRetry: false,
  });
}

async function context(pi: MockPi, messages: unknown[]) {
  const [out] = (await pi.emit("context", { messages })) as Array<
    { messages: unknown[] } | undefined
  >;
  return out?.messages;
}

describe("installTaskThread", () => {
  it("is off by default", () => {
    const p = join(root, "flags-default.json");
    writeFileSync(p, "{}");
    expect(readFlags(p).taskThread).toBe(false);
  });

  it("flag on: builds the block at compaction, stores it, inserts it after the summary", async () => {
    const dir = gitRepo();
    const { pi, stored } = setup({ taskThread: true }, dir, ENTRIES);
    await pi.emit("session_start", {});
    await compact(pi, "SUMMARY");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.customType).toBe(TASK_THREAD_TYPE);
    const block = (stored[0]!.data as { block: string }).block;
    expect(block).toContain("Git now (branch work/x):");
    expect(block).toContain("     M a.ts");
    expect(block).toContain("[128] git push origin main");

    const out = await context(pi, [
      { role: "compactionSummary", summary: "SUMMARY", timestamp: 1 },
    ]);
    expect(out?.[1]).toMatchObject({ role: "custom", content: block });
  });

  it("flag off: nothing is built or inserted", async () => {
    const { pi, stored } = setup({}, root, ENTRIES);
    await pi.emit("session_start", {});
    await compact(pi, "SUMMARY");
    expect(stored).toHaveLength(0);
    expect(await context(pi, [{ role: "compactionSummary", summary: "SUMMARY" }])).toBeUndefined();
  });

  it("after a host restart the stored block comes back from the session", async () => {
    const first = setup({ taskThread: true }, root, ENTRIES);
    await first.pi.emit("session_start", {});
    await compact(first.pi, "SUMMARY");

    const second = setup({ taskThread: true }, root, [...ENTRIES, ...first.stored]);
    await second.pi.emit("session_start", {});
    const out = await context(second.pi, [{ role: "compactionSummary", summary: "SUMMARY" }]);
    expect(out?.[1]).toMatchObject({
      customType: TASK_THREAD_TYPE,
      content: (first.stored[0]!.data as { block: string }).block,
    });
  });
});
