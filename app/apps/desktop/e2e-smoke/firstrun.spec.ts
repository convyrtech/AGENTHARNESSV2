/**
 * Product-mode smoke: the installed app as a user starts it, without ZENO_ENABLE_TEST_COMMANDS.
 *
 * 1. First-run gate against a local mock PRSLOY gateway: wrong key → the Russian error,
 *    right key → «Выберите папку проекта» → the app, then one chat turn through the real
 *    PRSLOY provider (the gateway must see the entered key: key handoff to the agent works).
 * 2. Update check offline: every Chromium request goes to a local proxy that resets (no
 *    network) or hangs (dead network) — loopback bypasses it, so the mock gateway still
 *    works. Startup must not wait for GitHub, no error may surface, quitting stays quick.
 *
 * The gateway address is seeded into userData/prsloy/state.json, as if the user had changed
 * it in Settings. The folder dialog is answered by stubbing dialog.showOpenDialog in main.
 */
import { expect, test } from "@playwright/test";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GOOD_KEY, passFirstRun, seedGateway, startGateway } from "./gateway.ts";
import {
  FIRST_RUN_KEY,
  beforeAllSmoke,
  close,
  exe,
  launch,
  shot,
  writeMetrics,
  type Launched,
  reinstall,
  uninstallAndWait,
} from "./helpers.ts";

const WRONG_KEY = "sk-prsloy-smoke-wrong-0002";
const INVALID_KEY_RU = "Ключ не подошёл. Проверьте, что скопировали его целиком";
// The startup update check runs 8 s after launch (auto-update.ts startupDelayMs).
const UPDATE_CHECK_SETTLE_MS = 25_000;

