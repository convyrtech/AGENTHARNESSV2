/**
 * Shared launch + check helpers for the installed-app smoke specs (`e2e-smoke/*.spec.ts`).
 *
 * Every launch starts an already-installed PRSLOY.exe (`PRSLOY_EXE`). Test mode wires the
 * same fake OpenAI-compatible model the e2e suite uses through plain config (models.json in
 * an isolated PI_CODING_AGENT_DIR + ZENO_MODEL_* env); product mode starts the app as a user
 * would, behind the first-run gate.
 */
import { expect, test, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { existsSync, readdirSync, statSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeOpenAiServer } from "@zeno/test-utils";

export const exe = process.env.PRSLOY_EXE ?? "";
export const outDir = resolve(process.env.SMOKE_OUT ?? "smoke-out");
export const MARKER = "PRSLOY_SMOKE_42";
// Harness bash wrapper prefixes every result: `[exit 0 · 0,3 с · 349 Б]`.
export const HARNESS_HEADER = /^\s*\[exit \d+/;
// $((6*7)) proves a real POSIX shell evaluated the command, not just echoed it.
export const BASH_COMMAND = "echo PRSLOY_SMOKE_$((6*7)); echo SHELL=$0; uname -a || ver";
export const FIRST_RUN_KEY = '[data-testid="prsloy-first-run-key"]';
const APP_READY = '[data-testid="zeno-app"][data-bootstrap-ready="true"]';

export interface Launched {
  label: string;
  bashCommand: string;
  app: ElectronApplication;
  page: Page;
  fakeModel: FakeOpenAiServer;
  root: string;
  workspace: string;
  userData: string;
  mainLog: string;
  /** Launch → first BrowserWindow. */
  launchMs: number;
  /** Launch → app ready (test mode) or first-run key screen (product mode). */
  readyMs: number;
  /** ms from launch to `[prsloy] PortableGit: ready|failed` (Windows background unpack). */
  gitSetup: { status?: string; ms?: number };
  /** Uncaught renderer errors since launch. */
  pageErrors: string[];
  /** Main-process `[prsloy-timing] <phase> <ms since process start>` lines. */
  timings: Record<string, number>;
  t0: number;
}

export interface LaunchOptions {
  bashCommand?: string;
  /** Windows: hide Git for Windows (ProgramFiles* → empty dir, git/msys off PATH). */
  hideGitBash?: boolean;
  /**
   * false = product mode: no ZENO_ENABLE_TEST_COMMANDS / fake model / fixture workspace;
   * the first-run gate and the update check run as for a user. Default true.
   */
  testMode?: boolean;
  /**
   * Windows profile root to pretend to be (e.g. `C:\Users\Иван Петров`): USERPROFILE,
   * APPDATA, LOCALAPPDATA, TEMP point inside it and userData is `APPDATA\PRSLOY`.
   */
  profile?: string;
  /** Project folder (test mode → ZENO_WORKSPACE). Default: `<root>/workspace`. */
  workspace?: string;
  /** Extra Chromium/Electron switches (e.g. `--proxy-server=…`). */
  args?: string[];
  /** Selector that means "launched" (default: app ready in test mode, key screen otherwise). */
  readySelector?: string;
  /** Extra env for the app, applied last (product mode strips ZENO_/PRSLOY_/PI_ before). */
  env?: Record<string, string>;
  /** Runs before launch with the userData dir (seed state files). */
  prepare?: (userData: string) => Promise<void>;
  /**
   * Profile to launch with: a path reuses it (second launch), null = no --user-data-dir,
   * i.e. the app's own default profile (install → uninstall → reinstall).
   */
  userData?: string | null;
}

export async function writeMetrics(patch: Record<string, unknown>): Promise<void> {
  const path = join(outDir, "metrics.json");
  const prev = existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : {};
  await writeFile(path, JSON.stringify({ ...prev, ...patch }, null, 2));
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(outDir, `${name}.png`) }).catch(() => undefined);
}

/** PATH without Git for Windows / MSYS / Cygwin — what a clean Windows user has. */
export function cleanWindowsPath(path: string): string {
  return path
    .split(";")
    .filter((dir) => !/\\(git|msys64|msys2|cygwin64|cygwin|mingw64|usr\\bin)(\\|$)/i.test(dir))
    .join(";");
}

/** Windows env names are case-insensitive: drop every spelling, return the first value. */
function takeEnv(env: Record<string, string>, name: string): string | undefined {
  const keys = Object.keys(env).filter((k) => k.toLowerCase() === name.toLowerCase());
  const value = keys.length ? env[keys[0]!] : undefined;
  for (const k of keys) delete env[k];
  return value;
}

