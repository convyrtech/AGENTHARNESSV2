import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MockGatewayServer } from "../../../../../packages/test-utils/src/index.ts";
import { checkPrsloyKey } from "./gateway-check.ts";

const servers: MockGatewayServer[] = [];
async function gateway(options: ConstructorParameters<typeof MockGatewayServer>[0]) {
  const server = new MockGatewayServer(options);
  await server.start();
  servers.push(server);
  return server;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

/** A loopback port with nothing listening. */
async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("checkPrsloyKey (mock gateway)", () => {
  it("accepts a good key via GET /models and lists models", async () => {
    const server = await gateway({ apiKey: "sk-good", modelIds: ["kimi-k3.1-pro"] });
    const result = await checkPrsloyKey({ baseUrl: server.baseUrl, apiKey: "sk-good", fetch });
    expect(result).toEqual({ ok: true, modelIds: ["kimi-k3.1-pro"], via: "models" });
    expect(server.modelListRequests[0]!.headers.authorization).toBe("Bearer sk-good");
  });

  it("maps a wrong key to invalid_key", async () => {
    const server = await gateway({ apiKey: "sk-good" });
    const result = await checkPrsloyKey({ baseUrl: server.baseUrl, apiKey: "sk-bad", fetch });
    expect(result).toEqual({ ok: false, code: "invalid_key", status: 401 });
  });

  it("falls back to a one-token completion when /models is hidden", async () => {
    const server = await gateway({ apiKey: "sk-good", noModelsEndpoint: true });
    const ok = await checkPrsloyKey({ baseUrl: server.baseUrl, apiKey: "sk-good", fetch });
    expect(ok).toEqual({ ok: true, modelIds: [], via: "completion" });
    expect(server.requests[0]!.body).toMatchObject({ max_tokens: 1, stream: false });
    const bad = await checkPrsloyKey({ baseUrl: server.baseUrl, apiKey: "sk-bad", fetch });
    expect(bad).toMatchObject({ ok: false, code: "invalid_key" });
  });

  it("maps 5xx to server and 402 to no_balance", async () => {
    const broken = await gateway({ apiKey: "k", failWithStatus: 503 });
    expect(await checkPrsloyKey({ baseUrl: broken.baseUrl, apiKey: "k", fetch })).toEqual({
      ok: false,
      code: "server",
      status: 503,
    });
    const broke = await gateway({ apiKey: "k", failWithStatus: 402 });
    expect(await checkPrsloyKey({ baseUrl: broke.baseUrl, apiKey: "k", fetch })).toMatchObject({
      code: "no_balance",
    });
  });

  it("maps a dead endpoint to network and a hung one to timeout", async () => {
    const port = await deadPort();
    expect(
      await checkPrsloyKey({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", fetch }),
    ).toEqual({ ok: false, code: "network" });
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    expect(
      await checkPrsloyKey({ baseUrl: "https://gw/v1", apiKey: "k", fetch: hang, timeoutMs: 20 }),
    ).toEqual({ ok: false, code: "timeout" });
  });

  it("rejects empty keys and broken URLs without network", async () => {
    const never = () => Promise.reject(new Error("must not be called"));
    expect(await checkPrsloyKey({ baseUrl: "https://gw/v1", apiKey: " ", fetch: never })).toEqual({
      ok: false,
      code: "invalid_key",
    });
    expect(await checkPrsloyKey({ baseUrl: "::nope", apiKey: "k", fetch: never })).toEqual({
      ok: false,
      code: "bad_url",
    });
  });
});
