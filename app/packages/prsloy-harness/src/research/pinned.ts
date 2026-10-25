// Соединение web_fetch — на тот IP, что прошёл проверку на частный адрес (ревью #23, второй круг): иначе fetch
// разрешает имя заново, и злой DNS между проверкой и запросом отдаёт 127.0.0.1 (DNS rebinding). node:http(s)
// с подменой lookup: имя для TLS (SNI, сертификат) и заголовка Host остаётся прежним.
// За прокси так нельзя — имя разрешает прокси; тогда обычный fetch (прокси пользователя — его сеть).
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const NULL_BODY = new Set([101, 204, 205, 304]);

/** Прокси из окружения для этого адреса (HTTPS_PROXY / HTTP_PROXY с учётом NO_PROXY), если он есть. */
export function proxyFor(url: URL, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const proxy =
    url.protocol === "https:"
      ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy)
      : (env.HTTP_PROXY ?? env.http_proxy);
  if (!proxy) return undefined;
  const host = url.hostname.toLowerCase();
  for (const raw of (env.NO_PROXY ?? env.no_proxy ?? "").split(",")) {
    const rule = raw.trim().toLowerCase().replace(/:\d+$/, "");
    if (!rule) continue;
    if (rule === "*") return undefined;
    const bare = rule.replace(/^\*?\./, "");
    if (host === bare || host.endsWith(`.${bare}`)) return undefined;
  }
  return proxy;
}

/** GET на адрес, но соединение — на `ip`. Ответ — обычный Response (тело потоком). */
export function pinnedFetch(
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal },
  ip: string,
): Promise<Response> {
  const u = new URL(url);
  const family = isIP(ip) === 6 ? 6 : 4;
  const request = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: init.headers ?? {},
        ...(init.signal ? { signal: init.signal } : {}),
        // и одиночный lookup, и {all: true} (autoSelectFamily) — всегда проверенный адрес
        lookup: ((
          _host: string,
          opts: { all?: boolean },
          cb: (err: Error | null, address: unknown, family?: number) => void,
        ) => {
          if (opts?.all) cb(null, [{ address: ip, family }]);
          else cb(null, ip, family);
        }) as never,
      },
      (res: IncomingMessage) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const x of v) headers.append(k, x);
          else if (v !== undefined) headers.set(k, v);
        }
        const status = res.statusCode ?? 0;
        const body = NULL_BODY.has(status)
          ? null
          : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        if (!body) res.resume();
        resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