function fakeModelsJson(baseUrl: string): string {
  return JSON.stringify({
    providers: {
      "zeno-fake": {
        baseUrl,
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
  });
}

export async function launch(label: string, options: LaunchOptions = {}): Promise<Launched> {
  const testMode = options.testMode ?? true;
  const bashCommand = options.bashCommand ?? BASH_COMMAND;
  let root: string;
  let userData: string;
  if (options.profile) {
    root = options.profile;
    userData = join(options.profile, "AppData", "Roaming", "PRSLOY");
  } else {
    root = await mkdtemp(join(tmpdir(), `prsloy-smoke-${label}-`));
    userData = options.userData ?? join(root, "userData");
  }
  const defaultProfile = options.userData === null;
  const home = options.profile ?? join(root, "home");
  const agentDir = join(root, "smoke-pi-agent");
  const workspace = options.workspace ?? join(root, "workspace");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    ...(defaultProfile ? [] : [mkdir(userData, { recursive: true })]),
  ]);
  const toolPath = join(workspace, "fixture.txt");
  await writeFile(toolPath, "PRSLOY smoke fixture\n");
  if (!defaultProfile) await options.prepare?.(userData);

  const fakeModel = new FakeOpenAiServer({
    toolPath,
    toolCall: { name: "bash", arguments: { command: bashCommand } },
  });
  await fakeModel.start();

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never hand runner credentials to the app under test.
    if (value === undefined || /TOKEN|SECRET|PASSWORD|^AWS_|^CSC_|^ACTIONS_/i.test(key)) continue;
    env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  if (options.profile && process.platform === "win32") {
    // A user named «Иван Петров»: every per-user folder lives under the Cyrillic profile.
    // Electron resolves known folders (Documents, …) through USERPROFILE, so create them.
    const local = join(options.profile, "AppData", "Local");
    const temp = join(local, "Temp");
    await Promise.all(
      ["Documents", "Desktop", "Downloads", join("AppData", "Roaming"), "AppData\\Local\\Temp"].map(
        (dir) => mkdir(join(options.profile!, dir), { recursive: true }),
      ),
    );
    for (const name of ["USERPROFILE", "HOME", "HOMEPATH", "HOMEDRIVE", "APPDATA", "LOCALAPPDATA"])
      takeEnv(env, name);
    for (const name of ["TEMP", "TMP"]) takeEnv(env, name);
    Object.assign(env, {
      USERPROFILE: options.profile,
      HOMEDRIVE: options.profile.slice(0, 2),
      HOMEPATH: options.profile.slice(2),
      APPDATA: join(options.profile, "AppData", "Roaming"),
      LOCALAPPDATA: local,
      TEMP: temp,
      TMP: temp,
    });
  } else if (process.platform !== "win32") {
    Object.assign(env, { HOME: home });
  }
  if (testMode) {
    await writeFile(join(agentDir, "models.json"), fakeModelsJson(fakeModel.baseUrl));
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
  } else {
    for (const name of Object.keys(env)) if (/^(ZENO_|PRSLOY_|PI_)/i.test(name)) delete env[name];
  }
  if (options.hideGitBash) {
    const empty = join(root, "no-program-files");
    await mkdir(empty, { recursive: true });
    takeEnv(env, "ProgramFiles");
    takeEnv(env, "ProgramFiles(x86)");
    takeEnv(env, "ProgramW6432");
    env.ProgramFiles = empty;
    env["ProgramFiles(x86)"] = empty;
    env.Path = cleanWindowsPath(takeEnv(env, "Path") ?? "");
  }

  Object.assign(env, options.env ?? {});

  const mainLog = join(outDir, `${label}-main.log`);
  const rendererLog = join(outDir, `${label}-renderer.log`);
  const t0 = Date.now();
  const app = await electron.launch({
    executablePath: exe,
    args: [...(defaultProfile ? [] : [`--user-data-dir=${userData}`]), ...(options.args ?? [])],
    cwd: workspace,
    env,
    timeout: 120_000,
  });
  const proc = app.process();
  const gitSetup: Launched["gitSetup"] = {};
  const timings: Record<string, number> = {};
  proc.stdout?.on("data", (d) => {
    const m = /\[prsloy\] PortableGit: (ready|failed)/.exec(String(d));
    if (m && !gitSetup.status) Object.assign(gitSetup, { status: m[1], ms: Date.now() - t0 });
    for (const t of String(d).matchAll(/\[prsloy-timing\] (\w+) (\d+)/g)) {
      timings[t[1]!] ??= Number(t[2]);
    }
  });
  proc.stdout?.on("data", (d) => void appendFile(mainLog, d));
  proc.stderr?.on("data", (d) => void appendFile(mainLog, d));
  app.on("close", () => void appendFile(mainLog, `\n[smoke] app closed\n`));

  const seen = await app
    .evaluate(({ app: electronApp }) => {
      const path = (name: Parameters<typeof electronApp.getPath>[0]) => {
        try {
          return electronApp.getPath(name);
        } catch (error) {
          return `ERROR ${String(error)}`;
        }
      };
      return {
        ProgramFiles: process.env.ProgramFiles,
        "ProgramFiles(x86)": process.env["ProgramFiles(x86)"],
        Path: process.env.Path ?? process.env.PATH,
        USERPROFILE: process.env.USERPROFILE,
        execPath: process.execPath,
        userData: path("userData"),
        home: path("home"),
        documents: path("documents"),
        temp: path("temp"),
      };
    })
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

  await page.waitForSelector(options.readySelector ?? (testMode ? APP_READY : FIRST_RUN_KEY), {
    timeout: 180_000,
  });
  const readyMs = Date.now() - t0;
  if (defaultProfile) userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
  return {
    label,
    bashCommand,
    app,
    page,
    fakeModel,
    root,
    workspace,
    userData,
    mainLog,
    launchMs,
    readyMs,
    gitSetup,
    pageErrors,
    timings,
    t0,
  };
}

