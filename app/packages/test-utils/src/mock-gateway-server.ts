import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

/**
 * Minimal OpenAI-compatible gateway mock (PRSLOY shape):
 * - `GET /v1/models` checks `Authorization: Bearer <key>` (401 otherwise)
 * - `POST /v1/chat/completions` records headers + body and streams a scripted reply
 *
 * Each completion pops the next scripted turn; when the script is empty it answers
 * with plain text. Turns can carry `reasoning_content` and one tool call.
 */
export interface MockGatewayTurn {
  reasoning?: string;
  text?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
}

export interface MockGatewayRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface MockGatewayOptions {
  apiKey: string;
  modelIds?: string[];
  turns?: MockGatewayTurn[];
  /** Force a status for every request (e.g. 500 / 503 for error mapping tests). */
  failWithStatus?: number;
  /** Answer 404 on `GET /v1/models` (gateways that hide the list). */
  noModelsEndpoint?: boolean;
  /** Completions for a model not in `modelIds` answer 404 model_not_found. */
  serveListedOnly?: boolean;
  /** `max_tokens` above this answers 400 (a gateway with a lower output cap). */
  maxTokensLimit?: number;
  /** Prompt tokens reported in usage (default 10; 0 = a gateway that doesn't meter input). */
  promptTokens?: number;
}

function sendChunk(response: ServerResponse, delta: Record<string, unknown>, finish?: string) {
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock",
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    })}\n\n`,
  );
}

export class MockGatewayServer {
  readonly requests: MockGatewayRequest[] = [];
  readonly modelListRequests: MockGatewayRequest[] = [];
  /** What `GET /v1/models` lists; change it to drop a model mid-test. */
  modelIds: string[];
  #server: Server;
  #baseUrl: string | undefined;
  #options: MockGatewayOptions;
  #turns: MockGatewayTurn[];

  constructor(options: MockGatewayOptions) {
    this.#options = options;
    this.modelIds = [...(options.modelIds ?? [])];
    this.#turns = [...(options.turns ?? [])];
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  get baseUrl(): string {
    if (!this.#baseUrl) throw new Error("Mock gateway has not started");
    return this.#baseUrl;
  }

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    const address = this.#server.address();
    if (!address || typeof address === "string") throw new Error("Mock gateway has no address");
    this.#baseUrl = `http://127.0.0.1:${address.port}/v1`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    this.#server.close();
    await once(this.#server, "close");
  }

  #authorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.#options.apiKey}`;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let raw = "";
    for await (const data of request) raw += String(data);
    const record: MockGatewayRequest = {
      headers: { ...request.headers },
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    };

    if (this.#options.failWithStatus) {
      response.writeHead(this.#options.failWithStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "mock failure" } }));
      return;
    }

    if (
      request.method === "GET" &&
      request.url === "/v1/models" &&
      !this.#options.noModelsEndpoint
    ) {
      this.modelListRequests.push(record);
      if (!this.#authorized(request)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: this.modelIds.map((id) => ({ id, object: "model" })),
        }),
      );
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    this.requests.push(record);
    if (!this.#authorized(request)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }

    const model = typeof record.body.model === "string" ? record.body.model : "";
    if (this.#options.serveListedOnly && !this.modelIds.includes(model)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: `The model \`${model}\` does not exist`, code: "model_not_found" },
        }),
      );
      return;
    }
    const limit = this.#options.maxTokensLimit;
    if (limit && typeof record.body.max_tokens === "number" && record.body.max_tokens > limit) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: `max_tokens is too large: ${record.body.max_tokens} > ${limit}` },
        }),
      );
      return;
    }
    const turn = this.#turns.shift() ?? { text: "ok" };
    if (record.body.stream === false) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: turn.text ?? "" },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    sendChunk(response, { role: "assistant", content: "" });
    if (turn.reasoning) sendChunk(response, { reasoning_content: turn.reasoning });
    if (turn.text) sendChunk(response, { content: turn.text });
    if (turn.toolCall) {
      sendChunk(response, {
        tool_calls: [
          {
            index: 0,
            id: `call-${this.requests.length}`,
            type: "function",
            function: {
              name: turn.toolCall.name,
              arguments: JSON.stringify(turn.toolCall.arguments),
            },
          },
        ],
      });
      sendChunk(response, {}, "tool_calls");
    } else {
      sendChunk(response, {}, "stop");
    }
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1,
        model: "mock",
        choices: [],
        usage: {
          prompt_tokens: this.#options.promptTokens ?? 10,
          completion_tokens: 5,
          total_tokens: (this.#options.promptTokens ?? 10) + 5,
        },
      })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  }
}