/** HTTP proxy that never reaches the internet: `reset` drops the connection, `hang` stalls it. */
async function startDeadProxy(mode: "reset" | "hang") {
  const targets: string[] = [];
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.once("data", (chunk) => {
      targets.push(String(chunk).split("\r\n")[0] ?? "");
      if (mode === "reset") socket.resetAndDestroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("proxy has no port");
  return {
    arg: `--proxy-server=http://127.0.0.1:${address.port}`,
    targets,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

/** Text a user could read as an update failure (sidebar button or any update wording). */
async function visibleUpdateError(launched: Launched): Promise<string | undefined> {
  const page = launched.page;
  if (
    await page
      .getByTestId("sidebar-update-btn")
      .isVisible()
      .catch(() => false)
  ) {
    return "sidebar-update-btn visible";
  }
  const text = await page.locator("body").innerText();
  const line = text.split("\n").find((l) => /обновлен|update|github/i.test(l));
  return line;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(beforeAllSmoke);

test("first run (no test mode): wrong key → Russian error, right key → folder → app → reply; update check offline (reset)", async () => {
  const proxy = await startDeadProxy("reset");
  const gateway = await startGateway();
  let launched: Launched | undefined;
  try {
    launched = await launch("firstrun", {
      testMode: false,
      updates: true,
      args: [proxy.arg],
      prepare: seedGateway(gateway.baseUrl),
    });
    gateway.setUpstream(launched.fakeModel.baseUrl);
    const { page } = launched;
    await writeMetrics({ firstRunKeyScreenMs: launched.readyMs });
    await shot(page, "10-firstrun-key");

    const keyInput = page.locator(`${FIRST_RUN_KEY} input`);
    const submit = page.locator(`${FIRST_RUN_KEY} button[type="submit"]`);
    await keyInput.fill(WRONG_KEY);
    await submit.click();
    await expect(page.locator(`${FIRST_RUN_KEY} [role="alert"]`)).toHaveText(INVALID_KEY_RU, {
      timeout: 30_000,
    });
    await shot(page, "11-firstrun-wrong-key");
    expect(gateway.hits.some((h) => h.url === "/v1/models" && h.auth === "wrong")).toBe(true);

    await keyInput.fill(GOOD_KEY);
    await submit.click();
    await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
    await shot(page, "12-firstrun-folder");

    const folder = join(launched.root, "Мой проект");
    await mkdir(folder, { recursive: true });
    await launched.app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [picked],
      })) as unknown as typeof dialog.showOpenDialog;
    }, folder);
    await page.getByTestId("prsloy-folder-pick").click();
    await expect(page.getByTestId("zeno-app")).toBeVisible({ timeout: 60_000 });
    await shot(page, "13-firstrun-app");

    // One turn through the real PRSLOY provider: the gateway must receive the entered key.
    const input = page.getByTestId("prompt-input");
    await expect(input).toBeEditable({ timeout: 60_000 });
    await input.fill("Привет! Ответь одной фразой.");
    await page.getByTestId("send-prompt").click();
    await expect
      .poll(async () => page.locator("body").innerText(), { timeout: 180_000 })
      .toContain("Zeno fake model response");
    expect(
      gateway.hits.some((h) => h.url === "/v1/chat/completions" && h.auth === "good"),
      JSON.stringify(gateway.hits),
    ).toBe(true);
    await shot(page, "14-firstrun-reply");

    // Update check went out (through the dead proxy) and failed quietly.
    const wait = UPDATE_CHECK_SETTLE_MS - (Date.now() - launched.t0);
    if (wait > 0) await page.waitForTimeout(wait);
    const updateError = await visibleUpdateError(launched);
    const mainLog = await readFile(launched.mainLog, "utf8").catch(() => "");
    await writeMetrics({
      offlineReset: {
        proxyTargets: proxy.targets,
        updateLogged: /startup update check failed/.test(mainLog),
        visibleUpdateError: updateError ?? null,
      },
      firstRunGatewayHits: gateway.hits,
    });
    await shot(page, "15-firstrun-after-update-check");
    // electron-updater only runs for NSIS/AppImage builds: Windows CI is where it must fire.
    if (process.platform === "win32") {
      expect(
        proxy.targets.some((t) => /github/i.test(t)),
        proxy.targets.join("\n"),
      ).toBe(true);
    }
    expect(updateError, "update failure must stay invisible").toBeUndefined();
    expect(launched.pageErrors, launched.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    if (launched) await shot(launched.page, "99-firstrun-final");
    await close(launched);
    await gateway.stop();
    await proxy.stop();
  }
});

test("update check with a dead (hanging) network: startup not delayed, no error, quick quit", async () => {
  const proxy = await startDeadProxy("hang");
  const gateway = await startGateway();
  let launched: Launched | undefined;
  try {
    launched = await launch("offline", {
      testMode: false,
      updates: true,
      args: [proxy.arg],
      prepare: seedGateway(gateway.baseUrl),
    });
    const { page } = launched;
    await shot(page, "16-offline-key");
    // Stay past the update check while the request hangs; the UI must keep working.
    await page.waitForTimeout(Math.max(0, UPDATE_CHECK_SETTLE_MS - (Date.now() - launched.t0)));
    const keyInput = page.locator(`${FIRST_RUN_KEY} input`);
    await keyInput.fill("typing works");
    await expect(keyInput).toHaveValue("typing works");
    const updateError = await visibleUpdateError(launched);
    await shot(page, "17-offline-after-update-check");
    const closeMs = await close(launched);
    await writeMetrics({
      offlineHang: {
        keyScreenMs: launched.readyMs,
        proxyTargets: proxy.targets,
        visibleUpdateError: updateError ?? null,
        closeMs,
      },
    });
    // electron-updater only runs for NSIS/AppImage builds: Windows CI is where it must fire.
    if (process.platform === "win32") {
      expect(
        proxy.targets.some((t) => /github/i.test(t)),
        proxy.targets.join("\n"),
      ).toBe(true);
    }
    expect(updateError, "update failure must stay invisible").toBeUndefined();
    expect(launched.readyMs, "first-run screen must not wait for GitHub").toBeLessThan(60_000);
    expect(closeMs ?? 0, "quit must not wait for the hung update request").toBeLessThan(15_000);
    expect(launched.pageErrors, launched.pageErrors.join("\n\n")).toEqual([]);
    launched = undefined;
  } finally {
    if (launched) await shot(launched.page, "99-offline-final");
    await close(launched);
    await gateway.stop();
    await proxy.stop();
  }
});

// ── First command after the first launch, timed (the «ждёт 30–40 секунд» of the alpha notes) ──

/** `[prsloy-timing] <phase> <ms>` lines of a main log: phase → ms (since main started, or a duration). */
function mainTimings(log: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of log.matchAll(/\[prsloy-timing\] (\S+) (\d+)/g)) out[m[1]!] ??= Number(m[2]);
  return out;
}

