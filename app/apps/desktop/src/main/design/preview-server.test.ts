import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { findEntry, type PreviewServer, startPreviewServer } from "./preview-server.ts";

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

describe("findEntry", () => {
  it("prefers site/<page>/, else the shallowest index.html", () => {
    const { dir } = site();
    expect(findEntry(dir, "landing")).toBe("landing/");
    expect(findEntry(dir, "other")).toBe("landing/");
    const empty = mkdtempSync(join(tmpdir(), "design-site-"));
    expect(findEntry(empty, "landing")).toBeUndefined();
  });
});
