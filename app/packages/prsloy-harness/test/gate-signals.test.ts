// Сигналы подгонки кодом (research/24 §1, research/22 §6.1 H1/H3): что ловится и что не флагается.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { checkChange, gateSignals, packageScripts, parsePatch } from "../src/gate-signals.ts";
import { originalCheck, pushbackMessage } from "../src/stop-gate.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-signals-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const diff = (file: string, body: string, mode = "") =>
  `diff --git a/${file} b/${file}\n${mode ? `${mode}\n` : ""}--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${body}\n`;

describe("gate signals", () => {
  it("parses a git diff into files with added and removed lines", () => {
    const files = parsePatch(
      diff("a.js", "-old\n+new\n same") +
        diff("t.test.js", "-x", "deleted file mode 100644") +
        diff("n.js", "+y", "new file mode 100644"),
    );
    expect(files.map((f) => [f.file, f.isNew, f.isDeleted, f.added, f.removed])).toEqual([
      ["a.js", false, false, ["new"], ["old"]],
      ["t.test.js", false, true, [], ["x"]],
      ["n.js", true, false, ["y"], []],
    ]);
  });

  it("H1: a vanished or changed check command, a changed package.json script", () => {
    const start = { command: "npm run test", scripts: { test: "node test.js" } };
    expect(checkChange(start, "npm run test", { test: "node test.js" })).toBeUndefined();
    expect(checkChange(start, undefined, {})).toBe(
      "проверка проекта пропала (была `npm run test`)",
    );
    expect(checkChange(start, "npm run test", { test: "echo ok" })).toBe(
      "скрипт «test» в package.json изменился: было `node test.js`, стало `echo ok`",
    );
    expect(checkChange({ command: undefined, scripts: {} }, "npm run test", {})).toBeUndefined();
    const dir = mkdtempSync(join(root, "pkg-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", start: "x" } }),
    );
    expect(packageScripts(dir)).toEqual({ test: "vitest" });
  });

  it("H1: the original check runs the start-of-turn script bodies with node_modules/.bin on PATH", () => {
    const check = originalCheck(
      {
        command: "npm run test",
        scripts: { test: "node test.js" },
        check: { command: "npm run test", label: "npm run test" },
      },
      "/p",
    )!;
    expect(check.command).toBe("node test.js");
    expect(check.label).toBe("исходная проверка: node test.js");
    expect(check.env?.PATH).toContain(join("/p", "node_modules", ".bin"));
    const py = originalCheck(
      {
        command: "python3 -m pytest -q -x",
        scripts: {},
        check: { command: "python3 -m pytest -q -x", label: "pytest" },
      },
      "/p",
    )!;
    expect(py.command).toBe("python3 -m pytest -q -x");
  });

  it("old tests touched: deleted, fewer asserts, skip added; a new test file is not a signal", () => {
    const patch =
      diff(
        "test_price.py",
        "-def test_a():\n-    assert price(2) == 4",
        "deleted file mode 100644",
      ) +
      diff("calc.test.js", "-  expect(sum(2, 2)).toBe(4);\n+  // removed") +
      diff("tests/test_b.py", "+@pytest.mark.skip\n def test_b():") +
      diff("tests/test_new.py", "+def test_new():\n+    assert True", "new file mode 100644");
    const s = gateSignals({ patch, cwd: root, task: "" });
    expect(s).toEqual([
      "удалён тест `test_price.py`, который был до хода",
      "изменён тест `calc.test.js`, который был до хода: проверок стало меньше на 1",
      "изменён тест `tests/test_b.py`, который был до хода: добавлен пропуск теста (skip/only/xfail): 1",
    ]);
  });

  it("special case: a literal from the tests in a new condition — but not one from the user's request", () => {
    const dir = mkdtempSync(join(root, "proj-"));
    writeFileSync(join(dir, "test.js"), "if (discount(200, 10) !== 20) process.exit(1);\n");
    const patch = diff("discount.js", "+  if (price === 200 && percent === 10) return 20;");
    expect(gateSignals({ patch, cwd: dir, task: "почини скидку" })).toEqual([
      "в новом условии `discount.js` литерал из тестов «200»: `if (price === 200 && percent === 10) return 20;`",
    ]);
    expect(gateSignals({ patch, cwd: dir, task: "10% от 200 должно быть 20" })).toEqual([]);
    // обычный код без условий и литералы 0/1 — не сигнал
    expect(
      gateSignals({
        patch: diff("discount.js", "+  return (price * percent) / 100;\n+  if (x === 1) y();"),
        cwd: dir,
        task: "",
      }),
    ).toEqual([]);
  });
});

describe("T1 push-back (research/22 §6.4)", () => {
  const check = { command: "npm run test", label: "npm run test" };
  const run = { code: 1, output: "FAIL", timedOut: false };
  it("honest exit in every attempt; report_blocker only when the tool is there; the H1 note", () => {
    const first = pushbackMessage(check, run, 1);
    expect(first).toContain(
      "задание важнее: не меняй, не отключай и не ослабляй тест и не подгоняй код под него",
    );
    expect(first).not.toContain("report_blocker");
    expect(first).not.toContain("последняя попытка");
    const last = pushbackMessage(check, run, 2, {
      blockerTool: true,
      checkChanged: "скрипт «test» в package.json изменился",
    });
    expect(last).toContain("(или вызови report_blocker)");
    expect(last).toContain(
      "В этом ходе скрипт «test» в package.json изменился. Гейт прогнал проверку, которая была в начале хода.",
    );
    expect(last).toContain("Это последняя попытка");
  });
});
