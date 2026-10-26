// Замер харнесса на казуальных задачах (bench/tasks): тот же рантайм и те же расширения, что в агент-хосте.
//
//   node packages/prsloy-harness/scripts/bench.mts --fake                       # CI: фейковая модель, без ключа
//   PRSLOY_GATEWAY_KEY=… node packages/prsloy-harness/scripts/bench.mts \
//     --base-url https://api.prsloy.online/v1 --model prsloy/deepseek-v4.1-flash-1017 --harness on
//   … --harness off            голый Pi с тем же системным промптом
//   … --task visit-card        одна задача (можно несколько --task; `conflicting-test/v2` — один вариант)
//   … --suite honesty          задачи честности H-0 (research/24 §4.1): casual (по умолчанию), honesty, all
//   … --timeout 900            секунд на задачу (по умолчанию 600)
//   … --prompt pi              базовый промпт Pi вместо своего (research/17 §9); по умолчанию prsloy
//   … --prompt diet            диета промпта (H-1p, #6): ≤4 000 знаков; A/B против prsloy на каждой модели
//   … --delta on               дельта промпта под модель (qwen, opus)
//   … --suite web --web on     кодовые задачи с поиском (issue #23): web_search/web_fetch (флаг "webTools")
//   … --lessons off            без уроков (флаг "lessons" в prsloy-harness.json агента)
//   … --review off             без второго мнения (флаг "secondOpinion"): честный A/B цены ревью
//   … --skills on              с курированными навыками (флаг "skills", S9; по умолчанию выкл.)
//   … --memory off             без памяти (флаг "memory")
//   … --honest-exit on         инструмент report_blocker (флаг "honestExit", H-1; по умолчанию выкл.)
//   … --test-guard on          страж старых тестов (флаг "testGuard", H-1; по умолчанию выкл.)
//   … --test-quality on        полезность новых тестов (флаг "testQuality", H-3; по умолчанию выкл.)
//   … --reviewer-cheats on     ревьюер ищет подгонку (флаг "reviewerCheats", H-4; по умолчанию выкл.)
//   … --claim-check on         слова и факты (флаг "claimCheck", H-2: H6–H8; по умолчанию выкл.)
//   … --audit                  разборщик сессий после прогона (research/24 §6, ci; пока только метка в отчёте)
//   … --allow-outside          отвечать «Да» на «менять файлы вне проекта?» (по умолчанию «Нет»)
//   … --out bench-out          куда писать отчёт, сессии и папки задач; результат каждой задачи — results/<задача>.json
//   … --resume bench-out       продолжить прерванный прогон в этой папке: готовые задачи не гоняются, отчёт — по всем
//                              (настройки — те же, что в прошлый раз; иначе ошибка)
//   … --lessons-file <json>    уроки вместо lessons/code.json пакета (оффлайн-улучшатель, #33)
//   … --skills-dir <папка>     навыки из папки <навык>/SKILL.md вместо встроенных; включает навыки (#33)
//   … --delta-file <md>        добавка промпта модели из файла; включает дельту (#33)
// Итог: <out>/bench-<модель>-<on|off>-<время>.md и .json. Ключ берётся только из окружения и никуда не пишется.
// Выход 0 — у всех проверенных задач исход тот, что ждали (обычно «решено»; у задач честности — например «жулик
// пойман», research/24 §4.1); 1 — нет; 2 — не запустилось.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PRSLOY_DEFAULT_BASE_URL } from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { reportMarkdown, runBench } from "../bench/run.ts";
import { skillFilesFromDir } from "../src/skills.ts";

const { values } = parseArgs({
  options: {
    fake: { type: "boolean" },
    harness: { type: "string", default: "on" },
    model: { type: "string", default: "prsloy/deepseek-v4.1-flash-1017" },
    "base-url": { type: "string" },
    task: { type: "string", multiple: true },
    suite: { type: "string", default: "casual" },
    timeout: { type: "string", default: "600" },
    "allow-outside": { type: "boolean" },
    lessons: { type: "string", default: "on" },
    review: { type: "string", default: "on" },
    skills: { type: "string", default: "off" },
    audit: { type: "boolean", default: false },
    prompt: { type: "string", default: "prsloy" },
    delta: { type: "string", default: "off" },
    memory: { type: "string", default: "on" },
    "honest-exit": { type: "string", default: "off" },
    "test-guard": { type: "string", default: "off" },
    "test-quality": { type: "string", default: "off" },
    "reviewer-cheats": { type: "string", default: "off" },
    "claim-check": { type: "string", default: "off" },
    web: { type: "string", default: "off" },
    out: { type: "string", default: "bench-out" },
    resume: { type: "string" },
    "lessons-file": { type: "string" },
    "skills-dir": { type: "string" },
    "delta-file": { type: "string" },
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
  if (!["casual", "honesty", "web", "all"].includes(values.suite)) {
    console.error("--suite casual|honesty|web|all");
    return 2;
  }
  const key = process.env.PRSLOY_GATEWAY_KEY ?? process.env.PRSLOY_KEY;
  if (!values.fake && !key) {
    console.error("Нужен ключ шлюза в PRSLOY_GATEWAY_KEY (или --fake).");
    return 2;
  }
  const outDir = resolve(values.resume ?? values.out);
  const report = await runBench({
    ...(values.resume ? { resume: true } : {}),
    harness: values.harness === "on",
    lessons: values.lessons !== "off",
    review: values.review !== "off",
    skills: values.skills === "on",
    audit: values.audit === true,
    prompt: values.prompt === "pi" || values.prompt === "diet" ? values.prompt : "prsloy",
    delta: values.delta === "on",
    memory: values.memory !== "off",
    honestExit: values["honest-exit"] === "on",
    testGuard: values["test-guard"] === "on",
    testQuality: values["test-quality"] === "on",
    reviewerCheats: values["reviewer-cheats"] === "on",
    claimCheck: values["claim-check"] === "on",
    webTools: values.web === "on",
    model: values.model,
    ...(values.fake ? { fake: true } : { baseUrl: values["base-url"] ?? PRSLOY_DEFAULT_BASE_URL }),
    ...(key && !values.fake ? { key } : {}),
    ...(values.task?.length ? { tasks: values.task } : {}),
    suite: values.suite as "casual" | "honesty" | "web" | "all",
    outDir,
    timeoutSec: Number(values.timeout) || 600,
    allowOutside: values["allow-outside"] === true,
    ...(values["lessons-file"] ? { lessonsFile: resolve(values["lessons-file"]) } : {}),
    ...(values["skills-dir"]
      ? { skillFiles: skillFilesFromDir(resolve(values["skills-dir"])) }
      : {}),
    ...(values["delta-file"]
      ? { deltaText: readFileSync(values["delta-file"], "utf8").trim() }
      : {}),
    log: (line) => console.log(line),
  });
  const stamp = report.meta.date.replace(/[:.]/g, "-");
  const mode = `${values.harness}-${values.prompt}${values.delta === "on" ? "-delta" : ""}${values.lessons === "off" ? "-nolessons" : ""}${values.review === "off" ? "-noreview" : ""}${values.skills === "on" ? "-skills" : ""}${values.memory === "off" ? "-nomemory" : ""}${values.web === "on" ? "-web" : ""}`;
  const base = join(outDir, `bench-${values.model.replace(/\//g, "_")}-${mode}-${stamp}`);
  const md = reportMarkdown(report);
  writeFileSync(`${base}.md`, md);
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${md}\nОтчёт: ${base}.md, ${base}.json`);
  return report.totals.unexpected === 0 ? 0 : 1;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error);
  return 2;
});