/** Close the app; resolves with how long the quit took (ms). */
export async function close(launched: Launched | undefined): Promise<number | undefined> {
  if (!launched) return undefined;
  // Undefined once the app has already quit (e.g. it restarted itself for an update).
  let proc: ReturnType<ElectronApplication["process"]> | undefined;
  try {
    proc = launched.app.process();
  } catch {
    proc = undefined;
  }
  const started = Date.now();
  await Promise.race([
    launched.app.close().catch(() => undefined),
    new Promise((resolveTimer) => setTimeout(resolveTimer, 30_000)),
  ]);
  const ms = Date.now() - started;
  if (proc && proc.exitCode === null) proc.kill();
  await launched.fakeModel.stop().catch(() => undefined);
  return ms;
}

export async function startHost(page: Page): Promise<void> {
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

export async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("prompt-input").fill(text);
  await page.getByTestId("send-prompt").click();
  await expect(page.getByTestId("host-status").first()).toContainText(
    /Agent settled|Agent aborted/,
    // First turn after first launch waits for the background PortableGit unpack.
    { timeout: 180_000 },
  );
}

/** Text of the last `tool` message the app sent back to the model. */
export function lastToolResult(fakeModel: FakeOpenAiServer): string | undefined {
  for (const request of [...fakeModel.requests].reverse()) {
    const tool = [...(request.messages ?? [])].reverse().find((m) => m.role === "tool");
    if (!tool) continue;
    const content = tool.content;
    if (typeof content === "string") return content;
    return JSON.stringify(content);
  }
  return undefined;
}

export function listFiles(dir: string, depth = 2): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    out.push(path);
    if (depth > 0 && statSync(path).isDirectory()) out.push(...listFiles(path, depth - 1));
  }
  return out;
}

/** Bundled Node / Python after first-run extraction (undefined when missing). */
export function bundledRuntimes(userData: string): {
  node: string | undefined;
  python: string | undefined;
  /** The provision stamp is written last: true once the background unpack has finished. */
  stamp: boolean;
} {
  const runtimes = join(userData, "runtimes");
  const exeName = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);
  const found = (candidates: string[]) => candidates.find((p) => existsSync(p));
  return {
    stamp: existsSync(join(runtimes, ".provisioned.json")),
    node: found([
      join(runtimes, "node", exeName("node")),
      join(runtimes, "node", "bin", exeName("node")),
    ]),
    python: found([
      join(runtimes, "python", exeName("python")),
      join(runtimes, "python", "bin", exeName("python3")),
      join(runtimes, "python", "python", exeName("python")),
    ]),
  };
}

export async function runBashTurn(launched: Launched, label: string, marker = MARKER) {
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
  const ok = result.includes(marker);
  await writeFile(
    join(outDir, `bash-${label}.json`),
    JSON.stringify({ ok, command: launched.bashCommand, result }, null, 2),
  );
  return { ok, result };
}

export async function beforeAllSmoke(): Promise<void> {
  expect(exe, "PRSLOY_EXE must point at the installed PRSLOY.exe").not.toBe("");
  expect(existsSync(exe), `missing ${exe}`).toBe(true);
  await mkdir(outDir, { recursive: true });
}

/**
 * Checks for known-open bugs owned by another stream: every check is recorded in
 * metrics.json (`findings.<scope>`) and as a test annotation; with `strict` (env flag set
 * once the fix lands) any failed check fails the test.
 */
export function findings(scope: string, strict: boolean) {
  const list: { check: string; ok: boolean; detail?: string }[] = [];
  return {
    check(check: string, ok: boolean, detail?: string) {
      list.push({ check, ok, ...(ok || detail === undefined ? {} : { detail }) });
    },
    async finish(): Promise<void> {
      const prev = existsSync(join(outDir, "metrics.json"))
        ? JSON.parse(await readFile(join(outDir, "metrics.json"), "utf8"))
        : {};
      await writeMetrics({ findings: { ...prev.findings, [scope]: list } });
      const failed = list.filter((f) => !f.ok);
      for (const f of failed) {
        test.info().annotations.push({ type: `${scope}: ${f.check}`, description: f.detail ?? "" });
      }
      if (strict) {
        expect(
          failed.map((f) => `${f.check}\n${f.detail ?? ""}`),
          `${scope} findings`,
        ).toEqual([]);
      }
    },
  };
}
