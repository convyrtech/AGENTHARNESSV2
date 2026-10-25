/**
 * Static update feed for the Windows auto-update e2e: serves `latest.yml`, the installer and
 * blockmaps from a directory, with byte ranges (single and multipart) like GitHub's CDN, so
 * electron-updater's differential download runs the same path as in production.
 */
import { createReadStream, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { basename, join } from "node:path";

export type FeedHit = {
  /** ms since the server started. */
  t: number;
  method: string;
  path: string;
  range?: string;
  status: number;
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

export async function startFeedServer(dir: string) {
  const hits: FeedHit[] = [];
  const t0 = Date.now();
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://feed").pathname);
    const name = basename(path);
    const file = join(dir, name);
    const hit: FeedHit = { t: Date.now() - t0, method: req.method ?? "", path, status: 0 };
    if (req.headers.range) hit.range = req.headers.range;
    hits.push(hit);
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
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("feed has no port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    hits,
    stop: async () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
