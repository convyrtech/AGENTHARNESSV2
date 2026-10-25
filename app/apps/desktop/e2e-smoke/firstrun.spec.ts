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
import { request as httpRequest, createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  FIRST_RUN_KEY,
  beforeAllSmoke,
  close,
  launch,
  shot,
  writeMetrics,
  type Launched,
} from "./helpers.ts";

const GOOD_KEY = "sk-prsloy-smoke-good-0001";
const WRONG_KEY = "sk-prsloy-smoke-wrong-0002";
const INVALID_KEY_RU = "Ключ не подошёл. Проверьте, что скопировали его целиком";
// The startup update check runs 8 s after launch (auto-update.ts startupDelayMs).
const UPDATE_CHECK_SETTLE_MS = 25_000;

type GatewayHit = { method: string; url: string; auth: "good" | "wrong" | "none" };

/**
 * OpenAI-compatible PRSLOY gateway: /v1/models checks the key, chat is proxied to `upstream`
 * (the launch's fake model, set once the app is up).
 */
async function startGateway() {
  const hits: GatewayHit[] = [];
  const state: { upstream?: URL } = {};
  const server: Server = createServer((req: IncomingMessage, res) => {
    const header = req.headers.authorization ?? "";
    const auth = header === `Bearer ${GOOD_KEY}` ? "good" : header ? "wrong" : "none";
    hits.push({ method: req.method ?? "", url: req.url ?? "", auth });
    if (auth !== "good") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key", type: "auth" } }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "deepseek-v4.1-flash-1017", object: "model" },
            { id: "kimi-k3.1-pro", object: "model" },
          ],
        }),
      );
      return;
    }
    const fake = state.upstream;
    if (!fake) {
      res.writeHead(503).end();
      return;
    }
    const upstream = httpRequest(
      {
        host: fake.hostname,
        port: fake.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: fake.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("gateway has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    hits,
    setUpstream: (fakeBaseUrl: string) => {
      state.upstream = new URL(fakeBaseUrl);
    },
    stop: async () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

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

function seedGateway(baseUrl: string) {
  return async (userData: string) => {
    await mkdir(join(userData, "prsloy"), { recursive: true });
    await writeFile(join(userData, "prsloy", "state.json"), `${JSON.stringify({ baseUrl })}\n`);
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
