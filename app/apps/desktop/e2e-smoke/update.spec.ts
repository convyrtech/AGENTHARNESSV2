/**
 * Auto-update end to end on Windows (CI: desktop-windows.yml → update-e2e job).
 *
 * The job builds version A and a newer B the way the tag build does, installs A, and serves
 * B's `latest.yml` + installer + blockmaps from a local feed (`update-feed.ts`). A is pointed
 * at it with the test-only override (PRSLOY_E2E=1 + loopback PRSLOY_UPDATE_FEED_URL; production
 * stays on GitHub — see auto-update.ts resolveUpdateFeed).
 *
 * 1. Bad feed (B's installer bytes changed, latest.yml unchanged → sha512 mismatch): A must
 *    refuse quietly, show nothing and keep running as A.
 * 2. Good feed: A detects and downloads B, shows «Обновление готово — перезапустить»; the click
 *    installs B and the updater relaunches it; the installed app then reports version B.
 * 3. Previous public release → this build: the installer published on GitHub (the newest release
 *    before this one) is installed, used like a person would — key, a project, a chat, a memory
 *    entry its own memory tool saved — and updated to B through the same feed. B must open
 *    straight into the app with all of it in %APPDATA%\PRSLOY.
 *
 * Env: PRSLOY_EXE (installed A), UPDATE_INSTALLER_A (A's setup, to reinstall A), UPDATE_VERSION_A,
 * UPDATE_VERSION_B, UPDATE_FEED_GOOD, UPDATE_FEED_BAD (directories); for 3: UPDATE_PUBLIC_VERSION,
 * UPDATE_PUBLIC_INSTALLER, UPDATE_RELEASE_PUBLIC (its release assets), UPDATE_FEED_PUBLIC (B + its blockmap).
 *
 * electron-updater downloads B differentially (changed blocks only, the rest from A's cached
 * installer) and installs a verified download on quit even without the click
 * (autoInstallOnAppQuit), so each test starts by reinstalling A.
 */
import { expect, test } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { passFirstRun, seedGateway, startGateway } from "./gateway.ts";
import {
  beforeAllSmoke,
  close,
  findings,
  FIRST_RUN_KEY,
  launch,
  outDir,
  shot,
  writeMetrics,
  type Launched,
} from "./helpers.ts";
import { startGitHubFeed, type FakeRelease, type FeedHit } from "./update-feed.ts";

const versionA = process.env.UPDATE_VERSION_A ?? "";
const versionB = process.env.UPDATE_VERSION_B ?? "";
const feedGood = process.env.UPDATE_FEED_GOOD ?? "";
const feedBad = process.env.UPDATE_FEED_BAD ?? "";
/** A's own release assets (its blockmap is the base of the differential download). */
const releaseA = process.env.UPDATE_RELEASE_A ?? "";
const installerA = process.env.UPDATE_INSTALLER_A ?? "";
/** The newest release already on GitHub (what users have installed) and B's feed for it. */
const publicVersion = process.env.UPDATE_PUBLIC_VERSION ?? "";
const publicInstaller = process.env.UPDATE_PUBLIC_INSTALLER ?? "";
const releasePublic = process.env.UPDATE_RELEASE_PUBLIC ?? "";
const feedPublic = process.env.UPDATE_FEED_PUBLIC ?? "";
const READY = '[data-testid="prsloy-update-ready"]';

