/**
 * Request parameters per model (research/17 §4.3), on the wire through a real pi runtime
 * and the mock gateway: each body carries only the fields allowed for its model, and
 * reasoning of earlier turns goes back where the vendor needs it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPixRuntime } from "@zeno/agent-runtime";
import { MockGatewayServer } from "../../../../../packages/test-utils/src/index.ts";
import { PRSLOY_PROVIDER_ID } from "../../shared/prsloy-config.ts";
import { bootstrapPrsloy } from "./context.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type Body = Record<string, unknown> & { messages: Msg[] };
type Msg = { role: string; reasoning_content?: string; tool_calls?: unknown[] };

/** Two turns (a tool call, then a plain answer) on one model; the request bodies. */
async function bodiesFor(
  modelId: string,
  tweak?: (h: Awaited<ReturnType<typeof createPixRuntime>>) => void,
) {
  const userData = mkdtempSync(join(tmpdir(), "prsloy-params-ud-"));
  const workspace = mkdtempSync(join(tmpdir(), "prsloy-params-ws-"));
  cleanups.push(() => rmSync(userData, { recursive: true, force: true }));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "a.txt"), "x\n");
  const server = new MockGatewayServer({
    apiKey: "sk-params",
    turns: [
      {
        reasoning: "R1",
        toolCall: { name: "read", arguments: { path: join(workspace, "a.txt") } },
      },
      { reasoning: "R2", text: "Готово." },
      { text: "Ещё." },
    ],
  });
  await server.start();
  cleanups.push(() => server.stop());
  const ctx = bootstrapPrsloy({
    userDataPath: userData,
    cipher: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (buf) => buf.toString(),
    },
    env: {},
    platform: "linux",
  });
  ctx.setBaseUrl(server.baseUrl);
  const handle = await createPixRuntime({
    cwd: workspace,
    agentDir: ctx.agentDir,
    tools: ["read"],
    runtimeApiKeys: { [PRSLOY_PROVIDER_ID]: "sk-params" },
  });
  cleanups.push(() => handle.dispose());
  await handle.setModel(PRSLOY_PROVIDER_ID, modelId);
  tweak?.(handle);
  await handle.runtime.session.prompt("Прочитай a.txt");
  await handle.runtime.session.prompt("Ещё раз");
  return {
    handle,
    bodies: server.requests.map((r) => r.body as Body),
  };
}

const COMMON = ["max_tokens", "messages", "model", "stream", "stream_options", "tools"];
const keys = (body: Body) => Object.keys(body).sort();
const replayed = (body: Body) =>
  body.messages.filter((m) => m.role === "assistant").map((m) => m.reasoning_content);

describe("request parameters per model (§4.3)", () => {
  it("DeepSeek: thinking on, no temperature, reasoning of every turn back, max_tokens ≥ 64K", async () => {
    const { bodies, handle } = await bodiesFor("deepseek-v4.1-flash-1017");
    expect(handle.snapshot().availableThinkingLevels).not.toContain("off");
    for (const body of bodies) {
      expect(keys(body)).toEqual([...COMMON, "reasoning_effort", "thinking"].sort());
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.max_tokens).toBeGreaterThanOrEqual(64_000);
    }
    expect(replayed(bodies[2]!)).toEqual(["R1", "R2"]);
  }, 60_000);

  it("Kimi: one effort for the whole session, no temperature / top_p", async () => {
    const { bodies, handle } = await bodiesFor("kimi-k3.1-pro");
    expect(handle.snapshot().availableThinkingLevels).toEqual(["high"]);
    expect(() => handle.setThinkingLevel("low")).toThrow(/not available/);
    for (const body of bodies) {
      expect(keys(body)).toEqual([...COMMON, "reasoning_effort"].sort());
      expect(body.reasoning_effort).toBe("high");
    }
    expect(replayed(bodies[2]!)).toEqual(["R1", "R2"]);
  }, 60_000);

  it("Qwen: parallel_tool_calls=true, tool_choice only auto, reasoning back, temperature ≥ 0.6", async () => {
    const { bodies } = await bodiesFor("qwen3.8-max");
    for (const body of bodies) {
      expect(keys(body)).toEqual(
        [...COMMON, "enable_thinking", "parallel_tool_calls", "reasoning_effort"].sort(),
      );
      expect(body.parallel_tool_calls).toBe(true);
      expect(body.tool_choice ?? "auto").toBe("auto");
      expect((body.temperature as number | undefined) ?? 0.6).toBeGreaterThanOrEqual(0.6);
    }
    expect(replayed(bodies[2]!)).toEqual(["R1", "R2"]);
  }, 60_000);

  it("Opus: no effort or thinking field, max_tokens within its 128K limit", async () => {
    const { bodies, handle } = await bodiesFor("claude-opus-5-5");
    expect(handle.snapshot().availableThinkingLevels).toEqual(["off"]);
    for (const body of bodies) {
      expect(keys(body)).toEqual(COMMON);
      expect(body.max_tokens).toBeLessThanOrEqual(128_000);
    }
  }, 60_000);
});
