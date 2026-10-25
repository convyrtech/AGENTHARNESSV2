/**
 * Static update feed for the Windows auto-update e2e: serves `latest.yml`, the installer and
 * blockmaps from a directory, with byte ranges (single and multipart) like GitHub's CDN, so
 * electron-updater's differential download runs the same path as in production.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { basename, join } from "node:path";

export type FeedHit = {
  /** ms since the server started. */
  t: number;
  method: string;
  path: string;
  range?: string;
  status: number;
  /** GitHub look-alike: "github" (atom, 302) or "objects" (bytes). */
  host?: string;
};

function parseRanges(header: string, size: number): Array<[number, number]> | undefined {
  const match = /^bytes=(.+)$/.exec(header.trim());
  if (!match) return undefined;
  const ranges: Array<[number, number]> = [];
  for (const part of match[1]!.split(",")) {
    const [rawStart, rawEnd] = part.trim().split("-");
    let start: number;
    let end: number;
    if (rawStart === "") {
      start = Math.max(0, size - Number(rawEnd));
      end = size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === "" || rawEnd === undefined ? size - 1 : Math.min(Number(rawEnd), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return undefined;
    ranges.push([start, end]);
  }
  return ranges.length ? ranges : undefined;
}

function contentType(name: string): string {
  if (name.endsWith(".yml")) return "text/yaml";
  return "application/octet-stream";
}

async function sendMultipart(
  res: ServerResponse,
  file: string,
  size: number,
  ranges: Array<[number, number]>,
): Promise<void> {
  const boundary = "PRSLOY_FEED_BOUNDARY";
  res.writeHead(206, { "content-type": `multipart/byteranges; boundary=${boundary}` });
  for (const [start, end] of ranges) {
    res.write(
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n` +
        `Content-Range: bytes ${start}-${end}/${size}\r\n\r\n`,
    );
    const stream = createReadStream(file, { start, end });
    stream.pipe(res, { end: false });
    await once(stream, "end");
  }
  res.end(`\r\n--${boundary}--\r\n`);
}

/** Serve one file with HTTP byte ranges (single and multipart), recording the status. */
function serveFile(req: IncomingMessage, res: ServerResponse, file: string, hit: FeedHit): void {
  const name = basename(file);
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    hit.status = 404;
    res.writeHead(404).end();
    return;
  }
  const ranges = req.headers.range ? parseRanges(req.headers.range, size) : undefined;
  if (req.headers.range && !ranges) {
    hit.status = 416;
    res.writeHead(416, { "content-range": `bytes */${size}` }).end();
    return;
  }
  if (!ranges) {
    hit.status = 200;
    res.writeHead(200, {
      "content-type": contentType(name),
      "content-length": size,
      "accept-ranges": "bytes",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
    return;
  }
  hit.status = 206;
  if (ranges.length === 1) {
    const [start, end] = ranges[0]!;
    res.writeHead(206, {
      "content-type": contentType(name),
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  void sendMultipart(res, file, size, ranges).catch(() => res.destroy());
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server: Server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("feed has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function record(hits: FeedHit[], t0: number, req: IncomingMessage, host?: string): FeedHit {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://feed").pathname);
  const hit: FeedHit = { t: Date.now() - t0, method: req.method ?? "", path, status: 0 };
  if (host) hit.host = host;
  if (req.headers.range) hit.range = req.headers.range;
  hits.push(hit);
  return hit;
}

/** Generic feed: every file of `dir` at `/<name>`. */
export async function startFeedServer(dir: string) {
  const hits: FeedHit[] = [];
  const t0 = Date.now();
  const server = await listen((req, res) => {
    const hit = record(hits, t0, req);
    serveFile(req, res, join(dir, basename(hit.path)), hit);
  });
  return { url: `${server.origin}/`, hits, stop: server.stop };
}

export type FakeRelease = {
  tag: string;
  /** Assets directory; null = a published release without assets (yet). */
  dir: string | null;
};

/**
 * A GitHub look-alike for electron-updater's GitHubProvider (host/protocol pointed here):
 * `/<owner>/<repo>/releases.atom` lists `releases` newest first, exactly as github.com does,
 * and `/<owner>/<repo>/releases/download/<tag>/<file>` answers 302 to a second «objects» host
 * (like objects.githubusercontent.com), which serves the bytes with ranges.
 */
export async function startGitHubFeed(options: {
  owner: string;
  repo: string;
  releases: FakeRelease[];
}) {
  const hits: FeedHit[] = [];
  const t0 = Date.now();
  const base = `/${options.owner}/${options.repo}/releases`;
  const byTag = new Map(options.releases.map((r) => [r.tag, r]));

  const objects = await listen((req, res) => {
    const hit = record(hits, t0, req, "objects");
    const [, tag = "", name = ""] = /^\/([^/]+)\/([^/]+)$/.exec(hit.path) ?? [];
    const dir = byTag.get(tag)?.dir;
    if (!dir) {
      hit.status = 404;
      res.writeHead(404).end();
      return;
    }
    serveFile(req, res, join(dir, name), hit);
  });

  const github = await listen((req, res) => {
    const hit = record(hits, t0, req, "github");
    if (hit.path === `${base}.atom`) {
      hit.status = 200;
      res.writeHead(200, { "content-type": "application/atom+xml; charset=utf-8" });
      res.end(releasesAtom(options.owner, options.repo, options.releases));
      return;
    }
    const download = new RegExp(`^${base}/download/([^/]+)/([^/]+)$`).exec(hit.path);
    const release = download ? byTag.get(download[1]!) : undefined;
    if (download && release?.dir && existsSync(join(release.dir, download[2]!))) {
      hit.status = 302;
      res.writeHead(302, {
        location: `${objects.origin}/${encodeURIComponent(download[1]!)}/${encodeURIComponent(download[2]!)}`,
      });
      res.end();
      return;
    }
    hit.status = 404;
    res.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
  });

  return {
    url: `${github.origin}/`,
    hits,
    stop: async () => {
      await github.stop();
      await objects.stop();
    },
  };
}

function releasesAtom(owner: string, repo: string, releases: FakeRelease[]): string {
  const entries = releases
    .map(
      (r, i) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${r.tag}</id>
    <updated>2026-10-25T0${9 - Math.min(i, 9)}:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/${owner}/${repo}/releases/tag/${r.tag}"/>
    <title>${r.tag}</title>
    <content type="html">No content.</content>
    <author><name>${owner}</name></author>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/${owner}/${repo}/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/${owner}/${repo}/releases"/>
  <link type="application/atom+xml" rel="self" href="https://github.com/${owner}/${repo}/releases.atom"/>
  <title>Release notes from ${repo}</title>
  <updated>2026-10-25T09:00:00Z</updated>
${entries}
</feed>
`;
}
