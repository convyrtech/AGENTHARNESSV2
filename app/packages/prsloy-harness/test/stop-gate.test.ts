import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolveOptions } from "../src/options.ts";
import {
  type CheckRun,
  type CheckRunner,
  detectProjectCheck,
  installStopGate,
  MAX_PUSHBACKS,
  runProjectCheck,
} from "../src/stop-gate.ts";
import { MockPi } from "./mock-pi.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prsloy-gate-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const yes = () => true;

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "x", scripts, ...extra });

describe("detectProjectCheck", () => {
  it("package.json: test, then typecheck and lint if present", async () => {
    expect(
      detectProjectCheck(await project({ "package.json": pkg({ test: "node test.js" }) }), yes)
        ?.command,
    ).toBe("npm run test");
    const all = await project({
      "package.json": pkg({ test: "vitest", typecheck: "tsc", lint: "eslint ." }),
      "pnpm-lock.yaml": "",
    });
    expect(detectProjectCheck(all, yes)?.command).toBe(
      "pnpm run test && pnpm run typecheck && pnpm run lint",
    );
  });

  it("the npm init placeholder test is not a check", async () => {
    const dir = await project({
      "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }),
    });
    expect(detectProjectCheck(dir, yes)).toBeUndefined();
  });

  it("dependencies not installed: no cheap check, stay quiet", async () => {
    const dir = await project({
      "package.json": pkg({ test: "vitest" }, { devDependencies: { vitest: "^4" } }),
    });
    expect(detectProjectCheck(dir, yes)).toBeUndefined();
    await mkdir(join(dir, "node_modules"));
    expect(detectProjectCheck(dir, yes)?.command).toBe("npm run test");
  });

  it("pytest when Python tests exist; cargo and go only when installed", async () => {
    expect(
      detectProjectCheck(await project({ "app.py": "", "tests/test_app.py": "" }), yes)?.label,
    ).toBe("pytest");
    expect(detectProjectCheck(await project({ "app.py": "x = 1" }), yes)).toBeUndefined();
    const rust = await project({ "Cargo.toml": "[package]" });
    expect(detectProjectCheck(rust, () => true)?.command).toBe("cargo test -q");
    expect(detectProjectCheck(rust, () => false)).toBeUndefined();
    expect(detectProjectCheck(await project({ "go.mod": "module x" }), () => true)?.command).toBe(
      "go test ./...",
    );
  });

  it("no package manager or python on PATH: no check (not a red project)", async () => {
    expect(
      detectProjectCheck(
        await project({ "package.json": pkg({ test: "node t.js" }) }),
        () => false,
      ),
    ).toBeUndefined();
    expect(detectProjectCheck(await project({ "test_a.py": "" }), () => false)).toBeUndefined();
  });

  it("an HTML-only site has no project check (post-edit checks already ran)", async () => {
    expect(
      detectProjectCheck(await project({ "index.html": "<p>hi</p>", "style.css": "" }), yes),
    ).toBeUndefined();
  });
});

