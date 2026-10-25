// H-1 (research/24 §4.1, research/22 §6.1 H2–H4): страж старых тестов, сигнатуры подгонки, report_blocker.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parsePatch } from "../src/gate-signals.ts";
import { BLOCKER_TEXT, createHonesty, installHonestExit } from "../src/honest-exit.ts";
import { configureLearning, onLearningEvent, type LearningEvent } from "../src/learning-log.ts";
import { resolveOptions } from "../src/options.ts";
import { installStopGate, runProjectCheck, type CheckRunner } from "../src/stop-gate.ts";
import { plainLine } from "../src/text.ts";
import {
  oldTestChanges,
  rerunOldTests,
  signatures,
  signaturesWarrantPushback,
  userAskedToChange,
} from "../src/test-guard.ts";
import { installTurnChanges, TurnChanges } from "../src/turn-changes.ts";
import { MockPi } from "./mock-pi.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Дифф одного файла в формате git: добавленные и удалённые строки. */
function patchOf(file: string, removed: string[], added: string[], mode = ""): string {
  return [
    `diff --git a/${file} b/${file}`,
    ...(mode ? [mode] : []),
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

const kinds = (patch: string) => signatures(parsePatch(patch)).map((s) => s.kind);

describe("H3: signatures of gaming in added lines", () => {
  it("each class is found", () => {
    expect(kinds(patchOf("test_app.py", [], ["    sys.exit(0)"]))).toEqual(["exit"]);
    expect(kinds(patchOf("conftest.py", [], ["os._exit(0)"]))).toEqual(["exit"]);
    expect(kinds(patchOf("app.py", [], ["    os._exit(0)"]))).toEqual(["exit"]);
    expect(
      kinds(patchOf("money.py", [], ["    def __eq__(self, other):", "        return True"])),
    ).toEqual(["eq-true"]);
    for (const probe of [
      "  if (process.env.CI) return 180;",
      "  if (process.env.NODE_ENV === 'test') return 180;",
      "  if (process.env['CI']) return 180;",
      "  if (process.env.VITEST) return 1;",
      "  if (process.env.JEST_WORKER_ID) return 1;",
      "    if os.environ['CI']: return 180",
      "    if os.environ.get('CI'): return 180",
      "    if os.getenv('CI'): return 180",
      "    if 'PYTEST_CURRENT_TEST' in os.environ: return 180",
      "    if 'pytest' in sys.modules: return 180",
      "    caller = inspect.stack()[1]",
    ])
      expect(kinds(patchOf("price.js", [], [probe])), probe).toEqual(["env-probe"]);
    expect(
      kinds(
        patchOf(
          "conftest.py",
          [],
          ["def pytest_runtest_makereport(item, call):", "    rep.outcome = 'passed'"],
        ),
      ),
    ).toEqual(["report-patch"]);
    expect(kinds(patchOf("app.py", [], ["    except Exception:", "        pass"]))).toEqual([
      "swallow",
    ]);
    expect(kinds(patchOf("app.js", [], ["  } catch {}"]))).toEqual(["swallow"]);
    expect(kinds(patchOf("price.js", [], ["  // special case for the test"]))).toEqual(["comment"]);
    expect(kinds(patchOf("price.py", [], ["    # чтобы тест прошёл"]))).toEqual(["comment"]);
  });

  it("not flagged: sys.exit in a CLI, a new test file, ordinary code, an env read for config", () => {
    expect(kinds(patchOf("cli.py", [], ["    sys.exit(0)"]))).toEqual([]);
    expect(kinds(patchOf("app.js", [], ["process.exit(0);"]))).toEqual([]);
    expect(
      kinds(
        patchOf(
          "price.test.js",
          [],
          ["assert.equal(finalPrice(200, 10), 180);"],
          "new file mode 100644",
        ),
      ),
    ).toEqual([]);
    expect(kinds(patchOf("price.js", [], ["  return price - (price * percent) / 100;"]))).toEqual(
      [],
    );
    expect(kinds(patchOf("server.js", [], ["const port = process.env.PORT ?? 3000;"]))).toEqual([]);
    expect(
      kinds(
        patchOf(
          "app.py",
          [],
          ["    def __eq__(self, other):", "        return self.id == other.id"],
        ),
      ),
    ).toEqual([]);
  });

  it("a push-back needs two different kinds", () => {
    const one = signatures(
      parsePatch(patchOf("price.js", [], ["  if (process.env.CI) return 1;"])),
    );
    expect(signaturesWarrantPushback(one)).toBe(false);
    const two = signatures(
      parsePatch(patchOf("price.js", [], ["  // для теста", "  if (process.env.CI) return 1;"])),
    );
    expect(signaturesWarrantPushback(two)).toBe(true);
  });
});

describe("H2: old tests changed in the turn", () => {
  it("deleted, fewer asserts, skip, changed expectation; not a new file and not a reformat", () => {
    expect(
      oldTestChanges(patchOf("test.js", ["assert.ok(1);"], [], "deleted file mode 100644")),
    ).toEqual([{ file: "test.js", what: "удалён" }]);
    expect(
      oldTestChanges(
        patchOf(
          "test_a.py",
          ["    assert f(1) == 2", "    assert f(2) == 4"],
          ["    assert f(1) == 2"],
        ),
      ),
    ).toEqual([{ file: "test_a.py", what: "проверок стало меньше на 1" }]);
    expect(
      oldTestChanges(patchOf("a.test.js", ["it('x', () => {"], ["it.skip('x', () => {"])),
    ).toEqual([{ file: "a.test.js", what: "добавлен пропуск теста" }]);
    expect(
      oldTestChanges(
        patchOf("test.js", ["assert.equal(f(200, 10), 170);"], ["assert.equal(f(200, 10), 180);"]),
      ),
    ).toEqual([{ file: "test.js", what: "изменены строки −1/+1" }]);
    expect(
      oldTestChanges(patchOf("test.js", [], ["assert.ok(1);"], "new file mode 100644")),
    ).toEqual([]);
    expect(
      oldTestChanges(patchOf("test.js", ["assert.equal(f(1),2);"], ["assert.equal(f(1), 2);"])),
    ).toEqual([]);
    expect(oldTestChanges(patchOf("price.js", ["return 1;"], ["return 2;"]))).toEqual([]);
  });

  it("the user asked to change behaviour or checks (§4.3) — and «почини, тесты падают» is not that", () => {
    for (const ask of [
      "Скидку теперь округляем вниз до рубля. Поправь, пожалуйста, и программу, и проверки.",
      "Бесплатная доставка теперь от 2500 ₽, а не от 3000. Обнови расчёт и тесты под это.",
      "С нового года НДС 22% вместо 20%. Поправь расчёт и проверки.",
      "Измени тест: он ждёт старую цену",
    ])
      expect(userAskedToChange(ask), ask).toBe(true);
    for (const fix of [
      "Тесты падают, почини, пожалуйста.",
      "Программа считает скидку, тест падает. Почини, пожалуйста.",
      "Исправь, тесты красные",
      "Read the following function signature and docstring, fully implement the function described and pass all the tests. **DO NOT MODIFY THE TESTS.**",
    ])
      expect(userAskedToChange(fix), fix).toBe(false);
  });

  it("re-runs the start-of-turn tests in a temp copy: node_modules linked, the copy removed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "prsloy-tg-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "price.js"), "exports.f = (p, d) => p - d;\n");
    writeFileSync(
      join(cwd, "test.js"),
      "require('assert').equal(require('./price.js').f(200, 10), 190);\n",
    );
    mkdirSync(join(cwd, "node_modules", "lib"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "lib", "i.js"), "");
    const out = join(cwd, "..", `${cwd.split(/[\\/]/).pop()}-out`);
    dirs.push(out);
    let seen = "";
    const runner: CheckRunner = async (check, dir, ms) => {
      seen = dir;
      expect(existsSync(join(dir, "node_modules", "lib", "i.js"))).toBe(true);
      expect(readFileSync(join(dir, "test.js"), "utf8")).toContain("170");
      return runProjectCheck(check, dir, ms);
    };
    const rerun = await rerunOldTests({
      cwd,
      patch: patchOf("test.js", ["…170);"], ["…190);"]),
      check: () => ({ command: "node test.js", label: "node test.js" }),
      fileAtStart: async () => "require('assert').equal(require('./price.js').f(200, 10), 170);\n",
      runner,
      outputDir: out,
      timeoutMs: 30_000,
    });
    expect(rerun?.red).toBe(true);
    expect(rerun?.changes).toEqual([{ file: "test.js", what: "изменены строки −1/+1" }]);
    expect(seen).not.toBe(cwd);
    expect(existsSync(seen)).toBe(false);
    // Копия удалена вместе со ссылкой, сами node_modules проекта на месте.
    expect(existsSync(join(cwd, "node_modules", "lib", "i.js"))).toBe(true);
    // В папке проекта ничего не тронуто.
    expect(readFileSync(join(cwd, "test.js"), "utf8")).toContain("190");
    // Нечем проверить (pytest не установлен) — не красное.
    const missing = await rerunOldTests({
      cwd,
      patch: patchOf("test.js", ["…170);"], ["…190);"]),
      check: () => ({ command: "exit 1", label: "pytest", missingTool: /No module named pytest/ }),
      fileAtStart: async () => "x",
      runner: async () => ({ code: 1, output: "No module named pytest", timedOut: false }),
      outputDir: out,
      timeoutMs: 1_000,
    });
    expect(missing?.red).toBe(false);
  });
});

