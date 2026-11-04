import { test as base, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { createRequire } from "node:module";
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeOpenAiServer } from "@zeno/test-utils";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const appDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

interface LaunchedZeno {
  app: ElectronApplication;
  page: Page;
  root: string;
  /** Isolated `~/.pi/agent` for this launch (`PI_CODING_AGENT_DIR`). */
  agentDir: string;
  workspace: string;
  attachmentPaths: string[];
  fakeModel: FakeOpenAiServer;
  /** Electron main + Agent Host stdout/stderr since launch (security greps). */
  output: string[];
}

export interface ZenoE2EFixtures {
  zeno: LaunchedZeno;
  page: Page;
}

export interface LaunchOptions {
  /** Comma-separated tool allow-list (default "read"). */
  tools?: string;
  /** Tool the fake model calls for prompts containing "tool". */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  mcpFixture?: {
    name: string;
    result: string;
    callsFile: string;
    hang?: boolean;
    pidFile?: string;
  };
  /** Model the host starts with (default: the fake model). */
  model?: { provider: string; id: string };
  /** Override the fake provider URL for packaged end-to-end tests. */
  modelBaseUrl?: string;
  /** Override the fake provider key for packaged end-to-end tests. */
  modelApiKey?: string;
  /** Override fake provider input modalities for packaged end-to-end tests. */
  modelInput?: string[];
  /** Extra env for the app process (e.g. a planted secret the agent must not see). */
  env?: Record<string, string>;
  /** Scripted model answer for a request whose last user message matches (see FakeOpenAiServer). */
  reply?: (lastUserText: string) => string | undefined;
  /** When the last user text contains this marker, the reply ends with finish_reason "length" (#79). */
  truncatedWhenPromptIncludes?: string;
  /** Delay between streamed chunks (ms) — a stream slow enough to switch chats mid-answer. */
  streamDelayMs?: number;
  /**
   * Reuse the temp root of an earlier launch: the app starts again on the same `~/.pi/agent`,
   * workspace and userData, so the previous chats are still on disk (#79 restart case).
   */
  root?: string;
  /** Optional isolated project path, independent of the private test profile. */
  workspacePath?: string;
}

/**
 * `PRSLOY_E2E_PACKAGED=<path to the packaged app executable>` runs the suite against an
 * electron-builder output (e.g. release/app/linux-unpacked/PRSLOY) instead of the dev tree:
 * catches modules missing from app.asar.
 */
const packagedExecutable = process.env.PRSLOY_E2E_PACKAGED?.trim() || undefined;

