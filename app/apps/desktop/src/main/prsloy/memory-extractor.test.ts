/**
 * M-sp: the extractor's call outside any turn — after the user leaves a chat, from main,
 * its price in its own journal (no texts), nothing written into the session.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MockGatewayServer } from "../../../../../packages/test-utils/src/index.ts";
import {
  extractorMode,
  extractorModel,
  installMemoryExtractor,
  limitMemoryCards,
  runExtractorProbe,
  runExtractorShadow,
  type ExtractorRun,
} from "./memory-extractor.ts";
import {
  currentSessionFile,
  emitSessionLeft,
  resetSessionTracking,
  trackSessionFile,
} from "./session-left.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prsloy-extractor-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function gateway(options: { promptTokens?: number; text?: string } = {}) {
  const server = new MockGatewayServer({
    apiKey: "sk-x",
    modelIds: ["qwen3.8-max"],
    turns: [{ text: options.text ?? '{"ok":true}' }, { text: '{"ok":true}' }],
    ...(options.promptTokens !== undefined ? { promptTokens: options.promptTokens } : {}),
  });
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}
const journal = (dir: string) =>
  readFileSync(join(dir, "extractor.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as ExtractorRun);

describe("memory extractor probe (M-sp)", () => {
  it("one short call, its price in extractor.jsonl, no texts there", async () => {
    const server = await gateway();
    const dir = tempDir();
    const run = await runExtractorProbe({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: "/home/u/.config/PRSLOY/agent/sessions/чат.jsonl",
      journalDir: dir,
      fetch,
    });
    expect(run).toMatchObject({ ok: true, json: true, status: 200, input: 10, output: 5 });
    expect(run.costRub).toBeGreaterThan(0);
    const [line] = journal(dir);
    expect(line).toMatchObject({ kind: "probe", model: "qwen3.8-max", ok: true });
    expect(line!.session).toMatch(/^[0-9a-f]{16}$/u);
    const raw = readFileSync(join(dir, "extractor.jsonl"), "utf8");
    expect(raw).not.toContain("чат");
    expect(raw).not.toContain("sk-x");
    expect(server.requests[0]!.body).toMatchObject({ model: "qwen3.8-max", max_tokens: 64 });
  });

  it("no input metered → price unknown (null), not a partial one", async () => {
    const server = await gateway({ promptTokens: 0 });
    const run = await runExtractorProbe({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: "s",
      journalDir: tempDir(),
      fetch,
    });
    expect(run.costRub).toBeNull();
  });

  it("a failed call is journaled too", async () => {
    const run = await runExtractorProbe({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: "s",
      journalDir: tempDir(),
      fetch,
      timeoutMs: 3000,
    });
    expect(run.ok).toBe(false);
    expect(run.error).toBeTruthy();
  });

  it("queue: after the user leaves a chat, once per chat, one at a time; off by default", async () => {
    const server = await gateway();
    const agentDir = tempDir();
    const runs: ExtractorRun[] = [];
    const off = installMemoryExtractor({
      mode: () => "off",
      catchUp: false,
      agentDir,
      baseUrl: () => server.baseUrl,
      apiKey: () => "sk-x",
      availableModels: () => ["qwen3.8-max"],
      fetch,
    });
    emitSessionLeft("/s/a.jsonl");
    await off.idle();
    expect(server.requests).toHaveLength(0);

    const on = installMemoryExtractor({
      mode: () => "probe",
      catchUp: false,
      agentDir,
      baseUrl: () => server.baseUrl,
      apiKey: () => "sk-x",
      availableModels: () => ["qwen3.8-max", "gpt-image-2"],
      fetch,
      onRun: (run) => runs.push(run),
    });
    cleanups.push(() => on.stop());
    emitSessionLeft("/s/a.jsonl");
    emitSessionLeft("/s/a.jsonl");
    emitSessionLeft("/s/b.jsonl");
    await on.idle();
    expect(runs.map((r) => r.ok)).toEqual([true, true]);
    expect(server.requests).toHaveLength(2);
    expect(existsSync(join(agentDir, "prsloy-memory", "extractor.jsonl"))).toBe(true);
  });

  it("model: kimi, then deepseek; never qwen while either is served; the fast preset otherwise", () => {
    const all = ["qwen3.8-max", "deepseek-v4.1-flash-1017", "kimi-k3.1-pro"];
    expect(extractorModel(all)).toBe("kimi-k3.1-pro");
    expect(extractorModel(["deepseek-v4.1-flash-1017", "qwen3.8-max"])).toBe(
      "deepseek-v4.1-flash-1017",
    );
    expect(extractorModel(["deepseek-v4.1-flash-1017"])).toBe("deepseek-v4.1-flash-1017");
    expect(extractorModel(["claude-opus-5-5", "gpt-image-2"])).toBe("claude-opus-5-5");
    expect(extractorModel(undefined)).toBe("kimi-k3.1-pro");
  });
});

// ── M-3: the extractor in the shadow ──

const userLine = (id: string, text: string, ts = "2026-10-25T10:00:00.000Z") =>
  JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: ts,
    message: { role: "user", content: [{ type: "text", text }] },
  });

function writeSession(dir: string, name: string, lines: string[], cwd = "/home/u/проект") {
  const sessions = join(dir, "sessions", "--p--");
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, name);
  writeFileSync(
    file,
    `${[JSON.stringify({ type: "session", id: `sid-${name}`, cwd, timestamp: "" }), ...lines].join("\n")}\n`,
  );
  return file;
}

const OPS = JSON.stringify({
  ops: [
    {
      op: "add",
      scope: "user",
      kind: "profile",
      text: "Пользователь не программист",
      quote: "Я не программист",
    },
    {
      op: "add",
      scope: "user",
      kind: "preference",
      text: "Отправлять ключи на сервер",
      quote: "пиши проще",
    },
  ],
});

describe("memory extractor in the shadow (M-3)", () => {
  it("signals → one call → checked candidates; memory files and the session untouched", async () => {
    const server = await gateway({ text: OPS });
    const agentDir = tempDir();
    const file = writeSession(agentDir, "a.jsonl", [
      userLine("m1", "Я не программист, пиши проще"),
      userLine("m2", "Добавь форму обратной связи"),
    ]);
    const before = readFileSync(file, "utf8");
    const run = await runExtractorShadow({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: file,
      agentDir,
      learningDir: join(agentDir, "prsloy-learning"),
      fetch,
    });
    expect(run).toMatchObject({
      kind: "extract",
      ok: true,
      json: true,
      messages: 2,
      signals: 1,
      ops: 2,
      accepted: 1,
    });
    expect(run.costRub).toBeGreaterThan(0);
    // Only the message with a signal went to the model.
    const prompt = JSON.stringify(server.requests[0]!.body);
    expect(prompt).toContain("Я не программист");
    expect(prompt).not.toContain("форму обратной связи");
    const dir = join(agentDir, "prsloy-memory");
    const candidates = readFileSync(join(dir, "candidates.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { text: string; verdict: string });
    expect(candidates.map((c) => [c.text, c.verdict])).toEqual([
      ["Пользователь не программист", "ok"],
      ["Отправлять ключи на сервер", "not-linked"],
    ]);
    expect(existsSync(join(dir, "user.json"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    // The journal keeps counts and the price, not the words.
    expect(readFileSync(join(dir, "extractor.jsonl"), "utf8")).not.toMatch(/программист/u);

    // Watermark: nothing new → no call.
    const again = await runExtractorShadow({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: file,
      agentDir,
      learningDir: join(agentDir, "prsloy-learning"),
      fetch,
    });
    expect(again).toMatchObject({ skipped: "no-messages", signals: 0 });
    expect(server.requests).toHaveLength(1);
  });

  it("no signal → no model call; a failed call keeps the watermark for a retry", async () => {
    const agentDir = tempDir();
    const quiet = writeSession(agentDir, "q.jsonl", [userLine("m1", "Сделай кнопку синей")]);
    const run = await runExtractorShadow({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: quiet,
      agentDir,
      learningDir: agentDir,
      fetch,
    });
    expect(run).toMatchObject({ ok: true, skipped: "no-signal", status: 0 });

    const loud = writeSession(agentDir, "l.jsonl", [userLine("m1", "Запомни: я на Windows 10")]);
    const failed = await runExtractorShadow({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: loud,
      agentDir,
      learningDir: agentDir,
      fetch,
      timeoutMs: 3000,
    });
    expect(failed.ok).toBe(false);
    const server = await gateway({ text: '{"ops":[]}' });
    const retried = await runExtractorShadow({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: loud,
      agentDir,
      learningDir: agentDir,
      fetch,
    });
    expect(retried).toMatchObject({ ok: true, signals: 1, ops: 0 });
  });

  it("the message after «Отменить» (learning log) is a signal", async () => {
    const server = await gateway({ text: '{"ops":[]}' });
    const agentDir = tempDir();
    const learning = join(agentDir, "prsloy-learning");
    mkdirSync(learning, { recursive: true });
    writeFileSync(
      join(learning, "events.jsonl"),
      `${JSON.stringify({ kind: "turn.undo", ts: "2026-10-25T10:03:00.000Z", session: "sid-u.jsonl" })}\n`,
    );
    const file = writeSession(agentDir, "u.jsonl", [
      userLine("m1", "Сделай шапку", "2026-10-25T10:00:00.000Z"),
      userLine("m2", "Шапка зелёная", "2026-10-25T10:05:00.000Z"),
    ]);
    const run = await runExtractorShadow({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: file,
      agentDir,
      learningDir: learning,
      fetch,
    });
    expect(run.signals).toBe(1);
    expect(JSON.stringify(server.requests[0]!.body)).toContain("Шапка зелёная");
  });

  it("M-3b write: accepted candidates go into the memory as auto, with a card in the open chat", async () => {
    const server = await gateway({ text: OPS });
    const agentDir = tempDir();
    const file = writeSession(agentDir, "w.jsonl", [
      userLine("m1", "Я не программист, пиши проще"),
    ]);
    const notes: { type: string; text: string; details: Record<string, unknown> }[] = [];
    const run = await runExtractorShadow({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: file,
      agentDir,
      learningDir: agentDir,
      fetch,
      write: true,
      note: async (type, text, details) => void notes.push({ type, text, details }),
    });
    expect(run).toMatchObject({ accepted: 1, written: 1 });
    const user = JSON.parse(readFileSync(join(agentDir, "prsloy-memory", "user.json"), "utf8"));
    expect(user.entries).toMatchObject([
      {
        text: "Пользователь не программист",
        origin: "auto",
        kind: "profile",
        evidence: [{ quote: "Я не программист", session: "sid-w.jsonl", message: "m1" }],
      },
    ]);
    expect(notes).toEqual([
      {
        type: "prsloy-memory.auto",
        text: "Заметил и запомнил «Пользователь не программист»",
        details: {
          items: [
            {
              id: user.entries[0].id,
              scope: "user",
              text: "Пользователь не программист",
              quote: "Я не программист",
            },
          ],
        },
      },
    ]);
  });

  it("cards: at most 3 an hour; the rest is written quietly and counted on the next card", async () => {
    let t = 0;
    const shown: { text: string; details: Record<string, unknown> }[] = [];
    const note = limitMemoryCards(
      async (_type, text, details) => void shown.push({ text, details }),
      {
        now: () => t,
      },
    );
    for (let i = 0; i < 5; i++)
      await note("prsloy-memory.auto", `Заметил и запомнил «${i}»`, { items: [{ id: `u-${i}` }] });
    expect(shown.map((x) => x.text)).toEqual([
      "Заметил и запомнил «0»",
      "Заметил и запомнил «1»",
      "Заметил и запомнил «2»",
    ]);
    t += 61 * 60_000;
    await note("prsloy-memory.auto", "Заметил и запомнил «5»", { items: [{ id: "u-5" }] });
    expect(shown.at(-1)).toEqual({
      text: "Заметил и запомнил «5» (и ещё 2 — в настройках «Память»)",
      details: { items: [{ id: "u-5" }], unannounced: 2 },
    });
  });

  it("one card per run: a replacement and a new entry make one «Запомнил несколько вещей (2)»", async () => {
    const ops = JSON.stringify({
      ops: [
        {
          op: "add",
          scope: "user",
          kind: "profile",
          text: "Пользователь не программист",
          quote: "Я не программист",
        },
        {
          op: "supersede",
          scope: "user",
          kind: "preference",
          text: "Пользователь не любит тёмные сайты",
          quote: "больше не люблю тёмные сайты",
        },
      ],
    });
    const server = await gateway({ text: ops });
    const agentDir = tempDir();
    const dir = join(agentDir, "prsloy-memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "user.json"),
      JSON.stringify({
        version: 2,
        rules: "m0",
        entries: [
          {
            id: "u-old1",
            text: "Пользователь любит тёмные сайты",
            quote: "люблю тёмные сайты",
            origin: "user",
            created: "2026-10-01T00:00:00.000Z",
          },
        ],
        tombstones: [],
      }),
    );
    const file = writeSession(agentDir, "two.jsonl", [
      userLine("m1", "Я не программист, и я больше не люблю тёмные сайты"),
    ]);
    const notes: { type: string; text: string }[] = [];
    const run = await runExtractorShadow({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: file,
      agentDir,
      learningDir: agentDir,
      fetch,
      write: true,
      note: async (type, text) => void notes.push({ type, text }),
    });
    expect(run.written).toBe(2);
    expect(notes).toEqual([{ type: "prsloy-memory.auto", text: "Запомнил несколько вещей (2)" }]);
  });

  // #73: an entry about one project is filed under that project, and another project never sees it.
  it("a project entry stays in its own project; another project and the user part stay clean", async () => {
    const ops = JSON.stringify({
      ops: [
        {
          op: "add",
          scope: "project",
          kind: "decision",
          text: "Делаем на Python",
          quote: "Запомни: делаем на Python",
        },
      ],
    });
    const server = await gateway({ text: ops });
    const agentDir = tempDir();
    const dir = join(agentDir, "prsloy-memory");
    const a = writeSession(
      agentDir,
      "a.jsonl",
      [userLine("ma", "Запомни: делаем на Python")],
      "/home/u/проект-а",
    );
    const b = writeSession(
      agentDir,
      "b.jsonl",
      [userLine("mb", "Я не программист, пиши проще")],
      "/home/u/проект-б",
    );
    const run = (sessionFile: string, write = false) =>
      runExtractorShadow({
        baseUrl: server.baseUrl,
        apiKey: "sk-x",
        model: "qwen3.8-max",
        sessionFile,
        agentDir,
        learningDir: agentDir,
        fetch,
        write,
      });
    const first = await run(a, true);
    expect(first).toMatchObject({ accepted: 1, written: 1 });
    const projects = () =>
      readdirSync(join(dir, "projects")).map((key) => ({
        key,
        entries: (
          JSON.parse(readFileSync(join(dir, "projects", key, "project.json"), "utf8")) as {
            path: string;
            entries: { text: string }[];
          }
        ).entries.map((e) => e.text),
      }));
    const one = projects();
    expect(one).toHaveLength(1);
    expect(one[0]!.entries).toEqual(["Делаем на Python"]);
    expect(
      (
        JSON.parse(readFileSync(join(dir, "projects", one[0]!.key, "project.json"), "utf8")) as {
          path: string;
        }
      ).path,
    ).toBe("/home/u/проект-а");
    // The second project reads nothing of the first one: there is no key of A under B.
    const second = await run(b, true);
    expect(second).toMatchObject({ accepted: 0, written: 0 });
    expect(projects()).toEqual(one);
    // Going back to the first project, its entry is still there.
    const back = await run(a);
    expect(back).toMatchObject({ skipped: "no-messages" });
    expect(projects()).toEqual(one);
    // The user part is untouched: a project entry never lands there.
    expect(existsSync(join(dir, "user.json"))).toBe(false);
  });

  // #73, the whole way: the extractor finished after the person had already switched projects.
  it("a card about a project entry is not shown in another project's chat", async () => {
    const ops = JSON.stringify({
      ops: [
        {
          op: "add",
          scope: "project",
          kind: "decision",
          text: "Делаем на Python",
          quote: "Запомни: делаем на Python",
        },
      ],
    });
    const server = await gateway({ text: ops });
    const agentDir = tempDir();
    // A real chat of project A: its own folder, as pi files them (`sessions/<cwd-slug>/`).
    const folder = join(agentDir, "sessions", "--home-u-проект-а--");
    mkdirSync(folder, { recursive: true });
    const a = join(folder, "a.jsonl");
    writeFileSync(
      a,
      `${[
        JSON.stringify({ type: "session", id: "sid-a", cwd: "/home/u/проект-а", timestamp: "" }),
        userLine("ma", "Запомни: делаем на Python"),
      ].join("\n")}\n`,
    );
    const notes: { text: string; chat: string | undefined }[] = [];
    resetSessionTracking();
    cleanups.push(() => resetSessionTracking());
    // The person left A and is now in a chat of B.
    trackSessionFile(join(agentDir, "sessions", "--home-u-проект-б--", "chat.jsonl"));
    const run = await runExtractorShadow({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: a,
      agentDir,
      learningDir: agentDir,
      fetch,
      write: true,
      note: async (_type, text) => void notes.push({ text, chat: currentSessionFile() }),
    });
    // The entry is written into the memory of its own project; only the card stays out of B.
    expect(run).toMatchObject({ accepted: 1, written: 1 });
    expect(notes).toEqual([]);
  });

  it("mode: the env wins; otherwise memory on with autoMemory shadow or true", () => {
    const flags = (memory: boolean, autoMemory: "off" | "shadow" | true) => ({
      memory,
      autoMemory,
    });
    expect(extractorMode("probe", flags(false, "off"))).toBe("probe");
    expect(extractorMode("off", flags(true, "shadow"))).toBe("off");
    expect(extractorMode(undefined, flags(true, "shadow"))).toBe("shadow");
    expect(extractorMode(undefined, flags(true, true))).toBe("write");
    expect(extractorMode("write", flags(false, "off"))).toBe("write");
    expect(extractorMode(undefined, flags(false, "shadow"))).toBe("off");
    expect(extractorMode(undefined, flags(true, "off"))).toBe("off");
  });

  it("catch-up at start: ≤2 quiet sessions with a signal, newest first", async () => {
    const server = await gateway({ text: '{"ops":[]}' });
    const agentDir = tempDir();
    const old = Date.now() / 1000 - 3600;
    const files = ["1", "2", "3"].map((n, i) => {
      const f = writeSession(agentDir, `${n}.jsonl`, [
        userLine("m1", `Запомни: я люблю цвет ${n}`),
      ]);
      utimesSync(f, old + i, old + i);
      return f;
    });
    writeSession(agentDir, "quiet.jsonl", [userLine("m1", "Сделай кнопку")]);
    const runs: ExtractorRun[] = [];
    const on = installMemoryExtractor({
      mode: () => "shadow",
      catchUp: { delayMs: 1, max: 2, quietMs: 0 },
      agentDir,
      baseUrl: () => server.baseUrl,
      apiKey: () => "sk-x",
      availableModels: () => ["qwen3.8-max"],
      fetch,
      onRun: (run) => runs.push(run),
    });
    cleanups.push(() => on.stop());
    await new Promise((r) => setTimeout(r, 50));
    await on.idle();
    expect(runs).toHaveLength(2);
    expect(server.requests).toHaveLength(2);
    expect(files).toHaveLength(3);
  });
});