test("first command after the first launch: key → folder → command → reply, timed", async () => {
  // A fresh profile on the installed app: the runtimes unpack now, in the background. The key and
  // the folder go in at machine speed — the worst case; a person takes longer on both screens.
  const gateway = await startGateway();
  let launched: Launched | undefined;
  const m: Record<string, unknown> = {};
  try {
    launched = await launch("first-command", {
      testMode: false,
      prepare: seedGateway(gateway.baseUrl),
    });
    gateway.setUpstream(launched.fakeModel.baseUrl);
    const { page, t0 } = launched;
    const since = (at = Date.now()) => at - t0;
    m.keyScreenMs = since();
    m.setupShownOnKeyScreen = await page.getByTestId("prsloy-app-setup").isVisible();
    await page.locator(`${FIRST_RUN_KEY} input`).fill(GOOD_KEY);
    const keyAt = Date.now();
    m.keyEnteredMs = since(keyAt);
    await page.locator(`${FIRST_RUN_KEY} button[type="submit"]`).click();
    await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
    m.folderScreenMs = since();
    const folder = join(launched.root, "Первый проект");
    await mkdir(folder, { recursive: true });
    await launched.app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [picked],
      })) as unknown as typeof dialog.showOpenDialog;
    }, folder);
    await page.getByTestId("prsloy-folder-pick").click();
    await expect(page.getByTestId("zeno-app")).toBeVisible({ timeout: 60_000 });
    m.appMs = since();
    const input = page.getByTestId("prompt-input");
    await expect(input).toBeEditable({ timeout: 60_000 });
    // «tool» makes the fake model call bash: the first command of the agent.
    await input.fill("Запусти команду и скажи, что вышло. tool");
    await page.getByTestId("send-prompt").click();
    const sentAt = Date.now();
    m.sentMs = since(sentAt);
    // While the turn waits for the unpack the person must see progress, not silence.
    const waitShown = page
      .getByTestId("prsloy-turn-setup")
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => since())
      .catch(() => null);
    await expect
      .poll(async () => page.locator("body").innerText(), { timeout: 300_000 })
      .toContain("Tool result received.");
    const replyAt = Date.now();
    m.replyMs = since(replyAt);
    m.keyToReplyMs = replyAt - keyAt;
    m.sendToReplyMs = replyAt - sentAt;
    const chats = gateway.hits.filter((h) => h.url === "/v1/chat/completions");
    m.sendToFirstModelRequestMs = chats[0] ? chats[0].at - sentAt : null;
    m.turnProgressShownMs = await waitShown;
    await shot(page, "15-first-command-reply");
    const timings = mainTimings(await readFile(launched.mainLog, "utf8").catch(() => ""));
    m.main = timings;
    // The unpack finished this long after the person pressed «send» (≤ 0: before it).
    m.runtimesAfterSendMs =
      timings.runtimes !== undefined ? timings.runtimes - since(sentAt) : null;
    expect(chats.length, "the command's result went back to the model").toBeGreaterThanOrEqual(2);
    expect(launched.pageErrors, launched.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    await writeMetrics({ firstCommand: m });
    await close(launched);
    await gateway.stop();
  }
});