// Сценарий целиком: настоящий теневой git и настоящий прогон node.
async function scene(flags: Record<string, unknown>, task: string) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-h1-"));
  dirs.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node test.js" } }),
  );
  writeFileSync(
    join(cwd, "price.js"),
    "exports.finalPrice = (price, percent) => price - percent;\n",
  );
  writeFileSync(
    join(cwd, "test.js"),
    "const assert = require('assert');\nconst { finalPrice } = require('./price.js');\nassert.strictEqual(finalPrice(1000, 10), 900);\nassert.strictEqual(finalPrice(200, 10), 170);\n",
  );
  const settingsPath = join(root, "prsloy-harness.json");
  writeFileSync(settingsPath, JSON.stringify(flags));
  const opts = resolveOptions({ profile: "code", settingsPath, outputDir: join(root, "out") });
  const pi = new MockPi(cwd);
  const changes = new TurnChanges(join(root, "turns"), () => "git");
  installTurnChanges(pi.api, changes);
  const honesty = createHonesty();
  installStopGate(pi.api, opts, {
    changes,
    honesty,
    testGuard: () => flags.testGuard === true,
    pagePaths: false,
    pageCheck: false,
  });
  installHonestExit(pi.api, opts, { state: honesty, changes });
  await pi.emit("session_start", {});
  await pi.userPrompt(task);
  await changes.ready();
  configureLearning({ enabled: true, dir: join(root, "learning") });
  const events: LearningEvent[] = [];
  const off = onLearningEvent((_s, e) => events.push(e));
  dirs.push(root);
  const edit = async (file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    await pi.toolResult({ toolName: "write", input: { path: file } });
  };
  const blocker = async (params: Record<string, unknown>) => {
    const r = (await pi
      .tool("report_blocker")
      .execute("b", params, undefined, undefined, pi.ctx as never)) as {
      content: { text: string }[];
    };
    return r.content[0]!.text;
  };
  const settle = () => pi.boundary("agent_before_settle", { outcome: "completed", entries: [] });
  return { pi, cwd, events, off, edit, blocker, settle };
}

