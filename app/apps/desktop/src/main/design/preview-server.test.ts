import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  BRIDGE_PATH,
  findEntry,
  injectBridgeTag,
  type PreviewServer,
  previewServerPorts,
  startPreviewServer,
} from "./preview-server.ts";

function site() {
  const root = mkdtempSync(join(tmpdir(), "design-site-"));
  const dir = join(root, "site");
  mkdirSync(join(dir, "landing", "assets"), { recursive: true });
  writeFileSync(join(dir, "landing", "index.html"), "<h1>Зерно</h1>");
  writeFileSync(join(dir, "landing", "assets", "a.css"), "h1{}");
  writeFileSync(join(root, "secret.txt"), "s");
  return { root, dir };
}

/** Raw request: fetch() would normalise `..` away before it reaches the server. */
function get(
  url: string,
  path: string,
): Promise<{ status: number; type: string | undefined; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

let server: PreviewServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("startPreviewServer", () => {
  it("serves the page and its assets on loopback", async () => {
    const { dir } = site();
    server = await startPreviewServer(dir);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await get(server.url, "/landing/");
    expect(page).toMatchObject({ status: 200, body: "<h1>Зерно</h1>" });
    expect(page.type).toMatch(/^text\/html/);
    expect((await get(server.url, "/landing/assets/a.css")).type).toMatch(/^text\/css/);
    expect((await get(server.url, "/landing")).status).toBe(301);
  });

  it("never leaves the site folder", async () => {
    const { dir } = site();
    server = await startPreviewServer(dir);
    expect((await get(server.url, "/../secret.txt")).status).toBe(404);
    expect((await get(server.url, "/%2e%2e/secret.txt")).status).toBe(404);
    expect((await get(server.url, "/nope.html")).status).toBe(404);
  });
});

describe("project preview (hideDotfiles)", () => {
  it("serves the project but never its dotfiles, and registers its port while up", async () => {
    const { root } = site();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".env"), "KEY=1");
    writeFileSync(join(root, ".git", "config"), "x");
    server = await startPreviewServer(root, { hideDotfiles: true });
    const port = Number(new URL(server.url).port);
    expect(previewServerPorts.has(port)).toBe(true);
    expect((await get(server.url, "/site/landing/")).status).toBe(200);
    expect((await get(server.url, "/.env")).status).toBe(404);
    expect((await get(server.url, "/.git/config")).status).toBe(404);
    expect((await get(server.url, "/site/%2eenv")).status).toBe(404);
    await server.close();
    server = undefined;
    expect(previewServerPorts.has(port)).toBe(false);
  });
});

describe("project preview (inject)", () => {
  it("adds the bridge to HTML pages only and serves the bridge itself", async () => {
    const { dir } = site();
    server = await startPreviewServer(dir, { inject: "/*bridge*/" });
    const page = await get(server.url, "/landing/");
    expect(page.body).toBe(`<script src="${BRIDGE_PATH}"></script><h1>Зерно</h1>`);
    expect((await get(server.url, "/landing/assets/a.css")).body).toBe("h1{}");
    const bridge = await get(server.url, BRIDGE_PATH);
    expect(bridge).toMatchObject({ status: 200, body: "/*bridge*/" });
    expect(bridge.type).toMatch(/^text\/javascript/);
  });

  it("has no bridge without the option", async () => {
    const { dir } = site();
    server = await startPreviewServer(dir);
    expect((await get(server.url, "/landing/")).body).toBe("<h1>Зерно</h1>");
    expect((await get(server.url, BRIDGE_PATH)).status).toBe(404);
  });

  it("puts the tag first in <head>, so it hears the page's own first errors", () => {
    expect(injectBridgeTag('<html lang="ru"><HEAD><script>x()</script></HEAD></html>')).toBe(
      `<html lang="ru"><HEAD><script src="${BRIDGE_PATH}"></script><script>x()</script></HEAD></html>`,
    );
    expect(injectBridgeTag("<html><body>a</body></html>")).toBe(
      `<html><script src="${BRIDGE_PATH}"></script><body>a</body></html>`,
    );
    // <header> is not <head>.
    expect(injectBridgeTag("<header>a</header>")).toBe(
      `<script src="${BRIDGE_PATH}"></script><header>a</header>`,
    );
  });
});

describe("findEntry", () => {
  it("prefers site/<page>/, else the shallowest index.html", () => {
    const { dir } = site();
    expect(findEntry(dir, "landing")).toBe("landing/");
    expect(findEntry(dir, "other")).toBe("landing/");
    const empty = mkdtempSync(join(tmpdir(), "design-site-"));
    expect(findEntry(empty, "landing")).toBeUndefined();
  });
});