export async function launchZenoApp(options: LaunchOptions = {}): Promise<LaunchedZeno> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "zeno-e2e-")));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const workspace = options.workspacePath ?? join(root, "workspace");
  const toolPath = join(workspace, "fixture.txt");
  const attachmentPaths = [
    "report.xlsx",
    "photo.png",
    "brief.pdf",
    "deck.pptx",
    "proposal.docx",
    "bundle.zip",
    "notes.txt",
    "README.md",
    "Main.java",
    "app.js",
    "worker.py",
  ].map((name) => join(workspace, name));

  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(join(agentDir, "prompts"), { recursive: true }),
    mkdir(join(agentDir, "skills", "e2e-skill"), { recursive: true }),
    mkdir(join(home, ".agents"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(toolPath, "Zeno Playwright E2E fixture\n"),
    ...attachmentPaths.map((path) =>
      path.endsWith("photo.png")
        ? writeFile(
            path,
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
          )
        : writeFile(path, `E2E attachment fixture: ${path}\n`),
    ),
    writeFile(join(workspace, "demo.mp4"), ""),
    writeFile(
      join(agentDir, "prompts", "e2e-review.md"),
      "---\ndescription: Review the active workspace\n---\nReview the active workspace.\n",
    ),
    writeFile(
      join(agentDir, "skills", "e2e-skill", "SKILL.md"),
      "---\nname: e2e-skill\ndescription: E2E-only skill fixture\n---\n\nExercise the E2E skill.\n",
    ),
  ]);

  // Local package fixture for install E2E (absolute path source).
  const localPackage = join(workspace, "e2e-local-package");
  await mkdir(join(localPackage, "prompts"), { recursive: true });
  await Promise.all([
    writeFile(
      join(localPackage, "package.json"),
      JSON.stringify({
        name: "zeno-e2e-local-package",
        version: "1.0.0",
        keywords: ["pi-package"],
        pi: { prompts: ["prompts/*.md"] },
      }),
    ),
    writeFile(join(localPackage, "prompts", "e2e.md"), "E2E local package prompt.\n"),
  ]);

  const fakeModel = new FakeOpenAiServer({
    toolPath,
    ...(options.toolCall ? { toolCall: options.toolCall } : {}),
    ...(options.reply ? { reply: options.reply } : {}),
    ...(options.truncatedWhenPromptIncludes
      ? { truncatedWhenPromptIncludes: options.truncatedWhenPromptIncludes }
      : {}),
    ...(options.streamDelayMs ? { streamDelayMs: options.streamDelayMs } : {}),
  });
  await fakeModel.start();
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "zeno-fake": {
          baseUrl: options.modelBaseUrl ?? fakeModel.baseUrl,
          apiKey: options.modelApiKey ?? "test-key-not-secret",
          api: "openai-completions",
          models: [
            {
              id: "zeno-fake",
              name: "Zeno Fake Model",
              reasoning: false,
              input: options.modelInput ?? ["text"],
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
  let fixtureBinary: string | undefined;
  if (options.mcpFixture) {
    const nodeBinary = process.env.NODE_BINARY ?? process.execPath;
    fixtureBinary =
      process.platform === "win32" ? join(root, "munim-computer-use.exe") : nodeBinary;
    if (fixtureBinary !== nodeBinary) await cp(nodeBinary, fixtureBinary);
    const script = join(root, `${options.mcpFixture.name}-mcp.mjs`);
    await writeFile(
      script,
      `import { appendFileSync } from "node:fs";
const calls = ${JSON.stringify(options.mcpFixture.callsFile)};
const result = ${JSON.stringify(options.mcpFixture.result)};
${options.mcpFixture.pidFile ? `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(options.mcpFixture.pidFile)}, String(process.pid));` : ""}
let buffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const handle = (m) => {
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  if (m.method === "notifications/initialized") return;
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "list_apps", description: "fixture", inputSchema: { type: "object", properties: {} } }] } });
  if (m.method === "tools/call") { appendFileSync(calls, JSON.stringify(m.params ?? {}) + "\\n"); if (${options.mcpFixture?.hang === true ? "true" : "false"}) return; return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: result }] } }); }
};
process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { buffer += c; for (const line of buffer.split("\\n").slice(0, -1)) { try { handle(JSON.parse(line)); } catch {} } buffer = buffer.slice(buffer.lastIndexOf("\\n") + 1); });
`,
      "utf8",
    );
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            [options.mcpFixture.name]: {
              command: fixtureBinary,
              args: [script],
              cwd: workspace,
              exposure: "direct",
            },
          },
        },
        null,
        2,
      ),
    );
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PI_CODING_AGENT_DIR: agentDir,
    ZENO_WORKSPACE: workspace,
    ZENO_MODEL_PROVIDER: options.model?.provider ?? "zeno-fake",
    ZENO_MODEL_ID: options.model?.id ?? "zeno-fake",
    ZENO_TOOLS: options.tools ?? "read",
    ZENO_ENABLE_TEST_COMMANDS: "1",
    ZENO_TEST_PROVIDER_OAUTH: "openai-codex",
    ZENO_TEST_PROVIDER_USAGE: JSON.stringify([
      {
        provider: "zai",
        displayName: "Z.AI",
        updatedAt: new Date().toISOString(),
        status: "ok",
        planName: "GLM Coding Max",
        limits: [
          {
            label: "Session",
            usedPercent: 26,
            resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            windowDurationMins: 300,
          },
          {
            label: "Weekly",
            usedPercent: 63,
            resetsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
            windowDurationMins: 10_080,
          },
        ],
        usageLines: [{ label: "Web searches", value: "37 / 100" }],
      },
    ]),
    ZENO_PERSIST_SESSION: "1",
    // Product cold-start auto-resume is off so each test drives Host start via UI.
    ZENO_NO_AUTO_RESUME: "1",
  });
  if (process.platform === "win32") {
    const localAppData = join(root, "AppData", "Local");
    const appData = join(root, "AppData", "Roaming");
    const temp = join(localAppData, "Temp");
    await Promise.all([
      mkdir(temp, { recursive: true }),
      mkdir(appData, { recursive: true }),
      mkdir(join(root, "Documents"), { recursive: true }),
      mkdir(join(root, "Desktop"), { recursive: true }),
      mkdir(join(root, "Downloads"), { recursive: true }),
    ]);
    Object.assign(env, {
      USERPROFILE: root,
      HOMEDRIVE: root.slice(0, 2),
      HOMEPATH: root.slice(2),
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      TEMP: temp,
      TMP: temp,
    });
  }
  // Interactive E2E: product cold-start auto-resume is already off via ZENO_NO_AUTO_RESUME.
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, options.env ?? {});
  if (options.mcpFixture) {
    env.PRSLOY_COMPUTER_USE = "1";
    env.PRSLOY_MUNIM_BINARY = fixtureBinary!;
  }

  // Isolate Electron userData so recent workspaces / prefs do not leak across runs.
  const userData = join(root, "electron-userData");
  await mkdir(userData, { recursive: true });

  const app = await electron.launch({
    executablePath: packagedExecutable ?? electronBinary,
    // The suite asserts Chinese copy; PRSLOY otherwise detects ru for this environment.
    args: [
      ...(packagedExecutable ? [] : [appDirectory]),
      `--user-data-dir=${userData}`,
      "--lang=zh-CN",
    ],
    cwd: appDirectory,
    env,
    timeout: 60_000,
  });

  keepSessionsOnClose(app, agentDir);

  const output: string[] = [];
  app.process().stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  app.process().stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForSelector('[data-testid="zeno-app"]', { timeout: 30_000 });
  // The suite drives developer surfaces (terminal, packages, model picker) that casual mode hides.
  await page.evaluate(() =>
    localStorage.setItem(
      "prsloy.casual.prefs.v1",
      JSON.stringify({ developerMode: true, rubPerUsd: 95 }),
    ),
  );
  await page.reload();
  await page.waitForSelector('[data-testid="zeno-app"]', { timeout: 30_000 });
  // Cold-start overlay (pi ensure + host config) must finish before UI clicks.
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 120_000,
  });

  return { app, page, root, agentDir, workspace, attachmentPaths, fakeModel, output };
}

