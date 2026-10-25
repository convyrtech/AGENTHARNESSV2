import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { MockGatewayServer } from "@zeno/test-utils";
import { expect, launchZenoApp, startHost, test } from "./fixtures.ts";

/** Every file under root (bounded), for greps. */
async function allFiles(root: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "runtimes") continue;
      await allFiles(path, out);
    } else if (entry.isFile() && (await stat(path)).size < 20 * 1024 * 1024) {
      out.push(path);
    }
  }
  return out;
}

/**
 * PRSLOY security pass, end to end on the real app:
 * - the gateway key goes setKey → encrypted at rest → host handoff → pi runtime key, and is
 *   never written in plain text anywhere (userData, agent home, sessions, logs, stdout);
 * - the agent's bash sees neither the key nor a machine secret from the app's env.
 */
test("gateway key never leaks; agent env is scrubbed", async () => {
  const key = `sk-prsloy-leakcheck-${randomUUID()}`;
  const planted = `ghp_planted_${randomUUID().slice(0, 8)}`;
  const gateway = new MockGatewayServer({
    apiKey: key,
    modelIds: ["deepseek-v4.1-flash-1017"],
    turns: [{ toolCall: { name: "bash", arguments: { command: "env" } } }, { text: "done" }],
  });
  await gateway.start();
  const launched = await launchZenoApp({
    tools: "read,bash",
    model: { provider: "prsloy", id: "deepseek-v4.1-flash-1017" },
    env: { GH_TOKEN: planted, OPENAI_API_KEY: planted },
  });
  try {
    const { page } = launched;
    const result = await page.evaluate(
      ([k, url]) => window.zeno.prsloy.setKey(k!, url),
      [key, gateway.baseUrl],
    );
    expect(result.ok).toBe(true);

    await startHost(page);
    await page.getByTestId("prompt-input").fill("Run env please.");
    await page.getByTestId("send-prompt").click();
    await expect(page.getByTestId("host-status").first()).toContainText("Agent settled", {
      timeout: 60_000,
    });

    // The model call carried the key (runtime key works end to end)…
    expect(gateway.requests[0]?.headers.authorization).toBe(`Bearer ${key}`);
    // …and the bash tool's env output (sent back to the model) has neither secret.
    const toolOutput = JSON.stringify(gateway.requests[1]?.body.messages ?? []);
    expect(toolOutput).toContain("PI_CODING_AGENT_DIR");
    expect(toolOutput).not.toContain(key);
    expect(toolOutput).not.toContain(planted);

    await launched.app.close();
    const leaks: string[] = [];
    for (const file of await allFiles(launched.root)) {
      const text = await readFile(file, "latin1");
      if (text.includes(key)) leaks.push(file);
    }
    expect(leaks).toEqual([]);
    expect(launched.output.join("")).not.toContain(key);
    expect(launched.output.join("").length).toBeGreaterThan(0);
  } finally {
    await launched.app.close().catch(() => undefined);
    await launched.fakeModel.stop().catch(() => undefined);
    await gateway.stop().catch(() => undefined);
    await rm(launched.root, { recursive: true, force: true }).catch(() => undefined);
  }
});
