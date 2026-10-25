/**
 * Installed-app smoke test (CI: `.github/workflows/desktop-windows.yml` → smoke job).
 *
 * Launches an already-installed PRSLOY.exe (`PRSLOY_EXE`) — not the dev bundle — with
 * the same fake OpenAI-compatible model the e2e suite uses. The fake model is plain
 * config (models.json in an isolated PI_CODING_AGENT_DIR + ZENO_MODEL_* env), so the
 * packaged app needs no test-only code path.
 *
 * Checks: main window, first-run runtime extraction, Agent Host ready, one reply,
 * one bash tool call. A second launch hides Git for Windows (clean machine) and requires
 * the bundled PortableGit bash to run bash syntax, coreutils and git
 * (strict when SMOKE_STRICT_CLEAN_BASH=1, which CI sets; otherwise report only).
 *
 * Output (SMOKE_OUT, default ./smoke-out): screenshots, main.log, renderer.log,
 * metrics.json, bash-*.json.
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { existsSync, readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeOpenAiServer } from "@zeno/test-utils";

const exe = process.env.PRSLOY_EXE ?? "";
const outDir = resolve(process.env.SMOKE_OUT ?? "smoke-out");
const strictCleanBash = process.env.SMOKE_STRICT_CLEAN_BASH === "1";
const MARKER = "PRSLOY_SMOKE_42";
// Harness bash wrapper prefixes every result: `[exit 0 · 0,3 с · 349 Б]`.
const HARNESS_HEADER = /^\s*\[exit \d+/;
// $((6*7)) proves a real POSIX shell evaluated the command, not just echoed it.
const BASH_COMMAND = "echo PRSLOY_SMOKE_$((6*7)); echo SHELL=$0; uname -a || ver";

interface Launched {
  bashCommand: string;
  app: ElectronApplication;
  page: Page;
  fakeModel: FakeOpenAiServer;
  userData: string;
  launchMs: number;
  readyMs: number;
  /** ms from launch to `[prsloy] PortableGit: ready|failed` (Windows background unpack). */
  gitSetup: { status?: string; ms?: number };
  /** Uncaught renderer errors since launch. */
  pageErrors: string[];
}

async function writeMetrics(patch: Record<string, unknown>): Promise<void> {
  const path = join(outDir, "metrics.json");
  const prev = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  await writeFile(path, JSON.stringify({ ...prev, ...patch }, null, 2));
}

/** PATH without Git for Windows / MSYS / Cygwin — what a clean Windows user has. */
function cleanWindowsPath(path: string): string {
  return path
    .split(";")
    .filter((dir) => !/\\(git|msys64|msys2|cygwin64|cygwin|mingw64|usr\\bin)(\\|$)/i.test(dir))
    .join(";");
}

