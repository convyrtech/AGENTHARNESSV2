import { createServer } from "node:http";
import { once } from "node:events";
import { link, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  MockGatewayServer,
  type MockGatewayTurn,
} from "../../../../packages/test-utils/src/index.ts";
import {
  runDelegatedWorker,
  type DelegatedWorkerAssistant,
  type DelegatedWorkerOptions,
} from "./delegated-worker.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(turns: MockGatewayTurn[] = [], baseUrl?: string) {
  const root = await mkdtemp(join(process.cwd(), ".delegated-worker-"));
  cleanups.push(async () => {
    if (
      !resolve(root).startsWith(`${resolve(process.cwd())}\\.delegated-worker-`) &&
      !resolve(root).startsWith(`${resolve(process.cwd())}/.delegated-worker-`)
    )
      throw new Error("Unexpected test cleanup root");
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "project");
  const agentDir = join(root, "user-data", "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const gateway = new MockGatewayServer({ apiKey: "test-key", modelIds: ["worker-test"], turns });
  await gateway.start();
  cleanups.push(() => gateway.stop());
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "worker-test": {
          baseUrl: baseUrl ?? gateway.baseUrl,
          apiKey: "test-key",
          api: "openai-completions",
          models: [
            {
              id: "worker-test",
              name: "Worker test",
              reasoning: false,
              input: ["text"],
              cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
              contextWindow: 32768,
              maxTokens: 16384,
            },
          ],
        },
      },
    }),
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel("worker-test", "worker-test");
  if (!model) throw new Error("Missing fake model");
  const controller = new AbortController();
  const usage: DelegatedWorkerAssistant[] = [];
  const options: DelegatedWorkerOptions = {
    cwd,
    agentDir,
    modelRuntime,
    model,
    files: ["result.txt"],
    task: "Write the requested file.",
    signal: controller.signal,
    admit: (payload) => payload,
    onUsage: (reply) => usage.push(reply),
  };
  return { root, cwd, agentDir, gateway, controller, usage, options };
}

