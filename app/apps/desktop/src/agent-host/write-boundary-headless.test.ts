/**
 * A session nobody can answer (bench, scripts: createPixRuntime without
 * onExtensionUiRequest) refuses a write outside the project at once, with a line the
 * model understands; a host that answers synchronously gets its answer through.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPixRuntime, type ZenoRuntimeHandle } from "@zeno/agent-runtime";
import { FakeOpenAiServer } from "../../../../packages/test-utils/src/index.ts";
import { ANSWER_NO, createWriteBoundary, NO_UI_NOTE } from "./write-boundary.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(outsidePath: (root: string) => string) {
  const root = mkdtempSync(join(process.cwd(), ".wb-headless-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  const server = new FakeOpenAiServer({
    toolPath: join(project, "x.txt"),
    toolCall: { name: "write", arguments: { path: outsidePath(root), content: "x" } },
  });
  await server.start();
  cleanups.push(() => server.stop());
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "zeno-fake": {
          baseUrl: server.baseUrl,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [
            {
              id: "zeno-fake",
              name: "Fake",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8192,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  return { root, agentDir, project };
}

function toolResults(handle: ZenoRuntimeHandle): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  handle.runtime.session.subscribe((event) => {
    if (event.type !== "tool_execution_end") return;
    const content = (event.result as { content?: { text?: string }[] })?.content ?? [];
    out.push({ text: content.map((p) => p.text ?? "").join(""), at: Date.now() });
  });
  return out;
}

describe("write boundary without anyone to ask", () => {
  it("refuses a write outside the project in well under a second", async () => {
    const { agentDir, project } = await setup((root) => join(root, "elsewhere", "a.txt"));
    const handle = await createPixRuntime({
      cwd: project,
      agentDir,
      model: { provider: "zeno-fake", id: "zeno-fake" },
      tools: ["write"],
      extensionFactories: [createWriteBoundary({ agentDir })],
    });
    cleanups.push(() => handle.dispose());
    const results = toolResults(handle);
    const started = Date.now();
    await handle.runtime.session.prompt("use the tool");
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toContain(NO_UI_NOTE);
    expect(results[0]!.at - started).toBeLessThan(1000);
  }, 30_000);

  it("a host that answers synchronously is heard (bench answers «Нет» inline)", async () => {
    const { agentDir, project } = await setup((root) => join(root, "elsewhere", "a.txt"));
    let handle: ZenoRuntimeHandle | undefined;
    let asked = 0;
    handle = await createPixRuntime({
      cwd: project,
      agentDir,
      model: { provider: "zeno-fake", id: "zeno-fake" },
      tools: ["write"],
      extensionFactories: [createWriteBoundary({ agentDir })],
      onExtensionUiRequest: (request) => {
        if (request.method !== "select") return;
        asked += 1;
        handle?.respondExtensionUi({
          runtimeId: request.runtimeId,
          requestId: request.requestId,
          ok: true,
          value: ANSWER_NO,
        });
      },
    });
    cleanups.push(() => handle?.dispose());
    const results = toolResults(handle);
    const started = Date.now();
    await handle.runtime.session.prompt("use the tool");
    expect(asked).toBe(1);
    expect(results[0]!.text).toContain("Пользователь не разрешил");
    expect(results[0]!.at - started).toBeLessThan(1000);
  }, 30_000);

  it("the system temp dir needs no answer", async () => {
    const { agentDir, project } = await setup(() =>
      join(tmpdir(), `prsloy-wb-${process.pid}`, "a.txt"),
    );
    cleanups.push(() =>
      rmSync(join(tmpdir(), `prsloy-wb-${process.pid}`), { recursive: true, force: true }),
    );
    const handle = await createPixRuntime({
      cwd: project,
      agentDir,
      model: { provider: "zeno-fake", id: "zeno-fake" },
      tools: ["write"],
      extensionFactories: [createWriteBoundary({ agentDir })],
    });
    cleanups.push(() => handle.dispose());
    const results = toolResults(handle);
    await handle.runtime.session.prompt("use the tool");
    expect(results[0]!.text).not.toContain(NO_UI_NOTE);
  }, 30_000);
});
