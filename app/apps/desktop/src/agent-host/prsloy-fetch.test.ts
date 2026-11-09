import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createPrsloyFetch, installPrsloyFetch, PRSLOY_FETCH_MARKER } from "./prsloy-fetch.ts";

const endpoint = "https://gateway.invalid/v1/chat/completions";
const model = "gpt-6.1-sol";
const request = (): RequestInit => ({
  method: "POST",
  headers: { Authorization: "Bearer fixture-key" },
  body: JSON.stringify({ model, max_tokens: 128_000 }),
});

function harness(reply: (call: number) => Response, modelFallback?: boolean) {
  const calls: RequestInit[] = [];
  const listModels = vi.fn(async () => ["kimi-k3.1-pro"]);
  const onModelSwitch = vi.fn();
  const fetch = createPrsloyFetch({
    base: async (_url, init) => {
      calls.push(init!);
      return reply(calls.length);
    },
    apiKey: "fixture-key",
    listModels,
    onModelSwitch,
    ...(modelFallback === undefined ? {} : { modelFallback }),
  });
  return { fetch, calls, listModels, onModelSwitch };
}

describe("fixed-model requests", () => {
  it.each([400, 404, 503])(
    "returns HTTP %s without consulting or switching models",
    async (status) => {
      const h = harness(
        () => new Response("model_not_found", { status, headers: { "x-trace": "original" } }),
        false,
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await h.fetch(endpoint, request());
        expect(response.status).toBe(status);
        expect(response.headers.get("x-trace")).toBe("original");
        expect(await response.text()).toBe("model_not_found");
      }
      expect(h.calls.map((call) => JSON.parse(call.body as string).model)).toEqual([model, model]);
      expect(h.listModels).not.toHaveBeenCalled();
      expect(h.onModelSwitch).not.toHaveBeenCalled();
    },
  );

  it.each([400, 402])(
    "still reduces max_tokens on HTTP %s and remembers the cap",
    async (status) => {
      const h = harness(
        (call) =>
          call === 1 ? new Response("max_tokens too large", { status }) : new Response("ok"),
        false,
      );
      const controller = new AbortController();
      expect((await h.fetch(endpoint, { ...request(), signal: controller.signal })).ok).toBe(true);
      expect((await h.fetch(endpoint, request())).ok).toBe(true);
      const bodies = h.calls.map((call) => JSON.parse(call.body as string));
      expect(bodies.map((body) => body.max_tokens)).toEqual([128_000, 64_000, 64_000]);
      expect(bodies.every((body) => body.model === model)).toBe(true);
      for (const call of h.calls.slice(0, 2)) {
        expect(call.signal).toBe(controller.signal);
        expect(new Headers(call.headers).get(PRSLOY_FETCH_MARKER)).toBe("1");
      }
      expect(h.listModels).not.toHaveBeenCalled();
      expect(h.onModelSwitch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, true])(
    "preserves default recovery when modelFallback is %s",
    async (flag) => {
      const h = harness(
        (call) =>
          call === 1 ? new Response("model_not_found", { status: 404 }) : new Response("ok"),
        flag,
      );
      expect((await h.fetch(endpoint, request())).ok).toBe(true);
      expect((await h.fetch(endpoint, request())).ok).toBe(true);
      expect(h.calls.map((call) => JSON.parse(call.body as string).model)).toEqual([
        model,
        "kimi-k3.1-pro",
        "kimi-k3.1-pro",
      ]);
      expect(h.listModels).toHaveBeenCalledTimes(1);
      expect(h.onModelSwitch).toHaveBeenCalledExactlyOnceWith(model, "kimi-k3.1-pro");
    },
  );

  it("the global installer forwards the opt-out without fetching the model catalog", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "prsloy-fixed-model-"));
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: { prsloy: { baseUrl: "https://gateway.invalid/v1" } },
      }),
    );
    const original = globalThis.fetch;
    const urls: string[] = [];
    const onModelSwitch = vi.fn();
    globalThis.fetch = async (url) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      urls.push(href);
      return href.endsWith("/models")
        ? Response.json({ data: [{ id: "kimi-k3.1-pro" }] })
        : new Response("model_not_found", { status: 404 });
    };
    try {
      installPrsloyFetch({
        apiKey: "fixture-key",
        agentDir: () => agentDir,
        onModelSwitch,
        modelFallback: false,
      });
      expect((await globalThis.fetch(endpoint, request())).status).toBe(404);
      expect(urls).toEqual([endpoint]);
      expect(onModelSwitch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
