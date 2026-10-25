/**
 * Loopback static server over a workspace's `site/` for the built-page preview.
 * GET/HEAD only, paths resolved inside the root (symlinks included), no listing.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative, sep } from "node:path";
import { insideRoot, mimeFor } from "./paths.ts";

export type PreviewServer = { url: string; root: string; close(): Promise<void> };

/** Loopback ports of the preview servers that are up; the frame guard allows only these. */
export const previewServerPorts = new Set<number>();

/** Where an injecting server serves its script; never a project file (a project may not own it). */
export const BRIDGE_PATH = "/__prsloy/bridge.js";

/** `<script>` for the bridge, placed right after `<head>` so it hears the page's first errors. */
export function injectBridgeTag(html: string): string {
  const tag = `<script src="${BRIDGE_PATH}"></script>`;
  const at = /<head\b[^>]*>/iu.exec(html) ?? /<html\b[^>]*>/iu.exec(html);
  if (!at) return tag + html;
  const end = at.index + at[0].length;
  return html.slice(0, end) + tag + html.slice(end);
}

export function startPreviewServer(
  root: string,
  options: {
    hideDotfiles?: boolean;
    /** Script the «Код» preview adds to every HTML page (errors, «Выбрать на странице»). */
    inject?: string;
  } = {},
): Promise<PreviewServer> {
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
    if (options.inject !== undefined && pathname === BRIDGE_PATH) {
      res.writeHead(200, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : options.inject);
      return;
    }
    const rel = pathname.replace(/^\/+/, "");
    // A whole project is served for the «Код» preview: never its .env, .git or other dotfiles.
    if (options.hideDotfiles && rel.split("/").some((part) => part.startsWith("."))) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
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
    const type = mimeFor(target);
    if (options.inject !== undefined && type.startsWith("text/html")) {
      const body = Buffer.from(injectBridgeTag(readFileSync(target, "utf8")));
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
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
      previewServerPorts.add(port);
      resolve({
        url: `http://127.0.0.1:${port}/`,
        root,
        close: () => {
          previewServerPorts.delete(port);
          return new Promise((done) => server.close(() => done()));
        },
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
