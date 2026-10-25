/**
 * M-sp: the extractor's call outside any turn — after the user leaves a chat, from main,
 * its price in its own journal (no texts), nothing written into the session.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MockGatewayServer } from "../../../../../packages/test-utils/src/index.ts";
import {
  extractorModel,
  installMemoryExtractor,
  runExtractorProbe,
  type ExtractorRun,
} from "./memory-extractor.ts";
import { emitSessionLeft } from "./session-left.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prsloy-extractor-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function gateway(options: { promptTokens?: number; text?: string } = {}) {
  const server = new MockGatewayServer({
    apiKey: "sk-x",
    modelIds: ["qwen3.8-max"],
    turns: [{ text: options.text ?? '{"ok":true}' }, { text: '{"ok":true}' }],
    ...(options.promptTokens !== undefined ? { promptTokens: options.promptTokens } : {}),
  });
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}
const journal = (dir: string) =>
  readFileSync(join(dir, "extractor.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as ExtractorRun);

describe("memory extractor probe (M-sp)", () => {
  it("one short call, its price in extractor.jsonl, no texts there", async () => {
    const server = await gateway();
    const dir = tempDir();
    const run = await runExtractorProbe({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: "/home/u/.config/PRSLOY/agent/sessions/чат.jsonl",
      journalDir: dir,
      fetch,
    });
    expect(run).toMatchObject({ ok: true, json: true, status: 200, input: 10, output: 5 });
    expect(run.costUsd).toBeGreaterThan(0);
    const [line] = journal(dir);
    expect(line).toMatchObject({ kind: "probe", model: "qwen3.8-max", ok: true });
    expect(line!.session).toMatch(/^[0-9a-f]{16}$/u);
    const raw = readFileSync(join(dir, "extractor.jsonl"), "utf8");
    expect(raw).not.toContain("чат");
    expect(raw).not.toContain("sk-x");
    expect(server.requests[0]!.body).toMatchObject({ model: "qwen3.8-max", max_tokens: 64 });
  });

  it("no input metered → price unknown (null), not a partial one", async () => {
    const server = await gateway({ promptTokens: 0 });
    const run = await runExtractorProbe({
      baseUrl: server.baseUrl,
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: "s",
      journalDir: tempDir(),
      fetch,
    });
    expect(run.costUsd).toBeNull();
  });

  it("a failed call is journaled too", async () => {
    const run = await runExtractorProbe({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-x",
      model: "qwen3.8-max",
      sessionFile: "s",
      journalDir: tempDir(),
      fetch,
      timeoutMs: 3000,
    });
    expect(run.ok).toBe(false);
    expect(run.error).toBeTruthy();
  });

  it("queue: after the user leaves a chat, once per chat, one at a time; off by default", async () => {
    const server = await gateway();
    const agentDir = tempDir();
    const runs: ExtractorRun[] = [];
    const off = installMemoryExtractor({
      mode: undefined,
      agentDir,
      baseUrl: () => server.baseUrl,
      apiKey: () => "sk-x",
      availableModels: () => ["qwen3.8-max"],
      fetch,
    });
    emitSessionLeft("/s/a.jsonl");
    await off.idle();
    expect(server.requests).toHaveLength(0);

    const on = installMemoryExtractor({
      mode: "probe",
      agentDir,
      baseUrl: () => server.baseUrl,
      apiKey: () => "sk-x",
      availableModels: () => ["qwen3.8-max", "gpt-image-2"],
      fetch,
      onRun: (run) => runs.push(run),
    });
    cleanups.push(() => on.stop());
    emitSessionLeft("/s/a.jsonl");
    emitSessionLeft("/s/a.jsonl");
    emitSessionLeft("/s/b.jsonl");
    await on.idle();
    expect(runs.map((r) => r.ok)).toEqual([true, true]);
    expect(server.requests).toHaveLength(2);
    expect(existsSync(join(agentDir, "prsloy-memory", "extractor.jsonl"))).toBe(true);
  });

  it("model: qwen while deepseek meters no input; the fast preset otherwise", () => {
    expect(extractorModel(["deepseek-v4.1-flash-1017", "qwen3.8-max"])).toBe("qwen3.8-max");
    expect(extractorModel(["deepseek-v4.1-flash-1017"])).toBe("deepseek-v4.1-flash-1017");
    expect(extractorModel(["claude-opus-5-5", "gpt-image-2"])).toBe("claude-opus-5-5");
    expect(extractorModel(undefined)).toBe("qwen3.8-max");
  });
});
