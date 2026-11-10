import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  MockGatewayServer,
  type MockGatewayTurn,
} from "../../../../packages/test-utils/src/index.ts";
import { installDelegate } from "../../../../packages/prsloy-harness/src/delegate.ts";
import { installBudget } from "../../../../packages/prsloy-harness/src/budget.ts";
import { resolveOptions } from "../../../../packages/prsloy-harness/src/options.ts";
import { runDelegatedWorker } from "./delegated-worker.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function cycle(
  options: {
    verdict?: string;
    workerFinal?: MockGatewayTurn;
    reviewerFinish?: MockGatewayTurn["finishReason"];
    command?: string;
    denyCheck?: boolean;
    changeAfterReview?: boolean;
    enabled?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(process.cwd(), ".delegated-cycle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    outputDir = join(root, "traces");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "prsloy-harness.json"),
    JSON.stringify({ delegate: options.enabled !== false }),
  );
  const command = options.command ?? "grep -qx working result.txt";
  const gateway = new MockGatewayServer({
    apiKey: "test-key",
    modelIds: ["gpt-parent", "kimi-worker", "minimax-review"],
    turns: [
      {
        toolCall: {
          name: "delegate",
          arguments: {
            task: "Write working to result.txt",
            paths: ["result.txt"],
            check: command,
            workerModel: "test/kimi-worker",
            reviewerModel: "test/minimax-review",
          },
        },
      },
      { toolCall: { name: "write", arguments: { path: "result.txt", content: "working\n" } } },
      options.workerFinal ?? { text: "Changed result.txt. Verification pending." },
      ...(options.denyCheck || options.command
        ? []
        : [
            {
              text: options.verdict ?? '{"verdict":"PASS","items":[]}',
              finishReason: options.reviewerFinish ?? "stop",
            },
          ]),
      { text: "A short factual parent summary." },
    ],
  });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        test: {
          baseUrl: gateway.baseUrl,
          apiKey: "test-key",
          api: "openai-completions",
          models: ["gpt-parent", "kimi-worker", "minimax-review"].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
            contextWindow: 32768,
            maxTokens: 8192,
          })),
        },
      },
    }),
  );
  let nestedChecks = 0;
  let result: Record<string, unknown> | undefined;
  const opts = resolveOptions({
    profile: "code",
    settingsPath: join(agentDir, "prsloy-harness.json"),
    outputDir,
    reliability: { attempts: 1 },
  });
  let services: Awaited<ReturnType<typeof createAgentSessionServices>>;
  const extension: ExtensionFactory = (pi) => {
    const budget = installBudget(pi, opts);
    installDelegate(pi, opts, budget, (input) =>
      runDelegatedWorker({ ...input, agentDir, modelRuntime: services.modelRuntime }),
    );
    pi.on("tool_call", (event) => {
      if (event.toolName === "bash" && event.parentToolCallId) {
        nestedChecks++;
        if (options.denyCheck) return { block: true, reason: "Test permission refusal" };
      }
      return undefined;
    });
    pi.on("tool_result", (event) => {
      if (event.toolName === "delegate") {
        const part = event.content.find((c) => c.type === "text");
        if (part?.type === "text") result = JSON.parse(part.text) as Record<string, unknown>;
      }
    });
  };
  services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      cacheWarming: "off",
    }),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [extension],
      systemPrompt: "Complete the test task.",
      appendSystemPrompt: [],
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    },
  });
  const model = services.modelRuntime.getModel("test", "gpt-parent")!;
  const { session } = await createAgentSessionFromServices({
    services,
    model,
    sessionManager: SessionManager.inMemory(cwd),
  });
  cleanups.push(async () => {
    await session.abort();
    session.dispose();
  });
  await session.bindExtensions({ mode: "rpc" });
  if (options.enabled === false) return { session, gateway, result, nestedChecks, cwd };
  await session.prompt("Do the scoped task using delegate.");
  if (!result)
    throw new Error(
      JSON.stringify({
        messages: session.messages,
        requests: gateway.requests.map((r) => r.body.model),
      }),
    );
  return { session, gateway, result, nestedChecks, cwd };
}

describe("first delegated cycle through real SDK", () => {
  it("executes, checks through normal hooks, reviews with another model and returns compact evidence", async () => {
    const run = await cycle();
    expect(run.result?.status).toBe("verified");
    expect(run.nestedChecks).toBe(1);
    expect(await readFile(join(run.cwd, "result.txt"), "utf8")).toBe("working\n");
    expect(run.gateway.requests.map((r) => r.body.model)).toEqual([
      "gpt-parent",
      "kimi-worker",
      "kimi-worker",
      "minimax-review",
      "gpt-parent",
    ]);
    expect(run.result?.modelCalls).toBe(3);
    expect(run.result?.estimatedRub).toBeGreaterThan(0);
    const review = JSON.stringify(run.gateway.requests[3]!.body);
    expect(review).toContain("+working");
    expect(review).not.toContain("Verification pending");
    expect(JSON.stringify(run.result).length).toBeLessThan(2200);
    const trace = JSON.parse(await readFile(run.result!.tracePath as string, "utf8"));
    expect(trace.trace.length).toBeGreaterThan(3);
  }, 30_000);
  it.each([{ denyCheck: true }, { command: "exit 7" }])(
    "cannot verify a denied or failed acceptance command: %j",
    async (options) => {
      const run = await cycle(options);
      expect(run.result?.status).toBe("unverified");
      expect(run.gateway.requests.some((r) => r.body.model === "minimax-review")).toBe(false);
    },
    30_000,
  );
  it("does not turn a malformed FAIL review into success", async () => {
    const run = await cycle({ verdict: '{"verdict":"FAIL","items":[]}' });
    expect(run.result?.status).toBe("unverified");
  }, 30_000);
  it.each<MockGatewayTurn>([
    { reasoning: "I still need to summarize the change." },
    { text: "Changed result.txt, but", finishReason: "length" },
  ])(
    "keeps partial edits and stops when the executor has no complete summary: %j",
    async (workerFinal) => {
      const run = await cycle({ workerFinal });
      expect(run.result?.status).toBe("failed");
      expect(run.result?.error).toContain("final summary");
      expect(run.result?.files).toEqual(["result.txt"]);
      expect(await readFile(join(run.cwd, "result.txt"), "utf8")).toBe("working\n");
      expect(run.nestedChecks).toBe(0);
      expect(run.gateway.requests.some((r) => r.body.model === "minimax-review")).toBe(false);
    },
    30_000,
  );
  it("does not accept a valid-looking PASS from a truncated review", async () => {
    const run = await cycle({ reviewerFinish: "length" });
    expect(run.nestedChecks).toBe(1);
    expect(run.result?.status).toBe("unverified");
    expect(run.result?.error).toContain("length");
  }, 30_000);
  it("keeps delegation unavailable by default/when disabled", async () => {
    const run = await cycle({ enabled: false });
    expect(run.session.getActiveToolNames()).not.toContain("delegate");
    expect(run.gateway.requests).toHaveLength(0);
  }, 30_000);
});
