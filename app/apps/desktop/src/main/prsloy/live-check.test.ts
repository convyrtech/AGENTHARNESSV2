/**
 * The live gateway check against the mock gateway: a text model with reasoning (Qwen), one
 * without (Opus), an image model skipped, a gateway that refuses 128k output.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import { MockGatewayServer } from "../../../../../packages/test-utils/src/index.ts";
import { formatLiveReport, runLiveGatewayCheck } from "./live-check.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("live gateway check (mock)", () => {
  it("fills model × check, skips image models, reports the max_tokens step-down", async () => {
    const key = "sk-live-secret-123";
    const server = new MockGatewayServer({
      apiKey: key,
      modelIds: ["qwen3.8-max", "claude-opus-5-5", "gpt-image-2"],
      maxTokensLimit: 64_000,
      turns: [
        { reasoning: "Думаю.", text: "Привет" },
        {
          reasoning: "Нужно прочитать.",
          toolCall: { name: "read", arguments: { path: "ok.txt" } },
        },
        { text: "PRSLOY-LIVE-42" },
        { text: "Привет" },
        { toolCall: { name: "read", arguments: { path: "ok.txt" } } },
        { text: "PRSLOY-LIVE-42" },
      ],
    });
    await server.start();
    cleanups.push(() => server.stop());

    const report = await runLiveGatewayCheck({ baseUrl: server.baseUrl, apiKey: key });
    expect(report.skipped).toEqual(["gpt-image-2"]);
    expect(report.rows.map((r) => r.model)).toEqual(["qwen3.8-max", "claude-opus-5-5"]);
    const [qwen, opus] = report.rows;
    for (const row of report.rows) {
      expect(row.stream.ok, JSON.stringify(row)).toBe(true);
      expect(row.max_tokens).toMatchObject({ ok: true });
      expect(row.max_tokens.note).toContain("128000→400, 64000→200");
      expect(row.usage.ok, row.usage.note).toBe(true);
      expect(row.tool.ok, row.tool.note).toBe(true);
    }
    expect(qwen!.thinking.ok, qwen!.thinking.note).toBe(true);
    expect(qwen!.thinking.note).toContain("parallel_tool_calls=true");
    expect(qwen!.tool.note).toContain("reasoning replayed: yes");
    expect(opus!.thinking).toMatchObject({ ok: true });

    const table = formatLiveReport(report);
    expect(table).toContain("| qwen3.8-max | ✅");
    expect(JSON.stringify(report) + table).not.toContain(key);
    // ≤ 3 answered requests per model (stream 1 + tool 2), step-downs aside.
    const answered = server.requests.filter((r) => (r.body.max_tokens as number) <= 64_000);
    expect(answered).toHaveLength(6);
  }, 120_000);
});
