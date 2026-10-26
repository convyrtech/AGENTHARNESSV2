// Счётчик шлюза для замера (дирижёр, 26.10): всё, что задача шлёт в шлюз, идёт через этот прокси — агент, второе
// мнение, поиск моделью, экстрактор памяти. Он считает токены по usage из ответов шлюза (getSessionStats().cost Pi
// берёт цены из своей таблицы и врал ~в 100 раз) и запоминает ошибки шлюза: 401/403 — ключ не принят, 402 — квота,
// 5xx и обрыв связи. Тело запроса и ответа идёт как есть; ключ — заголовком Authorization, его счётчик не хранит.
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Кто позвал шлюз. */
export type GatewaySource = "agent" | "review" | "memory" | "search";
export const GATEWAY_SOURCES: readonly GatewaySource[] = ["agent", "review", "search", "memory"];

export interface TokenCount {
  calls: number;
  /** prompt_tokens: весь вход, вместе с кэшем (как считает OpenAI-совместимый шлюз). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type TokenUsage = TokenCount & {
  bySource: Partial<Record<GatewaySource, TokenCount>>;
  /** По моделям (id из запроса): цена у второго мнения своя. */
  byModel: Record<string, TokenCount>;
};

export interface GatewayFailure {
  source: GatewaySource;
  /** HTTP-код или "network" — шлюз не ответил. */
  status: number | "network";
  message: string;
}

export function emptyCount(): TokenCount {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function emptyUsage(): TokenUsage {
  return { ...emptyCount(), bySource: {}, byModel: {} };
}

export function addCount(to: TokenCount, from: TokenCount): void {
  to.calls += from.calls;
  to.input += from.input;
  to.output += from.output;
  to.cacheRead += from.cacheRead;
  to.cacheWrite += from.cacheWrite;
}

export function addUsage(to: TokenUsage, from: TokenUsage): void {
  addCount(to, from);
  for (const [source, count] of Object.entries(from.bySource) as [GatewaySource, TokenCount][])
    addCount((to.bySource[source] ??= emptyCount()), count);
  for (const [model, count] of Object.entries(from.byModel))
    addCount((to.byModel[model] ??= emptyCount()), count);
}

/** Начала промптов надстроек: second-opinion.ts reviewPrompt, memory-extract.ts extractorPrompt. */
export const REVIEW_MARKER = "Ты проверяющий";
export const MEMORY_MARKER = "Ты выбираешь из слов пользователя";

type Message = { role?: string; content?: unknown };

function textOf(m: Message): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as { text?: unknown }[])
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

/** Кто позвал: по телу запроса chat/completions. */
export function sourceOf(payload: Record<string, unknown>): GatewaySource {
  if (payload.web_search_options !== undefined) return "search";
  const messages = Array.isArray(payload.messages) ? (payload.messages as Message[]) : [];
  if (messages.some((m) => textOf(m).trimStart().startsWith(MEMORY_MARKER))) return "memory";
  const lastUser = messages.findLast((m) => m.role === "user");
  if (lastUser && textOf(lastUser).trimStart().startsWith(REVIEW_MARKER)) return "review";
  return "agent";
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** usage OpenAI-совместимого ответа → токены. Кэш: OpenAI, DeepSeek, Anthropic-поля, OpenRouter. */
export function countOf(usage: Record<string, unknown>): TokenCount {
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    calls: 1,
    input: num(usage.prompt_tokens) || num(usage.input_tokens),
    output: num(usage.completion_tokens) || num(usage.output_tokens),
    cacheRead:
      num(details.cached_tokens) ||
      num(usage.prompt_cache_hit_tokens) ||
      num(usage.cache_read_input_tokens),
    cacheWrite: num(details.cache_write_tokens) || num(usage.cache_creation_input_tokens),
  };
}

/** Текст ошибки шлюза из тела ответа: {error: {message}} / {error: "…"} / как есть. */
export function failureText(status: number, body: string): string {
  let message = body.trim().slice(0, 300);
  try {
    const json = JSON.parse(body) as { error?: { message?: unknown; type?: unknown } | string };
    const error = json.error;
    if (typeof error === "string") message = error;
    else if (error && typeof error.message === "string")
      message = typeof error.type === "string" ? `${error.message} (${error.type})` : error.message;
  } catch {
    // не JSON
  }
  return `HTTP ${status}: ${message || "пустой ответ"}`;
}

/** Ключ не принят шлюзом: дальше гонять нечего. */
export function isAuthFailure(f: GatewayFailure): boolean {
  return f.status === 401 || f.status === 403;
}

const HOP = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
  "keep-alive",
]);

