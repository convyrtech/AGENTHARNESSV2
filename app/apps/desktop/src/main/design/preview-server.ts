/**
 * Loopback static server over a workspace's `site/` for the built-page preview.
 * GET/HEAD only, paths resolved inside the root (symlinks included), no listing.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative, sep } from "node:path";
import { insideRoot, mimeFor } from "./paths.ts";

export type PreviewServer = { url: string; root: string; close(): Promise<void> };

export function startPreviewServer(root: string): Promise<PreviewServer> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const rel = pathname.replace(/^\/+/, "");
    let target = rel ? insideRoot(root, rel) : root;
    if (target && existsSync(target) && statSync(target).isDirectory()) {
      if (rel && !pathname.endsWith("/")) {
        res.writeHead(301, { Location: `${pathname}/` }).end();
        return;
      }
      target = insideRoot(root, join(rel, "index.html"));
    }
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeFor(target),
      "Content-Length": statSync(target).size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(target).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        root,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** The page to open: `site/<page>/index.html` first, else the shallowest index.html. */
export function findEntry(root: string, page: string): string | undefined {
  if (existsSync(join(root, page, "index.html"))) return `${page}/`;
  if (existsSync(join(root, "index.html"))) return "";
  const queue = [root];
  for (let depth = 0; depth < 4 && queue.length; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        continue;
      }
      for (const name of entries) {
        const full = join(dir, name);
        if (name === "index.html" && dir !== root) {
          return `${relative(root, dir).split(sep).map(encodeURIComponent).join("/")}/`;
        }
        if (!name.startsWith(".") && name !== "node_modules") {
          try {
            if (statSync(full).isDirectory()) next.push(full);
          } catch {
            // unreadable entry
          }
        }
      }
    }
    queue.splice(0, queue.length, ...next);
  }
  return undefined;
}
