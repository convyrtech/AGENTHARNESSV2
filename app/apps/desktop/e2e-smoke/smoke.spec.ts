/**
 * Installed-app smoke test (CI: `.github/workflows/desktop-windows.yml` → smoke job).
 *
 * Launches an already-installed PRSLOY.exe (`PRSLOY_EXE`) — not the dev bundle — with
 * the same fake OpenAI-compatible model the e2e suite uses (see helpers.ts).
 *
 * Checks: main window, first-run runtime extraction (in the background, after the window),
 * Agent Host ready, one reply, one bash tool call, the «Дизайн» tab; a second launch of the
 * same profile (time to window / host ready). A launch with Git for Windows hidden (clean
 * machine) requires the bundled PortableGit bash to run bash syntax, coreutils and git
 * (strict when SMOKE_STRICT_CLEAN_BASH=1, which CI sets; otherwise report only).
 * Windows CI with the installer present: uninstall → reinstall → launch keeps the user's
 * profile and projects and still runs a bash turn.
 *
 * Output (SMOKE_OUT, default ./smoke-out): screenshots, *-main.log, *-renderer.log,
 * metrics.json, bash-*.json.
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MockGatewayServer } from "@zeno/test-utils";
import { concurrentMemoryWrites } from "../../../packages/prsloy-harness/src/memory-lock-check.ts";
import {
  BASH_COMMAND,
  HARNESS_HEADER,
  MARKER,
  beforeAllSmoke,
  bundledRuntimes,
  findings,
  close,
  exe,
  launch,
  listFiles,
  outDir,
  runBashTurn,
  send,
  shot,
  startHost,
  writeMetrics,
  type Launched,
} from "./helpers.ts";

const strictCleanBash = process.env.SMOKE_STRICT_CLEAN_BASH === "1";

test.describe.configure({ mode: "serial" });

test.beforeAll(beforeAllSmoke);

let runnerUserData: string | undefined;

test("installed app: window, runtimes, host, reply, bash tool", async () => {
  let launched: Launched | undefined;
  try {
    launched = await launch("runner");
    const { page, userData } = launched;
    runnerUserData = userData;
    await writeMetrics({ firstWindowMs: launched.launchMs, bootstrapReadyMs: launched.readyMs });
    await shot(page, "01-window");

    // Window first: Node/Python unpack in the background and the first turn waits for them,
    // so the turn goes out right away and the extraction is checked after it.
    const hostT0 = Date.now();
    await startHost(page);
    await writeMetrics({ hostReadyMs: Date.now() - hostT0 });
    await shot(page, "02-host-ready");

    await send(page, "Привет! Ответь одной фразой.");
    await writeMetrics({
      firstTurnMs: Date.now() - launched.t0,
      // build/installer.nsh unpacks PortableGit while installing (marker = complete).
      installerGit: existsSync(
        join(dirname(exe), "resources", "runtimes", "git", ".prsloy-installer-git"),
      ),
    });

    // First-run extraction: Resources/runtimes/archives → userData/runtimes.
    await expect.poll(() => bundledRuntimes(userData).stamp, { timeout: 300_000 }).toBe(true);
    const runtimes = join(userData, "runtimes");
    const files = listFiles(runtimes, 2).map((p) => p.slice(runtimes.length + 1));
    await writeFile(join(outDir, "runtimes-tree.txt"), files.join("\n"));
    const bundled = bundledRuntimes(userData);
    await writeMetrics({
      bundledNode: bundled.node ?? null,
      bundledPython: bundled.python ?? null,
      mainTimings: launched.timings,
    });
    expect(bundled.node, `bundled node missing under ${runtimes}`).toBeTruthy();
    expect(bundled.python, `bundled python missing under ${runtimes}`).toBeTruthy();
    await expect
      .poll(async () => page.getByTestId("timeline").innerText(), { timeout: 30_000 })
      .toContain("Zeno fake model response");
    await shot(page, "03-reply");

    const bash = await runBashTurn(launched, "runner");
    await writeMetrics({
      gitSetupStatus:
        launched.gitSetup.status ??
        (await page.evaluate(() => window.zeno.prsloy.getState())).gitSetup.status,
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

// ── Memory (research/24 M-sp): files under a lock, a model call outside the turn ──

test("memory files: four processes writing at once lose nothing (lock, rename retry)", async () => {
  const root = await mkdtemp(join(tmpdir(), "prsloy-smoke-mem-"));
  const result = await concurrentMemoryWrites({
    dir: join(root, "prsloy-memory"),
    cwd: join(root, "мой проект"),
  });
  await writeMetrics({ memoryLock: result });
  expect(result.failures).toEqual([]);
  expect(result.entries).toBe(result.expected);
  expect(result.remembered).toBe(result.expected);
});

test("memory extractor: one call outside the turn after leaving a chat (installed app)", async () => {
  let launched: Launched | undefined;
  try {
    launched = await launch("extractor", {
      env: {
        PRSLOY_MEMORY_EXTRACTOR: "probe",
        PRSLOY_MEMORY_EXTRACTOR_PROVIDER: "zeno-fake",
        PRSLOY_MEMORY_EXTRACTOR_MODEL: "zeno-fake",
      },
    });
    const { page } = launched;
    await startHost(page);
    await send(page, "Привет! Ответь одной фразой.");
    await expect
      .poll(async () => page.getByTestId("timeline").innerText(), { timeout: 60_000 })
      .toContain("Zeno fake model response");
    await page.evaluate(() => window.zeno.session.create());
    const journal = join(launched.root, "smoke-pi-agent", "prsloy-memory", "extractor.jsonl");
    await expect.poll(() => existsSync(journal), { timeout: 60_000 }).toBe(true);
    const line = JSON.parse((await readFile(journal, "utf8")).trim().split("\n")[0]!);
    await writeMetrics({ extractorProbe: line });
    expect(line).toMatchObject({ kind: "probe", model: "zeno-fake", ok: true, status: 200 });
    expect(line.input).toBeGreaterThan(0);
  } finally {
    if (launched) await shot(launched.page, "99-extractor-final");
    await close(launched);
  }
});

test("second launch of the same profile: window and host ready", async () => {
  test.skip(!runnerUserData, "first launch did not run");
  let launched: Launched | undefined;
  try {
    launched = await launch("second", { userData: runnerUserData! });
    await startHost(launched.page);
    const hostReadyMs = Date.now() - launched.t0;
    await writeMetrics({
      secondLaunch: {
        windowMs: launched.launchMs,
        bootstrapReadyMs: launched.readyMs,
        hostReadyMs,
        mainTimings: launched.timings,
      },
    });
    await shot(launched.page, "05-second-launch");
    // Target is < 3 s; CI runners vary, so only a generous bound fails the build.
    expect(launched.launchMs).toBeLessThan(15_000);
    // Runtimes are already unpacked: nothing is extracted again.
    const { runtimes = 0, window = 0 } = launched.timings;
    expect(runtimes - window).toBeLessThan(1_000);
  } finally {
    await close(launched);
  }
});

// What a casual user's agent runs first: bash syntax, coreutils, git. On a clean machine this
// must come from the bundled PortableGit (Pi `shellPath`, set by the app), never WSL.
const AGENT_COMMAND =
  `${BASH_COMMAND}; echo BASH_VERSION=$BASH_VERSION; [[ 1 == 1 ]] && arr=(a b) && echo "bashisms=\${arr[1]}"; ` +
  `git --version; ls | head -5 | tr "\\n" " "; echo; grep -c . fixture.txt; sed -n 1p fixture.txt; ` +
  `awk "BEGIN{print 6*7}"; find . -maxdepth 1 -name "*.txt"; echo GIT_ROOT=$(cygpath -w /); ` +
  // Russian output from the bundled Python (needs UTF-8 stdout; Windows pipes default to ANSI).
  `echo PY=$(command -v python3); python3 -c "print('привет')"; ` +
  // Bundled Git only, in a new folder with a Cyrillic name.
  `mkdir -p 'проект с гитом' && cd 'проект с гитом' && git init -q && git status --porcelain -b && echo GIT_INIT_OK`;

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
    expect(bash.result, report).toContain("GIT_INIT_OK");
    expect(bash.result, report).toMatch(/^## (No commits yet on|Initial commit on) /m);
    expect(existsSync(join(launched.workspace, "проект с гитом", ".git", "HEAD")), report).toBe(
      true,
    );
    const ru = findings("encoding", process.env.SMOKE_STRICT_RU === "1");
    ru.check("bundled python3 prints привет", /^привет$/m.test(bash.result), report);
    await ru.finish();
  } finally {
    if (launched) await shot(launched.page, "99-clean-final");
    await close(launched);
  }
});

// ── Uninstall hygiene: uninstall keeps the profile and projects; reinstall works on top ──

const installer = process.env.SMOKE_INSTALLER ?? findInstaller(resolve("..", "..", "installer"));

function findInstaller(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((n) => /^PRSLOY-.*-win-x64\.exe$/.test(n));
  return name ? join(dir, name) : undefined;
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return check();
}

// ── Upgrade from the first alphas: profile in %APPDATA%\@zeno\desktop → %APPDATA%\PRSLOY ──

test("upgrade: the @zeno/desktop profile moves to PRSLOY with the key and runtimes", async () => {
  test.skip(process.platform !== "win32" || process.env.CI !== "true", "Windows CI only");
  const appData = process.env.APPDATA ?? "";
  const legacy = join(appData, "@zeno", "desktop");
  const target = join(appData, "PRSLOY");
  test.skip(existsSync(target), `${target} already exists (not a fresh runner)`);
  const key = `sk-prsloy-upgrade-${Date.now()}`;
  const gateway = new MockGatewayServer({ apiKey: key, modelIds: ["deepseek-v4.1-flash-1017"] });
  await gateway.start();
  const metrics: Record<string, unknown> = {};
  let launched: Launched | undefined;
  try {
    // 1. What the old build wrote: the same app on the old profile path (layout unchanged).
    launched = await launch("legacy", { userData: legacy });
    await startHost(launched.page);
    const saved = await launched.page.evaluate(([k, url]) => window.zeno.prsloy.setKey(k, url), [
      key,
      gateway.baseUrl,
    ] as const);
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    await expect.poll(() => bundledRuntimes(legacy).stamp, { timeout: 300_000 }).toBe(true);
    await close(launched);
    launched = undefined;

    // 2. The new build on its default profile: moved once, key decrypts, runtimes come back.
    launched = await launch("upgraded", { userData: null });
    metrics.userData = launched.userData;
    expect(launched.userData.toLowerCase()).toBe(target.toLowerCase());
    expect(existsSync(legacy), "old profile still there after the move").toBe(false);
    const state = await launched.page.evaluate(() => window.zeno.prsloy.getState());
    metrics.state = { hasKey: state.hasKey, baseUrl: state.baseUrl };
    expect(state.hasKey).toBe(true);
    expect(state.baseUrl).toBe(gateway.baseUrl);
    await startHost(launched.page);
    const bash = await runBashTurn(launched, "upgraded");
    expect(bash.result, `bash tool result:\n${bash.result}`).toContain(MARKER);
    // The moved venv pointed at the old path: runtimes were re-provisioned under PRSLOY.
    await expect.poll(() => bundledRuntimes(target).stamp, { timeout: 300_000 }).toBe(true);
    metrics.mainTimings = launched.timings;
    metrics.windowMs = launched.launchMs;
  } finally {
    await writeMetrics({ upgrade: metrics });
    if (launched) await shot(launched.page, "99-upgraded-final");
    await close(launched);
    await gateway.stop().catch(() => undefined);
  }
});

test("uninstall → reinstall → launch keeps the profile and projects", async () => {
  test.skip(
    process.platform !== "win32" || process.env.CI !== "true" || !installer,
    "Windows CI with the NSIS installer only (real install/uninstall)",
  );
  const installDir = dirname(exe);
  const uninstaller = join(installDir, "Uninstall PRSLOY.exe");
  const metrics: Record<string, unknown> = { installer };
  let launched: Launched | undefined;
  try {
    // 1. A real user profile (default userData, not --user-data-dir) and a user project.
    launched = await launch("profile", { userData: null });
    const userData = launched.userData;
    await startHost(launched.page);
    await expect.poll(() => bundledRuntimes(userData).stamp, { timeout: 300_000 }).toBe(true);
    await close(launched);
    launched = undefined;
    const project = join(
      process.env.USERPROFILE ?? tmpdir(),
      "Documents",
      "PRSLOY",
      "smoke-project",
    );
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "keep.txt"), "user work\n");
    metrics.userData = userData;

    // 2. Silent uninstall. NSIS re-launches itself from %TEMP%: wait for the files to go.
    expect(existsSync(uninstaller), `missing ${uninstaller}`).toBe(true);
    let t = Date.now();
    execFileSync(uninstaller, ["/S"], { windowsHide: true, timeout: 120_000 });
    const removed = await waitFor(() => !existsSync(exe), 120_000);
    expect(removed, `${exe} still present after uninstall`).toBe(true);
    // The uninstaller deletes the exe first and itself last.
    await waitFor(() => !existsSync(uninstaller), 120_000);
    metrics.uninstallMs = Date.now() - t;
    metrics.installDirLeftovers = existsSync(installDir) ? readdirSync(installDir) : [];
    // deleteAppDataOnUninstall: false — the profile (key, settings, runtimes) and projects stay.
    expect(existsSync(userData), "userData removed by uninstall").toBe(true);
    expect(existsSync(join(project, "keep.txt")), "user project removed by uninstall").toBe(true);

    // 3. Reinstall into the same folder over the kept profile (/D= last and unquoted).
    t = Date.now();
    execFileSync(installer!, ["/S", "/currentuser", `/D=${installDir}`], {
      windowsHide: true,
      timeout: 300_000,
    });
    expect(await waitFor(() => existsSync(exe), 60_000), `${exe} missing after reinstall`).toBe(
      true,
    );
    metrics.reinstallMs = Date.now() - t;

    // 4. Launch on the kept profile: window, host, a bash turn.
    launched = await launch("reinstalled", { userData: null });
    await startHost(launched.page);
    const bash = await runBashTurn(launched, "reinstalled");
    metrics.reinstalled = {
      windowMs: launched.launchMs,
      hostReadyMs: Date.now() - launched.t0,
      mainTimings: launched.timings,
      bashOk: bash.ok,
    };
    expect(bash.result, `bash tool result:\n${bash.result}`).toContain(MARKER);
    expect(bash.result, `bash tool result:\n${bash.result}`).toMatch(HARNESS_HEADER);
    expect(existsSync(join(project, "keep.txt"))).toBe(true);
  } finally {
    await writeMetrics({ installCycle: metrics });
    if (launched) await shot(launched.page, "99-reinstalled-final");
    await close(launched);
  }
});
