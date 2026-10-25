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
 *
 * Env: PRSLOY_EXE (installed A), UPDATE_INSTALLER_A (A's setup, to reinstall A), UPDATE_VERSION_A,
 * UPDATE_VERSION_B, UPDATE_FEED_GOOD, UPDATE_FEED_BAD (directories).
 *
 * electron-updater downloads B differentially (changed blocks only, the rest from A's cached
 * installer) and installs a verified download on quit even without the click
 * (autoInstallOnAppQuit), so each test starts by reinstalling A.
 */
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { passFirstRun, seedGateway, startGateway } from "./gateway.ts";
import {
  beforeAllSmoke,
  close,
  exe,
  launch,
  outDir,
  shot,
  writeMetrics,
  type Launched,
} from "./helpers.ts";
import { startFeedServer, type FeedHit } from "./update-feed.ts";

const versionA = process.env.UPDATE_VERSION_A ?? "";
const versionB = process.env.UPDATE_VERSION_B ?? "";
const feedGood = process.env.UPDATE_FEED_GOOD ?? "";
const feedBad = process.env.UPDATE_FEED_BAD ?? "";
const installerA = process.env.UPDATE_INSTALLER_A ?? "";
const READY = '[data-testid="prsloy-update-ready"]';

function powershell(command: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

/** PRSLOY.exe processes running from the install dir. */
function runningInstalled(): Array<{ Id: number; Path: string; StartTime: string }> {
  const json = powershell(
    "Get-Process PRSLOY -ErrorAction SilentlyContinue | Select-Object Id, Path, " +
      "@{n='StartTime';e={$_.StartTime.ToString('o')}} | ConvertTo-Json -Compress",
  );
  if (!json) return [];
  const parsed = JSON.parse(json) as unknown;
  return (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    Id: number;
    Path: string;
    StartTime: string;
  }>;
}

function installedProductVersion(): string {
  return powershell(
    `(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.ProductVersion`,
  );
}

/** Silent per-user install of A (undoes an update a previous test installed on quit). */
function reinstallA(): string {
  powershell("Get-Process PRSLOY -ErrorAction SilentlyContinue | Stop-Process -Force");
  execFileSync(installerA, ["/S", "/currentuser"], { windowsHide: true });
  return installedProductVersion();
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

function summarize(hits: FeedHit[]) {
  const yml = hits.find((h) => h.path.endsWith(".yml"));
  const exeHits = hits.filter((h) => h.path.endsWith(".exe"));
  const blockmaps = hits.filter((h) => h.path.endsWith(".blockmap")).map((h) => h.path);
  return {
    firstYmlMs: yml?.t ?? null,
    firstExeMs: exeHits[0]?.t ?? null,
    lastExeMs: exeHits.at(-1)?.t ?? null,
    exeRequests: exeHits.length,
    rangedExeRequests: exeHits.filter((h) => h.range).length,
    blockmaps,
  };
}

async function launchA(label: string, feedUrl: string, gatewayBase: string): Promise<Launched> {
  return launch(label, {
    testMode: false,
    prepare: seedGateway(gatewayBase),
    env: { PRSLOY_E2E: "1", PRSLOY_UPDATE_FEED_URL: feedUrl },
  });
}

test.beforeAll(async () => {
  await beforeAllSmoke();
  expect(versionA && versionB && feedGood && feedBad && installerA, "UPDATE_* env").toBeTruthy();
});

test.beforeEach(() => {
  if (process.platform !== "win32") return;
  expect(reinstallA()).toContain(versionA);
});

test("tampered update (sha512 mismatch): A refuses quietly and keeps running", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  const feed = await startFeedServer(feedBad);
  const gateway = await startGateway();
  let launched: Launched | undefined;
  try {
    launched = await launchA("upd-bad", feed.url, gateway.baseUrl);
    gateway.setUpstream(launched.fakeModel.baseUrl);
    await passFirstRun(launched);
    const { page } = launched;

    // The download is attempted, then rejected: wait for the installer requests to stop.
    await expect
      .poll(() => feed.hits.some((h) => h.path.endsWith(".exe")), {
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
  const product = installedProductVersion();
  await writeMetrics({ updateBadInstalledAfterQuit: product });
  expect(product).toContain(versionA);
});

test("good update: detect, download, «Обновление готово — перезапустить», relaunch as B", async () => {
  test.skip(process.platform !== "win32", "Windows only");
  const feed = await startFeedServer(feedGood);
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
    await shot(page, "31-update-ready");
    await writeMetrics({ updateGood: { readyMs, feed: summarize(feed.hits) } });

    // Click: quit → NSIS installs B (update mode, no wizard) → --force-run relaunches B.
    const before = new Set(runningInstalled().map((p) => p.Id));
    const clickedAt = Date.now();
    const closed = new Promise<void>((resolve) => launched!.app.once("close", () => resolve()));
    await page.locator(`${READY} button`).first().click();
    await Promise.race([closed, new Promise((r) => setTimeout(r, 60_000))]);
    const quitMs = Date.now() - clickedAt;

    let fresh: Array<{ Id: number; Path: string; StartTime: string }> = [];
    await expect
      .poll(
        () => {
          fresh = runningInstalled().filter((p) => !before.has(p.Id));
          return fresh.length;
        },
        { timeout: 240_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);
    const relaunchMs = Date.now() - clickedAt;
    await new Promise((r) => setTimeout(r, 8_000));
    desktopScreenshot("32-update-relaunched-desktop");
    const product = installedProductVersion();
    await writeMetrics({
      updateGood: {
        readyMs,
        feed: summarize(feed.hits),
        quitMs,
        relaunchMs,
        relaunchedProcesses: fresh,
        installedProductVersion: product,
      },
    });
    expect(product).toContain(versionB);

    // The relaunched app is not under Playwright: stop it and start the installed exe again
    // on the same profile to ask it which version it is.
    powershell("Get-Process PRSLOY -ErrorAction SilentlyContinue | Stop-Process -Force");
    await new Promise((r) => setTimeout(r, 3_000));
    relaunched = await launch("upd-after", {
      testMode: false,
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
