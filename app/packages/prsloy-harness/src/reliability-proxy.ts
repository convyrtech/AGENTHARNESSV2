// Практика 3 (PLAN-alpha §3): прокси надёжности на пути чата «Код». Порт логики
// playbooks/site/harness/a6proxy.py на TS, в процессе хоста, с одним отличием: после первого полезного куска
// ответ идёт агенту живым потоком (чату нужны токены по мере появления), а не копится целиком.
// Источник: E8q/E9 (DIARY 2026-10-25): ошибка внутри потока («等待响应超时 … 上游服务»), 200 с ошибкой в теле,
// пустой поток, поставщик молчит минутами до первого токена, chunked рвал JSON у Qwen, нет пустой строки после
// usage, «close» ждал 75 с. Ключа прокси не держит: заголовок Authorization от Pi уходит шлюзу как есть.
import { appendFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";

export interface ReliabilityOptions {
  /** До первого полезного куска (content / tool_calls / reasoning), мс. Чат: 60 с. */
  ttftMs?: number;
  /** Тишина посреди потока после первого куска, мс: дольше — обрыв. */
  idleMs?: number;
  /** Сколько раз пробовать до первого куска. */
  attempts?: number;
  /** Как часто слать «: ping», пока ждём первый кусок, мс. */
  pingMs?: number;
  /** Ответ без потока целиком, мс. */
  nonStreamTimeoutMs?: number;
  /** Пауза перед повтором после 429/5xx, мс (n — номер попытки). */
  backoffMs?: (attempt: number) => number;
  /** Для тестов: свой fetch. */
  fetchImpl?: typeof fetch;
}

/** Текст для интерфейса: по нему UI показывает «Связь с моделью оборвалась» + «Повторить». */
export const STREAM_INTERRUPTED_MESSAGE = "Связь с моделью оборвалась";
export const STREAM_INTERRUPTED_CODE = "prsloy_stream_interrupted";

// Ошибки a6/шлюза приходят текстом в теле или первом событии потока (a6proxy.py RETRY_TEXT).
const RETRY_TEXT = [
  "等待响应超时",
  "上游",
  "upstream",
  "timeout",
  "timed out",
  "overloaded",
  "temporarily",
  "no available",
  "rate limit",
  "try again",
  "稍后重试",
];
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

export function looksLikeGatewayError(text: string): boolean {
  if (text.includes("等待响应超时") || text.includes("上游服务")) return true;
  const lower = text.toLowerCase();
  return lower.includes('"error"') && RETRY_TEXT.some((k) => lower.includes(k.toLowerCase()));
}

interface Delta {
  content?: unknown;
  tool_calls?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
}

interface Chunk {
  choices?: { delta?: Delta; finish_reason?: string | null }[];
  usage?: Record<string, unknown> & {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: unknown;
}

function isUseful(chunk: Chunk): boolean {
  return (chunk.choices ?? []).some((choice) => {
    const d = choice.delta ?? {};
    return Boolean(d.content || d.tool_calls || d.reasoning_content || d.reasoning);
  });
}

/**
 * Разбор SSE по декодированному тексту (не по сокету: chunked и gzip уже сняты fetch-ем, E9 №1).
 * Строки `data:` с цельным JSON отдаются сразу — так поток без пустой строки между событиями
 * (E9: «без пустой строки после usage») не склеивается в одно событие.
 */
export class SseParser {
  #buffer = "";
  #data: string[] = [];

  push(text: string): string[] {
    this.#buffer += text;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    const out: string[] = [];
    for (const raw of lines) this.#line(raw.replace(/\r$/, ""), out);
    return out;
  }

  end(): string[] {
    const out: string[] = [];
    if (this.#buffer) this.#line(this.#buffer.replace(/\r$/, ""), out);
    this.#buffer = "";
    this.#flush(out);
    return out;
  }

  #line(line: string, out: string[]): void {
    if (line === "") return this.#flush(out);
    if (line.startsWith(":")) return; // комментарий, keep-alive
    if (!line.startsWith("data:")) return; // event:, id:, retry:
    const value = line.slice(5).replace(/^ /, "");
    if (this.#data.length === 0 && (value === "[DONE]" || parses(value))) {
      out.push(value);
      return;
    }
    this.#data.push(value);
    const joined = this.#data.join("\n");
    if (parses(joined)) {
      out.push(joined);
      this.#data = [];
    }
  }

  #flush(out: string[]): void {
    if (this.#data.length > 0) out.push(this.#data.join("\n"));
    this.#data = [];
  }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Ответ агенту: заголовки — лениво, каждое событие с пустой строкой после, [DONE] — ровно один раз. */
class SseWriter {
  headersSent = false;
  ended = false;
  // Без parameter property: файл грузится и через `node` со снятием типов (scripts/review-live.mts).
  private readonly res: ServerResponse;
  constructor(res: ServerResponse) {
    this.res = res;
  }

  #headers(): void {
    if (this.headersSent) return;
    this.headersSent = true;
    this.res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  }

  ping(): void {
    if (this.ended) return;
    this.#headers();
    this.res.write(": ping\n\n");
  }

  event(data: string): void {
    if (this.ended) return;
    this.#headers();
    this.res.write(`data: ${data}\n\n`);
  }

  done(): void {
    if (this.ended) return;
    this.#headers();
    this.res.write("data: [DONE]\n\n");
    this.ended = true;
    this.res.end();
  }

  error(message: string, code = STREAM_INTERRUPTED_CODE): void {
    if (this.ended) return;
    this.event(JSON.stringify({ error: { message, type: code, code } }));
    this.done();
  }
}

interface Attempt {
  n: number;
  status?: number;
  err?: string;
  ttft_s?: number;
}

export interface CallMetrics {
  ts: number;
  session?: string;
  model?: unknown;
  stream: boolean;
  upstream: string;
  attempts: Attempt[];
  status?: number | string;
  outcome?: "ok" | "failed" | "interrupted" | "passthrough";
  ttft_s?: number;
  total_s?: number;
  prompt?: number;
  cached?: number;
  completion?: number;
  reasoning?: number;
}

interface Route {
  /** Адрес шлюза, как в models.json (обычно …/v1). */
  u: string;
  /** Файл метрик (JSONL) в каталоге сессии. */
  m?: string;
  /** id сессии для строки метрик. */
  s?: string;
}

function encodeRoute(route: Route): string {
  return Buffer.from(JSON.stringify(route)).toString("base64url");
}

function decodeRoute(token: string): Route | undefined {
  try {
    const route = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Route;
    return typeof route.u === "string" ? route : undefined;
  } catch {
    return undefined;
  }
}

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "upgrade",
  "proxy-connection",
]);

function forwardHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_HEADERS.has(key.toLowerCase())) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const seconds = (ms: number) => Math.round(ms / 10) / 100;

export class ReliabilityProxy {
  readonly #opts: Required<Omit<ReliabilityOptions, "fetchImpl">> & { fetchImpl: typeof fetch };
  #server: Server | undefined;
  #origin: string | undefined;

  constructor(options: ReliabilityOptions = {}) {
    this.#opts = {
      ttftMs: options.ttftMs ?? 60_000,
      idleMs: options.idleMs ?? 120_000,
      attempts: options.attempts ?? 3,
      pingMs: options.pingMs ?? 5_000,
      nonStreamTimeoutMs: options.nonStreamTimeoutMs ?? 300_000,
      backoffMs: options.backoffMs ?? ((n) => Math.min(8_000, 1_000 * 2 ** (n - 1))),
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  get origin(): string | undefined {
    return this.#origin;
  }

  async start(): Promise<string> {
    if (this.#origin) return this.#origin;
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `prsloy proxy: ${String(error)}` } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref(); // прокси не держит процесс хоста
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("proxy has no address");
    this.#server = server;
    this.#origin = `http://127.0.0.1:${address.port}`;
    return this.#origin;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#origin = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** baseUrl для Pi: запросы пойдут через прокси на `upstream`. */
  route(upstream: string, metricsPath?: string, session?: string): string {
    if (!this.#origin) throw new Error("proxy is not started");
    const route: Route = { u: upstream.replace(/\/+$/, "") };
    if (metricsPath) route.m = metricsPath;
    if (session) route.s = session;
    return `${this.#origin}/p/${encodeRoute(route)}`;
  }

  /** Исходный адрес шлюза, если `baseUrl` — уже наш маршрут (повторная загрузка расширения). */
  upstreamOf(baseUrl: string): string | undefined {
    const match = /^https?:\/\/127\.0\.0\.1:\d+\/p\/([A-Za-z0-9_-]+)/.exec(baseUrl);
    return match?.[1] ? decodeRoute(match[1])?.u : undefined;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://proxy");
    const match = /^\/p\/([A-Za-z0-9_-]+)\/?(.*)$/.exec(url.pathname);
    const route = match?.[1] ? decodeRoute(match[1]) : undefined;
    if (!route || match === null) {
      res.writeHead(404).end();
      return;
    }
    const target = `${route.u}/${match[2] ?? ""}${url.search}`;
    const headers = forwardHeaders(req);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const abort = new AbortController();
    res.on("close", () => abort.abort("client closed"));

    let payload: Record<string, unknown> | undefined;
    if (req.method === "POST" && (match[2] ?? "").endsWith("chat/completions") && body) {
      try {
        payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        payload = undefined;
      }
    }
    const metrics: CallMetrics = {
      ts: Date.now() / 1000,
      model: payload?.model,
      stream: payload?.stream === true,
      upstream: new URL(route.u).host,
      attempts: [],
      ...(route.s ? { session: route.s } : {}),
    };
    const started = Date.now();
    try {
      if (!payload) {
        await this.#passthrough(req.method ?? "GET", target, headers, body, res, abort.signal);
        metrics.outcome = "passthrough";
        metrics.status = res.statusCode;
        return;
      }
      if (payload.stream === true) {
        const options = (payload.stream_options as Record<string, unknown> | undefined) ?? {};
        payload.stream_options = { ...options, include_usage: true };
        await this.#stream(target, headers, JSON.stringify(payload), res, metrics, abort.signal);
      } else {
        await this.#json(target, headers, JSON.stringify(payload), res, metrics, abort.signal);
      }
    } finally {
      metrics.total_s = seconds(Date.now() - started);
      if (route.m && metrics.outcome !== "passthrough") await writeMetrics(route.m, metrics);
    }
  }

  async #passthrough(
    method: string,
    target: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const upstream = await this.#opts.fetchImpl(target, {
      method,
      headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
      signal,
    });
    const data = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(data);
  }

