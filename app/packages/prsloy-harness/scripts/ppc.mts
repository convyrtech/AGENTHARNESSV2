// Оффлайн-улучшатель обвязки (#33): один раунд Propose–Probe–Compose на train-задачах разбиения
// (src/tuner/ppc.ts; промпты — google-research/harness2, Apache-2.0, см. licenses/harness2-Apache-2.0.txt).
//
//   node packages/prsloy-harness/scripts/ppc.mts run --fake --out ppc-out          # CI: фейковые модели, без ключа
//   PRSLOY_GATEWAY_KEY=… node packages/prsloy-harness/scripts/ppc.mts run \
//     --model prsloy/deepseek-v4.1-flash-1017 [--tuner-model prsloy/…] --k 1 --out ppc-out
//   … --no-test               без оценки базы и итога на test
//   … --timeout 600           секунд на задачу стенда; --session-timeout 1800 — на сессию редактора
//   node packages/prsloy-harness/scripts/ppc.mts split --seed 33 --train 4 --decided 2026-10-25
//   node packages/prsloy-harness/scripts/ppc.mts split --from base-1.json --from base-2.json --train 4 \
//     --decided 2026-11-01 --replace-seeded    # «нестабильные» по базовым отчётам вместо разбиения по seed
//
// Итог раунда: <out>/PROPOSAL.md (кандидаты, check.mjs на train и test, diff), RESULT.json, REFLECTION.md,
// candidates/composed/harness/ — обвязка, которую переносит человек. Выход 0 — раунд прошёл, 2 — нет.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PRSLOY_DEFAULT_BASE_URL } from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { listTasks } from "../bench/run.ts";
import { fakeScripts } from "../src/tuner/fake.ts";
import { runPpc } from "../src/tuner/ppc.ts";
import {
  loadSplit,
  seededSplit,
  SPLIT_FILE,
  unstableSplit,
  writeSplitOnce,
} from "../src/tuner/split.ts";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    fake: { type: "boolean" },
    model: { type: "string", default: "prsloy/deepseek-v4.1-flash-1017" },
    "tuner-model": { type: "string" },
    "base-url": { type: "string" },
    k: { type: "string", default: "1" },
    out: { type: "string", default: "ppc-out" },
    timeout: { type: "string", default: "600" },
    "session-timeout": { type: "string", default: "1800" },
    "no-test": { type: "boolean" },
    split: { type: "string" },
    seed: { type: "string" },
    train: { type: "string", default: "4" },
    decided: { type: "string" },
    from: { type: "string", multiple: true },
    "replace-seeded": { type: "boolean" },
  },
});

function split(): number {
  if (!values.decided || !/^\d{4}-\d{2}-\d{2}$/.test(values.decided)) {
    console.error("--decided ГГГГ-ММ-ДД: когда решено (до любого подбора)");
    return 2;
  }
  const tasks = listTasks(undefined, "casual", false).map((t) => t.id);
  const nTrain = Number(values.train);
  const file = values.split ? resolve(values.split) : SPLIT_FILE;
  const next = values.from?.length
    ? unstableSplit(
        tasks,
        values.from.map((f) => JSON.parse(readFileSync(f, "utf8"))),
        nTrain,
        values.decided,
      )
    : seededSplit(tasks, nTrain, Number(values.seed ?? 33), values.decided);
  if (next.train.length < nTrain) {
    console.error(`нашлось только ${next.train.length} задач для train (${next.rule})`);
    return 2;
  }
  writeSplitOnce(next, file, { replaceSeeded: values["replace-seeded"] === true });
  console.log(`${file}: train ${next.train.join(", ")}; test ${next.test.length} задач`);
  return 0;
}

async function run(): Promise<number> {
  if (!values.model.includes("/")) {
    console.error("--model провайдер/модель");
    return 2;
  }
  const key = process.env.PRSLOY_GATEWAY_KEY ?? process.env.PRSLOY_KEY;
  if (!values.fake && !key) {
    console.error("Нужен ключ шлюза в PRSLOY_GATEWAY_KEY (или --fake).");
    return 2;
  }
  const theSplit = loadSplit(values.split ? resolve(values.split) : SPLIT_FILE);
  const result = await runPpc(
    {
      model: values.model,
      ...(values["tuner-model"] ? { tunerModel: values["tuner-model"] } : {}),
      ...(values.fake
        ? { fake: true }
        : { baseUrl: values["base-url"] ?? PRSLOY_DEFAULT_BASE_URL }),
      ...(key && !values.fake ? { key } : {}),
      split: theSplit,
      k: Number(values.k) || 1,
      outDir: resolve(values.out),
      timeoutSec: Number(values.timeout) || 600,
      sessionTimeoutSec: Number(values["session-timeout"]) || 1800,
      test: values["no-test"] !== true,
      log: (line) => console.log(line),
    },
    values.fake ? fakeScripts(theSplit.train) : undefined,
  );
  console.log(`\nПредложение: ${result.outDir}/PROPOSAL.md`);
  return 0;
}

process.exitCode = await (
  command === "split"
    ? Promise.resolve(split())
    : command === "run"
      ? run()
      : Promise.resolve((console.error("ppc.mts run|split …"), 2))
).catch((error: unknown) => {
  console.error(error);
  return 2;
});