function powershell(command: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

/** PRSLOY.exe processes running from the install dir. */
function runningInstalled(): Array<{ Id: number; Path: string; StartTime: string }> {
  let json = "";
  try {
    json = powershell(
      "Get-Process PRSLOY -ErrorAction SilentlyContinue | Select-Object Id, Path, " +
        "@{n='StartTime';e={$_.StartTime.ToString('o')}} | ConvertTo-Json -Compress; exit 0",
    );
  } catch {
    return [];
  }
  if (!json) return [];
  const parsed = JSON.parse(json) as unknown;
  return (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    Id: number;
    Path: string;
    StartTime: string;
  }>;
}

/**
 * Installed version from the per-user uninstall entry NSIS writes (`DisplayVersion` keeps the
 * prerelease part; the exe's file version is just 0.1.0.0).
 */
/** Every PRSLOY* process (app and installer) with its window title, for diagnostics. */
function prsloyProcesses(): string {
  try {
    return powershell(
      "Get-Process | Where-Object Name -like 'PRSLOY*' | Select-Object Id, Name, MainWindowTitle, " +
        "@{n='StartTime';e={$_.StartTime.ToString('o')}} | ConvertTo-Json -Compress; exit 0",
    );
  } catch (error) {
    return String(error);
  }
}

function installedVersion(): string {
  return powershell(
    "Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' " +
      "-ErrorAction SilentlyContinue | Where-Object DisplayName -like 'PRSLOY*' | " +
      "Select-Object -First 1 -ExpandProperty DisplayVersion",
  );
}

/**
 * Wait until no PRSLOY installer runs: a test that closes A with B downloaded leaves B's silent
 * installer running (autoInstallOnAppQuit), and a second NSIS run at the same time fails.
 */
async function noInstallerRunning(maxMs = 240_000): Promise<string> {
  const running = () =>
    powershell(
      "Get-Process | Where-Object Name -like 'PRSLOY-*' | Select-Object -ExpandProperty Name; exit 0",
    );
  const end = Date.now() + maxMs;
  let names = running();
  while (names && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 2_000));
    names = running();
  }
  return names;
}

/** Silent per-user install of A (undoes an update a previous test installed on quit). */
async function reinstallA(): Promise<string> {
  powershell("Get-Process PRSLOY -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0");
  expect(await noInstallerRunning(), "an installer still running").toBe("");
  execFileSync(installerA, ["/S", "/currentuser"], { windowsHide: true });
  return installedVersion();
}

function desktopScreenshot(name: string): void {
  // Best effort: the relaunched app is not under Playwright, so capture the whole screen.
  const path = join(outDir, `${name}.png`).replaceAll("'", "''");
  try {
    powershell(
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
        "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; " +
        "$g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); " +
        `$bmp.Save('${path}')`,
    );
  } catch {
    // no interactive desktop
  }
}

/** Releases as on github.com, newest first; A's tag carries A's assets. */
function releases(...newer: FakeRelease[]): FakeRelease[] {
  return [...newer, { tag: `v${versionA}`, dir: releaseA }];
}

function startGitHub(list: FakeRelease[]) {
  return startGitHubFeed({ owner: "convyrtech", repo: "AGENTHARNESSV2", releases: list });
}

function summarize(hits: FeedHit[]) {
  const yml = hits.find((h) => h.path.endsWith(".yml"));
  // Bytes come from the «objects» host after GitHub's 302.
  const exeHits = hits.filter((h) => h.path.endsWith(".exe") && h.host === "objects");
  const blockmaps = hits.filter((h) => h.path.endsWith(".blockmap")).map((h) => h.path);
  return {
    firstYmlMs: yml?.t ?? null,
    firstExeMs: exeHits[0]?.t ?? null,
    lastExeMs: exeHits.at(-1)?.t ?? null,
    exeRequests: exeHits.length,
    rangedExeRequests: exeHits.filter((h) => h.range).length,
    blockmaps,
    /** GitHub-side requests in order: atom, channel files, downloads (path + status). */
    github: hits
      .filter((h) => h.host === "github")
      .map((h) => `${h.path.replace("/convyrtech/AGENTHARNESSV2/releases", "")} ${h.status}`),
  };
}

async function launchA(label: string, feedUrl: string, gatewayBase: string): Promise<Launched> {
  return launch(label, {
    testMode: false,
    updates: true,
    prepare: seedGateway(gatewayBase),
    env: { PRSLOY_E2E: "1", PRSLOY_UPDATE_FEED_URL: feedUrl },
  });
}

test.beforeAll(async () => {
  await beforeAllSmoke();
  expect(
    versionA && versionB && feedGood && feedBad && releaseA && installerA,
    "UPDATE_* env",
  ).toBeTruthy();
});