/**
 * `PRSLOY_E2E_SESSIONS=<dir>`: after the app closes, the Pi sessions of this launch (`<agentDir>/sessions`)
 * are copied to `<dir>/<test title>/` before the spec deletes its temp root — for the session auditor (#29).
 * Every spec closes the app before `rm(root)`, so wrapping `close()` covers the fixture and direct launches.
 */
const keepSessionsDir = process.env.PRSLOY_E2E_SESSIONS?.trim() || undefined;

function keepSessionsOnClose(app: ElectronApplication, agentDir: string): void {
  if (!keepSessionsDir) return;
  const close = app.close.bind(app);
  let kept = false;
  app.close = async () => {
    await close();
    if (kept) return;
    kept = true;
    const sessions = join(agentDir, "sessions");
    const names = await readdir(sessions, { recursive: true }).catch(() => [] as string[]);
    if (!names.some((name) => String(name).endsWith(".jsonl"))) return;
    let title = "launch";
    try {
      title = test.info().titlePath.slice(1).join(" › ");
    } catch {
      // outside a test (global setup): generic name
    }
    const safe = title.replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 120) || "launch";
    const target = join(keepSessionsDir, safe, String(Date.now()));
    await cp(sessions, target, { recursive: true }).catch(() => undefined);
  };
}

export const test = base.extend<ZenoE2EFixtures>({
  // eslint-disable-next-line no-empty-pattern
  zeno: async ({}, use) => {
    const launched = await launchZenoApp();
    try {
      await use(launched);
    } finally {
      await launched.app.close().catch(() => undefined);
      await launched.fakeModel.stop().catch(() => undefined);
      await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
    }
  },
  page: async ({ zeno }, use) => {
    await use(zeno.page);
  },
});

export { expect };

/** Start host via 新建会话 and wait until the shell reports ready. */
export async function startHost(page: Page): Promise<void> {
  await page.getByTestId("zeno-app").waitFor({ state: "visible" });
  // Cold-start overlay must finish (pi ensure + optional host warm-up).
  await page
    .waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
      timeout: 120_000,
    })
    .catch(() => undefined);
  const btn = page.getByTestId("start-host");
  await btn.waitFor({ state: "visible", timeout: 15_000 });
  const snapshot = page.getByTestId("runtime-snapshot").first();
  // Bootstrap may leave no snapshot yet (ensureHost is best-effort). Do not require
  // runtimeId before click — New conversation creates/replaces the host.
  const before = await snapshot.textContent().catch(() => "");
  const previousRuntimeId = /"runtimeId":\s*"([^"]+)"/.exec(before ?? "")?.[1];
  await page.waitForTimeout(300);
  await btn.click({ force: true });
  // Wait for a runtime (new or replaced) so later UI actions cannot race clearActive().
  if (previousRuntimeId) {
    await expect
      .poll(
        async () => {
          const text = await snapshot.textContent().catch(() => "");
          return /"runtimeId":\s*"([^"]+)"/.exec(text ?? "")?.[1];
        },
        { timeout: 60_000 },
      )
      .not.toBe(previousRuntimeId);
  } else {
    await expect(snapshot).toContainText("runtimeId", { timeout: 60_000 });
  }
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent Host ready|Agent Host restarted|Agent Host ready|就绪/,
    { timeout: 45_000 },
  );
  await expect(page.getByTestId("runtime-snapshot").first()).toContainText("runtimeId", {
    timeout: 15_000,
  });
}

/** Pure-conversation sessions live under 对话, not project nested thread-list. */
export function conversationSessionButtons(page: Page) {
  return page.getByTestId("conversations-list").locator("button[data-active]");
}

/** Wait until agent turn settles (locale-agnostic). */
export async function waitSettled(page: Page, timeout = 60_000): Promise<void> {
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent settled|Agent Host ready|Agent aborted/,
    { timeout },
  );
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  await page.getByTestId("prompt-input").fill(text);
  await page.getByTestId("send-prompt").click();
  await waitSettled(page);
}
