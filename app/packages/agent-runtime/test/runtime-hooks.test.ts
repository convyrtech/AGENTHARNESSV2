import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createPixRuntime,
  filterUntrustedContextFiles,
  hasProjectContextFiles,
  setContextFilesRequireTrust,
} from "../src/index.ts";
import { MockGatewayServer } from "../../test-utils/src/index.ts";

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zeno-hooks-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(project, { recursive: true })]);
  return { root, agentDir, project };
}

async function writeKeylessModels(agentDir: string, baseUrl: string): Promise<void> {
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        gw: {
          baseUrl,
          api: "openai-completions",
          compat: {
            supportsDeveloperRole: false,
            supportsStore: false,
            maxTokensField: "max_tokens",
          },
          models: [
            {
              id: "gw-model",
              name: "Gateway model",
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
}

afterEach(async () => {
  setContextFilesRequireTrust(false);
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("runtime api keys", () => {
  it("authenticates a keyless models.json provider with the runtime key only", async () => {
    const paths = await fixture();
    const server = new MockGatewayServer({ apiKey: "runtime-secret", turns: [{ text: "hi" }] });
    await server.start();
    try {
      await writeKeylessModels(paths.agentDir, server.baseUrl);
      const handle = await createPixRuntime({
        cwd: paths.project,
        agentDir: paths.agentDir,
        model: { provider: "gw", id: "gw-model" },
        tools: ["read"],
        runtimeApiKeys: { gw: "runtime-secret" },
      });
      try {
        await handle.runtime.session.prompt("hello");
        expect(server.requests).toHaveLength(1);
        expect(server.requests[0]!.headers.authorization).toBe("Bearer runtime-secret");
        const body = server.requests[0]!.body;
        expect(body.max_tokens).toBeTypeOf("number");
        expect(body.max_completion_tokens).toBeUndefined();
        const roles = (body.messages as { role: string }[]).map((m) => m.role);
        expect(roles).not.toContain("developer");
      } finally {
        await handle.dispose();
      }
      // Key never lands on disk.
      const { readdir, readFile } = await import("node:fs/promises");
      for (const name of await readdir(paths.agentDir)) {
        if (!name.endsWith(".json")) continue;
        expect(await readFile(join(paths.agentDir, name), "utf8")).not.toContain("runtime-secret");
      }
    } finally {
      await server.stop();
    }
  });
});

describe("extension paths", () => {
  it("loads extra extension sources for every session", async () => {
    const paths = await fixture();
    const extension = join(paths.root, "harness-ext.ts");
    await writeFile(extension, "export default function (_pi: unknown) {}\n");
    const handle = await createPixRuntime({
      cwd: paths.project,
      agentDir: paths.agentDir,
      tools: ["read"],
      extensionPaths: [extension],
    });
    try {
      expect(handle.snapshot().resources.extensions).toBe(1);
      await handle.newSession();
      expect(handle.snapshot().resources.extensions).toBe(1);
    } finally {
      await handle.dispose();
    }
  });
});

describe("context files require trust", () => {
  it("detects project AGENTS.md / CLAUDE.md but not files inside agentDir", async () => {
    const paths = await fixture();
    const getFixtureContextFiles = async () => {
      const handle = await createPixRuntime({ cwd: paths.project, agentDir: paths.agentDir });
      try {
        const allFiles = handle.runtime.services.resourceLoader.getAgentsFiles().agentsFiles;
        // Filter to project dir only, not agentDir
        return allFiles.filter((f) => f.path.startsWith(paths.project));
      } finally {
        await handle.dispose();
      }
    };
    expect((await getFixtureContextFiles()).length).toBe(0);
    expect(hasProjectContextFiles(paths.project, paths.agentDir)).toBe(false);
    await writeFile(join(paths.agentDir, "AGENTS.md"), "global\n");
    expect((await getFixtureContextFiles()).length).toBe(0);
    expect(hasProjectContextFiles(paths.project, paths.agentDir)).toBe(false);
    await writeFile(join(paths.project, "CLAUDE.md"), "project\n");
    expect((await getFixtureContextFiles()).length).toBe(1);
    expect(hasProjectContextFiles(paths.project, paths.agentDir)).toBe(true);
    expect(
      filterUntrustedContextFiles(
        [{ path: join(paths.agentDir, "AGENTS.md") }, { path: join(paths.project, "CLAUDE.md") }],
        paths.agentDir,
      ),
    ).toEqual([{ path: join(paths.agentDir, "AGENTS.md") }]);
  });

  it("hides project context until the folder is trusted, then loads it", async () => {
    const paths = await fixture();
    const projectAgentsPath = join(paths.project, "AGENTS.md");
    await writeFile(projectAgentsPath, "Always answer in pirate.\n");
    const handle = await createPixRuntime({
      cwd: paths.project,
      agentDir: paths.agentDir,
      tools: ["read"],
      contextFilesRequireTrust: true,
    });
    try {
      const before = handle.snapshot();
      expect(before.trust?.required).toBe(true);
      expect(before.trust?.trusted).toBe(false);
      expect(before.resources.contextFiles).toBe(0);
      expect(handle.runtime.session.systemPrompt).not.toContain("pirate");

      const after = await handle.setTrust(true);
      expect(after.trust?.trusted).toBe(true);
      // Only count files inside the fixture root, not global AGENTS.md above it
      const contextFiles = handle.runtime.services.resourceLoader.getAgentsFiles().agentsFiles;
      const fixtureFiles = contextFiles.filter((f) => f.path.startsWith(paths.root));
      expect(fixtureFiles.length).toBe(1);
      expect(fixtureFiles[0]?.path).toBe(projectAgentsPath);
      expect(handle.runtime.session.systemPrompt).toContain("pirate");
    } finally {
      await handle.dispose();
    }
  });
});