const updaterCache = join(process.env.LOCALAPPDATA ?? "", "prsloy-updater");

test.beforeEach(async () => {
  if (process.platform !== "win32") return;
  // That test installs the public release itself; A is not part of it.
  if (test.info().title.startsWith("previous public release")) return;
  expect(await reinstallA()).toContain(versionA);
  // The installer keeps its own copy here: the base for differential downloads.
  expect(existsSync(join(updaterCache, "installer.exe")), `${updaterCache}\\installer.exe`).toBe(
    true,
  );
});

test("tampered update (sha512 mismatch): A refuses quietly and keeps running", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  const feed = await startGitHub(releases({ tag: `v${versionB}`, dir: feedBad }));
  const gateway = await startGateway();
  let launched: Launched | undefined;
  try {
    launched = await launchA("upd-bad", feed.url, gateway.baseUrl);
    gateway.setUpstream(launched.fakeModel.baseUrl);
    await passFirstRun(launched);
    const { page } = launched;

    // The download is attempted, then rejected: wait for the installer requests to stop.
    await expect
      .poll(() => feed.hits.some((h) => h.path.endsWith(".exe") && h.host === "objects"), {
        timeout: 180_000,
      })
      .toBe(true);
    let last = feed.hits.length;
    for (;;) {
      await page.waitForTimeout(10_000);
      if (feed.hits.length === last) break;
      last = feed.hits.length;
    }
    const mainLog = await readFile(launched.mainLog, "utf8").catch(() => "");
    const rejection = mainLog
      .split("\n")
      .filter((line) => /sha512|checksum|mismatch|Cannot download|ERR_UPDATER/i.test(line))
      .slice(0, 8);
    await shot(page, "30-update-bad-after-download");

    const version = await launched.app.evaluate(({ app }) => app.getVersion());
    const ready = await page.locator(READY).isVisible();
    await page.getByTestId("prompt-input").fill("всё ещё работает");
    await expect(page.getByTestId("prompt-input")).toHaveValue("всё ещё работает");
    await writeMetrics({
      updateBad: {
        feed: summarize(feed.hits),
        rejection,
        versionAfter: version,
        readyShown: ready,
      },
    });
    expect(ready, "no «Обновление готово» for a tampered update").toBe(false);
    expect(version).toBe(versionA);
    expect(rejection.join("\n"), "updater logged the checksum rejection").toMatch(
      /sha512|checksum/i,
    );
    expect(launched.pageErrors, launched.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    await close(launched);
    await gateway.stop();
    await feed.stop();
    await writeFile(join(outDir, "update-feed-hits-bad.json"), JSON.stringify(feed.hits, null, 2));
  }
  // Quit must not install anything (autoInstallOnAppQuit only installs a verified download).
  await new Promise((r) => setTimeout(r, 5_000));
  const product = installedVersion();
  await writeMetrics({ updateBadInstalledAfterQuit: product });
  expect(product).toContain(versionA);
});

