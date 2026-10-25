/**
 * PRSLOY provider through a real pi runtime against a local mock gateway:
 * keyless models.json + runtime key, default model from the seeded settings,
 * compat on the wire (max_tokens, no developer role / store), reasoning_content
 * replayed verbatim across tool turns, no effort for Opus.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createPixRuntime } from "@zeno/agent-runtime";
import { MockGatewayServer } from "../../../../../packages/test-utils/src/index.ts";
import { PRSLOY_PROVIDER_ID } from "../../shared/prsloy-config.ts";
import { bootstrapPrsloy } from "./context.ts";
import type { SecretCipher } from "./key-store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text),
  decryptString: (buf) => buf.toString(),
};

type Msg = { role: string; content?: unknown; reasoning_content?: string; tool_calls?: unknown[] };

describe("PRSLOY provider (mock gateway, real pi runtime)", () => {
  it("speaks the gateway's dialect and replays reasoning verbatim", async () => {
    const userData = tempDir("prsloy-prov-ud-");
    const workspace = tempDir("prsloy-prov-ws-");
    const file = join(workspace, "notes.txt");
    writeFileSync(file, "hello from file\n");

    const server = new MockGatewayServer({
      apiKey: "sk-prov",
      turns: [
        {
          reasoning: "Нужно прочитать файл.",
          toolCall: { name: "read", arguments: { path: file } },
        },
        { reasoning: "Файл прочитан.", text: "Готово." },
        { text: "Второй ответ." },
        { text: "Ответ Opus." },
      ],
    });
    await server.start();
    cleanups.push(() => server.stop());

    const env: NodeJS.ProcessEnv = {};
    const ctx = bootstrapPrsloy({ userDataPath: userData, cipher, env, platform: "linux" });
    ctx.setBaseUrl(server.baseUrl);
    ctx.keyStore.write("sk-prov");

    const handle = await createPixRuntime({
      cwd: workspace,
      agentDir: ctx.agentDir,
      tools: ["read"],
      runtimeApiKeys: { [PRSLOY_PROVIDER_ID]: ctx.keyStore.read()! },
      contextFilesRequireTrust: true,
    });
    cleanups.push(() => handle.dispose());

    // Default model comes from the seeded settings (fast preset).
    expect(handle.snapshot().model).toMatchObject({
      provider: "prsloy",
      id: "deepseek-v4.1-flash-1017",
    });

    await handle.runtime.session.prompt("Прочитай notes.txt");
    await handle.runtime.session.prompt("Ещё раз");

    // Cost from the price table, computed by pi itself: mock usage is 10 in / 5 out tokens.
    const lastAssistant = [...handle.runtime.session.messages]
      .reverse()
      .find((m) => m.role === "assistant") as { usage?: { cost?: { total?: number } } };
    expect(lastAssistant.usage?.cost?.total).toBeCloseTo((10 * 0.0012 + 5 * 0.0048) / 1e6, 15);
    expect(server.requests.length).toBe(3);
    if (process.env.PRSLOY_WIRE_OUT) {
      const { messages: _m, tools: _t, ...shape } = server.requests[0]!.body;
      (await import("node:fs")).writeFileSync(
        process.env.PRSLOY_WIRE_OUT ?? "wire.json",
        JSON.stringify(shape),
      );
    }

    for (const request of server.requests) {
      expect(request.headers.authorization).toBe("Bearer sk-prov");
      const body = request.body;
      expect(body.model).toBe("deepseek-v4.1-flash-1017");
      expect(body.max_tokens).toBeTypeOf("number");
      expect(body.max_completion_tokens).toBeUndefined();
      expect(body.store).toBeUndefined();
      const roles = (body.messages as Msg[]).map((m) => m.role);
      expect(roles[0]).toBe("system");
      expect(roles).not.toContain("developer");
    }

    // Turn 2 (after the tool result): the tool-call assistant message carries its
    // reasoning back byte for byte.
    const second = server.requests[1]!.body.messages as Msg[];
    const toolCallMsg = second.find((m) => m.role === "assistant" && m.tool_calls);
    expect(toolCallMsg?.reasoning_content).toBe("Нужно прочитать файл.");
    expect(second.some((m) => m.role === "tool")).toBe(true);

    // Turn 3: every earlier assistant message still has its reasoning.
    const third = server.requests[2]!.body.messages as Msg[];
    const assistants = third.filter((m) => m.role === "assistant");
    expect(assistants.map((m) => m.reasoning_content)).toEqual([
      "Нужно прочитать файл.",
      "Файл прочитан.",
    ]);

    // Opus: thinking cannot be turned on, and no effort / thinking field is sent.
    await handle.setModel(PRSLOY_PROVIDER_ID, "claude-opus-5-5");
    expect(handle.snapshot().availableThinkingLevels).toEqual(["off"]);
    expect(() => handle.setThinkingLevel("high")).toThrow(/not available/);
    await handle.runtime.session.prompt("Теперь Opus");
    const opus = server.requests[3]!.body;
    expect(opus.model).toBe("claude-opus-5-5");
    expect(opus.reasoning_effort).toBeUndefined();
    expect(opus.thinking).toBeUndefined();
    expect(opus.reasoning).toBeUndefined();
    expect(opus.max_tokens).toBeTypeOf("number");
  });
});
