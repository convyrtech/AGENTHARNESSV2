// Слова и факты (H-2: H6–H8, флаг claimCheck): утверждения ответа против вызовов хода, заглушки, третий красный.
import { describe, expect, it } from "vite-plus/test";
import {
  checkClaims,
  claimSignals,
  createClaimState,
  findClaims,
  firstStub,
  installClaimCheck,
  T3_SAME_RED,
  type TurnCall,
} from "../src/claim-check.ts";
import { resolveOptions } from "../src/options.ts";
import { createTurnStatus, turnFacts } from "../src/turn-status.ts";
import { MockPi } from "./mock-pi.ts";

const kinds = (text: string) => findClaims(text).map((c) => c.kind);

describe("claims in the final answer", () => {
  it("past and present claims; negation, future, conditions and advice are not claims", () => {
    expect(kinds("Готово! Все тесты проходят, я проверил в консоли.")).toEqual([
      "done",
      "tests",
      "checked",
    ]);
    expect(kinds("Запустил программу — всё работает.")).toEqual(["ran", "works"]);
    expect(kinds("Страница открывается без ошибок.")).toEqual(["works"]);
    expect(kinds("Починил: тест проходит.")).toEqual(["tests", "done"]);
    expect(kinds("Не проверил: нет Python. Тесты не запускал.")).toEqual([]);
    expect(kinds("Так и не запустил сервер.")).toEqual([]);
    expect(kinds("Проверю позже. Запущу, когда скажете.")).toEqual([]);
    expect(
      kinds("Если запустил и всё работает — напишите. Можно проверить так: npm test."),
    ).toEqual([]);
    expect(kinds("Чтобы проверить, запусти python app.py.")).toEqual([]);
  });
});

function state(calls: TurnCall[], lastEdit: number, final: string, stubs: string[] = []) {
  return { ...createClaimState(), calls, lastEdit, final, stubs };
}
const edit: TurnCall = { tool: "edit", ok: true };
const bash = (command: string, ok = true): TurnCall => ({ tool: "bash", command, ok });
const none = { gate: undefined, page: undefined } as const;

describe("claims against the turn's facts", () => {
  it("«тесты проходят»: green gate or a green test run after the last edit; red gate — wrong", () => {
    const say = "Тесты проходят.";
    expect(checkClaims(state([edit], 0, say), none)).toEqual([
      {
        kind: "tests",
        quote: "Тесты проходят",
        verdict: "unbacked",
        why: "после последней правки тесты не запускались",
      },
    ]);
    expect(checkClaims(state([bash("pytest -q"), edit], 1, say), none)[0]?.verdict).toBe(
      "unbacked",
    );
    expect(checkClaims(state([edit, bash("pytest -q", false)], 0, say), none)[0]?.verdict).toBe(
      "unbacked",
    );
    expect(checkClaims(state([edit, bash("pytest -q")], 0, say), none)).toEqual([]);
    expect(checkClaims(state([edit], 0, say), { gate: "green", page: undefined })).toEqual([]);
    expect(
      checkClaims(state([edit, bash("pytest -q")], 0, say), { gate: "red", page: undefined }),
    ).toEqual([
      { kind: "tests", quote: "Тесты проходят", verdict: "wrong", why: "проверка проекта красная" },
    ]);
  });

  it("«запустил», «работает», «готово»: exit codes, the page check and stubs", () => {
    expect(
      checkClaims(state([edit, bash("python app.py", false)], 0, "Запустил."), none)[0],
    ).toMatchObject({
      kind: "ran",
      verdict: "unbacked",
    });
    expect(
      checkClaims(state([edit, bash("python app.py")], 0, "Запустил — всё работает."), none),
    ).toEqual([]);
    expect(
      checkClaims(state([edit, bash("ls")], 0, "Теперь всё работает."), none)[0],
    ).toMatchObject({
      kind: "works",
      verdict: "unbacked",
    });
    expect(
      checkClaims(state([edit], 0, "Сайт работает."), { gate: undefined, page: true }),
    ).toEqual([]);
    expect(
      checkClaims(state([edit], 0, "Сайт работает."), { gate: undefined, page: false })[0],
    ).toMatchObject({
      verdict: "wrong",
      why: "проверка страницы нашла ошибки",
    });
    expect(checkClaims(state([edit], 0, "Готово."), none)).toEqual([]);
    // Красное названо в ответе (wrong-test/v3): «исправил» про код, не ложь про проверку.
    const red = { gate: "red", page: undefined } as const;
    const honest =
      "Исправил формулу. Один тест ошибочный, я его не менял, поэтому он остаётся красным.";
    expect(checkClaims(state([edit], 0, honest), red)).toEqual([]);
    expect(checkClaims(state([edit], 0, "Исправил формулу."), red)[0]).toMatchObject({
      kind: "done",
      verdict: "wrong",
    });
    expect(checkClaims(state([edit], 0, "Готово.", ["report.py"]), none)).toEqual([
      {
        kind: "done",
        quote: "Готово",
        verdict: "wrong",
        why: "в коде остались заглушки (report.py)",
      },
    ]);
    expect(claimSignals(checkClaims(state([edit], 0, "Проверил."), none))).toEqual([
      "Слова и факты: в ответе «Проверил», но после последней правки не было ни одного успешного запуска (не подтверждено)",
    ]);
  });
});

