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
import { installLessons } from "../../../../packages/prsloy-harness/src/lessons.ts";
import {
  configureLearning,
  onLearningEvent,
  type LearningEvent,
} from "../../../../packages/prsloy-harness/src/learning-log.ts";
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
    noWorkerChanges?: boolean;
    command?: string;
    denyCheck?: boolean;
    changeAfterReview?: boolean;
    enabled?: boolean;
    invalidDelegatePath?: boolean;
    workerReadOutsideScope?: boolean;
    lessons?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(process.cwd(), ".delegated-cycle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  configureLearning({ dir: join(root, "learning"), enabled: true });
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    outputDir = join(root, "traces");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "prsloy-harness.json"),
    JSON.stringify({ delegate: options.enabled !== false, lessons: options.lessons !== false }),
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
            paths: [options.invalidDelegatePath ? "./result.txt" : "result.txt"],
            check: command,
            workerModel: "test/kimi-worker",
            reviewerModel: "test/minimax-review",
          },
        },
      },
      ...(options.invalidDelegatePath
        ? [{ text: "The delegate request was rejected. I should report the path issue." }]
        : [
            ...(options.workerReadOutsideScope
              ? [
                  {
                    toolCall: {
                      name: "read",
                      arguments: { path: "unlisted-check.mjs" },
                    },
                  },
                ]
              : []),
            ...(options.noWorkerChanges
              ? []
              : [
                  {
                    toolCall: {
                      name: "write",
                      arguments: { path: "result.txt", content: "working\n" },
                    },
                  },
                ]),
            options.workerFinal ?? { text: "Changed result.txt. Verification pending." },
            ...(options.denyCheck || options.command || options.noWorkerChanges
              ? []
              : [
                  {
                    text: options.verdict ?? '{"verdict":"PASS","items":[]}',
                    finishReason: options.reviewerFinish ?? "stop",
                  },
                ]),
            { text: "A short factual parent summary." },
          ]),
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
  const learningEvents: Array<{ session: string; event: LearningEvent }> = [];
  const stopLearningEvents = onLearningEvent((session, event) =>
    learningEvents.push({ session, event }),
  );
  const opts = resolveOptions({
    profile: "code",
    settingsPath: join(agentDir, "prsloy-harness.json"),
    outputDir,
    reliability: { attempts: 1 },
  });
  let services: Awaited<ReturnType<typeof createAgentSessionServices>>;
  const extension: ExtensionFactory = (pi) => {
    const budget = installBudget(pi, opts);
    installLessons(pi, {
      settingsPath: opts.settingsPath,
      countersPath: join(root, "lessons.json"),
    });
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
    stopLearningEvents();
    await session.abort();
    session.dispose();
  });
  await session.bindExtensions({ mode: "rpc" });
  if (options.enabled === false)
    return { session, gateway, result, nestedChecks, cwd, learningEvents };
  await session.prompt("Do the scoped task using delegate.");
  if (!result)
    throw new Error(
      JSON.stringify({
        messages: session.messages,
        requests: gateway.requests.map((r) => r.body.model),
      }),
    );
  return { session, gateway, result, nestedChecks, cwd, learningEvents };
}

describe("first delegated cycle through real SDK", () => {
  it("executes, checks through normal hooks, reviews with another model and returns compact evidence", async () => {
    const run = await cycle();
    expect(run.result?.status).toBe("verified");
    expect(run.learningEvents.map(({ event }) => event)).toContainEqual({
      kind: "delegate.verified",
      sig: "check-review",
      scope: expect.stringMatching(/^[a-f0-9]{32}$/u),
    });
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
  it("reports no changes and skips the check and reviewer when the worker only returns a summary", async () => {
    const run = await cycle({
      noWorkerChanges: true,
      workerFinal: { text: "I checked the task but didn't change anything." },
    });
    expect(run.result?.status).toBe("unverified");
    expect(run.result?.files).toEqual([]);
    expect(run.nestedChecks).toBe(0);
    expect(run.result?.error).toBe("Worker did not change any delegated files");
    expect(run.result?.modelCalls).toBe(1);
    expect(run.result?.estimatedRub).toBeGreaterThan(0);
    expect(run.result?.reservedRub).toBe(0);
    expect(run.result?.accounting).toBe("catalogue_estimate");
    expect(run.gateway.requests.some((r) => r.body.model === "minimax-review")).toBe(false);
  }, 30_000);
  it("returns a relative-path lesson for an invalid delegate path and logs no path", async () => {
    const run = await cycle({ invalidDelegatePath: true });
    expect(run.result?.status).toBe("failed");
    expect(run.result?.error).toBe("Invalid delegate path");
    expect(run.result?.lesson).toContain("normalized project-relative paths");
    expect(run.gateway.requests).toHaveLength(2);
    expect(run.learningEvents.map(({ event }) => event)).toContainEqual({
      kind: "delegate.path",
      tool: "delegate",
      sig: "invalid",
      lessons: ["L-delegate-relative-paths"],
    });
    expect(JSON.stringify(run.learningEvents)).not.toContain("result.txt");
  }, 30_000);
  it("returns the file-scope lesson through the normal worker and logs a fixed event code", async () => {
    const run = await cycle({ workerReadOutsideScope: true });
    expect(run.result?.status).toBe("failed");
    expect(run.result?.error).toBe("Worker file is outside its explicit scope");
    expect(run.result?.lesson).toContain("worker should not read or run the acceptance check");
    expect(run.learningEvents.map(({ event }) => event)).toContainEqual({
      kind: "delegate.scope",
      tool: "delegate",
      sig: "worker-outside-scope",
      lessons: ["L-delegate-scope-and-check"],
    });
    expect(JSON.stringify(run.learningEvents)).not.toContain("unlisted-check.mjs");
  }, 30_000);
  it("records a normalized delegate failure without guidance when lessons are disabled", async () => {
    const run = await cycle({ invalidDelegatePath: true, lessons: false });
    expect(run.result?.error).toBe("Invalid delegate path");
    expect(run.result?.lesson).toBeUndefined();
    expect(run.learningEvents.map(({ event }) => event)).toContainEqual({
      kind: "delegate.path",
      tool: "delegate",
      sig: "invalid",
    });
  }, 30_000);
  it("keeps delegation unavailable by default/when disabled", async () => {
    const run = await cycle({ enabled: false });
    expect(run.session.getActiveToolNames()).not.toContain("delegate");
    expect(run.gateway.requests).toHaveLength(0);
  }, 30_000);
});
