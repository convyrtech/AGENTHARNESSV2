// Стоп-гейт + второе мнение: когда ревью идёт, когда молчит, общий лимит возвратов.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { BudgetHandle } from "../src/budget.ts";
import { resolveOptions } from "../src/options.ts";
import type { Reviewer } from "../src/reviewer.ts";
import { REVIEW_PASS_CARD } from "../src/second-opinion.ts";
import { type CheckRun, installStopGate, MAX_PUSHBACKS } from "../src/stop-gate.ts";
import type { TurnChanges, TurnDiff } from "../src/turn-changes.ts";
import { MockPi } from "./mock-pi.ts";
import { BUGGY_DIFF } from "./review-fixtures.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function dir(withTests: boolean): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "prsloy-review-"));
  dirs.push(d);
  if (withTests)
    await writeFile(join(d, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }));
  return d;
}

const PASS = '{"verdict":"PASS","items":[]}';
const failWith = (evidence: string) =>
  JSON.stringify({
    verdict: "FAIL",
    items: [{ file: "sum.js", line: 2, problem: "sum вычитает вместо сложения", evidence }],
  });

interface Entry {
  type: string;
  customType?: string;
  content?: string;
  display?: boolean;
  data?: Record<string, unknown>;
  details?: Record<string, unknown>;
}

async function setup(o: {
  replies?: string[];
  checks?: Partial<CheckRun>[];
  withTests?: boolean;
  diff?: TurnDiff | undefined;
  ratio?: number;
  enabled?: boolean;
  noPair?: boolean;
}) {
  const cwd = await dir(o.withTests ?? false);
  const pi = new MockPi(cwd);
  const prompts: string[] = [];
  let spent = 0;
  let r = 0;
  const reviewer: Reviewer = async (prompt) => {
    if (o.noPair) return undefined;
    prompts.push(prompt);
    const text = o.replies?.[Math.min(r++, o.replies.length - 1)] ?? PASS;
    return { text, model: "prsloy/kimi-k3.1-pro", costUsd: 0.002 };
  };
  const diff = "diff" in o ? o.diff : { files: ["sum.js"], patch: BUGGY_DIFF };
  const changes = {
    begin() {},
    async ready() {},
    current: async () => diff,
  } as unknown as TurnChanges;
  const budget = {
    ratio: () => o.ratio ?? 0,
    spend: (usd: number) => {
      spent += usd;
    },
  } as unknown as BudgetHandle;
  let c = 0;
  installStopGate(pi.api, resolveOptions({ profile: "code" }), {
    runner: async () => {
      const res = o.checks?.[Math.min(c++, o.checks.length - 1)] ?? {};
      return { code: res.code ?? 0, output: res.output ?? "ok", timedOut: res.timedOut ?? false };
    },
    changes,
    reviewer,
    budget,
    reviewEnabled: () => o.enabled ?? true,
  });
  const settle = async (extra: Record<string, unknown> = {}) => {
    const out = await pi.boundary("agent_before_settle", { outcome: "completed", ...extra });
    return { ...out, entries: out.entries as Entry[] };
  };
  await pi.userPrompt("сделай функцию sum");
  return { pi, prompts, settle, spent: () => spent };
}

const cards = (entries: Entry[]) =>
  entries.filter((e) => e.type === "custom_message" && e.display).map((e) => e.content);