  async #json(
    target: string,
    headers: Record<string, string>,
    body: string,
    res: ServerResponse,
    metrics: CallMetrics,
    signal: AbortSignal,
  ): Promise<void> {
    let last: { status: number; text: string; type: string } | undefined;
    for (let n = 1; n <= this.#opts.attempts && !signal.aborted; n++) {
      const attempt: Attempt = { n };
      metrics.attempts.push(attempt);
      const t0 = Date.now();
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(this.#opts.nonStreamTimeoutMs)]);
      try {
        const upstream = await this.#opts.fetchImpl(target, {
          method: "POST",
          headers,
          body,
          signal: timeout,
        });
        attempt.status = upstream.status;
        const text = await upstream.text();
        last = {
          status: upstream.status,
          text,
          type: upstream.headers.get("content-type") ?? "application/json",
        };
        if (
          RETRY_STATUS.has(upstream.status) ||
          (upstream.status === 200 && looksLikeGatewayError(text))
        ) {
          attempt.err = text.slice(0, 300);
          if (n < this.#opts.attempts) await sleep(this.#opts.backoffMs(n));
          continue;
        }
        if (upstream.status === 200) {
          const json = JSON.parse(text) as {
            choices?: { message?: Delta }[];
            usage?: Chunk["usage"];
          };
          const message = json.choices?.[0]?.message ?? {};
          if (!(message.content || message.tool_calls)) {
            attempt.err = "empty";
            continue;
          }
          takeUsage(metrics, json.usage);
          metrics.ttft_s = attempt.ttft_s = seconds(Date.now() - t0);
        }
        metrics.status = upstream.status;
        metrics.outcome = upstream.status === 200 ? "ok" : "failed";
        res.writeHead(upstream.status, { "content-type": last.type }).end(text);
        return;
      } catch (error) {
        attempt.err = String(error).slice(0, 200);
      }
    }
    metrics.status = "failed";
    metrics.outcome = "failed";
    if (last) res.writeHead(last.status, { "content-type": last.type }).end(last.text);
    else res.writeHead(502, { "content-type": "application/json" }).end(allFailedBody(metrics));
  }

  async #stream(
    target: string,
    headers: Record<string, string>,
    body: string,
    res: ServerResponse,
    metrics: CallMetrics,
    clientSignal: AbortSignal,
  ): Promise<void> {
    const out = new SseWriter(res);
    let lastFailure: { status: number; text: string; type: string } | undefined;
    for (let n = 1; n <= this.#opts.attempts && !clientSignal.aborted; n++) {
      const attempt: Attempt = { n };
      metrics.attempts.push(attempt);
      const result = await this.#streamAttempt(
        target,
        headers,
        body,
        out,
        attempt,
        metrics,
        clientSignal,
      );
      if (result.kind === "done") {
        metrics.status = 200;
        metrics.outcome = "ok";
        return;
      }
      if (result.kind === "interrupted") {
        // Агент уже получил куски ответа: повтор сломал бы поток (E9 №1). Честная ошибка — и UI предложит «Повторить».
        metrics.status = 200;
        metrics.outcome = "interrupted";
        out.error(STREAM_INTERRUPTED_MESSAGE);
        return;
      }
      if (result.kind === "final") {
        // Ответ, который не повторяют (400, 401…): как есть, если агенту ещё ничего не ушло.
        metrics.status = result.status;
        metrics.outcome = "failed";
        if (!out.headersSent) {
          res.writeHead(result.status, { "content-type": result.type }).end(result.text);
        } else {
          out.error(errorText(result.text), "prsloy_upstream_error");
        }
        return;
      }
      if (result.failure) lastFailure = result.failure;
      if (result.backoff && n < this.#opts.attempts) await sleep(this.#opts.backoffMs(n));
    }
    metrics.status = "failed";
    metrics.outcome = "failed";
    if (out.headersSent)
      out.error(
        `${STREAM_INTERRUPTED_MESSAGE}: модель не ответила после ${metrics.attempts.length} попыток`,
      );
    else if (lastFailure)
      res.writeHead(lastFailure.status, { "content-type": lastFailure.type }).end(lastFailure.text);
    else res.writeHead(502, { "content-type": "application/json" }).end(allFailedBody(metrics));
  }

  async #streamAttempt(
    target: string,
    headers: Record<string, string>,
    body: string,
    out: SseWriter,
    attempt: Attempt,
    metrics: CallMetrics,
    clientSignal: AbortSignal,
  ): Promise<
    | { kind: "done" }
    | { kind: "interrupted" }
    | { kind: "final"; status: number; text: string; type: string }
    | { kind: "retry"; backoff?: boolean; failure?: { status: number; text: string; type: string } }
  > {
    const t0 = Date.now();
    const upstreamAbort = new AbortController();
    const signal = AbortSignal.any([clientSignal, upstreamAbort.signal]);
    let committed = false;
    // До первого полезного куска — «: ping», чтобы Pi не счёл тишину зависанием, и повтор ещё возможен.
    const ping = setInterval(() => {
      if (!committed) out.ping();
    }, this.#opts.pingMs);
    const ttft = setTimeout(() => {
      if (!committed) upstreamAbort.abort("ttft deadline");
    }, this.#opts.ttftMs);
    try {
      let upstream: Response;
      try {
        upstream = await this.#opts.fetchImpl(target, {
          method: "POST",
          headers: { ...headers, accept: "text/event-stream" },
          body,
          signal,
        });
      } catch (error) {
        attempt.err = signal.aborted
          ? String(upstreamAbort.signal.reason ?? "aborted")
          : String(error).slice(0, 200);
        return { kind: "retry", backoff: !signal.aborted };
      }
      attempt.status = upstream.status;
      const type = upstream.headers.get("content-type") ?? "";
      if (upstream.status !== 200) {
        const text = await upstream.text().catch(() => "");
        if (RETRY_STATUS.has(upstream.status)) {
          attempt.err = text.slice(0, 300);
          return { kind: "retry", backoff: true, failure: { status: upstream.status, text, type } };
        }
        return { kind: "final", status: upstream.status, text, type: type || "application/json" };
      }
      if (!type.includes("event-stream")) {
        // 200 без потока: шлюз прислал ошибку телом (E8q) — повтор; иначе как есть.
        const text = await upstream.text().catch(() => "");
        if (looksLikeGatewayError(text) || text.trim() === "") {
          attempt.err = text.slice(0, 300) || "empty body";
          return { kind: "retry" };
        }
        return { kind: "final", status: 200, text, type: type || "application/json" };
      }
      const reader = upstream.body?.getReader();
      if (!reader) {
        attempt.err = "no body";
        return { kind: "retry" };
      }
      const decoder = new TextDecoder();
      const parser = new SseParser();
      const pending: string[] = [];
      let finished = false;
      let sawDone = false;
      let interrupted = false;

      const handle = (event: string): "stop" | "retry" | undefined => {
        if (event === "[DONE]") {
          sawDone = true;
          return "stop";
        }
        let chunk: Chunk;
        try {
          chunk = JSON.parse(event) as Chunk;
        } catch {
          if (!committed) {
            attempt.err = `bad json: ${event.slice(0, 120)}`;
            return "retry";
          }
          return undefined; // после начала потока битый кусок пропускаем, Pi он бы уронил
        }
        if (chunk.error || looksLikeGatewayError(event)) {
          if (!committed) {
            attempt.err = event.slice(0, 300);
            return "retry";
          }
          interrupted = true;
          return "stop";
        }
        if (chunk.usage) takeUsage(metrics, chunk.usage);
        if (!committed && isUseful(chunk)) {
          committed = true;
          clearTimeout(ttft);
          metrics.ttft_s = attempt.ttft_s = seconds(Date.now() - t0);
          for (const earlier of pending.splice(0)) out.event(earlier);
        }
        if (committed) out.event(event);
        else pending.push(event);
        if ((chunk.choices ?? []).some((c) => c.finish_reason)) finished = true;
        // Итог по токенам после finish_reason — последний кусок: дальше поставщики шлют keep-alive минутами (E9).
        if (finished && chunk.usage && !(chunk.choices ?? []).length) return "stop";
        return undefined;
      };

      reading: while (true) {
        // После finish_reason ждём usage не дольше 2 с; после первого куска — тишину не дольше idle.
        const wait = finished ? 2_000 : committed ? this.#opts.idleMs : undefined;
        const next = await readWithTimeout(reader, wait);
        if (next === "timeout") {
          if (finished) break;
          interrupted = true;
          attempt.err = "idle";
          break;
        }
        if (next === "error") {
          if (committed && !finished) interrupted = true;
          attempt.err ??= signal.aborted
            ? String(upstreamAbort.signal.reason ?? "aborted")
            : "read error";
          break;
        }
        if (next.done) break;
        for (const event of parser.push(decoder.decode(next.value, { stream: true }))) {
          const verdict = handle(event);
          if (verdict === "retry") return { kind: "retry" };
          if (verdict === "stop") break reading;
        }
      }
      if (!sawDone && !interrupted) {
        for (const event of parser.end()) {
          const verdict = handle(event);
          if (verdict === "retry") return { kind: "retry" };
          if (verdict === "stop") break;
        }
      }
      // Не ждём, пока поставщик закроет связь сам (E9: «close» +75 с), — рвём сразу.
      upstreamAbort.abort("done");
      void reader.cancel().catch(() => undefined);
      if (!committed) {
        attempt.err ??= "empty stream";
        return { kind: "retry" };
      }
      if (interrupted || !(finished || sawDone)) {
        attempt.err ??= "stream ended early";
        return { kind: "interrupted" };
      }
      out.done();
      return { kind: "done" };
    } finally {
      clearInterval(ping);
      clearTimeout(ttft);
      if (!upstreamAbort.signal.aborted) upstreamAbort.abort("attempt over");
    }
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number | undefined,
): Promise<ReadableStreamReadResult<Uint8Array> | "timeout" | "error"> {
  const read = reader.read().catch(() => "error" as const);
  if (ms === undefined) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function takeUsage(metrics: CallMetrics, usage: Chunk["usage"] | undefined): void {
  if (!usage) return;
  if (typeof usage.prompt_tokens === "number") metrics.prompt = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") metrics.completion = usage.completion_tokens;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    (usage.cache_read_input_tokens as number | undefined);
  if (typeof cached === "number") metrics.cached = cached;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === "number") metrics.reasoning = reasoning;
}

function errorText(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string };
    const message = typeof json.error === "string" ? json.error : json.error?.message;
    if (message) return message;
  } catch {
    // не JSON
  }
  return text.slice(0, 300) || "upstream error";
}

function allFailedBody(metrics: CallMetrics): string {
  return JSON.stringify({
    error: {
      message: `prsloy proxy: all ${metrics.attempts.length} attempts failed`,
      attempts: metrics.attempts,
    },
  });
}

async function writeMetrics(path: string, metrics: CallMetrics): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(metrics)}\n`);
  } catch {
    // метрики не важнее ответа
  }
}
