import { createServer, type RequestListener, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { classifyModelError, createPixRuntime } from "../src/index.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** Real pi errors for a given gateway behaviour (retries off so failures surface at once). */
async function piErrorFor(
  handler: RequestListener | "dead",
): Promise<{ text: string; stop: string }> {
  const root = await mkdtemp(join(tmpdir(), "model-error-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  let base = "http://127.0.0.1:9/v1";
  if (handler !== "dead") {
    const server: Server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => {
      server.closeAllConnections();
      server.close();
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  }
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        gw: {
          baseUrl: base,
          apiKey: "k",
          api: "openai-completions",
          models: [
            {
              id: "m",
              name: "m",
              reasoning: false,
              input: ["text"],
              contextWindow: 8192,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const handle = await createPixRuntime({
    cwd: root,
    agentDir,
    model: { provider: "gw", id: "m" },
    tools: ["read"],
  });
  cleanups.push(() => handle.dispose());
  let result = { text: "", stop: "" };
  handle.runtime.session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      result = { text: event.message.errorMessage ?? "", stop: event.message.stopReason };
    }
  });
  await handle.runtime.session.prompt("hi");
  return result;
}

const json =
  (status: number, body: string): RequestListener =>
  (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };

describe("classifyModelError on pi's real failures", () => {
  it("gateway unreachable, reset or cut mid-stream → network", async () => {
    for (const handler of [
      "dead" as const,
      ((_req, res) => res.destroy()) as RequestListener,
      ((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'data: {"id":"x","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
        );
        setTimeout(() => res.destroy(), 30);
      }) as RequestListener,
    ]) {
      const { text, stop } = await piErrorFor(handler);
      expect(stop).toBe("error");
      expect(classifyModelError(text, stop), text).toBe("network");
    }
  });

  it("maps HTTP statuses", async () => {
    const cases: [number, string, string][] = [
      [401, '{"error":{"message":"invalid api key"}}', "auth"],
      [402, '{"error":{"message":"insufficient balance"}}', "no_balance"],
      [429, '{"error":{"message":"rate limited"}}', "rate_limit"],
      [
        404,
        '{"error":{"message":"The model `qwen9` does not exist","type":"invalid_request_error","code":"model_not_found"}}',
        "model_unavailable",
      ],
      [502, "<html>bad gateway</html>", "server"],
    ];
    for (const [status, body, code] of cases) {
      const { text } = await piErrorFor(json(status, body));
      expect(classifyModelError(text, "error"), text).toBe(code);
    }
  });

  it("a wrong base URL (plain 404 Not Found) is not mistaken for a key problem", async () => {
    const { text } = await piErrorFor((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    });
    const code = classifyModelError(text, "error");
    expect(code, text).not.toBe("auth");
    expect(code, text).toBe("model_unavailable");
  });

  it("model errors in a 400/200-ish body are recognised by text", () => {
    expect(classifyModelError("400 no such model: kimi-x", "error")).toBe("model_unavailable");
    expect(classifyModelError("model not available on this gateway", "error")).toBe(
      "model_unavailable",
    );
  });

  it("covers aborts, timeouts and unknown text", () => {
    expect(classifyModelError("whatever", "aborted")).toBe("aborted");
    expect(classifyModelError("Request timed out.", "error")).toBe("timeout");
    // The reliability proxy waited out every attempt: silent model, not a dropped connection.
    expect(
      classifyModelError("Модель долго не отвечает: нет ответа после 3 попыток", "error"),
    ).toBe("timeout");
    expect(classifyModelError("Связь с моделью оборвалась", "error")).toBe("network");
    expect(classifyModelError("something odd", "error")).toBe("unknown");
    // the harness reliability proxy reports a mid-stream drop with this text (code prsloy_stream_interrupted)
    expect(classifyModelError("Связь с моделью оборвалась", "error")).toBe("network");
    expect(classifyModelError(undefined)).toBe("unknown");
  });
});
