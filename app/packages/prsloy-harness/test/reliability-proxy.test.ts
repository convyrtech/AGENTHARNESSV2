import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  estimatePromptTokens,
  looksLikeGatewayError,
  ReliabilityProxy,
  SseParser,
  STREAM_INTERRUPTED_MESSAGE,
  ttftFor,
} from "../src/reliability-proxy.ts";
import { type Behaviour, chunk, FakeGateway } from "./fake-gateway.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(
  script: (i: number) => Behaviour,
  options: ConstructorParameters<typeof ReliabilityProxy>[0] = {},
) {
  const gateway = new FakeGateway(script);
  await gateway.start();
  const proxy = new ReliabilityProxy({
    ttftMs: 2_000,
    pingMs: 100,
    idleMs: 1_000,
    backoffMs: () => 0,
    ...options,
  });
  await proxy.start();
  const dir = await mkdtemp(join(tmpdir(), "prsloy-proxy-"));
  const metricsPath = join(dir, "prsloy-proxy.jsonl");
  cleanup.push(async () => {
    await proxy.close();
    await gateway.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const base = proxy.route(gateway.baseUrl, metricsPath, "sess-1");
  return { gateway, proxy, base, metricsPath };
}

async function chat(base: string, stream = true, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer rk-test-key" },
    body: JSON.stringify({
      model: "deepseek-v4.1-flash",
      stream,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    }),
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type") ?? "", text };
}

/** Проверка формы потока: каждое событие — одна строка `data:` или комментарий, разделитель — пустая строка. */
function events(text: string): { data: string[]; comments: number } {
  expect(text.endsWith("\n\n")).toBe(true);
  const blocks = text.slice(0, -2).split("\n\n");
  const data: string[] = [];
  let comments = 0;
  for (const block of blocks) {
    expect(block.includes("\n")).toBe(false);
    if (block.startsWith(":")) comments++;
    else {
      expect(block.startsWith("data: ")).toBe(true);
      data.push(block.slice(6));
    }
  }
  expect(data.filter((d) => d === "[DONE]")).toHaveLength(1);
  expect(data.at(-1)).toBe("[DONE]");
  return { data, comments };
}

/** Метрики пишутся после ответа агенту — ждём строку. */
async function metricsLines(path: string): Promise<Record<string, any>[]> {
  for (let i = 0; i < 50; i++) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.trim())
      return text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, any>);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no metrics in ${path}`);
}

const contentOf = (data: string[]) =>
  data
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d) as { choices?: { delta?: { content?: string } }[] })
    .map((j) => j.choices?.[0]?.delta?.content ?? "")
    .join("");

describe("reliability proxy: retries before the first useful delta", () => {
  it("in-stream gateway error, then success — the agent sees only the good answer", async () => {
    const { gateway, base, metricsPath } = await setup((i) =>
      i === 0 ? { kind: "stream-error" } : { kind: "ok", text: "Всё хорошо." },
    );
    const { status, text } = await chat(base);
    expect(status).toBe(200);
    const { data } = events(text);
    expect(contentOf(data)).toBe("Всё хорошо. ");
    expect(text).not.toContain("等待响应超时");
    expect(gateway.requests).toHaveLength(2);
    const [line] = await metricsLines(metricsPath);
    expect(line).toMatchObject({
      session: "sess-1",
      model: "deepseek-v4.1-flash",
      stream: true,
      outcome: "ok",
      status: 200,
      prompt: 120,
      cached: 100,
      completion: 7,
    });
    expect(line?.attempts).toHaveLength(2);
    expect(line?.attempts[0].err).toContain("等待响应超时");
    expect(typeof line?.ttft_s).toBe("number");
  });

  it("a supplier that stalls past the TTFT deadline is retried; pings keep the agent waiting", async () => {
    const { gateway, base } = await setup(
      (i) => (i === 0 ? { kind: "stall", ms: 3_000 } : { kind: "ok" }),
      { ttftMs: 400 },
    );
    const started = Date.now();
    const { text } = await chat(base);
    const { data, comments } = events(text);
    expect(contentOf(data)).toBe("Привет от модели. ");
    expect(comments).toBeGreaterThan(0);
    expect(gateway.requests).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("a model silent through every attempt is «Модель долго не отвечает», not a dropped connection", async () => {
    const { gateway, base } = await setup(() => ({ kind: "stall", ms: 3_000 }), {
      ttftMs: 200,
      attempts: 2,
    });
    const { text } = await chat(base);
    const { data } = events(text);
    const error = JSON.parse(data.at(-2) ?? "{}") as {
      error?: { message?: string; code?: string };
    };
    expect(error.error?.message).toBe("Модель долго не отвечает: нет ответа после 2 попыток");
    expect(error.error?.code).toBe("prsloy_model_slow");
    expect(gateway.requests).toHaveLength(2);
  });

  it("429, 5xx, 200-with-error-body and an empty stream are all retried", async () => {
    const script: Behaviour[] = [
      { kind: "status", status: 429 },
      { kind: "json-error" },
      { kind: "empty" },
      { kind: "ok", text: "наконец" },
    ];
    const { gateway, base } = await setup((i) => script[i] ?? { kind: "ok" }, { attempts: 4 });
    const { text } = await chat(base);
    expect(contentOf(events(text).data)).toBe("наконец ");
    expect(gateway.requests).toHaveLength(4);
  });

  it("forwards the agent's key as is and asks for usage in the stream", async () => {
    const { gateway, base } = await setup(() => ({ kind: "ok" }));
    await chat(base);
    expect(gateway.requests[0]?.headers.authorization).toBe("Bearer rk-test-key");
    expect(gateway.requests[0]?.body.stream_options).toEqual({ include_usage: true });
  });

  it("after all attempts fail: the gateway's status as is if nothing was sent yet", async () => {
    const { gateway, base } = await setup(() => ({
      kind: "status",
      status: 503,
      body: '{"error":"busy"}',
    }));
    const { status, text } = await chat(base);
    expect(status).toBe(503);
    expect(text).toBe('{"error":"busy"}');
    expect(gateway.requests).toHaveLength(3);
  });

  it("errors that retrying cannot fix (400, 401) are passed through at once", async () => {
    const { gateway, base } = await setup(() => ({
      kind: "status",
      status: 401,
      body: '{"error":{"message":"bad key"}}',
    }));
    const { status, text } = await chat(base);
    expect(status).toBe(401);
    expect(text).toContain("bad key");
    expect(gateway.requests).toHaveLength(1);
  });
});

describe("reliability proxy: framing and live streaming", () => {
  it("chunks split mid-JSON and mid-UTF-8 are reassembled into well-formed events", async () => {
    const { base } = await setup(() => ({ kind: "split", text: "разрезанный посреди ответ" }));
    const { text } = await chat(base);
    expect(contentOf(events(text).data)).toBe("разрезанный посреди ответ");
  });

  it("data lines without blank lines between them become separate events", async () => {
    const { base } = await setup(() => ({ kind: "no-blank-lines", text: "склейка" }));
    const { text } = await chat(base);
    const { data } = events(text);
    expect(contentOf(data)).toBe("склейка");
    expect(data.length).toBe(4); // content, finish, usage, [DONE]
  });

  it("tokens are streamed live after the first delta (not buffered to the end)", async () => {
    const { base } = await setup(() => ({
      kind: "ok",
      text: "раз два три четыре",
      tokenDelayMs: 150,
    }));
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    const reader = res.body!.getReader();
    const started = Date.now();
    const first = await reader.read();
    const firstAt = Date.now() - started;
    expect(new TextDecoder().decode(first.value)).toContain("раз");
    while (!(await reader.read()).done);
    expect(firstAt).toBeLessThan(Date.now() - started - 300);
  });

  it("a drop after the first delta becomes one clean error event, not a retry", async () => {
    const { gateway, base, metricsPath } = await setup(() => ({
      kind: "drop-after-first",
      text: "Начало",
    }));
    const { text } = await chat(base);
    const { data } = events(text);
    expect(contentOf(data.slice(0, 1))).toBe("Начало");
    const error = JSON.parse(data.at(-2) ?? "{}") as {
      error?: { message?: string; code?: string };
    };
    expect(error.error?.message).toBe(STREAM_INTERRUPTED_MESSAGE);
    expect(error.error?.code).toBe("prsloy_stream_interrupted");
    expect(gateway.requests).toHaveLength(1);
    const [line] = await metricsLines(metricsPath);
    expect(line?.outcome).toBe("interrupted");
  });

  it("does not wait for a supplier that keeps the connection open after the answer", async () => {
    const { base } = await setup(() => ({ kind: "linger" }));
    const started = Date.now();
    const { text } = await chat(base);
    expect(contentOf(events(text).data)).toBe("конец");
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("tool calls count as the first useful delta", async () => {
    const { base } = await setup(() => ({ kind: "tool-call" }));
    const { data } = events((await chat(base)).text);
    expect(data[0]).toContain('"tool_calls"');
  });
});

describe("reliability proxy: non-streaming calls", () => {
  it("retries a 200 with an error body and returns the good answer", async () => {
    const { gateway, base } = await setup((i) =>
      i === 0 ? { kind: "json-error" } : { kind: "ok" },
    );
    const { status, text } = await chat(base, false);
    expect(status).toBe(200);
    expect(JSON.parse(text).choices[0].message.content).toBe("ok");
    expect(gateway.requests).toHaveLength(2);
  });
});

describe("reliability proxy: per-model deadlines and the hidden-prompt canary", () => {
  it("Opus and Grok get their own first-token deadline; the common one is the floor", () => {
    expect(ttftFor("claude-opus-5-5", 60_000)).toBe(300_000);
    expect(ttftFor("grok-4.7", 60_000)).toBe(180_000);
    expect(ttftFor("deepseek-v4.1-flash-1017", 60_000)).toBe(60_000);
    expect(ttftFor("grok-4.7", 400_000)).toBe(400_000);
    expect(ttftFor(undefined, 2_000)).toBe(2_000);
  });

  it("a slow first token from Opus is waited for, not cut and retried", async () => {
    const { gateway, base } = await setup(() => ({ kind: "ok", delayMs: 300 }), { ttftMs: 100 });
    const { status, text } = await chat(base, true, { model: "claude-opus-5-5" });
    expect(status).toBe(200);
    expect(contentOf(events(text).data)).toContain("Привет");
    expect(gateway.requests).toHaveLength(1);
    const slow = await setup(() => ({ kind: "ok", delayMs: 300 }), { ttftMs: 100 });
    await chat(slow.base, true);
    expect(slow.gateway.requests.length).toBeGreaterThan(1);
  });

  it("the first call of a session with far more prompt tokens than ours is logged, once", async () => {
    const warn: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warn.push(args.join(" "));
    cleanup.push(async () => {
      console.warn = original;
    });
    const { base, metricsPath } = await setup(() => ({ kind: "ok", promptTokens: 2_100 }));
    await chat(base, true, { model: "qwen3.8-max" });
    await chat(base, true, { model: "qwen3.8-max" });
    await expect.poll(async () => (await metricsLines(metricsPath)).length).toBe(2);
    const [first, second] = await metricsLines(metricsPath);
    expect(first!.hidden_prompt).toBeGreaterThan(1_500);
    expect(second!.hidden_prompt).toBeUndefined();
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain("канал добавляет скрытый промпт: qwen3.8-max");
    expect(warn[0]).not.toContain("rk-test-key");
  });

  it("a genuine channel stays quiet", async () => {
    const warn: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warn.push(args.join(" "));
    cleanup.push(async () => {
      console.warn = original;
    });
    const messages = [{ role: "system", content: "x".repeat(8_000) }];
    const ours = estimatePromptTokens({ messages });
    const { base, metricsPath } = await setup(() => ({ kind: "ok", promptTokens: ours + 400 }));
    await chat(base, true, { messages });
    expect((await metricsLines(metricsPath))[0]!.hidden_prompt).toBeUndefined();
    expect(warn).toHaveLength(0);
  });
});

describe("pieces", () => {
  it("SseParser: comments, CRLF, multi-line data, missing blank lines", () => {
    const parser = new SseParser();
    const a = chunk({ content: "a" });
    expect(parser.push(`: ping\r\n\r\ndata: ${a.slice(0, 10)}`)).toEqual([]);
    expect(parser.push(`${a.slice(10)}\r\n`)).toEqual([a]);
    expect(parser.push('data: {"x":\ndata: 1}\n\n')).toEqual(['{"x":\n1}']);
    expect(parser.push("data: [DONE]\n")).toEqual(["[DONE]"]);
    expect(parser.end()).toEqual([]);
  });

  it("looksLikeGatewayError matches a6 texts, not ordinary content", () => {
    expect(looksLikeGatewayError('{"error":{"message":"等待响应超时，请稍后重试"}}')).toBe(true);
    expect(looksLikeGatewayError('{"error":{"message":"upstream overloaded"}}')).toBe(true);
    expect(looksLikeGatewayError(chunk({ content: "timeout в коде — это нормально" }))).toBe(false);
  });

  it("route encodes the upstream; upstreamOf decodes it back", async () => {
    const proxy = new ReliabilityProxy();
    await proxy.start();
    cleanup.push(() => proxy.close());
    const base = proxy.route("https://api.prsloy.online/v1/", "/tmp/m.jsonl", "s");
    expect(base.startsWith(`${proxy.origin}/p/`)).toBe(true);
    expect(proxy.upstreamOf(base)).toBe("https://api.prsloy.online/v1");
    expect(proxy.upstreamOf("https://api.prsloy.online/v1")).toBeUndefined();
  });
});
