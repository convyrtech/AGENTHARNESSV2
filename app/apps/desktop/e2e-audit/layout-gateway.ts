/**
 * Local stand-in for the PRSLOY gateway, the same as casual-audit.spec.ts uses: the prompt picks
 * the answer. «сайт» writes a page (preview, undo), «денег» 402, «ключ» 401, «модель» 404
 * model_not_found, «обрыв» cuts the stream after the first token, «разметк» leaks a tool call as
 * text (the harness's «Модель сбилась» card).
 */
import { createServer, type Server } from "node:http";

export const GOOD_KEY = "sk-good-0000abcd";

type Message = { role: string; content?: unknown };

export function mockGateway(): Server {
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
      const { messages = [], model = "m" } = JSON.parse(body || "{}") as {
        messages?: Message[];
        model?: string;
      };
      const lastUser = messages.findLastIndex((m) => m.role === "user");
      const afterTool = messages.slice(lastUser + 1).some((m) => m.role === "tool");
      const prompt = JSON.stringify(messages[lastUser]?.content ?? "");
      const fail = (status: number, error: object) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error }));
      };
      if (!authorized || prompt.includes("ключ")) {
        fail(401, { message: "Invalid API key", type: "authentication_error" });
        return;
      }
      if (prompt.includes("денег")) {
        fail(402, { message: "Insufficient balance", type: "insufficient_quota" });
        return;
      }
      if (prompt.includes("модель")) {
        fail(404, { message: `The model \`${model}\` does not exist`, code: "model_not_found" });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finish: string | null = null, usage?: object) =>
        res.write(
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 0,
            model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {}),
          })}\n\n`,
        );
      send({ role: "assistant", content: "" });
      // The harness's retry note reaches the model as a user message: keep leaking all turn long.
      if (body.includes("сбой разметки")) {
        // DeepSeek sometimes sends its tool call as text; the harness retries, then shows a card.
        send({ content: '<｜DSML｜invoke name="write">\n<｜DSML｜parameter name="path">a.html' });
        send({}, "stop", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
        res.end("data: [DONE]\n\n");
        return;
      }
      if (prompt.includes("обрыв")) {
        send({ content: "Начинаю" });
        res.destroy();
        return;
      }
      if (prompt.includes("сайт") && !afterTool) {
        const content =
          "<!doctype html>\n<meta charset=utf-8>\n<title>Анна</title>\n<h1>Анна Смирнова — флорист</h1>\n";
        send({
          tool_calls: [
            {
              index: 0,
              id: "call-write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "site/index.html", content }),
              },
            },
          ],
        });
        send({}, "tool_calls", { prompt_tokens: 2400, completion_tokens: 90, total_tokens: 2490 });
      } else {
        for (const part of "Готово: сделал страницу-визитку. Посмотрите превью.".split(" ")) {
          send({ content: `${part} ` });
        }
        send({}, "stop", { prompt_tokens: 2600, completion_tokens: 40, total_tokens: 2640 });
      }
      res.end("data: [DONE]\n\n");
    });
  });
}
