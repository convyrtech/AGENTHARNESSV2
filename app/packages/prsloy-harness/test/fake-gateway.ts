// Мок шлюза PRSLOY/a6 со сценариями сбоев из E8q/E9: ошибка в потоке, молчание до первого токена,
// JSON, разрезанный посреди кусков, обрыв после первого куска, 200 с ошибкой телом, пустой поток,
// события без пустой строки, keep-alive после конца ответа.
import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";

export type Behaviour =
  | { kind: "ok"; text?: string; delayMs?: number; tokenDelayMs?: number }
  | { kind: "stream-error"; message?: string }
  | { kind: "status"; status: number; body?: string }
  | { kind: "json-error"; message?: string }
  | { kind: "empty" }
  | { kind: "stall"; ms: number }
  | { kind: "split"; text?: string }
  | { kind: "drop-after-first"; text?: string }
  | { kind: "no-blank-lines"; text?: string }
  | { kind: "linger"; text?: string }
  | { kind: "tool-call" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1,
    model: "fake",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
}

const USAGE = JSON.stringify({
  id: "chatcmpl-fake",
  object: "chat.completion.chunk",
  created: 1,
  model: "fake",
  choices: [],
  usage: {
    prompt_tokens: 120,
    completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 100 },
  },
});

export class FakeGateway {
  readonly requests: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  #server: Server;
  baseUrl = "";

  constructor(private readonly script: (index: number) => Behaviour) {
    this.#server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += String(d)));
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        this.requests.push({ headers: req.headers, body });
        void this.#reply(this.script(this.requests.length - 1), body, res);
      });
    });
  }

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    this.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#server.close();
    await once(this.#server, "close").catch(() => undefined);
  }

  async #reply(b: Behaviour, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const sse = () =>
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (data: string) => res.write(`data: ${data}\n\n`);
    const answer = (text: string) => {
      for (const part of text.split(" ")) event(chunk({ content: `${part} ` }));
      event(chunk({}, "stop"));
      event(USAGE);
      res.end("data: [DONE]\n\n");
    };
    if (body.stream !== true) {
      if (b.kind === "json-error" || b.kind === "stream-error") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: b.message ?? "等待响应超时，请稍后重试 上游服务" } }),
        );
        return;
      }
      if (b.kind === "status") {
        res.writeHead(b.status, { "content-type": "application/json" }).end(b.body ?? "{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
      );
      return;
    }
    switch (b.kind) {
      case "ok": {
        if (b.delayMs) await sleep(b.delayMs);
        sse();
        const text = b.text ?? "Привет от модели.";
        for (const part of text.split(" ")) {
          event(chunk({ content: `${part} ` }));
          if (b.tokenDelayMs) await sleep(b.tokenDelayMs);
        }
        event(chunk({}, "stop"));
        event(USAGE);
        res.end("data: [DONE]\n\n");
        return;
      }
      case "tool-call":
        sse();
        event(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "bash", arguments: '{"command":"echo hi"}' },
              },
            ],
          }),
        );
        event(chunk({}, "tool_calls"));
        res.end("data: [DONE]\n\n");
        return;
      case "stream-error":
        sse();
        event(chunk({ role: "assistant", content: "" }));
        event(
          JSON.stringify({ error: { message: b.message ?? "等待响应超时，请稍后重试 上游服务" } }),
        );
        res.end();
        return;
      case "status":
        res.writeHead(b.status, { "content-type": "application/json" }).end(b.body ?? "{}");
        return;
      case "json-error":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: b.message ?? "upstream timeout, try again" } }));
        return;
      case "empty":
        sse();
        res.end("data: [DONE]\n\n");
        return;
      case "stall":
        sse();
        res.write(": keep-alive\n\n");
        await sleep(b.ms);
        if (!res.destroyed) answer("поздно");
        return;
      case "split": {
        sse();
        const full = [
          `data: ${chunk({ content: b.text ?? "разрезанный ответ" })}\n\n`,
          `data: ${chunk({}, "stop")}\n\n`,
          `data: ${USAGE}\n\n`,
          "data: [DONE]\n\n",
        ].join("");
        // Режем по байтам, в том числе посреди JSON и посреди UTF-8.
        const bytes = Buffer.from(full);
        for (let i = 0; i < bytes.length; i += 7) {
          res.write(bytes.subarray(i, i + 7));
          await sleep(1);
        }
        res.end();
        return;
      }
      case "drop-after-first":
        sse();
        event(chunk({ content: b.text ?? "Начало ответа" }));
        await sleep(30);
        res.destroy(); // поставщик оборвал связь посреди ответа
        return;
      case "no-blank-lines":
        sse();
        res.write(`data: ${chunk({ content: b.text ?? "склейка" })}\n`);
        res.write(`data: ${chunk({}, "stop")}\n`);
        res.write(`data: ${USAGE}\n`);
        res.end("data: [DONE]\n");
        return;
      case "linger":
        sse();
        event(chunk({ content: b.text ?? "конец" }));
        event(chunk({}, "stop"));
        event(USAGE);
        // [DONE] нет, связь не закрывается: только keep-alive (E9: +75 с на вызов).
        for (let i = 0; i < 100 && !res.destroyed; i++) {
          res.write(": keep-alive\n\n");
          await sleep(500);
        }
        return;
    }
  }
}