test("good update: detect, download, «Обновление готово — перезапустить», relaunch as B", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  // A non-semver tag on top (an old «desktop-v» name) must be skipped, not installed.
  const feed = await startGitHub(
    releases(
      { tag: `desktop-v${versionB.replace(/\d+$/, "99")}`, dir: feedGood },
      { tag: `v${versionB}`, dir: feedGood },
    ),
  );
  const gateway = await startGateway();
  let launched: Launched | undefined;
  let relaunched: Launched | undefined;
  try {
    launched = await launchA("upd-good", feed.url, gateway.baseUrl);
    gateway.setUpstream(launched.fakeModel.baseUrl);
    await passFirstRun(launched);
    const { page, t0, userData } = launched;

    await expect(page.locator(READY)).toBeVisible({ timeout: 300_000 });
    const readyMs = Date.now() - t0;
    await expect(page.locator(READY)).toContainText("Обновление готово — перезапустить");
    // electron-updater downloaded into %LOCALAPPDATA%\prsloy-updater, differentially.
    const updaterLog = await readFile(launched.mainLog, "utf8").catch(() => "");
    const cacheLine = /updater cache dir: (.+)/.exec(updaterLog)?.[1]?.trim() ?? "";
    const toDownload = /To download: ([\d,.]+ KB) \((\d+)%\)/.exec(updaterLog);
    await writeMetrics({
      updaterCache: {
        dir: cacheLine,
        toDownload: toDownload?.[1] ?? null,
        percent: toDownload?.[2],
      },
    });
    expect(cacheLine.toLowerCase()).toBe(updaterCache.toLowerCase());
    expect(Number(toDownload?.[2] ?? 100), "differential download").toBeLessThan(20);
    await shot(page, "31-update-ready");
    await writeMetrics({ updateGood: { readyMs, feed: summarize(feed.hits) } });
    // The real GitHubProvider path: atom → channel file (alpha.yml 404 → latest.yml) via the
    // tag's download URL → 302 → bytes from the objects host; the non-semver tag never touched.
    const github = summarize(feed.hits).github;
    expect(github[0], github.join("\n")).toBe(".atom 200");
    expect(github, github.join("\n")).toContain(`/download/v${versionB}/latest.yml 302`);
    expect(
      github.some((h) => h.includes("desktop-v")),
      github.join("\n"),
    ).toBe(false);
    expect(
      feed.hits.some((h) => h.host === "objects" && h.path.endsWith(".exe") && h.status === 206),
    ).toBe(true);

    // Click: quit → NSIS installs B (update mode, no wizard) → --force-run relaunches B.
    const before = new Set(runningInstalled().map((p) => p.Id));
    const clickedAt = Date.now();
    const closed = new Promise<void>((resolve) => launched!.app.once("close", () => resolve()));
    await page.locator(`${READY} button`).first().click();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 60_000))]);
    const quitMs = Date.now() - clickedAt;

    // Watch the installer and the relaunch; keep a timeline whatever happens.
    let fresh: Array<{ Id: number; Path: string; StartTime: string }> = [];
    const timeline: Array<{ phase: string; ms: number; installed: string; processes: string }> = [];
    let relaunchMs: number | undefined;
    let installedMs: number | undefined;
    const watch = async (phase: string, maxMs: number) => {
      const deadline = Date.now() + maxMs;
      while (relaunchMs === undefined && Date.now() < deadline) {
        const installed = installedVersion();
        if (installedMs === undefined && installed.includes(versionB)) {
          installedMs = Date.now() - clickedAt;
        }
        timeline.push({
          phase,
          ms: Date.now() - clickedAt,
          installed,
          processes: prsloyProcesses(),
        });
        fresh = runningInstalled().filter((p) => !before.has(p.Id));
        if (fresh.length > 0) relaunchMs = Date.now() - clickedAt;
        else await new Promise((r) => setTimeout(r, 3_000));
      }
    };
    await watch("click", 45_000);
    desktopScreenshot("32a-update-after-click-desktop");

    // The click must update without questions. quitAndInstall(false, true) runs the assisted
    // NSIS installer without /S, which stops on «Choose Installation Options» (English, all
    // users / only me) while the app is already gone.
    const installers = prsloyProcesses();
    const wizard =
      relaunchMs === undefined &&
      !installedVersion().includes(versionB) &&
      /"MainWindowTitle":"PRSLOY Setup/.test(installers);
    const silent = findings("update-silent", process.env.SMOKE_STRICT_UPDATE_SILENT === "1");
    silent.check(
      "click installs B without an installer wizard",
      !wizard,
      `installer window after 45 s: ${installers}`,
    );
    await silent.finish();
    let viaSilentInstaller = false;
    if (wizard) {
      // Proposed fix, proven here: run the verified pending installer the way
      // quitAndInstall(true, true) does (--updated /S --force-run).
      const pending = powershell(
        "Get-Process | Where-Object Name -like 'PRSLOY-*-win-x64' | Select-Object -First 1 " +
          "-ExpandProperty Path; exit 0",
      );
      powershell(
        "Get-Process | Where-Object Name -like 'PRSLOY-*-win-x64' | Stop-Process -Force; exit 0",
      );
      await new Promise((r) => setTimeout(r, 2_000));
      expect(pending, "pending installer path").toMatch(/pending.*\.exe$/i);
      spawn(pending, ["--updated", "/S", "--force-run"], {
        detached: true,
        stdio: "ignore",
      }).unref();
      viaSilentInstaller = true;
      await watch("silent", 240_000);
    }
    await new Promise((r) => setTimeout(r, 8_000));
    desktopScreenshot("32-update-relaunched-desktop");
    const product = installedVersion();
    await writeMetrics({
      updateGood: {
        readyMs,
        feed: summarize(feed.hits),
        quitMs,
        installedMs: installedMs ?? null,
        clickShowedWizard: wizard,
        viaSilentInstaller,
        relaunchMs: relaunchMs ?? null,
        relaunchedProcesses: fresh,
        installedVersion: product,
      },
    });
    await writeFile(join(outDir, "update-timeline.json"), JSON.stringify(timeline, null, 2));
    expect(product, "installed version after the click").toContain(versionB);
    expect(relaunchMs, "updater relaunched the app (--force-run)").toBeDefined();

    // The relaunched app is not under Playwright: stop it and start the installed exe again
    // on the same profile to ask it which version it is.
    powershell("Get-Process PRSLOY -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0");
    await new Promise((r) => setTimeout(r, 3_000));
    relaunched = await launch("upd-after", {
      testMode: false,
      updates: true,
      userData,
      readySelector: '[data-testid="zeno-app"]',
      env: { PRSLOY_NO_UPDATE: "1" },
    });
    const version = await relaunched.app.evaluate(({ app }) => app.getVersion());
    await shot(relaunched.page, "33-update-after-relaunch");
    await writeMetrics({ updateGoodVersionAfter: version });
    expect(version).toBe(versionB);
    expect(relaunched.pageErrors, relaunched.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    await close(relaunched);
    await close(launched);
    await gateway.stop();
    await feed.stop();
    await writeFile(join(outDir, "update-feed-hits-good.json"), JSON.stringify(feed.hits, null, 2));
  }
});

