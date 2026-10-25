// Мок OpenAI-совместимого шлюза: каждый ответ задаёт сценарий теста.
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: { function: { name: string } }[];
}

export interface ScriptedReply {
  /** Рассуждение (`reasoning_content`, как у DeepSeek). */
  reasoning?: string;
  text?: string;
  /** `raw` — текст аргументов как есть (битый JSON для проверки ремонта). */
  toolCalls?: { name: string; arguments: Record<string, unknown>; raw?: string }[];
  finishReason?: "stop" | "tool_calls" | "length";
}

export type Script = (request: ChatRequest, index: number) => ScriptedReply;

export function messageText(message: ChatMessage | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part: { text?: string }) => part.text ?? "").join("");
}

export class ScriptedOpenAiServer {
  readonly requests: ChatRequest[] = [];
  #server: Server;
  #baseUrl: string | undefined;

  // Без parameter property: сервер грузится и через `node` со снятием типов (scripts/bench.mts --fake).
  private readonly script: Script;

  constructor(script: Script) {
    this.script = script;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  get baseUrl(): string {
    if (!this.#baseUrl) throw new Error("server not started");
    return this.#baseUrl;
  }

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    this.#baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#server.close();
    await once(this.#server, "close");
  }

  async #handle(
    request: import("node:http").IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const data of request) body += String(data);
    const parsed = JSON.parse(body) as ChatRequest;
    this.requests.push(parsed);
    const reply = this.script(parsed, this.requests.length - 1);

    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (
      delta: Record<string, unknown>,
      finish: string | null = null,
      usage?: Record<string, number>,
    ) =>
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: 1,
          model: "mock",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    send({ role: "assistant", content: "" });
    if (reply.reasoning) send({ reasoning_content: reply.reasoning });
    if (reply.text) send({ content: reply.text });
    (reply.toolCalls ?? []).forEach((call, i) => {
      send({
        tool_calls: [
          {
            index: i,
            id: `call_${this.requests.length}_${i}`,
            type: "function",
            function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.arguments) },
          },
        ],
      });
    });
    const finish = reply.finishReason ?? (reply.toolCalls?.length ? "tool_calls" : "stop");
    send({}, finish, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    response.end("data: [DONE]\n\n");
  }
}
