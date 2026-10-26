// Гейт для Python (#37): python из .venv проекта; нет pytest — запасной unittest с честной подписью; голые
// pytest-функции unittest не видит — «проверять нечем», а не «прошло». Наличие pytest задаёт заглушка в PYTHONPATH,
// а не машина.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";
import { nothingChecked, runCheck } from "../src/check-run.ts";
import { detectProjectCheck, projectPython, runProjectCheck } from "../src/stop-gate.ts";
import { turnStatusLine } from "../src/turn-status.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-pygate-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(root, `p${n++}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const before = process.env.PYTHONPATH;
afterEach(() => {
  if (before === undefined) delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH = before;
});
function pytest(mode: "absent" | "present") {
  const stub = join(import.meta.dirname, "fixtures", "pytest-stub", mode);
  process.env.PYTHONPATH = before ? `${stub}${delimiter}${before}` : stub;
}

const UNITTEST_OK =
  "import unittest\n\nclass T(unittest.TestCase):\n    def test_sum(self):\n        self.assertEqual(1 + 1, 2)\n";
const UNITTEST_RED =
  "import unittest\n\nclass T(unittest.TestCase):\n    def test_sum(self):\n        self.assertEqual(1 + 1, 3)\n";
const BARE = "def test_sum():\n    assert 1 + 1 == 2\n";

describe("python of the project (#37 a)", () => {
  it(".venv / venv interpreter by OS; none — the system python; a venv works even without python on PATH", () => {
    const win = project({ "test_a.py": BARE, ".venv/Scripts/python.exe": "" });
    expect(projectPython(win, "win32")).toEqual({
      command: `"${join(win, ".venv", "Scripts", "python.exe")}"`,
      venv: true,
    });
    const unix = project({ "test_a.py": BARE, "venv/bin/python": "" });
    expect(projectPython(unix, "linux")).toEqual({
      command: `"${join(unix, "venv", "bin", "python")}"`,
      venv: true,
    });
    const none = project({ "test_a.py": BARE });
    expect(projectPython(none, "win32")).toEqual({ command: "python", venv: false });
    expect(projectPython(none, "darwin")).toEqual({ command: "python3", venv: false });
    // Системного python нет, а venv есть — проверка всё равно есть, и с запасным unittest.
    const check = detectProjectCheck(unix, () => false, "linux")!;
    expect(check.command).toBe(`"${join(unix, "venv", "bin", "python")}" -m pytest -q -x`);
    expect(check.fallback?.command).toBe(
      `"${join(unix, "venv", "bin", "python")}" -m unittest discover -q`,
    );
    expect(detectProjectCheck(none, () => false, "linux")).toBeUndefined();
  });
});

describe("pytest or unittest (#37 b), real python", () => {
  const gate = (cwd: string) => runCheck(runProjectCheck, detectProjectCheck(cwd)!, cwd, 60_000);

  it("pytest present — pytest runs", async () => {
    pytest("present");
    const { check, run } = await gate(project({ "test_a.py": BARE }));
    expect([check.label, run.code, nothingChecked(check, run)]).toEqual(["pytest", 0, false]);
  }, 60_000);

  it("no pytest + unittest tests — checked through unittest: green and red as they are", async () => {
    pytest("absent");
    const ok = await gate(project({ "test_a.py": UNITTEST_OK }));
    expect([ok.check.label, ok.run.code, nothingChecked(ok.check, ok.run)]).toEqual([
      "unittest",
      0,
      false,
    ]);
    const red = await gate(project({ "test_a.py": UNITTEST_RED }));
    expect([red.check.label, red.run.code === 0, nothingChecked(red.check, red.run)]).toEqual([
      "unittest",
      false,
      false,
    ]);
  }, 60_000);

  it("no pytest + bare pytest functions — unittest sees nothing: «nothing to check», not «passed»", async () => {
    pytest("absent");
    const r = await gate(project({ "test_a.py": BARE }));
    expect(r.check.label).toBe("unittest");
    expect(nothingChecked(r.check, r.run)).toBe(true);
  }, 60_000);

  it("a real venv of the project is used (Linux: venv/bin/python → python3)", async (t) => {
    if (process.platform === "win32") return t.skip();
    pytest("absent");
    const dir = project({ "test_a.py": UNITTEST_OK });
    mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
    symlinkSync("/usr/bin/python3", join(dir, ".venv", "bin", "python"));
    const r = await gate(dir);
    expect(r.check.command).toContain(join(dir, ".venv", "bin", "python"));
    expect([r.check.label, r.run.code]).toEqual(["unittest", 0]);
  }, 60_000);

  it("the turn status says how it was checked", () => {
    expect(turnStatusLine(["checks-pass"], "unittest")).toBe(
      "Проверки прошли · проверено через unittest",
    );
    expect(turnStatusLine(["checks-pass"])).toBe("Проверки прошли");
    expect(turnStatusLine(["no-checks"], "unittest")).toBe(
      "Проверить нечем — в проекте нет проверок",
    );
  });
});