async function launch(
  label: string,
  options: { hideGitBash?: boolean; bashCommand?: string } = {},
): Promise<Launched> {
  const bashCommand = options.bashCommand ?? BASH_COMMAND;
  const root = await mkdtemp(join(tmpdir(), `prsloy-smoke-${label}-`));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const workspace = join(root, "workspace");
  const userData = join(root, "userData");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(userData, { recursive: true }),
  ]);
  const toolPath = join(workspace, "fixture.txt");
  await writeFile(toolPath, "PRSLOY smoke fixture\n");

  const fakeModel = new FakeOpenAiServer({
    toolPath,
    toolCall: { name: "bash", arguments: { command: bashCommand } },
  });
  await fakeModel.start();
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "zeno-fake": {
          baseUrl: fakeModel.baseUrl,
          apiKey: "test-key-not-secret",
          api: "openai-completions",
          models: [
            {
              id: "zeno-fake",
              name: "Fake Model",
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

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never hand runner credentials to the app under test.
    if (value === undefined || /TOKEN|SECRET|PASSWORD|^AWS_|^CSC_|^ACTIONS_/i.test(key)) continue;
    env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  // Windows keeps the real profile: Electron resolves Documents etc. from it, and a temp
  // USERPROFILE makes app.getPath("documents") throw. Pi is isolated via PI_CODING_AGENT_DIR.
  if (process.platform !== "win32") Object.assign(env, { HOME: home, USERPROFILE: home });
  Object.assign(env, {
    PI_CODING_AGENT_DIR: agentDir,
    ZENO_WORKSPACE: workspace,
    ZENO_MODEL_PROVIDER: "zeno-fake",
    ZENO_MODEL_ID: "zeno-fake",
    ZENO_TOOLS: "read,bash",
    ZENO_ENABLE_TEST_COMMANDS: "1",
    ZENO_PERSIST_SESSION: "0",
    ZENO_NO_AUTO_RESUME: "1",
  });
  if (options.hideGitBash) {
    const empty = join(root, "no-program-files");
    await mkdir(empty, { recursive: true });
    // Windows env names are case-insensitive; drop every spelling so ours is the only one.
    const take = (name: string) => {
      const keys = Object.keys(env).filter((k) => k.toLowerCase() === name.toLowerCase());
      const value = keys.length ? env[keys[0]!] : undefined;
      for (const k of keys) delete env[k];
      return value;
    };
    take("ProgramFiles");
    take("ProgramFiles(x86)");
    take("ProgramW6432");
    env.ProgramFiles = empty;
    env["ProgramFiles(x86)"] = empty;
    env.Path = cleanWindowsPath(take("Path") ?? "");
  }

  const mainLog = join(outDir, `${label}-main.log`);
  const rendererLog = join(outDir, `${label}-renderer.log`);
  const t0 = Date.now();
  const app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${userData}`],
    cwd: workspace,
    env,
    timeout: 120_000,
  });
  const proc = app.process();
  const gitSetup: Launched["gitSetup"] = {};
  proc.stdout?.on("data", (d) => {
    const m = /\[prsloy\] PortableGit: (ready|failed)/.exec(String(d));
    if (m && !gitSetup.status) Object.assign(gitSetup, { status: m[1], ms: Date.now() - t0 });
  });
  proc.stdout?.on("data", (d) => void appendFile(mainLog, d));
  proc.stderr?.on("data", (d) => void appendFile(mainLog, d));
  app.on("close", () => void appendFile(mainLog, `\n[smoke] app closed\n`));

  const seen = await app
    .evaluate(() => ({
      ProgramFiles: process.env.ProgramFiles,
      "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
      Path: process.env.Path ?? process.env.PATH,
    }))
    .catch((error: unknown) => ({ error: String(error) }));
  await writeFile(join(outDir, `${label}-env.json`), JSON.stringify(seen, null, 2));

  const page = await app.firstWindow({ timeout: 120_000 });
  const launchMs = Date.now() - t0;
  page.on("console", (m) => void appendFile(rendererLog, `[${m.type()}] ${m.text()}\n`));
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => {
    pageErrors.push(String(e.stack ?? e));
    void appendFile(rendererLog, `[pageerror] ${e.stack ?? e}\n`);
  });
  page.on("crash", () => void appendFile(rendererLog, `[crash] renderer crashed\n`));

  await page.waitForSelector('[data-testid="zeno-app"]', { timeout: 60_000 });
  await page.waitForSelector('[data-testid="zeno-app"][data-bootstrap-ready="true"]', {
    timeout: 180_000,
  });
  const readyMs = Date.now() - t0;
  return {
    bashCommand,
    app,
    page,
    fakeModel,
    userData,
    launchMs,
    readyMs,
    gitSetup,
    pageErrors,
  };
}

async function close(launched: Launched | undefined): Promise<void> {
  if (!launched) return;
  await launched.app.close().catch(() => undefined);
  await launched.fakeModel.stop().catch(() => undefined);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outDir, `${name}.png`) }).catch(() => undefined);
}

async function startHost(page: Page): Promise<void> {
  const btn = page.getByTestId("start-host");
  await btn.waitFor({ state: "visible", timeout: 30_000 });
  await btn.click({ force: true });
  await expect(page.getByTestId("runtime-snapshot").first()).toContainText("runtimeId", {
    timeout: 90_000,
  });
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent Host ready|Agent Host restarted|就绪/,
    { timeout: 60_000 },
  );
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("prompt-input").fill(text);
  await page.getByTestId("send-prompt").click();
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent settled|Agent aborted/,
    // First turn after first launch waits for the background PortableGit unpack.
    { timeout: 180_000 },
  );
}

/** Text of the last `tool` message the app sent back to the model. */
function lastToolResult(fakeModel: FakeOpenAiServer): string | undefined {
  for (const request of [...fakeModel.requests].reverse()) {
    const tool = [...(request.messages ?? [])].reverse().find((m) => m.role === "tool");
    if (!tool) continue;
    const content = tool.content;
    if (typeof content === "string") return content;
    return JSON.stringify(content);
  }
  return undefined;
}

function listFiles(dir: string, depth = 2): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    out.push(path);
    if (depth > 0 && statSync(path).isDirectory()) out.push(...listFiles(path, depth - 1));
  }
  return out;
}

async function runBashTurn(launched: Launched, label: string) {
  await send(launched.page, "Use the tool to run a shell command.");
  await expect
    .poll(() => lastToolResult(launched.fakeModel), { timeout: 30_000 })
    .not.toBeUndefined();
  const result = lastToolResult(launched.fakeModel) ?? "";
  // Expand process blocks so the screenshot shows the tool card.
  for (const summary of await launched.page.locator(".timeline-process-summary").all()) {
    await summary.click({ force: true }).catch(() => undefined);
  }
  for (const row of await launched.page.locator('[data-kind="tool"]').all()) {
    await row.click({ force: true }).catch(() => undefined);
  }
  await shot(launched.page, `${label}-bash`);
  const ok = result.includes(MARKER);
  await writeFile(
    join(outDir, `bash-${label}.json`),
    JSON.stringify({ ok, command: launched.bashCommand, result }, null, 2),
  );
  return { ok, result };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(exe, "PRSLOY_EXE must point at the installed PRSLOY.exe").not.toBe("");
  expect(existsSync(exe), `missing ${exe}`).toBe(true);
  await mkdir(outDir, { recursive: true });
});

test("installed app: window, runtimes, host, reply, bash tool", async () => {
  let launched: Launched | undefined;
  try {
    launched = await launch("runner");
    const { page, userData } = launched;
    await writeMetrics({ firstWindowMs: launched.launchMs, bootstrapReadyMs: launched.readyMs });
    await shot(page, "01-window");

    // First-run extraction: Resources/runtimes/archives → userData/runtimes.
    const runtimes = join(userData, "runtimes");
    const files = listFiles(runtimes, 2).map((p) => p.slice(runtimes.length + 1));
    await writeFile(join(outDir, "runtimes-tree.txt"), files.join("\n"));
    const exeName = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);
    const found = (candidates: string[]) => candidates.find((p) => existsSync(p));
    const nodeBin = found([
      join(runtimes, "node", exeName("node")),
      join(runtimes, "node", "bin", exeName("node")),
    ]);
    const pythonBin = found([
      join(runtimes, "python", exeName("python")),
      join(runtimes, "python", "bin", exeName("python3")),
      join(runtimes, "python", "python", exeName("python")),
    ]);
    await writeMetrics({ bundledNode: nodeBin ?? null, bundledPython: pythonBin ?? null });
    expect(nodeBin, `bundled node missing under ${runtimes}`).toBeTruthy();
    expect(pythonBin, `bundled python missing under ${runtimes}`).toBeTruthy();

    const hostT0 = Date.now();
    await startHost(page);
    await writeMetrics({ hostReadyMs: Date.now() - hostT0 });
    await shot(page, "02-host-ready");

    await send(page, "Привет! Ответь одной фразой.");
    await expect
      .poll(async () => page.getByTestId("timeline").innerText(), { timeout: 30_000 })
      .toContain("Zeno fake model response");
    await shot(page, "03-reply");

    const bash = await runBashTurn(launched, "runner");
    await writeMetrics({
      gitSetupStatus: launched.gitSetup.status ?? null,
      gitSetupMs: launched.gitSetup.ms ?? null,
    });
    await expect
      .poll(async () => page.getByTestId("timeline").innerText(), { timeout: 30_000 })
      .toContain("Tool result received");
    expect(bash.result, `bash tool result:\n${bash.result}`).toContain(MARKER);
    expect(bash.result, `bash tool result:\n${bash.result}`).toMatch(HARNESS_HEADER);

    // «Дизайн» tab must open into a calm state, never crash. Without the design bundle (CI has
    // no token for the private pipeline repo) that is `design-unavailable`; with it, setup/key/empty.
    await page.getByTestId("nav-design").click();
    const designState = page.locator(
      [
        '[data-testid="design-unavailable"]',
        '[data-testid="design-setup"]',
        '[data-testid="design-needs-key"]',
        '[data-testid="design-empty"]',
      ].join(", "),
    );
    await expect(designState.first()).toBeVisible({ timeout: 30_000 });
    const states = await designState.evaluateAll((els) =>
      els.map(
        (el) =>
          `${el.getAttribute("data-testid")}${el.getAttribute("data-phase") ? `:${el.getAttribute("data-phase")}` : ""}`,
      ),
    );
    await writeMetrics({ designStates: states });
    await shot(page, "04-design");
    expect(launched.pageErrors, launched.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    if (launched) await shot(launched.page, "99-runner-final");
    await close(launched);
  }
});

// What a casual user's agent runs first: bash syntax, coreutils, git. On a clean machine this
// must come from the bundled PortableGit (Pi `shellPath`, set by the app), never WSL.
const AGENT_COMMAND =
  `${BASH_COMMAND}; echo BASH_VERSION=$BASH_VERSION; [[ 1 == 1 ]] && arr=(a b) && echo "bashisms=\${arr[1]}"; ` +
  `git --version; ls | head -5 | tr "\\n" " "; echo; grep -c . fixture.txt; sed -n 1p fixture.txt; ` +
  `awk "BEGIN{print 6*7}"; find . -maxdepth 1 -name "*.txt"; echo GIT_ROOT=$(cygpath -w /)`;

test("clean Windows (system Git hidden): bash tool via bundled Git", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  let launched: Launched | undefined;
  try {
    launched = await launch("clean", { hideGitBash: true, bashCommand: AGENT_COMMAND });
    await startHost(launched.page);
    const bash = await runBashTurn(launched, "clean");
    const report = `bash tool result:\n${bash.result}`;
    if (!strictCleanBash) {
      if (!bash.ok) test.info().annotations.push({ type: "clean-bash", description: report });
      return;
    }
    expect(bash.result, report).toMatch(HARNESS_HEADER);
    expect(bash.result, report).toContain(MARKER);
    expect(bash.result, report).toContain("bashisms=b");
    expect(bash.result, report).toMatch(/git version \d/);
    expect(bash.result, report).toContain("PRSLOY smoke fixture");
    expect(bash.result, report).toMatch(/^42$/m);
    expect(bash.result, report).toContain("./fixture.txt");
    expect(bash.result, report).not.toMatch(/command not found|Windows Subsystem for Linux/);
    // Bundled Git lives under userData\runtimes (not Program Files, not WSL).
    expect(bash.result, report).toMatch(/GIT_ROOT=.*\\runtimes\\/i);
  } finally {
    if (launched) await shot(launched.page, "99-clean-final");
    await close(launched);
  }
});