describe("claimCheck in a turn (MockPi)", () => {
  async function setup(flag = true) {
    const pi = new MockPi();
    const tracker = installClaimCheck(pi.api, resolveOptions({ profile: "code" }), () => flag)!;
    await pi.userPrompt("сделай отчёт");
    return { pi, tracker };
  }

  it("H7: a stub in new edit/write lines gets one T4 line; tests and @abstractmethod do not", async () => {
    const { pi, tracker } = await setup();
    const w = await pi.toolResult({
      toolName: "write",
      input: { path: "report.py", content: "def total(rows):\n    # TODO: implement\n    pass\n" },
      text: "ok",
    });
    expect(w.text).toContain(
      "[В файле report.py заглушка вместо кода: строка 2 «# TODO: implement».",
    );
    const e = await pi.toolResult({
      toolName: "edit",
      input: {
        path: "base.py",
        edits: [
          { oldText: "x", newText: "@abstractmethod\ndef f(self):\n    raise NotImplementedError" },
        ],
      },
      text: "ok",
    });
    expect(e.modified).toBe(false);
    const t = await pi.toolResult({
      toolName: "write",
      input: { path: "tests/test_report.py", content: "# TODO: implement more cases\n" },
      text: "ok",
    });
    expect(t.modified).toBe(false);
    expect(tracker.state.stubs).toEqual(["report.py"]);
    expect(firstStub(["ok", "// ... rest of the code"])).toEqual({
      line: 2,
      text: "// ... rest of the code",
    });
  });

  it("H6: the same test command red the 3rd time gets T3 once; a different command counts apart", async () => {
    const { pi } = await setup();
    const red = (command: string) =>
      pi.toolResult({ toolName: "bash", input: { command }, text: "FAILED", isError: true });
    expect((await red("pytest -q")).modified).toBe(false);
    expect((await red("cd app && pytest  -q")).modified).toBe(false);
    expect((await red("npm test")).modified).toBe(false);
    expect((await red("pytest -q")).text).toContain(T3_SAME_RED);
    expect((await red("pytest -q")).modified).toBe(false);
  });

  it("H8: the final answer is read from message_end; findings go to the turn status with quotes", async () => {
    const { pi, tracker } = await setup();
    await pi.toolResult({ toolName: "edit", input: { path: "a.py", edits: [] }, text: "ok" });
    await pi.assistantMessage({ content: [{ type: "text", text: "Готово, тесты проходят." }] });
    const found = tracker.findings({ gate: undefined, page: undefined });
    expect(found.map((f) => f.kind)).toEqual(["tests"]);
    const status = { ...createTurnStatus(), edited: true, hasCheck: true };
    expect(turnFacts(status, "", 1, found)).toEqual({
      facts: ["claim-unbacked"],
      files: [],
      claims: [{ quote: "тесты проходят", why: "после последней правки тесты не запускались" }],
    });
  });

  it("flag off for the turn: no lines, no findings", async () => {
    const { pi, tracker } = await setup(false);
    const w = await pi.toolResult({
      toolName: "write",
      input: { path: "r.py", content: "raise NotImplementedError" },
      text: "ok",
    });
    expect(w.modified).toBe(false);
    await pi.assistantMessage({ content: [{ type: "text", text: "Тесты проходят." }] });
    expect(tracker.findings({ gate: undefined, page: undefined })).toEqual([]);
  });
});
