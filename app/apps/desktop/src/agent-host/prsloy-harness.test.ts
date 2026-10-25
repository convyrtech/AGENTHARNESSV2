/**
 * The agent host loads @prsloy/harness for every session (extensionFactories, bundled
 * into the host so it survives asar). Prove it end to end with the fake model: a bash
 * tool result reaches the model with the harness header `[exit 0 · … ]`, also after
 * a new session.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPixRuntime } from "@zeno/agent-runtime";
import { createPrsloyHarness } from "@prsloy/harness";
import { FakeOpenAiServer } from "../../../../packages/test-utils/src/index.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Msg = { role?: string; content?: unknown };
const text = (m: Msg | undefined) =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
      ? (m.content as { text?: string }[]).map((p) => p.text ?? "").join("")
      : "";

describe.skipIf(process.platform === "win32")("prsloy harness in host sessions", () => {
  it("adds the harness header to bash tool results", async () => {
    const root = mkdtempSync(join(tmpdir(), "prsloy-harness-host-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    const toolPath = join(project, "fixture.txt");
    writeFileSync(toolPath, "fixture\n");

    const server = new FakeOpenAiServer({
      toolPath,
      toolCall: { name: "bash", arguments: { command: "echo harness-ok" } },
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

    const previousProfile = process.env.PRSLOY_PROFILE;
    process.env.PRSLOY_PROFILE = "code"; // main sets this in the host env
    cleanups.push(() => {
      if (previousProfile === undefined) delete process.env.PRSLOY_PROFILE;
      else process.env.PRSLOY_PROFILE = previousProfile;
    });

    // Same options agent-host/index.ts passes on host.start.
    const handle = await createPixRuntime({
      cwd: project,
      agentDir,
      model: { provider: "zeno-fake", id: "zeno-fake" },
      tools: ["read", "bash"],
      extensionFactories: [createPrsloyHarness()],
      contextFilesRequireTrust: true,
    });
    cleanups.push(() => handle.dispose());

    const toolOutputs: string[] = [];
    handle.runtime.session.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        const content = (event.result as { content?: { text?: string }[] })?.content ?? [];
        toolOutputs.push(content.map((p) => p.text ?? "").join(""));
      }
    });

    await handle.runtime.session.prompt("run the tool please");
    const toolMessage = (server.requests.at(-1)?.messages ?? []).find((m) => m.role === "tool");
    expect(text(toolMessage)).toMatch(/^\[exit 0 · [^\]]+\]\nharness-ok/u);
    expect(toolOutputs.at(-1)).toMatch(/^\[exit 0 · /u);

    // Still loaded after session replacement.
    await handle.newSession();
    await handle.runtime.session.prompt("tool again");
    const again = (server.requests.at(-1)?.messages ?? []).find((m) => m.role === "tool");
    expect(text(again)).toMatch(/^\[exit 0 · /u);
  });
});