describe("isolated delegated worker", () => {
  it("writes an explicit file with real SDK tools, caps output and reports each response once", async () => {
    const f = await fixture([
      { toolCall: { name: "write", arguments: { path: "result.txt", content: "working" } } },
      { text: "Changed result.txt; checks are pending." },
    ]);
    const result = await runDelegatedWorker(f.options);
    expect(result.status, result.error).toBe("completed");
    expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("working");
    expect(result.requests).toBe(2);
    expect(f.usage).toHaveLength(2);
    for (const request of f.gateway.requests) {
      expect(request.body.max_tokens ?? request.body.max_completion_tokens).toBeLessThanOrEqual(
        8192,
      );
      const tools = request.body.tools as Array<{ function: { name: string } }>;
      expect(tools.map((t) => t.function.name).sort()).toEqual(["edit", "read", "write"]);
    }
  }, 30_000);

  it("does not inherit project/global instructions, skills, prompts or extensions", async () => {
    const f = await fixture([{ text: "scoped answer" }]);
    for (const dir of [f.agentDir, join(f.cwd, ".pi")]) {
      await mkdir(join(dir, "extensions"), { recursive: true });
      await mkdir(join(dir, "skills", "sentinel"), { recursive: true });
      await writeFile(join(dir, "SYSTEM.md"), "GLOBAL_SYSTEM_SENTINEL");
      await writeFile(join(dir, "APPEND_SYSTEM.md"), "GLOBAL_APPEND_SENTINEL");
      await writeFile(
        join(dir, "skills", "sentinel", "SKILL.md"),
        "---\nname: sentinel\ndescription: GLOBAL_SKILL_SENTINEL\n---\nsecret",
      );
      await writeFile(
        join(dir, "extensions", "sentinel.ts"),
        'throw new Error("GLOBAL_EXTENSION_EXECUTED");',
      );
      await writeFile(
        join(dir, "settings.json"),
        JSON.stringify({ shellCommandPrefix: "GLOBAL_SETTINGS_SENTINEL" }),
      );
    }
    await writeFile(join(f.cwd, "AGENTS.md"), "PROJECT_CONTEXT_SENTINEL");
    await writeFile(join(f.agentDir, "AGENTS.md"), "GLOBAL_CONTEXT_SENTINEL");
    const result = await runDelegatedWorker(f.options);
    expect(result.status).toBe("completed");
    expect(JSON.stringify(f.gateway.requests)).not.toMatch(/GLOBAL_|PROJECT_CONTEXT_SENTINEL/);
  }, 30_000);

  it("refuses an out-of-scope read before its content reaches the model", async () => {
    const f = await fixture([
      { toolCall: { name: "read", arguments: { path: "other.txt" } } },
      { toolCall: { name: "write", arguments: { path: "result.txt", content: "recovered" } } },
      { text: "Changed the requested file." },
    ]);
    await writeFile(join(f.cwd, "other.txt"), "UNSCOPED_SECRET");
    const result = await runDelegatedWorker(f.options);
    expect(result.status).toBe("completed");
    expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("recovered");
    expect(JSON.stringify(f.gateway.requests)).not.toContain("UNSCOPED_SECRET");
    expect(JSON.stringify(f.gateway.requests[1]?.body.messages)).toContain("WORKER_READ_SCOPE");
  }, 30_000);

  it("returns a tool error for reading a directory and lets the worker continue", async () => {
    const f = await fixture([
      { toolCall: { name: "read", arguments: { path: "folder" } } },
      { toolCall: { name: "write", arguments: { path: "result.txt", content: "recovered" } } },
      { text: "Changed the requested file." },
    ]);
    await mkdir(join(f.cwd, "folder"));
    await writeFile(join(f.cwd, "folder", "secret.txt"), "DIRECTORY_SECRET");
    const result = await runDelegatedWorker(f.options);
    expect(result.status).toBe("completed");
    expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("recovered");
    expect(JSON.stringify(f.gateway.requests)).not.toContain("DIRECTORY_SECRET");
    expect(JSON.stringify(f.gateway.requests[1]?.body.messages)).toContain("WORKER_READ_DIRECTORY");
  }, 30_000);

  it.each([
    {
      name: "write",
      arguments: { path: "other.txt", content: "REPLACEMENT" },
    },
    {
      name: "edit",
      arguments: {
        path: "other.txt",
        edits: [{ oldText: "UNSCOPED_WRITE_FILE_SENTINEL_9F", newText: "REPLACEMENT" }],
      },
    },
  ])(
    "keeps a denied in-project $name fatal",
    async (toolCall) => {
      const f = await fixture([{ toolCall }]);
      await writeFile(join(f.cwd, "other.txt"), "UNSCOPED_WRITE_FILE_SENTINEL_9F");
      const result = await runDelegatedWorker(f.options);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("explicit scope");
      expect(await readFile(join(f.cwd, "other.txt"), "utf8")).toBe(
        "UNSCOPED_WRITE_FILE_SENTINEL_9F",
      );
      expect(f.gateway.requests).toHaveLength(1);
      expect(JSON.stringify(f.gateway.requests)).not.toContain("UNSCOPED_WRITE_FILE_SENTINEL_9F");
    },
    30_000,
  );

  it("rejects outside paths and hardlinked files before requesting the model", async () => {
    const f = await fixture();
    expect((await runDelegatedWorker({ ...f.options, files: ["../outside.txt"] })).status).toBe(
      "failed",
    );
    await mkdir(join(f.cwd, "scope-directory"));
    expect((await runDelegatedWorker({ ...f.options, files: ["scope-directory"] })).status).toBe(
      "failed",
    );
    await writeFile(join(f.cwd, "original.txt"), "unchanged");
    await link(join(f.cwd, "original.txt"), join(f.cwd, "result.txt"));
    const result = await runDelegatedWorker(f.options);
    expect(result.error).toContain("hard links");
    expect(f.gateway.requests).toHaveLength(0);
  }, 30_000);

  it("rechecks a directory replaced by a junction after admission", async () => {
    const f = await fixture([
      { toolCall: { name: "write", arguments: { path: "sub/result.txt", content: "bad" } } },
    ]);
    await mkdir(join(f.cwd, "sub"));
    await mkdir(join(f.root, "outside"));
    await writeFile(join(f.root, "outside", "result.txt"), "unchanged");
    const result = await runDelegatedWorker({
      ...f.options,
      files: ["sub/result.txt"],
      admit: async (payload) => {
        await rmdir(join(f.cwd, "sub"));
        await symlink(join(f.root, "outside"), join(f.cwd, "sub"), "junction");
        return payload;
      },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("symbolic links");
    expect(f.gateway.requests).toHaveLength(1);
    expect(await readFile(join(f.root, "outside", "result.txt"), "utf8")).toBe("unchanged");
  }, 30_000);

  it("a denied admission makes zero HTTP requests", async () => {
    const f = await fixture();
    const result = await runDelegatedWorker({
      ...f.options,
      admit: () => {
        throw new Error("budget exhausted");
      },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("budget exhausted");
    expect(result.requests).toBe(0);
    expect(f.gateway.requests).toHaveLength(0);
  }, 30_000);

  it("stops before a second model request and retains completed edits", async () => {
    const f = await fixture([
      { toolCall: { name: "write", arguments: { path: "result.txt", content: "partial" } } },
    ]);
    const result = await runDelegatedWorker({ ...f.options, maxRequests: 1 });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("request limit");
    expect(f.gateway.requests).toHaveLength(1);
    expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("partial");
  }, 30_000);

  it("cancels an in-flight request and settles before returning", async () => {
    let received!: () => void;
    const requested = new Promise<void>((resolveRequest) => {
      received = resolveRequest;
    });
    const server = createServer((_request, _response) => {
      received();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port");
    const f = await fixture([], `http://127.0.0.1:${address.port}/v1`);
    const pending = runDelegatedWorker(f.options);
    await requested;
    f.controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.requests).toBe(1);
  }, 30_000);

  it("does not retry a provider 503", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts++;
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unavailable" } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server port");
    const f = await fixture([], `http://127.0.0.1:${address.port}/v1`);
    const result = await runDelegatedWorker(f.options);
    expect(result.status).toBe("failed");
    expect(result.requests).toBe(1);
    expect(attempts).toBe(1);
  }, 30_000);
});
