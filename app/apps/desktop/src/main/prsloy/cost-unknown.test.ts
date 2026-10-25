/**
 * A gateway reply with output tokens but no input (seen live on deepseek): the session's
 * cost is unknown, so the snapshot says so and shows no money (`cost` 0, like a model
 * without a price) instead of an output-only partial price.
 */
import { mkdtempSync, rmSync } from "node:fs";
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

async function sessionCost(promptTokens: number) {
  const userData = mkdtempSync(join(tmpdir(), "prsloy-cost-ud-"));
  const workspace = mkdtempSync(join(tmpdir(), "prsloy-cost-ws-"));
  cleanups.push(() => rmSync(userData, { recursive: true, force: true }));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  const server = new MockGatewayServer({
    apiKey: "sk-c",
    promptTokens,
    turns: [{ text: "Привет." }],
  });
  await server.start();
  cleanups.push(() => server.stop());
  const ctx = bootstrapPrsloy({
    userDataPath: userData,
    cipher: {
      isEncryptionAvailable: () => true,
      encryptString: (t) => Buffer.from(t),
      decryptString: (b) => b.toString(),
    },
    env: {},
    platform: "linux",
  });
  ctx.setBaseUrl(server.baseUrl);
  const handle = await createPixRuntime({
    cwd: workspace,
    agentDir: ctx.agentDir,
    tools: [],
    runtimeApiKeys: { [PRSLOY_PROVIDER_ID]: "sk-c" },
  });
  cleanups.push(() => handle.dispose());
  await handle.setModel(PRSLOY_PROVIDER_ID, "deepseek-v4.1-flash-1017");
  await handle.runtime.session.prompt("Привет");
  return handle.snapshot().usage;
}

describe("session cost when the gateway doesn't meter input", () => {
  it("input 0, output > 0 → cost unknown: no money shown", async () => {
    const usage = await sessionCost(0);
    expect(usage?.tokens.output).toBeGreaterThan(0);
    expect(usage?.costUnknown).toBe(true);
    expect(usage?.cost).toBe(0);
  }, 60_000);

  it("metered input → the real cost, no flag", async () => {
    const usage = await sessionCost(10);
    expect(usage?.costUnknown).toBeUndefined();
    expect(usage?.cost).toBeGreaterThan(0);
  }, 60_000);
});