export class GatewayMeter {
  /** Адрес шлюза (обычно …/v1); в --fake меняется на каждую сессию. */
  upstream: string;
  /** Токены и ошибки текущей задачи: бенч забирает их take() после задачи. */
  #usage = emptyUsage();
  #failures: GatewayFailure[] = [];
  #server: Server;
  #origin: string | undefined;
  readonly #onCall: ((count: TokenCount, model: string) => void) | undefined;
  readonly #onFailure: ((failure: GatewayFailure) => void) | undefined;

  constructor(
    upstream: string,
    hooks: {
      onCall?: (count: TokenCount, model: string) => void;
      onFailure?: (failure: GatewayFailure) => void;
    } = {},
  ) {
    this.upstream = upstream;
    this.#onCall = hooks.onCall;
    this.#onFailure = hooks.onFailure;
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
  }

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("meter has no address");
    this.#origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#server.close();
    await once(this.#server, "close");
  }

  /**
   * Адрес для models.json и поиска моделью: …/m/v1, если шлюз — …/v1 (поиск сам снимает /v1 и ставит
   * /v1/chat/completions — так путь сходится).
   */
  get baseUrl(): string {
    if (!this.#origin) throw new Error("meter is not started");
    return `${this.#origin}/m${/\/v1\/?$/.test(this.upstream) ? "/v1" : ""}`;
  }

  /** Токены и ошибки с прошлого take(). */
  take(): { usage: TokenUsage; failures: GatewayFailure[] } {
    const out = { usage: this.#usage, failures: this.#failures };
    this.#usage = emptyUsage();
    this.#failures = [];
    return out;
  }

  #fail(failure: GatewayFailure): void {
    this.#failures.push(failure);
    this.#onFailure?.(failure);
  }

  #count(source: GatewaySource, model: string, usage: Record<string, unknown> | undefined): void {
    const count = usage ? countOf(usage) : { ...emptyCount(), calls: 1 };
    addCount(this.#usage, count);
    addCount((this.#usage.bySource[source] ??= emptyCount()), count);
    addCount((this.#usage.byModel[model] ??= emptyCount()), count);
    this.#onCall?.(count, model);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://meter");
    if (!url.pathname.startsWith("/m/")) {
      res.writeHead(404).end();
      return;
    }
    const root = this.upstream.replace(/\/+$/, "").replace(/\/v1$/, "");
    const target = `${root}${url.pathname.slice(2)}${url.search}`;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    let payload: Record<string, unknown> | undefined;
    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      try {
        payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        payload = undefined;
      }
    }
    const source = payload ? sourceOf(payload) : "agent";
    const headers: Record<string, string> = { "accept-encoding": "identity" };
    for (const [k, v] of Object.entries(req.headers))
      if (!HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method ?? "GET",
        headers,
        ...(body.length ? { body } : {}),
        signal: abort.signal,
      });
    } catch (e) {
      if (payload && !abort.signal.aborted)
        this.#fail({
          source,
          status: "network",
          message: `нет ответа шлюза: ${e instanceof Error ? e.message : String(e)}`,
        });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "gateway unreachable" } }));
      return;
    }
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (k !== "content-encoding" && k !== "content-length" && k !== "transfer-encoding")
        outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);
    const sse = (upstream.headers.get("content-type") ?? "").includes("event-stream");
    const decoder = new TextDecoder();
    let text = "";
    let usage: Record<string, unknown> | undefined;
    let pending = "";
    try {
      for await (const chunk of upstream.body ?? []) {
        res.write(chunk);
        const piece = decoder.decode(chunk as Uint8Array, { stream: true });
        if (!payload) continue;
        if (!sse || upstream.status >= 400) {
          text += piece;
          continue;
        }
        pending += piece;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!data || data === "[DONE]" || !data.includes('"usage"')) continue;
          try {
            const json = JSON.parse(data) as { usage?: Record<string, unknown> | null };
            if (json.usage) usage = json.usage;
          } catch {
            // не JSON — не наше дело, агент разберётся
          }
        }
      }
    } catch {
      // клиент ушёл или шлюз оборвал поток: что успели, то и посчитали
    }
    res.end();
    if (!payload) return;
    if (upstream.status >= 400) {
      this.#fail({ source, status: upstream.status, message: failureText(upstream.status, text) });
      return;
    }
    if (!sse) {
      try {
        const json = JSON.parse(text) as { usage?: Record<string, unknown> };
        usage = json.usage;
      } catch {
        usage = undefined;
      }
    }
    this.#count(source, typeof payload.model === "string" ? payload.model : "?", usage);
  }
}
