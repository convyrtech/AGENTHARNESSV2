// H-3 (#8): полезность новых тестов — статика и fail-to-pass (research/22 §4, §6.1 H10).
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolveOptions } from "../src/options.ts";
import { installStopGate, runProjectCheck } from "../src/stop-gate.ts";
import { codeAndTests, failToPass, weakTests } from "../src/test-quality.ts";
import { installTurnChanges, TurnChanges } from "../src/turn-changes.ts";
import { createTurnStatus } from "../src/turn-status.ts";
import { MockPi } from "./mock-pi.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const newFile = (file: string, added: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    "@@ -0,0 +1 @@",
    ...added.map((l) => `+${l}`),
  ].join("\n");
const changed = (file: string, removed: string[], added: string[]) =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1 +1 @@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");

const kinds = (patch: string) => weakTests(patch).map((w) => `${w.name}:${w.kind}`);

describe("H-3 static: tests that check nothing", () => {
  it("Python: no assert, tautology, mock-only, type-only, skipped", () => {
    expect(
      kinds(
        newFile("test_shop.py", [
          "def test_runs():",
          "    total(3)",
          "def test_true():",
          "    assert True",
          "def test_same():",
          "    x = total(3)",
          "    assert x == x",
          "def test_mock():",
          "    m = Mock(return_value=5)",
          "    pay(m)",
          "    m.assert_called_once()",
          "def test_type():",
          "    assert isinstance(total(3), int)",
          "@pytest.mark.skip",
          "def test_later():",
          "    assert total(3) == 9",
          "def test_good():",
          "    assert total(3) == 9",
        ]),
      ),
    ).toEqual([
      "test_runs:no-assert",
      "test_true:tautology",
      "test_same:tautology",
      "test_mock:mock-only",
      "test_type:type-only",
      "test_later:skipped",
    ]);
  });

  it("JS: no expect, toBe(itself), snapshot-only, typeof-only, it.skip; a real check is fine", () => {
    expect(
      kinds(
        newFile("shop.test.js", [
          "test('runs', () => { total(3); });",
          "test('same', () => {",
          "  const x = total(3);",
          "  expect(x).toBe(x);",
          "});",
          "test('snap', () => {",
          "  expect(render()).toMatchSnapshot();",
          "});",
          "it('type', () => {",
          "  assert.equal(typeof grade(95), 'string');",
          "  assert.ok(grade(50));",
          "});",
          "it.skip('later', () => { expect(total(3)).toBe(9); });",
          "it('one line', () => { expect(total(1)).toBe(3); });",
          "it('good', () => {",
          "  expect(total(3)).toBe(9);",
          "});",
        ]),
      ),
    ).toEqual([
      "runs:no-assert",
      "same:tautology",
      "snap:snapshot-only",
      "type:type-only",
      "later:skipped",
    ]);
  });

  it("not flagged: real checks, code files, old tests untouched, a mock plus a result check, an assert script", () => {
    expect(
      kinds(
        newFile("test_a.py", [
          "def test_total():",
          "    assert total(3) == 9",
          "    assert total(0) == 0",
        ]),
      ),
    ).toEqual([]);
    expect(kinds(newFile("shop.js", ["function total(n) { return n * 3; }"]))).toEqual([]);
    expect(
      kinds(
        newFile("test_pay.py", [
          "def test_pay():",
          "    m = Mock()",
          "    assert pay(m, 5) == 'ok'",
          "    m.assert_called_once()",
        ]),
      ),
    ).toEqual([]);
    expect(
      kinds(
        newFile("test.js", [
          "const assert = require('assert');",
          "assert.strictEqual(total(3), 9);",
        ]),
      ),
    ).toEqual([]);
    // Импорт assert — не проверка: скрипт с одними typeof/ok — слабый.
    expect(
      kinds(
        newFile("grade.test.mjs", [
          'import assert from "node:assert/strict";',
          "assert.equal(typeof grade(95), 'string');",
          "assert.ok(grade(50));",
        ]),
      ),
    ).toEqual(["grade.test.mjs:type-only"]);
    // Скрипт-тест без блоков, который ничего не проверяет.
    expect(kinds(newFile("test.js", ["require('./shop.js');", "console.log('ok');"]))).toEqual([
      "test.js:no-assert",
    ]);
  });

  it("what fail-to-pass reverts: changed and new code, not tests and not package files", () => {
    const patch = [
      changed("price.js", ["a"], ["b"]),
      newFile("util.js", ["x"]),
      newFile("price.test.js", ["t"]),
      changed("package.json", ["{}"], ["{ }"]),
      newFile("README.md", ["#"]),
    ].join("\n");
    expect(codeAndTests(patch)).toEqual({
      code: ["price.js"],
      newCode: ["util.js"],
      tests: ["price.test.js"],
    });
  });
});

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "prsloy-h3-"));
  dirs.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  return { root, cwd };
}

