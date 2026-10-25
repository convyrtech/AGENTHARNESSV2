// Замер харнесса на казуальных задачах (bench/tasks): тот же рантайм и те же расширения, что в агент-хосте.
//
//   node packages/prsloy-harness/scripts/bench.mts --fake                       # CI: фейковая модель, без ключа
//   PRSLOY_GATEWAY_KEY=… node packages/prsloy-harness/scripts/bench.mts \
//     --base-url https://api.prsloy.online/v1 --model prsloy/deepseek-v4.1-flash-1017 --harness on
//   … --harness off            голый Pi с тем же системным промптом
//   … --task visit-card        одна задача (можно несколько --task)
//   … --timeout 900            секунд на задачу (по умолчанию 600)
//   … --allow-outside          отвечать «Да» на «менять файлы вне проекта?» (по умолчанию «Нет»)
//   … --out bench-out          куда писать отчёт, сессии и папки задач
// Итог: <out>/bench-<модель>-<on|off>-<время>.md и .json. Ключ берётся только из окружения и никуда не пишется.
// Выход 0 — все проверенные задачи прошли (нужно для --fake в CI); 1 — нет; 2 — не запустилось.
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PRSLOY_DEFAULT_BASE_URL } from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { reportMarkdown, runBench } from "../bench/run.ts";

const { values } = parseArgs({
  options: {
    fake: { type: "boolean" },
    harness: { type: "string", default: "on" },
    model: { type: "string", default: "prsloy/deepseek-v4.1-flash-1017" },
    "base-url": { type: "string" },
    task: { type: "string", multiple: true },
    timeout: { type: "string", default: "600" },
    "allow-outside": { type: "boolean" },
    out: { type: "string", default: "bench-out" },
  },
});

async function main(): Promise<number> {
  if (values.harness !== "on" && values.harness !== "off") {
    console.error("--harness on|off");
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
  const outDir = resolve(values.out);
  const report = await runBench({
    harness: values.harness === "on",
    model: values.model,
    ...(values.fake ? { fake: true } : { baseUrl: values["base-url"] ?? PRSLOY_DEFAULT_BASE_URL }),
    ...(key && !values.fake ? { key } : {}),
    ...(values.task?.length ? { tasks: values.task } : {}),
    outDir,
    timeoutSec: Number(values.timeout) || 600,
    allowOutside: values["allow-outside"] === true,
    log: (line) => console.log(line),
  });
  const stamp = report.meta.date.replace(/[:.]/g, "-");
  const base = join(outDir, `bench-${values.model.replace(/\//g, "_")}-${values.harness}-${stamp}`);
  const md = reportMarkdown(report);
  writeFileSync(`${base}.md`, md);
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${md}\nОтчёт: ${base}.md, ${base}.json`);
  return report.totals.failed === 0 ? 0 : 1;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error);
  return 2;
});
