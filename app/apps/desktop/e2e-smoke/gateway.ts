/**
 * Local PRSLOY gateway mock + first-run gate steps for product-mode smoke launches.
 */
import { expect } from "@playwright/test";
import { request as httpRequest, createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FIRST_RUN_KEY, type Launched } from "./helpers.ts";

export const GOOD_KEY = "sk-prsloy-smoke-good-0001";

export type GatewayHit = { method: string; url: string; auth: "good" | "wrong" | "none" };

/**
 * OpenAI-compatible PRSLOY gateway: /v1/models checks the key, chat is proxied to `upstream`
 * (the launch's fake model, set once the app is up).
 */
export async function startGateway() {
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

export function seedGateway(baseUrl: string) {
  return async (userData: string) => {
    await mkdir(join(userData, "prsloy"), { recursive: true });
    await writeFile(join(userData, "prsloy", "state.json"), `${JSON.stringify({ baseUrl })}\n`);
  };
}

/** Key → folder → app, the way a user passes the gate (folder dialog stubbed in main). */
export async function passFirstRun(launched: Launched, folderName = "Мой проект"): Promise<void> {
  const { page } = launched;
  await page.locator(`${FIRST_RUN_KEY} input`).fill(GOOD_KEY);
  await page.locator(`${FIRST_RUN_KEY} button[type="submit"]`).click();
  // RC check (desktop/ui-rc): the search step shows once SEARCH_READY
  await page.getByTestId("first-run-search-skip").click({ timeout: 60_000 });
  await expect(page.getByTestId("prsloy-first-run-folder")).toBeVisible({ timeout: 60_000 });
  const folder = join(launched.root, folderName);
  await mkdir(folder, { recursive: true });
  await launched.app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as unknown as typeof dialog.showOpenDialog;
  }, folder);
  await page.getByTestId("prsloy-folder-pick").click();
  await expect(page.getByTestId("zeno-app")).toBeVisible({ timeout: 60_000 });
}
