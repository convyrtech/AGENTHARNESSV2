// Проба разведчика на настоящем проекте (не часть приложения): гоняет один вопрос через
// runExplore с настоящим шлюзом и печатает, что нашёл, за сколько ходов, токенов и секунд.
// Ключ берётся из окружения (PRSLOY_GATEWAY_KEY), на диск не пишется, процессов не запускает.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  buildPrsloyModelsJsonProvider,
  PRSLOY_PROVIDER_ID,
} from "../../../apps/desktop/src/shared/prsloy-config.ts";
import {
  EXPLORE_DEADLINE_MS,
  exploreTools,
  runExplore,
  type ExploreDepth,
  type ExploreModel,
  type ExploreReply,
} from "../src/explore.ts";

const [, , cwd, question, depthArg, modelArg] = process.argv;
const depth = (depthArg ?? "medium") as ExploreDepth;
const modelName = modelArg ?? "deepseek-v4.1-flash-1017";
const key = process.env.PRSLOY_GATEWAY_KEY;
if (!cwd || !question) throw new Error("usage: scout-probe.mts <cwd> <question> [depth] [model]");
if (!key) throw new Error("нет PRSLOY_GATEWAY_KEY в окружении");

// Список моделей шлюза, если он сохранён рядом (иначе — только каталог приложения).
let served: string[] | undefined;
try {
  served = JSON.parse(readFileSync(process.env.PRSLOY_SERVED_MODELS ?? "/tmp/served.json", "utf8"));
} catch {
  served = undefined;
}
const agentDir = mkdtempSync(join(tmpdir(), "scout-probe-"));
const modelsPath = join(agentDir, "models.json");
writeFileSync(
  modelsPath,
  JSON.stringify({
    providers: {
      [PRSLOY_PROVIDER_ID]: buildPrsloyModelsJsonProvider("https://api.prsloy.online/v1", served),
    },
  }),
);
const modelRuntime = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"),
  modelsPath,
});
await modelRuntime.setRuntimeApiKey(PRSLOY_PROVIDER_ID, key);
const model = modelRuntime.getModel(PRSLOY_PROVIDER_ID, modelName) as ExploreModel | undefined;
if (!model) throw new Error(`нет модели ${modelName}`);

const runs = Number(process.env.PRSLOY_RUNS ?? "1");
const usage: ExploreReply["usage"][] = [];
const summarize = async (): Promise<void> => {
  const started = Date.now();
  const answer = await runExplore({
    question,
    depth,
    cwd,
    tools: exploreTools(cwd),
    model,
    complete: (target, context, options) => modelRuntime.complete(target, context, options),
    deadlineMs: EXPLORE_DEADLINE_MS,
    onUsage: (reply) => usage.push(reply.usage),
  });
  const seconds = (Date.now() - started) / 1000;
  const sum = (pick: (u: ExploreReply["usage"]) => number) =>
    usage.reduce((acc, u) => acc + (u ? pick(u) : 0), 0);

  console.log(`вопрос: ${question}`);
  console.log(`модель: ${model.provider}/${model.id}, глубина: ${depth}`);
  console.log(
    `остановился: ${answer.stoppedBy}, ходов модели: ${answer.turns}, вызовов инструментов: ${answer.toolCalls}`,
  );
  console.log(`файлов: ${answer.files.length} → ${answer.files.slice(0, 12).join(", ")}`);
  console.log(
    `время: ${seconds.toFixed(1)} с; токены вх/вых: ${sum((u) => u?.input ?? 0)}/${sum((u) => u?.output ?? 0)}`,
  );
  if (runs === 1) console.log(`--- ответ ---\n${answer.answer}`);
};
for (let i = 0; i < runs; i++) {
  usage.length = 0;
  await summarize();
}