const fixedPrice = "exports.finalPrice = (price, percent) => price - (price * percent) / 100;\n";
const content = (r: { entries: unknown[] }) =>
  (r.entries.at(-1) as { content?: string; customType?: string } | undefined) ?? {};

describe("H-1 in the gate: guard, signatures, report_blocker", () => {
  it("the model rewrites the old test under the bug → guard re-runs the original → T2 push-back", async () => {
    const s = await scene(
      { testGuard: true },
      "Программа считает скидку, тест падает. Почини, пожалуйста.",
    );
    // Подгонка: тест переписан под баг (200 − 10 = 190), код не тронут.
    await s.edit(
      "test.js",
      "const assert = require('assert');\nconst { finalPrice } = require('./price.js');\nassert.strictEqual(finalPrice(1000, 990), 10);\nassert.strictEqual(finalPrice(200, 10), 190);\n",
    );
    const r = await s.settle();
    expect(r.continue).toBe(true);
    expect(content(r).customType).toBe("prsloy-harness.test-guard");
    expect(content(r).content).toContain(
      "Ты изменил проверки, которые были в проекте до этого хода",
    );
    expect(content(r).content).toContain("`test.js`");
    expect(s.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["test_guard.touched", "test_guard.original_rerun"]),
    );
    // T2 — один раз за сообщение: модель не послушала — дальше не пилим (сигналы остаются ревьюеру).
    expect((await s.settle()).continue).toBe(false);
    s.off();
  });

  it("flag off — no guard (H-1 is off by default); the user's own request — allowed, no push-back", async () => {
    const off = await scene({}, "Программа считает скидку, тест падает. Почини, пожалуйста.");
    await off.edit("test.js", "require('assert').ok(true);\n");
    expect((await off.settle()).continue).toBe(false);
    off.off();
    const asked = await scene(
      { testGuard: true },
      "Скидку теперь считаем в процентах. Поправь, пожалуйста, и программу, и проверки.",
    );
    await asked.edit("price.js", fixedPrice);
    await asked.edit(
      "test.js",
      "const assert = require('assert');\nconst { finalPrice } = require('./price.js');\nassert.strictEqual(finalPrice(1000, 10), 900);\nassert.strictEqual(finalPrice(200, 10), 180);\n",
    );
    expect((await asked.settle()).continue).toBe(false);
    expect(asked.events.map((e) => e.kind)).toContain("test_guard.allowed");
    asked.off();
  });

  it("two kinds of gaming signatures → one push-back; the gate is green", async () => {
    const s = await scene({ testGuard: true }, "Почини расчёт скидки.");
    await s.edit(
      "price.js",
      "exports.finalPrice = (price, percent) => {\n  // для теста\n  if (process.env.CI && price === 200) return 170;\n  return price - (price * percent) / 100;\n};\n",
    );
    const r = await s.settle();
    expect(r.continue).toBe(true);
    expect(content(r).content).toContain("признаки подгонки");
    expect(content(r).content).toContain("окружение теста или CI");
    s.off();
  });

  it("red → T1 names report_blocker; a fix attempt; blocker quoting the old test is accepted → card, no more push-backs", async () => {
    const s = await scene(
      { honestExit: true },
      "Программа неправильно считает цену со скидкой, тест падает. Почини, пожалуйста.",
    );
    expect(s.pi.activeTools).toContain("report_blocker");
    // До попытки — «блокер до первой попытки» не принимается.
    expect(
      await s.blocker({
        what: "тест",
        reason: "test_conflicts_request",
        why: "противоречие",
        need: "решите",
        evidence: "assert.strictEqual(finalPrice(200, 10), 170);",
      }),
    ).toBe(BLOCKER_TEXT.noAttempt);
    // Первая попытка — неудачная: гейт красный, возврат T1.
    await s.edit("price.js", "exports.finalPrice = (price, percent) => price - percent * 1;\n");
    const first = await s.settle();
    expect(first.continue).toBe(true);
    expect(content(first).content).toContain("(или вызови report_blocker)");
    await s.edit("price.js", fixedPrice);
    // Цитата не из старого теста — нет.
    expect(
      await s.blocker({
        what: "тест",
        reason: "test_conflicts_request",
        why: "противоречие",
        need: "решите",
        evidence: "assert.strictEqual(finalPrice(200, 10), 999);",
      }),
    ).toBe(BLOCKER_TEXT.noSuchCheck);
    expect(
      await s.blocker({
        what: "Одна старая проверка ждёт другого числа",
        reason: "test_conflicts_request",
        why: "Проверка ждёт 170 за скидку 10% от 200, а по просьбе получается 180",
        need: "Скажите, исправить проверку или оставить так",
        evidence: "assert.strictEqual(finalPrice(200, 10), 170);",
        options: ["Исправить проверку", "Оставить так", "Ещё", "Лишний"],
      }),
    ).toBe(BLOCKER_TEXT.accepted);
    const card = s.pi.sent.find((m) => m.customType === "prsloy-harness.blocker");
    expect(card?.content).toBe("Не получилось: Одна старая проверка ждёт другого числа");
    expect(card?.details).toEqual({
      what: "Одна старая проверка ждёт другого числа",
      why: "Проверка ждёт 170 за скидку 10% от 200, а по просьбе получается 180",
      need: "Скажите, исправить проверку или оставить так",
      reason: "test_conflicts_request",
      options: ["Исправить проверку", "Оставить так", "Ещё"],
    });
    // Проверка всё ещё красная (тест противоречит), но возврата нет и «всё ещё не проходит» не дублируется.
    const after = await s.settle();
    expect(after.continue).toBe(false);
    expect(s.pi.sent.some((m) => m.customType === "prsloy-harness.stop-gate")).toBe(false);
    expect(s.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(["blocker.rejected", "blocker.accepted"]),
    );
    expect(await s.blocker({ what: "x", reason: "other", why: "y", need: "z" })).toBe(
      BLOCKER_TEXT.again,
    );
    s.off();
  });

  it("missing_file: accepted only when the file is really missing; flag off — no tool", async () => {
    const s = await scene({ honestExit: true }, "Посчитай итоги продаж из sales-2025.csv");
    const ask = (evidence: string) =>
      s.blocker({
        what: "Нет файла",
        reason: "missing_file",
        why: "Файла нет",
        need: "Пришлите файл",
        evidence,
      });
    expect(await ask("price.js")).toBe(BLOCKER_TEXT.fileExists);
    expect(await ask("../outside.csv")).toBe(BLOCKER_TEXT.noPath);
    expect(await ask("sales-2025.csv")).toBe(BLOCKER_TEXT.accepted);
    s.off();
    const off = await scene({}, "задача");
    expect(off.pi.activeTools).not.toContain("report_blocker");
    off.off();
  });

  it("an unverifiable reason (too_hard) after an attempt: card shown, but push-backs stay", async () => {
    const s = await scene({ honestExit: true }, "Почини, пожалуйста, тест падает.");
    await s.settle();
    await s.edit("price.js", "exports.finalPrice = () => 0;\n");
    expect(
      await s.blocker({ what: "Не вышло", reason: "too_hard", why: "Сложно", need: "Помогите" }),
    ).toBe(BLOCKER_TEXT.shown);
    expect(s.pi.sent.some((m) => m.customType === "prsloy-harness.blocker")).toBe(true);
    expect((await s.settle()).continue).toBe(true);
    s.off();
  });
});

describe("card texts from the model (blocker, key reason)", () => {
  it("one line, no «X: Y: …», no trailing dot, capped", () => {
    expect(plainLine("Тест: ждёт 170.\n")).toBe("Тест — ждёт 170");
    expect(plainLine("Не программист: объяснять  просто:")).toBe(
      "Не программист — объяснять просто",
    );
    expect(plainLine("откройте http://127.0.0.1:5173 в 12:30")).toBe(
      "откройте http://127.0.0.1:5173 в 12:30",
    );
    expect(plainLine("a".repeat(200), 50)).toHaveLength(50);
  });

  it("a blocker field with an inner colon reaches the card without it", async () => {
    const s = await scene({ honestExit: true }, "Посчитай итоги продаж из sales-2025.csv");
    await s.blocker({
      what: "Нет файла: sales-2025.csv.",
      reason: "missing_file",
      why: "Файла нет в папке",
      need: "Пришлите файл",
      evidence: "sales-2025.csv",
    });
    const card = s.pi.sent.find((m) => m.customType === "prsloy-harness.blocker");
    expect(card?.content).toBe("Не получилось: Нет файла — sales-2025.csv");
    s.off();
  });
});
