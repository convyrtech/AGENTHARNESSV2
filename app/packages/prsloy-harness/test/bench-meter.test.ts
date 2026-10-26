// Счётчик шлюза в замере (дирижёр, 26.10): токены по usage из ответов шлюза, кто звал (агент / второе мнение /
// поиск / память), цена в ₽ по bench/prices.json, бюджет. Ошибка шлюза — исход infra_error, не «честный отказ»:
// 401 останавливает прогон сразу (выход 2), бюджет — выход 3, --resume гоняет сбойные задачи заново.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  countOf,
  emptyUsage,
  failureText,
  type GatewayFailure,
  sourceOf,
} from "../bench/lib/meter.ts";
import { countRub, readPrices, usageRub } from "../bench/lib/prices.ts";
import { infraReason, reportMarkdown, runBench, sourcesLine } from "../bench/run.ts";
import { extractorPrompt } from "../src/memory-extract.ts";
import { reviewPrompt } from "../src/second-opinion.ts";
import { ScriptedOpenAiServer, type ScriptedReply } from "./scripted-openai-server.ts";

const out = mkdtempSync(join(tmpdir(), "prsloy-bench-meter-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const MODEL = "prsloy/deepseek-v4.1-flash-1017";

/** Шлюз, чей ответ можно поменять на ходу (адрес тот же — --resume сверяет настройки вместе с адресом). */
async function gateway(reply: (body: { model?: string }) => ScriptedReply) {
  const gw = { reply };
  const server = new ScriptedOpenAiServer((req) => gw.reply(req));
  await server.start();
  return Object.assign(server, { set: (next: typeof reply) => (gw.reply = next) });
}

describe("who called the gateway", () => {
  it("second opinion and memory extractor by their real prompts; search by web_search_options; the rest is the agent", () => {
    const review = reviewPrompt({ task: "сделай", diff: "+a", checks: "—" });
    expect(sourceOf({ messages: [{ role: "user", content: review }] })).toBe("review");
    const memory = extractorPrompt([{ id: "m1", text: "меня зовут Аня", kinds: [] }], {
      user: [],
      project: [],
    });
    expect(sourceOf({ messages: [{ role: "user", content: memory }] })).toBe("memory");
    expect(sourceOf({ web_search_options: {}, messages: [] })).toBe("search");
    expect(
      sourceOf({
        messages: [
          { role: "system", content: "You are the coding agent of PRSLOY" },
          { role: "user", content: [{ type: "text", text: "Сделай сайт. Ты проверяющий?" }] },
          { role: "assistant", content: "ок" },
          { role: "tool", content: "Ты проверяющий" },
        ],
      }),
    ).toBe("agent");
  });

  it("usage of OpenAI, DeepSeek and Anthropic-style gateways; error bodies", () => {
    expect(
      countOf({
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
      }),
    ).toEqual({ calls: 1, input: 1000, output: 50, cacheRead: 800, cacheWrite: 100 });
    expect(
      countOf({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 7 }),
    ).toEqual({ calls: 1, input: 10, output: 2, cacheRead: 7, cacheWrite: 0 });
    expect(
      countOf({
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      }),
    ).toEqual({ calls: 1, input: 10, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(
      failureText(401, '{"error":{"message":"Invalid API key","type":"authentication_error"}}'),
    ).toBe("HTTP 401: Invalid API key (authentication_error)");
    expect(failureText(502, "")).toBe("HTTP 502: пустой ответ");
  });
});

describe("price in rubles", () => {
  it("fresh input, cache read, cache write and output priced apart; a missing price is unknown, not zero", () => {
    const price = { input: 100, output: 400, cacheRead: 10, cacheWrite: 125 };
    const c = {
      calls: 1,
      input: 1_000_000,
      output: 100_000,
      cacheRead: 600_000,
      cacheWrite: 100_000,
    };
    // 300k свежих × 100 + 600k × 10 + 100k × 125 + 100k × 400 = 30 + 6 + 12,5 + 40.
    expect(countRub(c, price)).toBeCloseTo(88.5);
    expect(countRub(c, { ...price, cacheWrite: null })).toBeNull();
    expect(countRub({ ...c, cacheWrite: 0 }, { ...price, cacheWrite: null })).toBeCloseTo(
      88.5 - 12.5 + 12.5 * 0.8,
    );
    const usage = { ...emptyUsage(), byModel: { a: c, "prsloy/b": c } };
    expect(usageRub(usage, { a: price, b: price })).toBeCloseTo(177);
    expect(usageRub(usage, { a: price })).toBeNull();
  });

  it("bench/prices.json lists the gateway models with null prices until the conductor fills them", () => {
    const prices = readPrices();
    expect(Object.keys(prices)).toContain("deepseek-v4.1-flash-1017");
    expect(Object.keys(prices)).toContain("kimi-k3.1-pro");
    for (const p of Object.values(prices))
      expect(Object.values(p).every((v) => v === null || typeof v === "number")).toBe(true);
  });

  it("the sources line: calls per caller and the share of tokens our add-ons cost", () => {
    const one = { calls: 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };
    const t = {
      calls: 4,
      input: 400,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
      bySource: { agent: { ...one, calls: 3, input: 300, output: 60 }, review: one },
      byModel: {},
    };
    expect(sourcesLine(t)).toBe(
      "Вызовы шлюза: агент 3 (300/60/0+0), второе мнение 1 (100/20/0+0), поиск моделью 0, экстрактор памяти 0; надстройки — 25% токенов.",
    );
  });
});

describe("infra_error", () => {
  const f = (status: GatewayFailure["status"]): GatewayFailure => ({
    source: "agent",
    status,
    message: `HTTP ${status}: x`,
  });
  it("401/403 always; 402, 5xx and network only when the turn ended on it; budget stop", () => {
    expect(infraReason([f(401)], undefined, false)).toMatch(/^ключ не принят шлюзом/);
    expect(infraReason([f(403)], undefined, false)).toMatch(/^ключ не принят шлюзом/);
    // 402 — сначала спуск по max_tokens (#39): сбой, только если ход им и кончился.
    expect(infraReason([f(402)], undefined, false)).toBeUndefined();
    expect(infraReason([f(402)], undefined, true)).toMatch(/^квота шлюза/);
    // Прокси надёжности повторил 500 и дождался ответа — ход дошёл до конца, сбоя нет.
    expect(infraReason([f(500)], undefined, false)).toBeUndefined();
    expect(infraReason([f(500), f("network")], undefined, true)).toBe(
      "сбой шлюза: HTTP network: x",
    );
    expect(infraReason([], undefined, true)).toBeUndefined();
    expect(infraReason([], { reason: "budget", message: "бюджет исчерпан: 10 из 5" }, true)).toBe(
      "бюджет исчерпан: 10 из 5",
    );
  });

  it("the key dies: the first task is infra_error, the run stops at once; resume with a good key reruns it", async () => {
    const gw = await gateway(() => ({ status: 401, error: "Invalid API key" }));
    const base = {
      harness: true,
      model: MODEL,
      key: "revoked",
      timeoutSec: 60,
      tasks: ["explain-project", "fix-discount"],
    };
    const dir = join(out, "auth");
    const report = await runBench({ ...base, baseUrl: gw.baseUrl, outDir: dir });
    expect(report.stopped).toEqual({ reason: "auth", message: "ключ не принят шлюзом" });
    expect(report.results.map((r) => [r.id, r.outcome, r.ok, r.matched])).toEqual([
      ["explain-project", "infra_error", null, null],
    ]);
    expect(report.results[0]!.note).toBe(
      "ключ не принят шлюзом: HTTP 401: Invalid API key (mock_error)",
    );
    expect(report.totals).toMatchObject({ passed: 0, failed: 0, skipped: 0, unexpected: 0 });
    expect(report.totals.outcomes).toMatchObject({ honest_fail: 0, false_done: 0, infra_error: 1 });
    const md = reportMarkdown(report);
    expect(md).toContain("**Прогон остановлен: ключ не принят шлюзом.**");
    expect(md).toContain("Итого: прошло 0 из 0;");
    expect(md).toContain(
      "Сбой шлюза (infra_error, не в счёт ни решённых, ни провалов; --resume прогонит заново): 1 — explain-project.",
    );

    // Новый ключ: --resume гоняет сбойную задачу заново и доходит до конца.
    gw.set(() => ({ text: "Проект — сайт кофейни: страница и стили." }));
    const ran: string[] = [];
    const resumed = await runBench({
      ...base,
      baseUrl: gw.baseUrl,
      outDir: dir,
      resume: true,
      log: (line) => {
        if (line.startsWith("… ")) ran.push(line.slice(2));
      },
    });
    await gw.stop();
    expect(ran).toEqual(["explain-project", "fix-discount"]);
    expect(resumed.stopped).toBeUndefined();
    expect(resumed.results.every((r) => r.outcome !== "infra_error")).toBe(true);
  }, 120_000);

  it("5xx after the retries: infra_error with the gateway text, the run goes on", async () => {
    const down = await gateway(() => ({ status: 503, error: "upstream overloaded" }));
    const report = await runBench({
      harness: true,
      model: MODEL,
      key: "k",
      baseUrl: down.baseUrl,
      timeoutSec: 60,
      tasks: ["explain-project"],
      outDir: join(out, "down"),
    });
    await down.stop();
    expect(report.stopped).toBeUndefined();
    expect(report.results[0]!.outcome).toBe("infra_error");
    expect(report.results[0]!.note).toMatch(/^сбой шлюза: HTTP 50\d/);
  }, 120_000);
});

describe("the app's request path (#39)", () => {
  it("402 to a big output reserve: the bench steps max_tokens down like the app and the task runs", async () => {
    const gw = await gateway((body) =>
      Number((body as { max_tokens?: number }).max_tokens) > 32_000
        ? { status: 402, error: "Insufficient quota for this request" }
        : { text: "Проект — сайт кофейни: страница index.html и стили style.css." },
    );
    const report = await runBench({
      harness: true,
      model: MODEL,
      key: "k",
      baseUrl: gw.baseUrl,
      timeoutSec: 60,
      tasks: ["explain-project"],
      outDir: join(out, "reserve"),
    });
    await gw.stop();
    const sent = gw.requests.map((r) => (r as { max_tokens?: number }).max_tokens);
    // pi режет 128k до «окно − вход», потом 64k → 402, 32k → 200.
    expect(sent.slice(1, 3)).toEqual([64_000, 32_000]);
    expect(sent[0]).toBeGreaterThan(64_000);
    expect(report.stopped).toBeUndefined();
    expect(report.results[0]!.outcome).not.toBe("infra_error");
  }, 120_000);
});

describe("budget", () => {
  it("--budget-tokens: the run stops when the tokens reach N; the cut task is infra_error", async () => {
    const report = await runBench({
      fake: true,
      harness: true,
      model: MODEL,
      timeoutSec: 60,
      tasks: ["fix-discount", "sales-summary"],
      budgetTokens: 300,
      outDir: join(out, "budget-tokens"),
    });
    expect(report.stopped?.reason).toBe("budget");
    expect(report.stopped?.message).toMatch(/^бюджет исчерпан: 360 токенов из 300$/);
    // fix-discount — два вызова (240), третий — уже в sales-summary: она и оборвана.
    expect(report.results.map((r) => [r.id, r.outcome])).toEqual([
      ["fix-discount", "solved"],
      ["sales-summary", "infra_error"],
    ]);
    expect(report.totals.tokens.calls).toBe(3);
    expect(reportMarkdown(report)).toContain("Итого: прошло 1 из 1;");
  }, 120_000);

  it("--budget-rub: by the price table; refuses to start without the model's price", async () => {
    // 100 токенов входа по 10 000 ₽ за 1M = 1 ₽ за вызов.
    const price = { input: 10_000, output: 0, cacheRead: null, cacheWrite: null };
    const prices = {
      "deepseek-v4.1-flash-1017": price,
      "kimi-k3.1-pro": price,
      "qwen3.8-max": price,
    };
    const report = await runBench({
      fake: true,
      harness: true,
      model: MODEL,
      timeoutSec: 60,
      tasks: ["fix-discount", "sales-summary"],
      budgetRub: 2.5,
      prices,
      outDir: join(out, "budget-rub"),
    });
    expect(report.stopped?.message).toBe("бюджет исчерпан: 3.00 ₽ из 2.5");
    expect(report.totals.rub).toBeCloseTo(3);
    expect(reportMarkdown(report)).toContain("3.00 ₽.");
    await expect(
      runBench({
        fake: true,
        harness: true,
        model: MODEL,
        timeoutSec: 60,
        tasks: ["fix-discount"],
        budgetRub: 1,
        prices: {},
        outDir: join(out, "budget-none"),
      }),
    ).rejects.toThrow(/--budget-rub: нет цены модели deepseek-v4.1-flash-1017/);
  }, 120_000);
});

describe("scripts/bench.mts exit codes", () => {
  const script = join(import.meta.dirname, "..", "scripts", "bench.mts");
  // Не spawnSync: фейковый шлюз живёт в этом же процессе и должен отвечать, пока скрипт идёт.
  const run = async (args: string[], env: Record<string, string> = {}) => {
    try {
      const r = await promisify(execFile)(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", script, ...args],
        { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120_000 },
      );
      return { status: 0, stderr: r.stderr };
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      return { status: err.code ?? -1, stderr: err.stderr ?? "" };
    }
  };

  it("2 and «ключ не принят шлюзом» on a 401; 3 and «бюджет исчерпан» on the budget", async () => {
    const dead = await gateway(() => ({ status: 401, error: "Invalid API key" }));
    const auth = await run(
      [
        "--harness",
        "on",
        "--model",
        MODEL,
        "--base-url",
        dead.baseUrl,
        "--task",
        "explain-project",
        "--out",
        join(out, "cli-auth"),
      ],
      { PRSLOY_GATEWAY_KEY: "revoked" },
    );
    await dead.stop();
    expect(auth.status, auth.stderr).toBe(2);
    expect(auth.stderr).toContain("Ключ не принят шлюзом");
    const budget = await run([
      "--fake",
      "--harness",
      "on",
      "--model",
      MODEL,
      "--task",
      "fix-discount",
      "--budget-tokens",
      "100",
      "--out",
      join(out, "cli-budget"),
    ]);
    expect(budget.status, budget.stderr).toBe(3);
    expect(budget.stderr).toContain("Бюджет исчерпан");
    const reports = readFileSync(join(out, "cli-budget", "results", "fix-discount.json"), "utf8");
    expect(JSON.parse(reports).outcome).toBe("infra_error");
  }, 240_000);
});
