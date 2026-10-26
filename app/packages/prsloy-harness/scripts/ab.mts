// A/B одного флага одной командой (дирижёр, 26.10): тот же набор задач дважды — флаг вкл и выкл — и таблица
// «решено / ложное «готово» / жульничество / сбой шлюза / время / токены / ₽ / доля токенов на ревью» по наборам.
//
//   PRSLOY_GATEWAY_KEY=… node packages/prsloy-harness/scripts/ab.mts \
//     --model prsloy/kimi-k3.1-pro --suite casual,honesty --flag review
//   … --flag review            что сравнивать (по умолчанию второе мнение): review, lessons, memory, skills, web,
//                              honest-exit, test-guard, test-quality, reviewer-cheats, claim-check
//   … --out ab-out             папка: <out>/on и <out>/off — обычные прогоны бенча, <out>/ab-<флаг>-<время>.md — таблица
//   … --resume                 продолжить прерванное A/B в той же --out (каждый вариант — своим --resume)
//   … --task visit-card        только эти задачи (можно несколько)
//   … --timeout 600            секунд на задачу
//   … --fake                   фейковая модель (проверка самой команды, без ключа)
// Выход: 0 — оба прогона дошли до конца; 2 — не запустилось или шлюз не принял ключ; 3 — бюджет (если задан).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PRSLOY_DEFAULT_BASE_URL } from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { abMarkdown, abRows } from "../bench/lib/ab.ts";
import {
  type BenchOptions,
  type BenchReport,
  listTasks,
  reportMarkdown,
  runBench,
  type Suite,
  SUITES,
} from "../bench/run.ts";

/** Флаг командной строки → поле BenchOptions (булево). */
const FLAGS: Record<string, keyof BenchOptions> = {
  review: "review",
  lessons: "lessons",
  memory: "memory",
  skills: "skills",
  web: "webTools",
  "honest-exit": "honestExit",
  "test-guard": "testGuard",
  "test-quality": "testQuality",
  "reviewer-cheats": "reviewerCheats",
  "claim-check": "claimCheck",
};

const { values } = parseArgs({
  options: {
    fake: { type: "boolean" },
    model: { type: "string", default: "prsloy/deepseek-v4.1-flash-1017" },
    "base-url": { type: "string" },
    suite: { type: "string", default: "casual,honesty" },
    flag: { type: "string", default: "review" },
    task: { type: "string", multiple: true },
    timeout: { type: "string", default: "600" },
    out: { type: "string", default: "ab-out" },
    resume: { type: "boolean" },
  },
});

async function main(): Promise<number> {
  const field = FLAGS[values.flag];
  if (!field) {
    console.error(`--flag ${Object.keys(FLAGS).join("|")}`);
    return 2;
  }
  const suites = values.suite.split(",").map((x) => x.trim()) as Suite[];
  if (!suites.length || suites.some((x) => !SUITES.includes(x))) {
    console.error("--suite casual|honesty|web|dogfood|all, несколько через запятую");
    return 2;
  }
  if (!values.model.includes("/")) {
    console.error("--model провайдер/модель, например prsloy/kimi-k3.1-pro");
    return 2;
  }
  const key = process.env.PRSLOY_GATEWAY_KEY ?? process.env.PRSLOY_KEY;
  if (!values.fake && !key) {
    console.error("Нужен ключ шлюза в PRSLOY_GATEWAY_KEY (или --fake).");
    return 2;
  }
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const base: Omit<BenchOptions, "outDir"> = {
    harness: true,
    model: values.model,
    suite: suites.length === 1 ? suites[0]! : suites,
    timeoutSec: Number(values.timeout) || 600,
    ...(values.fake ? { fake: true } : { baseUrl: values["base-url"] ?? PRSLOY_DEFAULT_BASE_URL }),
    ...(key && !values.fake ? { key } : {}),
    ...(values.task?.length ? { tasks: values.task } : {}),
    log: (line) => console.log(line),
  };
  const variants: { name: string; report: BenchReport }[] = [];
  for (const [name, on] of [
    ["вкл", true],
    ["выкл", false],
  ] as const) {
    const outDir = join(out, on ? "on" : "off");
    console.log(`\n== ${values.flag} ${name} → ${outDir}`);
    const report = await runBench({
      ...base,
      [field]: on,
      outDir,
      ...(values.resume ? { resume: true } : {}),
    });
    writeFileSync(join(outDir, "report.md"), reportMarkdown(report));
    writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    variants.push({ name, report });
    if (report.stopped) break;
  }
  const suiteOf = new Map(
    listTasks(undefined, "all", values.fake ? false : undefined).map((t) => [t.id, t.suite]),
  );
  const md = abMarkdown(
    `A/B «${values.flag}»: ${values.model}, ${suites.join(" + ")}${values.fake ? " (фейковая модель)" : ""}`,
    abRows(variants, (id) => suiteOf.get(id) ?? "?"),
    variants.flatMap((v) =>
      v.report.stopped ? [{ variant: v.name, message: v.report.stopped.message }] : [],
    ),
  );
  const file = join(out, `ab-${values.flag}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(file, md);
  console.log(`\n${md}\nТаблица: ${file}`);
  const stop = variants.find((v) => v.report.stopped)?.report.stopped;
  if (stop?.reason === "auth") return 2;
  if (stop?.reason === "budget") return 3;
  return 0;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error);
  return 2;
});
