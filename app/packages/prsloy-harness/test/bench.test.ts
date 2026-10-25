// Замер в режиме --fake: раннер, проверки кодом и учёт вмешательств работают без ключа (CI на Linux).
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { countInterventions, listTasks, reportMarkdown, runBench } from "../bench/run.ts";

const out = mkdtempSync(join(tmpdir(), "prsloy-bench-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("bench --fake", () => {
  it("has 8 casual tasks, each with a prompt, a check and a fake solution", () => {
    const tasks = listTasks();
    expect(tasks.map((t) => t.id)).toEqual([
      "explain-project",
      "fix-discount",
      "port-to-js",
      "sales-summary",
      "snake-game",
      "speed-up",
      "tg-bot",
      "visit-card",
    ]);
    for (const t of tasks) {
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(existsSync(join(t.dir, "check.mjs"))).toBe(true);
      expect(existsSync(join(t.dir, "fake.json"))).toBe(true);
    }
  });

  it("every check fails on the untouched folder (no agent): the checks are real", async () => {
    for (const t of listTasks()) {
      const ws = mkdtempSync(join(out, `pristine-${t.id}-`));
      const original = join(t.dir, "workspace");
      if (existsSync(original)) cpSync(original, ws, { recursive: true });
      const check = (await import(pathToFileURL(join(t.dir, "check.mjs")).href)) as {
        default: (i: {
          ws: string;
          original: string;
          answer: string;
        }) => Promise<{ ok: boolean | null }>;
      };
      const result = await check.default({ ws, original, answer: "Готово." });
      expect(result.ok, t.id).not.toBe(true);
    }
  }, 60_000);

  for (const harness of [true, false]) {
    it(`harness ${harness ? "on" : "off"}: the fake solutions pass, metrics are filled`, async () => {
      const report = await runBench({
        fake: true,
        harness,
        model: "prsloy/deepseek-v4.1-flash-1017",
        outDir: join(out, harness ? "on" : "off"),
        timeoutSec: 60,
      });
      expect(report.totals.failed).toBe(0);
      // Нет браузера в CI — страницы «не проверены», но не провалены.
      expect(report.totals.passed + report.totals.skipped).toBe(8);
      expect(report.totals.toolCalls).toBeGreaterThanOrEqual(8);
      const reviews = report.results.reduce((n, r) => n + (r.interventions.reviewPass ?? 0), 0);
      if (harness) expect(reviews).toBeGreaterThan(0);
      else expect(reviews).toBe(0);
      const md = reportMarkdown(report);
      expect(md).toContain(
        "| Задача | Проверка | Время, с | Вызовов | $ | Вмешательства харнесса |",
      );
      expect(md).toContain(`харнесс ${harness ? "вкл" : "выкл"}`);
    }, 120_000);
  }
});

describe("bench: counting harness interventions", () => {
  it("from session records and harness counters", () => {
    const tr = (text: string) => ({ role: "toolResult", content: [{ type: "text", text }] });
    const custom = (customType: string, content: string, display = false) => ({
      role: "custom",
      customType,
      content,
      display,
    });
    const counts = countInterventions(
      [
        tr("Этот вызов уже был 2 раза с тем же результатом. Сделай другое: …"),
        tr("before\n\n[Процесс остановлен по таймауту 120 с.] …"),
        tr('Validation failed for tool "read":\n  - path: required'),
        custom("prsloy-harness.stop-gate", "Проверка проекта не прошла …"),
        custom(
          "prsloy-harness.second-opinion",
          "Вторая модель нашла 1 замечание — исправляю",
          true,
        ),
        custom("prsloy-harness.tool-leak", "Твой последний вызов …"),
        custom("prsloy-harness.budget", "Задача остановлена …", true),
        custom("prsloy-harness", "Ты написал вызов тула текстом …"),
      ],
      { "repair:json-string": 2, "repair:wrapper": 1, "validation-error": 1 },
    );
    expect(counts).toEqual({
      loop: 1,
      timeout: 1,
      validationError: 1,
      stopGate: 1,
      reviewFail: 1,
      leak: 1,
      budget: 1,
      pseudoCall: 1,
      repair: 3,
    });
  });
});
