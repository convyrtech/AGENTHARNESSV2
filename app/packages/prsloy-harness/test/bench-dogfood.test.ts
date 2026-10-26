// Набор «обычные задачи дирижёра» (--suite dogfood, 26.10): пять задач из настоящей работы на снимках данных —
// CI упал (флейк или регресс), конфликт слияния, сводка отчётов стенда, чужой навык, «Новое» в заметках к выпуску.
// Эталон (fake.json) проходит, нетронутая папка — нет; набор не смешивается с казуальным.
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { listTasks, runBench } from "../bench/run.ts";

const out = mkdtempSync(join(tmpdir(), "prsloy-dogfood-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const DOGFOOD = [
  "dogfood-bench-reports",
  "dogfood-ci-failure",
  "dogfood-merge-conflict",
  "dogfood-release-notes",
  "dogfood-skill-audit",
];

describe("bench --suite dogfood", () => {
  it("five tasks, each with a prompt, a check and a reference; not in the casual suite; suites combine", () => {
    const tasks = listTasks(undefined, "dogfood", false);
    expect(tasks.map((t) => t.id)).toEqual(DOGFOOD);
    for (const t of tasks) {
      expect(t.suite).toBe("dogfood");
      expect(t.prompts[0]!.length).toBeGreaterThan(40);
      expect(existsSync(join(t.dir, "check.mjs")), t.id).toBe(true);
      expect(t.fake, t.id).toBeDefined();
    }
    const casual = listTasks(undefined, "casual", false).map((t) => t.id);
    expect(casual.some((id) => id.startsWith("dogfood-"))).toBe(false);
    expect(listTasks(undefined, ["casual", "dogfood"], false)).toHaveLength(casual.length + 5);
  });

  it("every check fails on the untouched folder with an empty answer", async () => {
    for (const t of listTasks(undefined, "dogfood", false)) {
      const ws = mkdtempSync(join(out, `pristine-${t.id}-`));
      cpSync(t.workspace, ws, { recursive: true });
      const check = (await import(pathToFileURL(join(t.dir, "check.mjs")).href)) as {
        default: (i: Record<string, unknown>) => Promise<{ ok: boolean | null }>;
      };
      const result = await check.default({
        ws,
        original: t.workspace,
        answer: "Готово.",
        cards: [],
      });
      expect(result.ok, t.id).toBe(false);
    }
  }, 60_000);

  it("the references pass through the real runtime (fake model); time and tokens are counted", async () => {
    const report = await runBench({
      fake: true,
      harness: true,
      suite: "dogfood",
      model: "prsloy/deepseek-v4.1-flash-1017",
      outDir: join(out, "fake"),
      timeoutSec: 60,
    });
    expect(report.results.map((r) => [r.id, r.ok])).toEqual(DOGFOOD.map((id) => [id, true]));
    expect(report.meta.suite).toBe("dogfood");
    expect(report.totals.tokens.calls).toBeGreaterThan(report.results.length);
    expect(report.totals.seconds).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
