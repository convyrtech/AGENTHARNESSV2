// Теневой git видит правки, сделанные мимо edit/write: sed -i, генератор, npm init.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TurnChanges } from "../src/turn-changes.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "prsloy-turn-"));
  dirs.push(root);
  const cwd = join(root, "project");
  execFileSync("mkdir", ["-p", cwd]);
  return { root, cwd };
}

describe("turn changes (shadow git)", () => {
  it("sees a sed -i edit, a generated file and a deletion; ignores node_modules", async () => {
    const { root, cwd } = await workspace();
    await writeFile(join(cwd, "app.js"), "const port = 3000;\nconsole.log(port);\n");
    await writeFile(join(cwd, "old.txt"), "bye\n");
    const changes = new TurnChanges(join(root, "turns"), () => "git");
    changes.begin(cwd);
    await changes.ready();
    execFileSync(
      "sh",
      [
        "-c",
        "sed -i 's/3000/8080/' app.js && echo '{}' > package.json && rm old.txt && mkdir -p node_modules/x && echo 1 > node_modules/x/i.js",
      ],
      { cwd },
    );
    const diff = await changes.current();
    expect(diff?.files.sort()).toEqual(["app.js", "old.txt", "package.json"]);
    expect(diff?.patch).toContain("-const port = 3000;");
    expect(diff?.patch).toContain("+const port = 8080;");
    expect(diff?.patch).not.toContain("node_modules");
  });

  it("nothing changed → empty diff; the user's own .git is untouched", async () => {
    const { root, cwd } = await workspace();
    execFileSync("git", ["init", "-q"], { cwd });
    await writeFile(join(cwd, "a.txt"), "1\n");
    const head = await readFile(join(cwd, ".git", "HEAD"), "utf8");
    const changes = new TurnChanges(join(root, "turns"), () => "git");
    changes.begin(cwd);
    expect(await changes.current()).toEqual({ files: [], patch: "" });
    expect(await readFile(join(cwd, ".git", "HEAD"), "utf8")).toBe(head);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })).toBe(
      "?? a.txt\n",
    );
  });

  it("no git binary → undefined (unknown), never a throw", async () => {
    const { root, cwd } = await workspace();
    const changes = new TurnChanges(join(root, "turns"), () => join(root, "no-such-git"));
    changes.begin(cwd);
    expect(await changes.current()).toBeUndefined();
  });
});

describe("turn changes: no git left running after the turn", () => {
  it("a turn that ends with a gateway error waits for its start snapshot; shutdown leaves no git child", async () => {
    const { createServer } = await import("node:http");
    const { once } = await import("node:events");
    const { existsSync, mkdirSync, writeFileSync: write } = await import("node:fs");
    const pi = await import("@earendil-works/pi-coding-agent");
    const { createPrsloyHarness } = await import("../src/index.ts");
    const { root, cwd } = await workspace();
    // Папка побольше, чтобы снимок начала шёл дольше, чем ход с мгновенной ошибкой шлюза.
    for (let d = 0; d < 50; d++) {
      mkdirSync(join(cwd, `d${d}`));
      for (let f = 0; f < 200; f++)
        write(join(cwd, `d${d}`, `f${f}.txt`), `${d}-${f}\n`.repeat(20));
    }
    const outcomes: string[] = [];
    const gateway = createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } }));
    });
    gateway.listen(0, "127.0.0.1");
    await once(gateway, "listening");
    const port = (gateway.address() as { port: number }).port;
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const modelsPath = join(agentDir, "models.json");
    write(
      modelsPath,
      JSON.stringify({
        providers: {
          mock: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: "test-key-not-secret",
            api: "openai-completions",
            models: [
              {
                id: "m",
                name: "m",
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
    const modelRuntime = await pi.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath,
    });
    const settingsManager = pi.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        createPrsloyHarness({
          outputDir: join(root, "out"),
          profile: "code",
          reliabilityProviders: [],
        }),
        (api: import("@earendil-works/pi-coding-agent").ExtensionAPI) => {
          api.on("agent_before_settle", (e) => {
            outcomes.push(e.outcome);
            return undefined;
          });
        },
      ],
    });
    await resourceLoader.reload();
    const { session } = await pi.createAgentSession({
      cwd,
      agentDir,
      model: modelRuntime.getModel("mock", "m")!,
      thinkingLevel: "off",
      modelRuntime,
      resourceLoader,
      settingsManager,
      sessionManager: pi.SessionManager.inMemory(cwd),
    });
    await session.bindExtensions({});
    const gitChildren = () =>
      execFileSync("sh", ["-c", `pgrep -P ${process.pid} -x git || true`], {
        encoding: "utf8",
      }).trim();
    try {
      await session.prompt("сделай");
      expect(outcomes).toEqual(["error"]);
      // Ход кончился ошибкой — а снимок, начатый на его старте, уже завершён: папку снимков можно удалить
      // сразу, и никто её не пишет заново (раньше — ENOTEMPTY на уборке тестов).
      expect(gitChildren()).toBe("");
      await rm(join(root, "out"), { recursive: true });
      await new Promise((r) => setTimeout(r, 3000));
      expect(existsSync(join(root, "out"))).toBe(false);
      await session.prompt("ещё раз");
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      expect(gitChildren()).toBe("");
      // Папку можно удалить сразу, без повторов.
      await rm(join(root, "out"), { recursive: true });
    } finally {
      session.dispose();
      gateway.close();
    }
  }, 60_000);
});
