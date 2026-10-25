/**
 * The import's contract with Pi: the written file opens with Pi's own SessionManager, the model
 * sees the summary plus the kept tail, PRSLOY's model is current, the chat list shows the title,
 * and a real runtime sends the imported tail to a provider without errors.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPixRuntime } from "@zeno/agent-runtime";
import { FakeOpenAiServer } from "../../test-utils/src/index.ts";
import { readClaudeCodeChat } from "../src/adapters/claude-code.ts";
import { readPiCliSession } from "../src/adapters/pi-cli.ts";
import { buildPiSession, copyPiCliSession, writePiSession } from "../src/to-pi.ts";
import { CLAUDE_BASIC, cleanTemp, PI_FILE, tempDir } from "./helpers.ts";

afterEach(cleanTemp);

const TARGET = { provider: "zeno-fake", modelId: "zeno-fake" };

async function writeModels(agentDir: string, baseUrl: string): Promise<void> {
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "zeno-fake": {
          baseUrl,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [
            {
              id: "zeno-fake",
              name: "Zeno Fake Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
              compat: { supportsUsageInStreaming: true },
            },
          ],
        },
      },
    }),
  );
}

async function importedClaudeChat(project: string, sessionDir: string) {
  const chat = await readClaudeCodeChat(CLAUDE_BASIC);
  if (!chat) throw new Error("fixture did not parse");
  const file = buildPiSession(
    { ...chat, cwd: project },
    { target: TARGET, sha256: "0".repeat(64) },
  );
  return { chat, path: await writePiSession(sessionDir, file) };
}

function textOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as { type: string; text?: string }[])
    .map((block) => block.text ?? "")
    .join("");
}

describe("imported chat in Pi", () => {
  it("opens with the summary and the kept tail, on PRSLOY's model", async () => {
    const root = await tempDir();
    const project = join(root, "сайт-пекарни");
    const sessionDir = join(root, "sessions");
    await mkdir(project);
    const { path } = await importedClaudeChat(project, sessionDir);

    const manager = SessionManager.open(path, sessionDir, project);
    const context = manager.buildSessionContext();
    expect(context.model).toEqual({ provider: "zeno-fake", modelId: "zeno-fake" });
    expect(context.messages[0]?.role).toBe("compactionSummary");
    expect(
      context.messages.slice(1).map((m) => [m.role, textOf(m as { content: unknown })]),
    ).toEqual([
      ["user", "Сделай сайт для пекарни «Колосок»"],
      ["assistant", expect.stringContaining("Готово: index.html создан.")],
      ["user", "Добавь страницу с ценами\n[картинка не перенесена]"],
      ["assistant", "Добавил prices.html."],
    ]);
    // the whole history stays in the file for the person
    expect(manager.getEntries().filter((e) => e.type === "message")).toHaveLength(4);

    const listed = await SessionManager.list(project, sessionDir);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "Пекарня «Колосок»", cwd: project });
  });

  it("a Pi CLI copy keeps its tree and switches to PRSLOY's model", async () => {
    const root = await tempDir();
    const project = join(root, "заметки");
    const sessionDir = join(root, "sessions");
    await mkdir(project);
    const copy = await readPiCliSession(PI_FILE);
    if (!copy) throw new Error("fixture did not parse");
    const file = copyPiCliSession(
      { header: { ...copy.header, cwd: project }, entries: copy.entries },
      {
        target: TARGET,
        record: { tool: "pi-cli", sourceId: "x", sha256: "0", importedAt: "", secrets: 0 },
      },
    );
    const path = await writePiSession(sessionDir, file);
    const manager = SessionManager.open(path, sessionDir, project);
    const context = manager.buildSessionContext();
    expect(context.model).toEqual({ provider: "zeno-fake", modelId: "zeno-fake" });
    // the retried answer is the active one
    expect(context.messages.map((m) => textOf(m as { content: unknown }))).toEqual([
      "Составь план статьи про чай",
      "План: история, сорта, заваривание.",
    ]);
    expect(manager.getSessionId()).not.toBe(copy.header.id);
    expect(manager.getSessionName()).toBe("Статья про чай");
  });

  it("Pi sends the imported tail to the provider without errors", async () => {
    const root = await tempDir();
    const home = join(root, "home");
    const agentDir = join(home, ".pi", "agent");
    const project = join(root, "сайт-пекарни");
    const sessionDir = join(root, "sessions");
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(join(home, ".agents"), { recursive: true }),
      mkdir(project, { recursive: true }),
    ]);
    const { path } = await importedClaudeChat(project, sessionDir);

    const server = new FakeOpenAiServer({ toolPath: join(project, "fixture.txt") });
    await server.start();
    await writeModels(agentDir, server.baseUrl);
    const handle = await createPixRuntime({
      cwd: project,
      agentDir,
      model: { provider: "zeno-fake", id: "zeno-fake" },
      sessionFile: path,
      persistSession: true,
    });
    const errors: string[] = [];
    const unsubscribe = handle.runtime.session.subscribe((event) => {
      if (event.type === "message_end" && "message" in event) {
        const message = event.message as {
          role: string;
          stopReason?: string;
          errorMessage?: string;
        };
        if (message.role === "assistant" && message.stopReason === "error") {
          errors.push(message.errorMessage ?? "error");
        }
      }
    });
    try {
      await handle.runtime.session.prompt("Продолжим: добавь страницу контактов");
      expect(errors).toEqual([]);
      const request = server.requests.at(-1);
      const sent = JSON.stringify(request?.messages ?? []);
      expect(sent).toContain("Перенесённый чат из Claude Code");
      expect(sent).toContain("Добавил prices.html.");
      expect(sent).toContain("Продолжим: добавь страницу контактов");
      // the other agent's thinking and tool output never reach the provider
      expect(sent).not.toContain("Нужно начать с главной.");
      expect(sent).not.toContain("File created");
    } finally {
      unsubscribe();
      await handle.dispose();
      await server.stop();
    }
  }, 60_000);
});