describe("second opinion in the stop gate", () => {
  it("PASS: one short card, no continuation; review cost goes to the turn budget", async () => {
    const t = await setup({});
    const out = await t.settle();
    expect(out.continue).toBe(false);
    expect(cards(out.entries)).toEqual([REVIEW_PASS_CARD]);
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain("сделай функцию sum");
    expect(t.prompts[0]).toContain("своей проверки у проекта нет");
    expect(t.spent()).toBeCloseTo(0.002);
  });

  it("FAIL with real evidence: card «нашла 1 замечание — исправляю» and one push back", async () => {
    const t = await setup({ replies: [failWith("return a - b;")] });
    const out = await t.settle();
    expect(out.continue).toBe(true);
    expect(cards(out.entries)).toEqual(["Вторая модель нашла 1 замечание — исправляю"]);
    const hidden = out.entries.find((e) => e.type === "custom_message" && !e.display);
    expect(hidden?.content).toContain("sum.js:2 — sum вычитает вместо сложения");
    // Второго ревью в том же ходе нет: агент поправил — гейт молчит.
    const after = await t.settle();
    expect(after).toEqual({ entries: [], continue: false });
    expect(t.prompts).toHaveLength(1);
  });

  it("FAIL with a made-up quote counts as PASS", async () => {
    const t = await setup({ replies: [failWith("return a + b + 1;")] });
    const out = await t.settle();
    expect(out.continue).toBe(false);
    expect(cards(out.entries)).toEqual([REVIEW_PASS_CARD]);
    const record = out.entries.find((e) => e.type === "custom");
    expect(record?.data).toMatchObject({ verdict: "PASS", rejected: 1 });
  });

  it("review runs only after the gate is green and sees the check output", async () => {
    const t = await setup({
      withTests: true,
      checks: [
        { code: 1, output: "FAIL sum" },
        { code: 0, output: "1 passed" },
      ],
      replies: [PASS],
    });
    const red = await t.settle();
    expect(red.continue).toBe(true);
    expect(t.prompts).toHaveLength(0);
    const green = await t.settle();
    expect(cards(green.entries)).toEqual([REVIEW_PASS_CARD]);
    expect(t.prompts[0]).toContain("`npm run test`: прошла (код 0)\n1 passed");
  });

  it("shared cap: gate push back + review push back = 2, never a third", async () => {
    const t = await setup({
      withTests: true,
      checks: [{ code: 1, output: "FAIL" }, { code: 0 }, { code: 1, output: "FAIL again" }],
      replies: [failWith("return a - b;")],
    });
    expect((await t.settle()).continue).toBe(true); // гейт: 1
    expect((await t.settle()).continue).toBe(true); // ревью: 2
    const last = await t.settle(); // снова красно — возвратов больше нет
    expect(last.continue).toBe(false);
    expect(cards(last.entries)[0]).toContain(`после ${MAX_PUSHBACKS} попыток`);
  });

  it("gate used both push backs: no review at all", async () => {
    const t = await setup({
      withTests: true,
      checks: [{ code: 1 }, { code: 1 }, { code: 0 }],
      replies: [failWith("return a - b;")],
    });
    await t.settle();
    await t.settle();
    expect(await t.settle()).toEqual({ entries: [], continue: false });
    expect(t.prompts).toHaveLength(0);
  });

  it("skips: tiny diff, flag off, budget nearly spent, user stop, no pair, no snapshot", async () => {
    const tiny = await setup({
      diff: { files: ["a.js"], patch: "--- a/a.js\n+++ b/a.js\n@@\n-x\n+y\n" },
    });
    expect(await tiny.settle()).toEqual({ entries: [], continue: false });
    const off = await setup({ enabled: false });
    expect(await off.settle()).toEqual({ entries: [], continue: false });
    const poor = await setup({ ratio: 0.85 });
    expect(await poor.settle()).toEqual({ entries: [], continue: false });
    const stopped = await setup({});
    expect((await stopped.settle({ outcome: "aborted" })).entries).toEqual([]);
    const nopair = await setup({ noPair: true });
    expect(await nopair.settle()).toEqual({ entries: [], continue: false });
    const nosnap = await setup({ diff: undefined });
    await nosnap.pi.toolResult({ toolName: "edit", input: { path: "a.js" }, text: "ok" });
    expect(await nosnap.settle()).toEqual({ entries: [], continue: false });
    for (const t of [tiny, off, poor, stopped, nopair, nosnap]) expect(t.prompts).toEqual([]);
  });

  it("an unparseable reply shows no card", async () => {
    const t = await setup({ replies: ["Выглядит неплохо"] });
    const out = await t.settle();
    expect(cards(out.entries)).toEqual([]);
    expect(out.continue).toBe(false);
  });

  it("a bash-only change (no edit/write calls) still reaches the gate via the shadow diff", async () => {
    const t = await setup({ withTests: true, checks: [{ code: 1, output: "FAIL" }] });
    // ни одного edit/write — только снимок говорит, что файлы изменились
    const out = await t.settle();
    expect(out.continue).toBe(true);
    expect(String(out.entries[0]?.content)).toContain("Проверка проекта не прошла");
  });
});