// ── Uninstall → reinstall keeps the key and the chats (the gate is not shown again) ──

function findInstaller(): string | undefined {
  if (process.env.SMOKE_INSTALLER) return process.env.SMOKE_INSTALLER;
  const dir = resolve("..", "..", "installer");
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir).find((n) => /^PRSLOY-.*-win-x64\.exe$/.test(n));
  return name ? join(dir, name) : undefined;
}

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return check();
}

test("key and chats survive uninstall → reinstall (no first-run gate)", async () => {
  const installer = findInstaller();
  test.skip(
    process.platform !== "win32" || process.env.CI !== "true" || !installer,
    "Windows CI with the NSIS installer only (real install/uninstall)",
  );
  const profile = join(process.env.APPDATA ?? "", "PRSLOY");
  const installDir = dirname(exe);
  const chat = "Привет! Запомни этот чат.";
  const gateway = await startGateway();
  const metrics: Record<string, unknown> = {};
  let launched: Launched | undefined;
  try {
    // 1. A user's real profile: key through the gate, a project and one chat.
    await mkdir(join(profile, "prsloy"), { recursive: true });
    await seedGateway(gateway.baseUrl)(profile);
    launched = await launch("keep-key", { testMode: false, userData: null });
    gateway.setUpstream(launched.fakeModel.baseUrl);
    await passFirstRun(launched);
    await launched.page.getByTestId("prompt-input").fill(chat);
    await launched.page.getByTestId("send-prompt").click();
    await expect
      .poll(async () => launched!.page.locator("body").innerText(), { timeout: 180_000 })
      .toContain("Zeno fake model response");
    await shot(launched.page, "40-keep-key-before");
    await close(launched);
    launched = undefined;

    // 2. Uninstall silently; the program goes, the profile stays.
    // The %TEMP% copy of the uninstaller keeps deleting after PRSLOY.exe is gone: wait for it (#32).
    const uninstall = await uninstallAndWait(installDir, exe);
    metrics.uninstall = uninstall;
    expect(uninstall.exeGone, "PRSLOY.exe left after uninstall").toBe(true);
    expect(existsSync(profile), `${profile} removed by uninstall`).toBe(true);

    // 3. Reinstall silently into the same folder (/D= last, unquoted); exit codes in the metrics.
    const install = await reinstall(installer!, installDir);
    metrics.reinstall = install;
    expect(install.attempts.at(-1), JSON.stringify(install.attempts)).toMatchObject({ code: 0 });
    expect(await until(() => existsSync(exe), 60_000), "PRSLOY.exe missing after reinstall").toBe(
      true,
    );

    // 4. Same profile: straight into the app, key kept, the chat is there.
    launched = await launch("keep-key-after", {
      testMode: false,
      userData: null,
      readySelector: '[data-testid="zeno-app"]',
    });
    const gate = await launched.page.locator(FIRST_RUN_KEY).isVisible();
    const state = await launched.page.evaluate(() => window.zeno.prsloy.getState());
    await expect
      .poll(async () => launched!.page.locator("body").innerText(), { timeout: 60_000 })
      .toContain(chat);
    await shot(launched.page, "41-keep-key-after-reinstall");
    metrics.afterReinstall = { gate, hasKey: state.hasKey, needsWorkspace: state.needsWorkspace };
    expect(gate, "first-run key screen after reinstall").toBe(false);
    expect(state.hasKey, "key kept").toBe(true);
    expect(launched.pageErrors, launched.pageErrors.join("\n\n")).toEqual([]);
  } finally {
    await writeMetrics({ keepKeyReinstall: metrics });
    if (launched) await shot(launched.page, "99-keep-key-final");
    await close(launched);
    await gateway.stop();
    // Later tests expect a fresh runner (no %APPDATA%\PRSLOY).
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});
