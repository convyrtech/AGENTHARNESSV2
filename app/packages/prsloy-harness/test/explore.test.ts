// Разведчик (#47): ребёнок только читает, глубину не превышает, ответ обрезан, стоимость считается.
// Всё на подменённом вызове модели: настоящая сеть в этих тестах не нужна.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  callPath,
  cheapestModel,
  clipAnswer,
  exploreResultText,
  safeSlice,
  EXPLORE_ANSWER_LIMIT,
  EXPLORE_MARKER,
  EXPLORE_TURNS,
  exploreTools,
  runExplore,
  type ExploreComplete,
  type ExploreModel,
  type ExploreReply,
} from "../src/explore.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const MODEL = {
  id: "deepseek-v4.1-flash-1017",
  name: "deepseek",
  provider: "prsloy",
  api: "openai-completions",
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
} as unknown as ExploreModel;

const usage = () => ({
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function reply(
  content: ExploreReply["content"],
  stopReason: ExploreReply["stopReason"] = "toolUse",
): ExploreReply {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "prsloy",
    model: MODEL.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  } as ExploreReply;
}

const say = (text: string) => reply([{ type: "text", text }], "stop");
/** Аргументы вызова инструмента — в том виде, в каком их отдаёт модель (JSON). */
type CallArguments = Extract<ExploreReply["content"][number], { type: "toolCall" }>["arguments"];

const call = (name: string, args: CallArguments) =>
  reply([{ type: "toolCall", id: `call-${name}`, name, arguments: args }]);

/** Сценарий модели: по очереди отдаёт заготовленные ответы и запоминает контексты. */
function scripted(...replies: ExploreReply[]) {
  const seen: { systemPrompt?: string; tools?: { name: string }[]; messages: unknown[] }[] = [];
  const complete: ExploreComplete = (_model, context, _options) => {
    seen.push(context as unknown as (typeof seen)[number]);
    const next = replies.shift();
    if (!next) throw new Error("сценарий кончился");
    return Promise.resolve(next);
  };
  return { complete, seen };
}

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prsloy-explore-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

describe("разведчик: только чтение", () => {
  it("в наборе ровно read, grep, find, ls — ни bash, ни write, ни edit, ни он сам", async () => {
    const dir = await project({ "a.ts": "const a = 1;\n" });
    expect(exploreTools(dir).map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
  });

  it("модель ребёнка не получает write/bash, а на последнем ходе — вообще никаких инструментов", async () => {
    const dir = await project({ "a.ts": "const a = 1;\n" });
    const s = scripted(call("read", { path: "a.ts" }), say("Нашёл."));
    const answer = await runExplore({
      question: "где a?",
      depth: "medium",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
    });
    expect(answer.answer).toBe("Нашёл.");
    expect(s.seen[0]?.systemPrompt?.startsWith(EXPLORE_MARKER)).toBe(true);
    expect(s.seen[0]?.tools?.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
  });

  it("read действительно читает файл проекта, и результат доходит до модели", async () => {
    const dir = await project({ "a.ts": "export const retryBudget = 3;\n" });
    const s = scripted(call("read", { path: "a.ts" }), say("retryBudget в a.ts."));
    const answer = await runExplore({
      question: "где бюджет повторов?",
      depth: "medium",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
    });
    expect(answer.stoppedBy).toBe("answer");
    expect(answer.toolCalls).toBe(1);
    expect(answer.files).toEqual(["a.ts"]);
    // Второй вызов модели видит результат инструмента.
    expect(JSON.stringify(s.seen[1]?.messages)).toContain("retryBudget = 3");
  });

  it("просьбу записать или запустить ребёнок не выполняет: инструмента нет, ход продолжается", async () => {
    const dir = await project({ "a.ts": "const a = 1;\n" });
    const s = scripted(call("bash", { command: "rm -rf a.ts" }), say("Записать не могу."));
    const answer = await runExplore({
      question: "удали a.ts",
      depth: "quick",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
    });
    expect(answer.answer).toBe("Записать не могу.");
    expect(JSON.stringify(s.seen[1]?.messages)).toContain("можно только read, grep, find, ls");
    // Файл на месте.
    expect(exploreTools(dir).length).toBe(4);
  });
});

describe("разведчик: пределы", () => {
  it("глубина quick — 5 ответов модели, и последний уже без инструментов", async () => {
    const dir = await project({ "a.ts": "const a = 1;\n" });
    const s = scripted(
      ...Array.from({ length: EXPLORE_TURNS.quick }, () => call("grep", { pattern: "a" })),
    );
    const answer = await runExplore({
      question: "ищи",
      depth: "quick",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
    });
    expect(answer.turns).toBe(EXPLORE_TURNS.quick);
    expect(s.seen).toHaveLength(EXPLORE_TURNS.quick);
    expect(s.seen.at(-1)?.tools).toBeUndefined();
    expect(answer.stoppedBy).toBe("depth");
  });

  it("длинный ответ обрезан по лимиту и помечен", () => {
    const long = "я".repeat(EXPLORE_ANSWER_LIMIT * 2);
    const clip = clipAnswer(long);
    expect(clip.clipped).toBe(true);
    expect(clip.text.length).toBeLessThanOrEqual(EXPLORE_ANSWER_LIMIT);
    expect(clip.text).toContain("обрезано");
    expect(clipAnswer("короткий").clipped).toBe(false);
  });

  it("длинный результат инструмента не раздувает контекст ребёнка", async () => {
    const dir = await project({ "big.txt": `${"x".repeat(30_000)}\n` });
    const s = scripted(call("read", { path: "big.txt" }), say("Прочитал."));
    await runExplore({
      question: "что в big.txt?",
      depth: "quick",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
    });
    const sent = JSON.stringify(s.seen[1]?.messages);
    expect(sent.length).toBeLessThan(30_000);
    expect(sent).toContain("результат длиннее лимита");
  });

  it("ошибка инструмента — не падение: ребёнок видит ошибку и отвечает", async () => {
    const dir = await project({ "a.ts": "const a = 1;\n" });
    const s = scripted(call("read", { path: "нет-такого.ts" }), say("Файла нет."));
    const answer = await runExplore({
      question: "что в нет-такого.ts?",
      depth: "quick",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
    });
    expect(answer.answer).toBe("Файла нет.");
    expect(JSON.stringify(s.seen[1]?.messages)).toMatch(/нет-такого/);
  });

  it("отмена родителя останавливает разведчика", async () => {
    const dir = await project({ "a.ts": "const a = 1;\n" });
    const controller = new AbortController();
    controller.abort();
    const s = scripted(say("не должно вызваться"));
    const answer = await runExplore({
      question: "что-нибудь",
      depth: "quick",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
      signal: controller.signal,
    });
    expect(answer.stoppedBy).toBe("aborted");
    expect(s.seen).toHaveLength(0);
  });

  it("каждый ответ модели отдаётся в статистику — стоимость ребёнка видна", async () => {
    const dir = await project({ "a.ts": "const a = 1;\n" });
    const s = scripted(call("read", { path: "a.ts" }), say("Готово."));
    const seen: number[] = [];
    await runExplore({
      question: "где a?",
      depth: "quick",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
      onUsage: (r) => seen.push(r.usage.input),
    });
    expect(seen).toEqual([100, 100]);
  });

  it("ошибка модели возвращается ответом, а не исключением", async () => {
    const dir = await project({ "a.ts": "const a = 1;\n" });
    const broken = reply([{ type: "text", text: "" }], "error");
    broken.errorMessage = "шлюз ответил 500";
    const s = scripted(broken);
    const answer = await runExplore({
      question: "где a?",
      depth: "quick",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
    });
    expect(answer.stoppedBy).toBe("error");
    expect(answer.error).toContain("500");
  });
});

describe("ревью другой моделью (#47): найденные дыры закрыты", () => {
  it("pattern у grep/find не считается файлом, только path/file", () => {
    expect(callPath("grep", { pattern: "TODO|FIXME" })).toBeUndefined();
    expect(callPath("find", { pattern: "**/*.ts" })).toBeUndefined();
    expect(callPath("find", { pattern: "balance.json" })).toBe("balance.json");
    expect(callPath("read", { path: "src/a.ts" })).toBe("src/a.ts");
  });

  it("обрезка не рвёт символ пополам", () => {
    // Три единицы — это половина эмодзи: без защиты на конце осталась бы битая пара.
    expect(safeSlice("😀😀", 3)).toBe("😀");
    expect(safeSlice("😀😀", 4)).toBe("😀😀");
    const clip = clipAnswer("😀".repeat(EXPLORE_ANSWER_LIMIT));
    expect(clip.clipped).toBe(true);
    const last = clip.text.charCodeAt(clip.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("предел времени — честное «не успел», модель не зовём", async () => {
    const dir = await project({ "a.ts": "const a = 1;\n" });
    const s = scripted(say("Нашёл."));
    const answer = await runExplore({
      question: "где a?",
      depth: "thorough",
      cwd: dir,
      tools: exploreTools(dir),
      model: MODEL,
      complete: s.complete,
      deadlineMs: -1,
    });
    expect(answer.stoppedBy).toBe("timeout");
    expect(s.seen).toHaveLength(0);
    expect(exploreResultText(answer, MODEL, 3)).toContain("не успел");
  });

  it("модель без цены не выбирается как «самая дешёвая»", () => {
    type Priced = { id: string; cost?: { input?: number; output?: number } };
    const known: Priced = { id: "a", cost: { input: 1, output: 1 } };
    const unknown: Priced = { id: "b" };
    const pricey: Priced = { id: "c", cost: { input: 9, output: 9 } };
    expect(cheapestModel([unknown, pricey, known])?.id).toBe("a");
    expect(cheapestModel([unknown])).toBeUndefined();
  });
});

describe("выбор модели ребёнка", () => {
  it("cheap — самая дешёвая по входу и выходу", () => {
    expect(
      cheapestModel([
        { id: "a", cost: { input: 5, output: 10 } },
        { id: "b", cost: { input: 1, output: 2 } },
        { id: "c", cost: { input: 2, output: 2 } },
      ])?.id,
    ).toBe("b");
  });
});