describe("runProjectCheck", () => {
  it("returns the exit code and output", async () => {
    const dir = await project({});
    const run = await runProjectCheck(
      { command: "node -e \"console.log('boom'); process.exit(3)\"", label: "x" },
      dir,
      10_000,
    );
    expect(run).toMatchObject({ code: 3, timedOut: false });
    expect(run.output).toContain("boom");
  });

  it("stops a check that hangs past the timeout", async () => {
    const dir = await project({});
    const started = Date.now();
    const run = await runProjectCheck(
      { command: 'node -e "setInterval(() => {}, 1000)"', label: "x" },
      dir,
      300,
    );
    expect(run.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("stop gate", () => {
  function setup(results: Partial<CheckRun>[], cwd: string, profile: "code" | "design" = "code") {
    const pi = new MockPi(cwd);
    const runs: string[] = [];
    let i = 0;
    const runner: CheckRunner = async (check) => {
      runs.push(check.command);
      const r = results[Math.min(i++, results.length - 1)] ?? {};
      return { code: r.code ?? 0, output: r.output ?? "", timedOut: r.timedOut ?? false };
    };
    installStopGate(pi.api, resolveOptions({ profile }), runner);
    const edit = () => pi.toolResult({ toolName: "edit", input: { path: "a.js" }, text: "Edited" });
    const settle = (extra: Record<string, unknown> = {}) =>
      pi.boundary("agent_before_settle", { outcome: "completed", ...extra });
    return { pi, runs, edit, settle };
  }

  const red = { code: 1, output: "FAIL sum.test.js\n  expected 4, got 5\n" };

  it("does nothing when nothing was edited this turn", async () => {
    const { runs, settle, pi } = setup(
      [red],
      await project({ "package.json": pkg({ test: "node t.js" }) }),
    );
    await pi.userPrompt();
    expect(await settle()).toEqual({ entries: [], continue: false });
    expect(runs).toEqual([]);
  });

  it("green after edits: silent", async () => {
    const { runs, settle, edit, pi } = setup(
      [{ code: 0 }],
      await project({ "package.json": pkg({ test: "node t.js" }) }),
    );
    await pi.userPrompt();
    await edit();
    expect(await settle()).toEqual({ entries: [], continue: false });
    expect(runs).toEqual(["npm run test"]);
  });

  it("red after edits: one short Russian push back with the output, and a continuation", async () => {
    const { settle, edit, pi } = setup(
      [red],
      await project({ "package.json": pkg({ test: "node t.js" }) }),
    );
    await pi.userPrompt();
    await edit();
    const result = await settle();
    expect(result.continue).toBe(true);
    const entry = result.entries[0] as { content: string; display: boolean };
    expect(entry.display).toBe(false);
    expect(entry.content).toMatch(/^Проверка проекта не прошла \(`npm run test`, код 1\):/);
    expect(entry.content).toContain("expected 4, got 5");
    expect(entry.content.trimEnd().endsWith("Почини и проверь снова.")).toBe(true);
  });

  it("cap: at most 2 push backs per user turn, then a plain visible note, never a loop", async () => {
    const { runs, settle, edit, pi } = setup(
      [red],
      await project({ "package.json": pkg({ test: "node t.js" }) }),
    );
    await pi.userPrompt();
    await edit();
    const first = await settle();
    const second = await settle(); // модель «починила» на словах, без правок — всё равно проверяем
    expect([first.continue, second.continue]).toEqual([true, true]);
    expect((second.entries[0] as { content: string }).content).toContain("Это последняя попытка");
    const third = await settle();
    expect(third.continue).toBe(false);
    const note = third.entries[0] as { content: string; display: boolean };
    expect(note.display).toBe(true);
    expect(note.content).toContain(
      `Проверка проекта всё ещё не проходит (\`npm run test\`) — после ${MAX_PUSHBACKS} попыток`,
    );
    expect(await settle()).toEqual({ entries: [], continue: false });
    expect(runs).toHaveLength(3);
    // Новое сообщение пользователя — новый счёт.
    await pi.userPrompt("ещё раз");
    await edit();
    expect((await settle()).continue).toBe(true);
  });

  it("fixed after a push back: green, silent", async () => {
    const { settle, edit, pi } = setup(
      [red, { code: 0 }],
      await project({ "package.json": pkg({ test: "node t.js" }) }),
    );
    await pi.userPrompt();
    await edit();
    expect((await settle()).continue).toBe(true);
    await edit();
    expect(await settle()).toEqual({ entries: [], continue: false });
  });

  it("no check, a timeout, missing pytest, an aborted turn, or a budget stop: silent", async () => {
    const html = setup([red], await project({ "index.html": "<p>" }));
    await html.edit();
    expect((await html.settle()).continue).toBe(false);
    expect(html.runs).toEqual([]);

    const slow = setup(
      [{ code: null, timedOut: true }],
      await project({ "package.json": pkg({ test: "x" }) }),
    );
    await slow.edit();
    expect((await slow.settle()).continue).toBe(false);

    const py = setup(
      [{ code: 1, output: "/usr/bin/python3: No module named pytest" }],
      await project({ "test_a.py": "" }),
    );
    await py.edit();
    expect((await py.settle()).continue).toBe(false);

    const aborted = setup([red], await project({ "package.json": pkg({ test: "x" }) }));
    await aborted.edit();
    expect((await aborted.settle({ outcome: "aborted" })).continue).toBe(false);

    const budget = setup([red], await project({ "package.json": pkg({ test: "x" }) }));
    await budget.edit();
    const r = await budget.settle({
      entries: [{ type: "custom", customType: "prsloy-harness.budget", data: {} }],
    });
    expect(r.continue).toBe(false);
    expect(budget.runs).toEqual([]);
  });

  it("only in the «Код» profile", async () => {
    const { pi } = setup([red], await project({}), "design");
    expect(pi.handlers.get("agent_before_settle")).toBeUndefined();
  });
});
