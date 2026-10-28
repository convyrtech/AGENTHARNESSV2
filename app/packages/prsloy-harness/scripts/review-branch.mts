// Живое второе мнение по настоящему диффу ветки (не по синтетическим случаям review-live.mts): тот же промпт
// проверяющего, тот же разбор ответа (parseVerdict: замечание засчитывается только с цитатой из диффа) и тот же
// прокси надёжности, что в приложении. Пригождается, когда ход делал не человек-ревьюер, а агент.
//
//   PRSLOY_GATEWAY_KEY=… node packages/prsloy-harness/scripts/review-branch.mts --task "что просил пользователь"
//   … --base 6c95a70                   с чем сравнивать; по умолчанию — база ветки
//   … --reviewer kimi-k3.1-pro         проверяющий; по умолчанию пара к писателю задачи
//   … --checks "итог проверок"         текст для проверяющего; по умолчанию берётся из задачи
//   … --out review.json                куда писать разбор
//   … --max-requests 3                 потолок платных запросов; 402 — стоп сразу
//
// Ключ берётся только из окружения, в вывод и файл не попадает.
// Выход 0 — PASS; 1 — ошибка шлюза; 2 — не запустилось; 3 — 402; 4 — FAIL с замечаниями.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  PRSLOY_DEFAULT_BASE_URL,
  PRSLOY_MODELS,
  prsloyModelCost,
} from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { ReliabilityProxy } from "../src/reliability-proxy.ts";
import {
  changedLines,
  clipDiff,
  parseVerdict,
  pickModel,
  reviewerFor,
  reviewPrompt,
} from "../src/second-opinion.ts";

/** Корень репозитория: scripts → prsloy-harness → packages → app → корень. */
const REPO = resolve(import.meta.dirname, "../../../..");

const DEFAULT_TASK = "(задача не передана: см. --task)";
const DEFAULT_CHECKS = "(итог проверок не передан: см. --checks)";

function costRub(model: string, usage: Record<string, number> | undefined): number {
  const price = prsloyModelCost(model);
  if (!price || !usage) return 0;
  const cached = usage.prompt_tokens_details_cached ?? 0;
  const input = (usage.prompt_tokens ?? 0) - cached;
  return (
    (input * price.input +
      cached * (price.cacheRead ?? price.input) +
      (usage.completion_tokens ?? 0) * price.output) /
    1_000_000
  );
}

function branchDiff(base: string, paths: readonly string[]): string {
  return execFileSync(
    "git",
    ["diff", base, "--", ...(paths.length ? paths : ["."]), ":(exclude)*.png", ":(exclude)*.lock"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      reviewer: { type: "string" },
      task: { type: "string" },
      checks: { type: "string" },
      out: { type: "string" },
      "max-requests": { type: "string", default: "3" },
      "base-url": { type: "string" },
      /** Пути внутри репозитория: дифф только по ним (обрезка большого диффа теряет файлы). */
      path: { type: "string", multiple: true },
      /** Потолок символов диффа в промпте. */
      limit: { type: "string", default: "24000" },
    },
  });
  const key = process.env.PRSLOY_GATEWAY_KEY ?? process.env.PRSLOY_KEY;
  if (!key) {
    console.error("Нужен ключ шлюза в PRSLOY_GATEWAY_KEY.");
    return 2;
  }
  const writer = "deepseek-v4.1-flash-1017";
  const ids = PRSLOY_MODELS.map((m) => ({ id: m.id }));
  const wanted = values.reviewer ?? reviewerFor(writer);
  const reviewer = wanted ? pickModel(ids, wanted)?.id : undefined;
  if (!reviewer) {
    console.error(`Проверяющего ${wanted ?? "(пара не нашлась)"} нет в каталоге.`);
    return 2;
  }
  const task = values.task ?? DEFAULT_TASK;
  const checks = values.checks ?? DEFAULT_CHECKS;
  const maxRequests = Math.max(1, Number(values["max-requests"]) || 1);
  const base = values.base ?? "@{upstream}";
  const out = resolve(values.out ?? "review-branch.json");

  const raw = branchDiff(base, values.path ?? []);
  if (!raw.trim()) {
    console.error(`git diff ${base} пуст — нечего проверять.`);
    return 2;
  }
  const limit = Math.max(2_000, Number(values.limit) || 24_000);
  const diff = clipDiff(raw, limit, true);
  console.log(
    `Дифф ${base}..HEAD${values.path?.length ? ` (${values.path.join(", ")})` : ""}: ` +
      `${changedLines(raw)} строк изменено, в промпт ушло ${diff.length} из ${raw.length} символов`,
  );

  const proxy = new ReliabilityProxy();
  await proxy.start();
  const metrics = join(mkdtempSync(join(tmpdir(), "prsloy-review-")), "proxy.jsonl");
  const baseUrl = proxy.route(
    values["base-url"] ?? PRSLOY_DEFAULT_BASE_URL,
    metrics,
    "review-branch",
  );
  let total = 0;
  let calls = 0;
  try {
    const prompt = reviewPrompt({ task, diff, checks, cheats: true });
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: reviewer,
        max_tokens: 16_000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    calls += 1;
    const body = (await response.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
      error?: { message?: string };
    };
    if (response.status === 402) {
      console.error(`Шлюз ответил 402 (${body.error?.message ?? "нет средств"}) — останавливаюсь.`);
      return 3;
    }
    if (!response.ok || body.error) {
      console.error(`Шлюз ответил ${response.status} ${body.error?.message ?? ""}`);
      return 1;
    }
    const usage = body.usage && {
      prompt_tokens: body.usage.prompt_tokens ?? 0,
      completion_tokens: body.usage.completion_tokens ?? 0,
      prompt_tokens_details_cached: body.usage.prompt_tokens_details?.cached_tokens ?? 0,
    };
    total = costRub(reviewer, usage);
    const text = body.choices?.[0]?.message?.content ?? "";
    const verdict = parseVerdict(text, diff);
    console.log(
      `\nПроверяющий ${reviewer}: ${verdict.verdict}` +
        `${verdict.invalid ? " (ответ не разобран как JSON)" : ""}; ` +
        `замечаний с цитатой ${verdict.items.length}, отброшено без цитаты ${verdict.rejected}`,
    );
    for (const item of verdict.items)
      console.log(
        `\n  ${item.file}${item.line ? `:${item.line}` : ""} — ${item.problem}\n    «${item.evidence}»`,
      );
    if (verdict.invalid) console.log(`\nОтвет модели:\n${text.slice(0, 3_000)}`);
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          base,
          reviewer,
          verdict: verdict.verdict,
          invalid: verdict.invalid,
          items: verdict.items,
          rejected: verdict.rejected,
          diffLines: changedLines(raw),
          requested: calls,
          usage,
          costRub: total,
        },
        null,
        2,
      )
        .split(key)
        .join("***")}\n`,
    );
    console.log(
      `\nЗапросов: ${calls} из ${maxRequests}; токенов: вход ${usage?.prompt_tokens ?? 0}, ` +
        `выход ${usage?.completion_tokens ?? 0}; цена ${total.toFixed(6)} ₽; разбор: ${out}`,
    );
    return verdict.verdict === "PASS" ? 0 : 4;
  } finally {
    await proxy.close();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  const key = process.env.PRSLOY_GATEWAY_KEY ?? process.env.PRSLOY_KEY ?? "no-key";
  console.error(error instanceof Error ? error.message.split(key).join("***") : error);
  return 2;
});