test("newest release has no assets yet: A skips it and still finds B", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  // A release published before CI attached latest.yml (or a failed build). Plain GitHubProvider
  // stops at it (ERR_UPDATER_CHANNEL_FILE_NOT_FOUND, no fallback); the app's provider subclass
  // (update-provider.ts) drops that entry from the atom and finds the newest complete release.
  const empty = `v${versionB.replace(/\d+$/, "92")}`;
  const feed = await startGitHub(
    releases({ tag: empty, dir: null }, { tag: `v${versionB}`, dir: feedGood }),
  );
  const gateway = await startGateway();
  let launched: Launched | undefined;
  try {
    launched = await launchA("upd-noassets", feed.url, gateway.baseUrl);
    gateway.setUpstream(launched.fakeModel.baseUrl);
    await passFirstRun(launched);
    const { page } = launched;
    await expect(page.locator(READY)).toBeVisible({ timeout: 300_000 });
    const readyMs = Date.now() - launched.t0;
    const mainLog = await readFile(launched.mainLog, "utf8").catch(() => "");
    const skipped = /release (\S+) has no update files yet/.exec(mainLog)?.[1] ?? null;
    await shot(page, "34-update-noassets-skipped");
    const summary = summarize(feed.hits);
    await writeMetrics({ updateNoAssets: { feed: summary, skipped, readyMs } });
    expect(summary.github, summary.github.join("\n")).toContain(
      `/download/${empty}/latest.yml 404`,
    );
    expect(summary.github, summary.github.join("\n")).toContain(
      `/download/v${versionB}/latest.yml 302`,
    );
    expect(summary.github.filter((h) => h === ".atom 200").length, "one re-read of the feed").toBe(
      2,
    );
    expect(skipped).toBe(empty);
    expect(launched.pageErrors, launched.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    await close(launched);
    await gateway.stop();
    await feed.stop();
    await writeFile(
      join(outDir, "update-feed-hits-noassets.json"),
      JSON.stringify(feed.hits, null, 2),
    );
  }
});

