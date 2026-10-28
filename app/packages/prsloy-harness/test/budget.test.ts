import { describe, expect, it } from "vite-plus/test";
import { installBudget, messageCostRub } from "../src/budget.ts";
import { resolveOptions } from "../src/options.ts";
import { MockPi } from "./mock-pi.ts";

function setup(
  options: Parameters<typeof resolveOptions>[0] = {},
  model?: { cost?: Record<string, number> },
) {
  const pi = new MockPi(process.cwd(), model);
  const budget = installBudget(pi.api, resolveOptions(options));
  budget.installWarning();
  return { pi, budget };
}

describe("budget", () => {
  it("defaults to 300 tool calls per task and still honors an explicit lower limit", async () => {
    expect(resolveOptions().maxToolCalls).toBe(300);
    expect(resolveOptions({ maxToolCalls: 10 }).maxToolCalls).toBe(10);
  });

  it("warns once at 80% of tool calls", async () => {
    const { pi } = setup({ maxToolCalls: 10 });
    await pi.userPrompt();
    const texts: string[] = [];
    for (let i = 0; i < 9; i++)
      texts.push((await pi.call("read", { path: `f${i}` }, "ok")).result?.text ?? "");
    expect(texts.slice(0, 7).every((t) => t === "ok")).toBe(true);
    expect(texts[7]).toContain("[Задача израсходовала 80% лимита (шагов 8 из 10)");
    expect(texts[8]).toBe("ok");
  });

  it("stops cleanly at 100%: first block asks for a Russian summary, then terminates", async () => {
    const { pi, budget } = setup({ maxToolCalls: 3 });
    await pi.userPrompt();
    await pi.call("edit", { path: "src/app.ts", edits: [] }, "ok");
    await pi.call("bash", { command: "npm test" }, "ok");
    await pi.call("read", { path: "README.md" }, "ok");

    const first = await pi.toolCall("bash", { command: "npm run build" });
    expect(first?.block).toBe(true);
    expect(first?.terminate).toBe(false);
    expect(first?.reason).toContain("Напиши пользователю по-русски");
    const second = await pi.toolCall("bash", { command: "npm run build" });
    expect(second?.terminate).toBe(true);
    expect(budget.state().exhausted).toBe("calls");

    const settle = await pi.boundary("agent_before_settle");
    // Итог — карточкой (sendMessage), не записью границы: её приложение не показывает.
    expect(settle.entries).toEqual([]);
    const message = pi.sent[0] as { content: string; display: boolean; details: unknown };
    expect(message.display).toBe(true);
    expect(message.details).toMatchObject({ exhausted: "calls", toolCalls: 3 });
    expect(message.content).toBe(
      "Я остановился: на одну задачу у меня 3 шага, и они закончились. Успел изменить src/app.ts. Чтобы доделать, напишите «продолжай».",
    );
    // Человеку — ни «тулов», ни долларов; цифры — в details.
    expect(message.content).not.toMatch(/тул|вызов|\$/);
    expect(message.details).toMatchObject({ commands: 1 });
    // Итог пишется один раз.
    await pi.boundary("agent_before_settle");
    expect(pi.sent).toHaveLength(1);
  });

  it("counts money from usage.cost and stops at the limit", async () => {
    const { pi, budget } = setup({ maxCostRub: 0.05 });
    await pi.userPrompt();
    await pi.assistantMessage({ usage: { input: 1000, output: 100, cost: { total: 0.03 } } });
    expect(await pi.toolCall("read", { path: "a" })).toBeUndefined();
    await pi.assistantMessage({ usage: { input: 1000, output: 100, cost: { total: 0.03 } } });
    expect(budget.state().exhausted).toBe("money");
    const blocked = await pi.toolCall("read", { path: "b" });
    expect(blocked?.block).toBe(true);
    await pi.boundary("agent_before_settle");
    expect(JSON.stringify(pi.sent)).toContain("на эту задачу ушла вся отведённая на неё сумма");
  });

  it("falls back to the model cost table when the gateway reports no cost", async () => {
    const { pi, budget } = setup(
      {},
      { cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0 } },
    );
    await pi.assistantMessage({
      usage: { input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    });
    expect(budget.state().costRub).toBeCloseTo(0.28, 6);
  });

  it("resets per user task", async () => {
    const { pi, budget } = setup({ maxToolCalls: 1 });
    await pi.userPrompt();
    await pi.call("read", { path: "a" }, "ok");
    expect((await pi.toolCall("read", { path: "b" }))?.block).toBe(true);
    await pi.userPrompt("следующая задача");
    expect(budget.state().toolCalls).toBe(0);
    expect(await pi.toolCall("read", { path: "b" })).toBeUndefined();
  });

  it("aborts if the model keeps calling tools after the stop", async () => {
    const { pi } = setup({ maxToolCalls: 0 });
    for (let i = 0; i < 4; i++) await pi.toolCall("read", { path: "x" });
    expect(pi.aborted).toBe(1);
  });
});

describe("messageCostRub", () => {
  it("prefers the reported total", () => {
    expect(messageCostRub({ input: 10, cost: { total: 0.5 } }, { input: 100 })).toBe(0.5);
  });
  it("is zero without usage", () => {
    expect(messageCostRub(undefined, { input: 1 })).toBe(0);
  });
});