const PRICE_BUG = "exports.finalPrice = (price, percent) => price - percent;\n";
const PRICE_OK = "exports.finalPrice = (price, percent) => price - (price * percent) / 100;\n";

describe("H-3 fail-to-pass: would the new tests fail on the code before the turn?", () => {
  it("a test that pins the fix fails on the old code — fine; a test that does not — passOnOld", async () => {
    const { root, cwd } = await project({ "price.js": PRICE_OK });
    const check = { command: "node price.test.js", label: "node price.test.js" };
    const base = {
      cwd,
      check,
      runner: runProjectCheck,
      outputDir: join(root, "out"),
      timeoutMs: 30_000,
      fileAtStart: async () => PRICE_BUG,
    };
    writeFileSync(
      join(cwd, "price.test.js"),
      "require('assert').strictEqual(require('./price.js').finalPrice(200, 10), 180);\n",
    );
    const patch = [
      changed("price.js", [PRICE_BUG.trim()], [PRICE_OK.trim()]),
      newFile("price.test.js", ["…"]),
    ].join("\n");
    expect(await failToPass({ ...base, patch })).toEqual({
      passOnOld: false,
      tests: ["price.test.js"],
    });
    writeFileSync(
      join(cwd, "price.test.js"),
      "require('assert').strictEqual(require('./price.js').finalPrice(100, 0), 100);\n",
    );
    expect(await failToPass({ ...base, patch })).toEqual({
      passOnOld: true,
      tests: ["price.test.js"],
    });
    // Тесты без правки кода (write-tests) — fail-to-pass не к чему применить.
    expect(await failToPass({ ...base, patch: newFile("price.test.js", ["…"]) })).toBeUndefined();
  });
});

describe("H-3 in the gate: signals for the reviewer and the turn status, no push-back", () => {
  async function scene(flag: boolean) {
    const { root, cwd } = await project({
      "package.json": JSON.stringify({ name: "x", scripts: { test: "node price.test.js" } }),
      "price.js": PRICE_BUG,
      "price.test.js": "console.log('нет тестов');\n",
    });
    const opts = resolveOptions({
      profile: "code",
      outputDir: join(root, "out"),
      settingsPath: join(root, "none.json"),
    });
    const pi = new MockPi(cwd);
    const changes = new TurnChanges(join(root, "turns"), () => "git");
    installTurnChanges(pi.api, changes);
    const turnStatus = createTurnStatus();
    installStopGate(pi.api, opts, {
      changes,
      turnStatus,
      testQuality: () => flag,
      pagePaths: false,
      pageCheck: false,
    });
    await pi.userPrompt("Почини скидку и добавь тест.");
    await changes.ready();
    return { pi, cwd, turnStatus };
  }

  it("fix plus a test that passes on the buggy code too → tests-weak, no push-back; flag off → nothing", async () => {
    for (const flag of [true, false]) {
      const s = await scene(flag);
      writeFileSync(join(s.cwd, "price.js"), PRICE_OK);
      writeFileSync(
        join(s.cwd, "price.test.js"),
        "const assert = require('assert');\nconst { finalPrice } = require('./price.js');\nassert.strictEqual(finalPrice(100, 0), 100);\n",
      );
      await s.pi.toolResult({ toolName: "write", input: { path: "price.test.js" } });
      const r = await s.pi.boundary("agent_before_settle", { outcome: "completed", entries: [] });
      expect(r.continue).toBe(false);
      expect(s.turnStatus.weakTests).toEqual(flag ? ["price.test.js"] : []);
    }
  });
});
