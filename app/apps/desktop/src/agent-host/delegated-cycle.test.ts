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
    workerRetryChanges?: boolean;
    reviewerRetry?: MockGatewayTurn;
    expectReviewerRetry?: boolean;
    command?: string;
    denyCheck?: boolean;
    changeAfterReview?: boolean;
    enabled?: boolean;
    invalidDelegatePath?: boolean;
    workerReadOutsideScope?: boolean;
    lessons?: boolean;
    explicitKimi?: boolean;
    bashBeforeDelegate?: boolean;
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
  if (options.explicitKimi) {
    await writeFile(join(cwd, "result.txt"), "unfinished\n");
    await writeFile(
      join(cwd, "acceptance.mjs"),
      'import { readFileSync } from "node:fs";\nif (readFileSync("result.txt", "utf8").trim() !== "working") process.exit(1);\n',
    );
  }
  await writeFile(
    join(agentDir, "prsloy-harness.json"),
    JSON.stringify({ delegate: options.enabled !== false, lessons: options.lessons !== false }),
  );
  const command = options.command ?? "grep -qx working result.txt";
  const patch: MockGatewayTurn = {
    toolCall: { name: "write", arguments: { path: "result.txt", content: "working\n" } },
  };
  const workerDone: MockGatewayTurn = { text: "Changed result.txt. Verification pending." };
  const pass = '{"verdict":"PASS","items":[]}';
  const gateway = new MockGatewayServer({
    apiKey: "test-key",
    modelIds: ["gpt-parent", "kimi-worker", "minimax-review"],
    turns: [
      ...(options.bashBeforeDelegate
        ? [{ toolCall: { name: "bash", arguments: { command: "echo premature > bad.txt" } } }]
        : []),
      {
        toolCall: {
          name: "delegate",
          arguments: options.explicitKimi
            ? {}
            : {
                task: "Write working to result.txt",
                paths: [options.invalidDelegatePath ? "./result.txt" : "result.txt"],
                check: command,
                workerModel: "test/kimi-worker",
                reviewerModel: "test/minimax-review",
              },
        },
      },
      ...(options.explicitKimi
        ? [{ text: '{"paths":["result.txt"],"checkFile":"acceptance.mjs"}' }]
        : []),
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
            ...(options.noWorkerChanges ? [] : [patch]),
            options.workerFinal ?? workerDone,
            ...(options.noWorkerChanges
              ? options.workerRetryChanges
                ? [patch, workerDone]
                : [options.workerFinal ?? workerDone]
              : []),
            ...(options.denyCheck ||
            options.command ||
            (options.noWorkerChanges && !options.workerRetryChanges)
              ? []
              : [
                  {
                    text: options.verdict ?? pass,
                    finishReason: options.reviewerFinish ?? "stop",
                  },
                  ...(options.expectReviewerRetry ? [options.reviewerRetry ?? { text: pass }] : []),
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
  if (options.enabled === false && !options.explicitKimi)
    return { session, gateway, result, nestedChecks, cwd, learningEvents };
  await session.prompt(
    options.explicitKimi
      ? "Запиши working в result.txt. Пусть Кими сделает правку, затем прогони acceptance.mjs."
      : "Do the scoped task using delegate.",
  );
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
  it.each([false, true])(
    "routes a named worker through Kimi before shell, even if the parent tries bash (%s)",
    async (bashBeforeDelegate) => {
      const run = await cycle({ explicitKimi: true, enabled: false, bashBeforeDelegate });
      expect(run.result?.status, JSON.stringify(run.result)).toBe("verified");
      expect(run.result?.worker).toBe("test/kimi-worker");
      expect(run.result?.reviewer).toBe("test/gpt-parent");
      expect(run.nestedChecks).toBe(1);
      await expect(readFile(join(run.cwd, "bad.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      const requests = run.gateway.requests.map((request) => request.body);
      const dispatch = requests[Number(bashBeforeDelegate)]!;
      expect(dispatch.tool_choice).toBe("required");
      expect(dispatch.tools).toMatchObject([{ function: { name: "delegate" } }]);
      expect(requests.map((request) => request.model)).toEqual([
        ...(bashBeforeDelegate ? ["gpt-parent"] : []),
        "gpt-parent",
        "kimi-worker",
        "kimi-worker",
        "kimi-worker",
        "gpt-parent",
        "gpt-parent",
      ]);
      expect(requests.at(-1)?.tools ?? []).toEqual([]);
    },
    30_000,
  );

  it("executes, checks through normal hooks, reviews with another model and returns compact evidence", async () => {
    const run = await cycle();
    expect(run.result?.status).toBe("verified");
    expect(run.learningEvents.map(({ event }) => event)).toContainEqual({
      kind: "delegate.verified",
      sig: "check-review",
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
    expect(review).toContain("+ [L1] working");
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
    const verdict = '{"verdict":"FAIL","items":[]}';
    const run = await cycle({
      verdict,
      expectReviewerRetry: true,
      reviewerRetry: { text: verdict },
    });
    expect(run.result?.status).toBe("unverified");
    expect(run.gateway.requests.filter((r) => r.body.model === "minimax-review")).toHaveLength(2);
    expect(run.nestedChecks).toBe(1);
  }, 30_000);
  it.each([{ verdict: '{"verdict":"FAIL","items":[]}' }, { reviewerFinish: "length" as const }])(
    "retries only the reviewer on the original patch and check after an invalid verdict: %j",
    async (options) => {
      const run = await cycle({ ...options, expectReviewerRetry: true });
      expect(run.result?.status).toBe("verified");
      expect(run.result?.workerRetries).toBe(0);
      expect(run.result?.reviewerRetries).toBe(1);
      expect(run.nestedChecks).toBe(1);
      expect(run.gateway.requests.map((r) => r.body.model)).toEqual([
        "gpt-parent",
        "kimi-worker",
        "kimi-worker",
        "minimax-review",
        "minimax-review",
        "gpt-parent",
      ]);
      const firstMessages = run.gateway.requests[3]?.body.messages;
      const retryMessages = run.gateway.requests[4]?.body.messages;
      if (!Array.isArray(firstMessages) || !Array.isArray(retryMessages))
        throw new Error("Expected OpenAI-compatible reviewer messages");
      expect(firstMessages.at(-1)?.content).toEqual(retryMessages.at(-1)?.content);
    },
    30_000,
  );
  it("keeps an evidence-backed rejection and does not ask for a second opinion", async () => {
    const verdict = JSON.stringify({
      verdict: "FAIL",
      items: [
        {
          id: "L1",
          problem: "Specific defect in the patch",
        },
      ],
    });
    const run = await cycle({ verdict });
    expect(run.result?.status).toBe("needs_changes");
    expect(run.result?.findings).toEqual([
      { file: "result.txt", line: 1, problem: "Specific defect in the patch", evidence: "working" },
    ]);
    expect(run.result?.reviewerRetries).toBe(0);
    expect(run.gateway.requests.filter((r) => r.body.model === "minimax-review")).toHaveLength(1);
  }, 30_000);
  it("resolves a corrected review ID against the original patch after an unknown ID", async () => {
    const finding = (id: string) =>
      JSON.stringify({
        verdict: "FAIL",
        items: [{ id, problem: "Specific defect in the patch" }],
      });
    const run = await cycle({
      verdict: finding("L999"),
      expectReviewerRetry: true,
      reviewerRetry: { text: finding("L1") },
    });
    expect(run.result?.status).toBe("needs_changes");
    expect(run.result?.findings).toEqual([
      { file: "result.txt", line: 1, problem: "Specific defect in the patch", evidence: "working" },
    ]);
    expect(run.result?.reviewerRetries).toBe(1);
    expect(run.result?.workerRetries).toBe(0);
    expect(run.nestedChecks).toBe(1);
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
    const run = await cycle({
      reviewerFinish: "length",
      expectReviewerRetry: true,
      reviewerRetry: { text: '{"verdict":"PASS","items":[]}', finishReason: "length" },
    });
    expect(run.nestedChecks).toBe(1);
    expect(run.result?.status).toBe("unverified");
    expect(run.result?.error).toContain("length");
    expect(run.result?.reviewerRetries).toBe(1);
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
    expect(run.result?.modelCalls).toBe(2);
    expect(run.result?.estimatedRub).toBeGreaterThan(0);
    expect(run.result?.reservedRub).toBe(0);
    expect(run.result?.accounting).toBe("catalogue_estimate");
    expect(run.gateway.requests.some((r) => r.body.model === "minimax-review")).toBe(false);
  }, 30_000);
  it("retries the executor once with feedback, then checks and reviews a scoped patch", async () => {
    const run = await cycle({
      noWorkerChanges: true,
      workerRetryChanges: true,
      workerFinal: { text: "I checked the task but did not change anything." },
    });
    expect(run.result?.status).toBe("verified");
    expect(run.result?.workerRetries).toBe(1);
    expect(run.result?.reviewerRetries).toBe(0);
    expect(run.nestedChecks).toBe(1);
    expect(run.result?.files).toEqual(["result.txt"]);
    const workers = run.gateway.requests.filter((r) => r.body.model === "kimi-worker");
    expect(workers).toHaveLength(3);
    expect(JSON.stringify(workers[1]?.body.messages)).toContain(
      "Previous worker attempt made no changes",
    );
    expect(run.gateway.requests.filter((r) => r.body.model === "minimax-review")).toHaveLength(1);
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
  it("lets the normal worker recover from an unlisted read and complete its scoped edit", async () => {
    const run = await cycle({ workerReadOutsideScope: true });
    expect(run.result?.status).toBe("verified");
    expect(JSON.stringify(run.gateway.requests)).toContain("WORKER_READ_SCOPE");
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