/** Every file under `dir` (relative path → bytes). */
function contents(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length + 1)] = readFileSync(path);
  }
  return out;
}

/** sha256 of every file under `dir` (relative path → hash), for «nothing lost, nothing rewritten». */
function hashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    out[path.slice(dir.length + 1)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return out;
}

test("previous public release → this build: key, project, chat and memory survive the update", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  expect(
    publicVersion && publicInstaller && releasePublic && feedPublic,
    "UPDATE_PUBLIC_* env (the update-e2e job downloads the newest GitHub release)",
  ).toBeTruthy();
  // A real user's profile: %APPDATA%\PRSLOY, the folder the updater-relaunched app opens too.
  const profile = join(process.env.APPDATA ?? "", "PRSLOY");
  const chat = "Привет! Запомни: я люблю короткие ответы. tool";
  const fact = "Любит короткие ответы";
  const metrics: Record<string, unknown> = { from: publicVersion, to: versionB };
  const feed = await startGitHub([
    { tag: `v${versionB}`, dir: feedPublic },
    { tag: `v${publicVersion}`, dir: releasePublic },
  ]);
  const gateway = await startGateway();
  let launched: Launched | undefined;
  let after: Launched | undefined;
  try {
    // 1. Install what users have: the published installer, over whatever is there.
    powershell("Get-Process PRSLOY -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0");
    expect(await noInstallerRunning(), "an installer still running").toBe("");
    await rm(profile, { recursive: true, force: true });
    execFileSync(publicInstaller, ["/S", "/currentuser"], { windowsHide: true });
    expect(installedVersion()).toContain(publicVersion);

    // 2. Use it: key through the gate, a project folder, memory on, one chat in which its own
    //    memory tool saves a fact (the fake model calls it on a prompt with «tool»).
    await mkdir(join(profile, "prsloy"), { recursive: true });
    await seedGateway(gateway.baseUrl)(profile);
    await mkdir(join(profile, "agent"), { recursive: true });
    await writeFile(
      join(profile, "agent", "prsloy-harness.json"),
      JSON.stringify({ memory: true }),
    );
    launched = await launch("upd-public", {
      testMode: false,
      updates: true,
      userData: profile,
      env: { PRSLOY_E2E: "1", PRSLOY_UPDATE_FEED_URL: feed.url },
      toolCall: {
        name: "memory",
        arguments: {
          action: "remember",
          scope: "user",
          text: fact,
          quote: "я люблю короткие ответы",
        },
      },
    });
    gateway.setUpstream(launched.fakeModel.baseUrl);
    const { page } = launched;
    expect(await launched.app.evaluate(({ app }) => app.getVersion())).toBe(publicVersion);
    await passFirstRun(launched);
    const workspace = join(launched.root, "Мой проект");
    await page.getByTestId("prompt-input").fill(chat);
    await page.getByTestId("send-prompt").click();
    const remembered = () =>
      page.evaluate(
        async (ws) => ((await window.zeno.memory?.list(ws))?.user ?? []).map((e) => e.text),
        workspace,
      );
    await expect.poll(remembered, { timeout: 180_000 }).toContain(fact);
    await shot(page, "35-public-before-update");
    const stateBefore = await page.evaluate(() => window.zeno.prsloy.getState());
    expect(stateBefore.hasKey).toBe(true);

    // 3. The update arrives; snapshot the profile's data before the click.
    await expect(page.locator(READY)).toBeVisible({ timeout: 300_000 });
    const data = {
      key: hashes(join(profile, "prsloy")),
      // A chat file is a log: lines may be added later, what was written must stay as it was.
      sessions: contents(join(profile, "agent", "sessions")),
      memory: hashes(join(profile, "agent", "prsloy-memory")),
    };
    metrics.files = {
      key: Object.keys(data.key),
      sessions: Object.keys(data.sessions).length,
      memory: Object.keys(data.memory),
    };
    expect(Object.keys(data.key)).toContain("gateway-key.bin");
    expect(Object.keys(data.sessions).length, "the chat is on disk").toBeGreaterThan(0);
    const before = new Set(runningInstalled().map((p) => p.Id));
    const clickedAt = Date.now();
    const closed = new Promise<void>((resolve) => launched!.app.once("close", () => resolve()));
    await page.locator(`${READY} button`).first().click();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 60_000))]);
    launched = undefined;
    let relaunchMs: number | undefined;
    for (const end = Date.now() + 240_000; Date.now() < end; ) {
      if (
        installedVersion().includes(versionB) &&
        runningInstalled().some((p) => !before.has(p.Id))
      ) {
        relaunchMs = Date.now() - clickedAt;
        break;
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    metrics.relaunchMs = relaunchMs ?? null;
    metrics.installed = installedVersion();
    metrics.processes = prsloyProcesses();
    desktopScreenshot("36-public-relaunched-desktop");
    expect(installedVersion(), "installed version after the click").toContain(versionB);
    expect(relaunchMs, "updater installed B silently and relaunched it").toBeDefined();

    // 4. B on the same profile: straight into the app, everything still there.
    powershell("Get-Process PRSLOY -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0");
    await new Promise((r) => setTimeout(r, 3_000));
    after = await launch("upd-public-after", {
      testMode: false,
      updates: true,
      userData: profile,
      readySelector: '[data-testid="zeno-app"]',
      env: { PRSLOY_NO_UPDATE: "1" },
    });
    expect(await after.app.evaluate(({ app }) => app.getVersion())).toBe(versionB);
    const gate = await after.page.locator(FIRST_RUN_KEY).isVisible();
    const state = await after.page.evaluate(() => window.zeno.prsloy.getState());
    await expect
      .poll(async () => after!.page.locator("body").innerText(), { timeout: 60_000 })
      .toContain("Привет! Запомни: я люблю короткие ответы.");
    const memoryAfter = await after.page.evaluate(
      async (ws) => ((await window.zeno.memory?.list(ws))?.user ?? []).map((e) => e.text),
      workspace,
    );
    await shot(after.page, "37-public-after-update");
    const keyAfter = hashes(join(profile, "prsloy"));
    const sessionsAfter = contents(join(profile, "agent", "sessions"));
    metrics.after = {
      gate,
      hasKey: state.hasKey,
      needsWorkspace: state.needsWorkspace,
      memory: memoryAfter,
      memoryFiles: Object.keys(hashes(join(profile, "agent", "prsloy-memory"))),
    };
    expect(gate, "first-run key screen after the update").toBe(false);
    expect(state.hasKey, "key kept").toBe(true);
    expect(state.needsWorkspace, "project kept").toBe(false);
    expect(memoryAfter, "memory kept and readable by the new version").toContain(fact);
    expect(keyAfter["gateway-key.bin"], "key file unchanged").toBe(data.key["gateway-key.bin"]);
    metrics.chatFiles = Object.fromEntries(
      Object.entries(data.sessions).map(([f, b]) => [
        f,
        { before: b.length, after: sessionsAfter[f]?.length ?? null },
      ]),
    );
    for (const [file, bytes] of Object.entries(data.sessions)) {
      const now = sessionsAfter[file];
      expect(now, `chat file ${file} kept`).toBeDefined();
      expect(
        now!.subarray(0, bytes.length).equals(bytes),
        `chat file ${file}: what was written before the update is unchanged`,
      ).toBe(true);
    }
    expect(after.pageErrors, after.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    await writeMetrics({ updateFromPublic: metrics });
    await close(after);
    await close(launched);
    await gateway.stop();
    await feed.stop();
    await writeFile(
      join(outDir, "update-feed-hits-public.json"),
      JSON.stringify(feed.hits, null, 2),
    );
    powershell("Get-Process PRSLOY -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0");
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
