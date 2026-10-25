/**
 * A local stand-in for the PRSLOY gateway that answers like a real model, by script (the novice's first
 * hour, features-first-hour.spec.ts). A rule matches words in the user's request; its steps play in
 * order within that turn — step N is the answer after N assistant replies since that request — each either
 * tool calls (the harness runs them for real) or the closing text. Requests without tools (the memory
 * extractor, summaries) get an empty answer, or the scripted extractor answer. Every request body is kept for the checks (no secret leaks).
 */
import { createServer, type Server } from "node:http";

export const GOOD_KEY = "sk-good-0000abcd";

export type ScriptStep =
  | { tools: { name: string; args: Record<string, unknown> }[] }
  | { text: string }
  /** The gateway refuses: e.g. 402 «Insufficient balance». */
  | { fail: { status: number; error: Record<string, unknown> } }
  /** The connection drops before any answer (the internet went away). */
  | { drop: true }
  /** The first token comes after `afterMs` (a slow model). */
  | { slow: { afterMs: number; text: string } };

export type ScriptRule = { when: string; steps: ScriptStep[] };

type Message = { role: string; content?: unknown };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

/**
 * `extractor`: the memory extractor's answer (core's M-3: a request without tools that asks for `{"ops":[…]}`),
 * as a real model would give it; without it the extractor gets an empty answer.
 */
export function scriptedGateway(
  rules: ScriptRule[],
  bodies: string[],
  extractor?: { ops: Record<string, unknown>[] },
): Server {
  let callId = 0;
  return createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${GOOD_KEY}`;
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          authorized
            ? { data: [{ id: "deepseek-v4.1-flash-1017" }, { id: "kimi-k3.1-pro" }] }
            : { error: { message: "bad key" } },
        ),
      );
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += String(chunk)));
    req.on("end", () => {
      if (!authorized) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
        return;
      }
      bodies.push(body);
      const parsed = JSON.parse(body || "{}") as {
        messages?: Message[];
        model?: string;
        tools?: unknown[];
      };
      const messages = parsed.messages ?? [];
      const model = parsed.model ?? "m";
      // Harness cards and notes reach the model as user messages too: the turn starts at the last
      // user message a rule recognises, not at the last user message.
      const matches = (m: Message) => {
        const said = text(m.content).toLowerCase();
        return m.role === "user" && rules.some((r) => said.includes(r.when.toLowerCase()));
      };
      const anchor = messages.findLastIndex(matches);
      const lastUser = anchor >= 0 ? anchor : messages.findLastIndex((m) => m.role === "user");
      const prompt = text(messages[lastUser]?.content).toLowerCase();
      const step = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
      const send = (delta: object, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(finish
              ? { usage: { prompt_tokens: 2400, completion_tokens: 60, total_tokens: 2460 } }
              : {}),
          })}\n\n`,
        );
      const rule = parsed.tools?.length
        ? rules.find((r) => prompt.includes(r.when.toLowerCase()))
        : undefined;
      const next = rule?.steps[step];
      if (next && "fail" in next) {
        res.writeHead(next.fail.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: next.fail.error }));
        return;
      }
      if (next && "drop" in next) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (next && "slow" in next) {
        setTimeout(() => {
          if (res.destroyed) return;
          send({ role: "assistant", content: "" });
          for (const part of next.slow.text.split(" ")) if (part) send({ content: `${part} ` });
          send({}, "stop");
          res.end("data: [DONE]\n\n");
        }, next.slow.afterMs);
        return;
      }
      send({ role: "assistant", content: "" });
      if (next && "tools" in next) {
        send({
          tool_calls: next.tools.map((call, index) => ({
            index,
            id: `call-${++callId}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        });
        send({}, "tool_calls");
      } else {
        const asksOps = !parsed.tools?.length && body.includes('\\"ops\\"');
        const reply =
          next && "text" in next
            ? next.text
            : parsed.tools?.length
              ? "Готово."
              : asksOps && extractor
                ? JSON.stringify(extractor)
                : "";
        for (const part of reply.split(" ")) if (part) send({ content: `${part} ` });
        send({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    });
  });
}
