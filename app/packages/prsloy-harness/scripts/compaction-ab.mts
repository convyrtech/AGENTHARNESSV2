// A/B сжатия истории (#76): локальный пересказ против дешёвых моделей на одной и той же обезличенной истории.
//
//   node packages/prsloy-harness/scripts/compaction-ab.mts                      # бесплатно: только локальные варианты
//   node packages/prsloy-harness/scripts/compaction-ab.mts --plan               # что будет вызвано, цены и потолок бюджета
//   PRSLOY_GATEWAY_KEY=… node … --spend --budget-tokens 40000                   # платные вызовы, только по разрешению
//
// Считается одинаково для всех вариантов: сколько фактов задачи пережило сжатие (по точным строкам из
// bench/compaction/history.json), длина пересказа, время, токены. Деньги: цена из таблицы приложения — это
// ОЦЕНКА и она помечается как оценка; фактическое списание — разница /v1/dashboard/billing/usage до и после
// вызова, единицы которого не подтверждены, поэтому пишется как есть, без пересчёта в рубли.
// Ключ берётся только из окружения и никуда не пишется. Fable и Opus в списке моделей нет и быть не может.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PRSLOY_DEFAULT_BASE_URL } from "../../../apps/desktop/src/shared/prsloy-config.ts";
import { prsloyPriceFor } from "../../../apps/desktop/src/shared/prsloy-prices.ts";
import { factsFromEntries, renderThread } from "../src/task-thread.ts";
import { localSummaryText } from "../src/continuation-guard.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HISTORY = join(HERE, "..", "bench", "compaction", "history.json");

/** Модели для сжатия: только дешёвые и только из каталога шлюза. Fable и Opus здесь запрещены владельцем. */
const CANDIDATES = ["deepseek-v4.1-flash-1017", "gemini-3.8-flash"] as const;

interface Fact {
  id: string;
  needle: string;
  what: string;
}
interface History {
  task: string;
  facts: Fact[];
  entries: unknown[];
}

const HISTORY_PROMPT = [
  "Ты сжимаешь историю работы агента, чтобы он продолжил задачу без потерь.",
  "Верни короткий пересказ: что просил пользователь (дословно важные требования и запреты), какие файлы менялись,",
  "какие команды запускались и чем кончились, какие ошибки остались, что уже сделано и что не закончено.",
  "Ничего не выдумывай. Не добавляй советов и рассуждений.",
].join("\n");

function historyText(history: History): string {
  const lines: string[] = [`Задача: ${history.task}`, ""];
  for (const raw of history.entries) {
    const entry = raw as { message?: { role?: string; content?: unknown } };
    const m = entry.message;
    if (!m) continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = parts
      .map((p) => {
        const part = p as { type?: string; text?: string; name?: string; arguments?: unknown };
        if (part.type === "text" && part.text) return part.text;
        if (part.type === "toolCall")
          return `[вызов ${part.name}] ${JSON.stringify(part.arguments)}`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) lines.push(`### ${m.role ?? "?"}\n${text}`);
  }
  return lines.join("\n");
}

interface Candidate {
  id: string;
  /** Бесплатный: считается в процессе, без сети. */
  local?: boolean;
  text: string;
  notes?: string;
}

function localCandidates(history: History): Candidate[] {
  const facts = factsFromEntries(history.entries);
  const thread = renderThread(facts, undefined);
  return [
    {
      id: "local-now",
      local: true,
      text: localSummaryText(),
      notes: "то, что приложение пишет сейчас: без фактов задачи",
    },
    {
      id: "local-now+prev",
      local: true,
      text: localSummaryText("Предыдущий пересказ: форма заказа готова, доставка в работе."),
      notes: "то же плюс сохранённый прошлый пересказ",
    },
    {
      id: "local+thread",
      local: true,
      text: `${localSummaryText()}\n\n${thread}`,
      notes: "локальный пересказ + нить задачи харнесса (флаг taskThread), факты из записей сессии",
    },
  ];
}

function score(facts: readonly Fact[], text: string) {
  const kept = facts.filter((f) => text.includes(f.needle));
  return {
    kept: kept.length,
    total: facts.length,
    missing: facts.filter((f) => !kept.includes(f)).map((f) => f.what),
    chars: text.length,
  };
}

/** Цена по розничной таблице шлюза в ₽ — ОЦЕНКА. null — цена неизвестна (не ноль!). */
function estimateRub(model: string, prompt: number, completion: number): number | null {
  const price = prsloyPriceFor(model);
  if (!price) return null;
  return (prompt * price.input + completion * price.output) / 1_000_000;
}

async function billingUsage(key: string, baseUrl: string): Promise<number | null> {
  const url = `${baseUrl.replace(/\/v1\/?$/, "")}/v1/dashboard/billing/usage`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const json = (await res.json()) as { total_usage?: number };
    return typeof json.total_usage === "number" ? json.total_usage : null;
  } catch {
    return null;
  }
}

interface PaidResult {
  model: string;
  status: number;
  seconds: number;
  prompt: number | null;
  completion: number | null;
  cached: number | null;
  reasoning: number | null;
  requestId: string | null;
  text: string;
  error?: string;
}

async function askModel(
  model: string,
  history: History,
  key: string,
  baseUrl: string,
  maxTokens: number,
): Promise<PaidResult> {
  const started = Date.now();
  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
    messages: [
      { role: "system", content: HISTORY_PROMPT },
      { role: "user", content: historyText(history) },
    ],
  };
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const seconds = (Date.now() - started) / 1000;
  let json: Record<string, any> | undefined;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const usage = (json?.usage ?? {}) as Record<string, any>;
  return {
    model,
    status: res.status,
    seconds,
    prompt: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
    completion: typeof usage.completion_tokens === "number" ? usage.completion_tokens : null,
    cached:
      typeof usage.prompt_tokens_details?.cached_tokens === "number"
        ? usage.prompt_tokens_details.cached_tokens
        : null,
    reasoning:
      typeof usage.completion_tokens_details?.reasoning_tokens === "number"
        ? usage.completion_tokens_details.reasoning_tokens
        : null,
    requestId: res.headers.get("x-request-id"),
    text:
      typeof json?.choices?.[0]?.message?.content === "string"
        ? json.choices[0].message.content
        : "",
    ...(res.ok ? {} : { error: raw.slice(0, 200) }),
  };
}

const { values } = parseArgs({
  options: {
    plan: { type: "boolean" },
    spend: { type: "boolean" },
    model: { type: "string", multiple: true },
    "max-tokens": { type: "string", default: "900" },
    "budget-tokens": { type: "string" },
    "base-url": { type: "string" },
  },
});

const history = JSON.parse(readFileSync(HISTORY, "utf8")) as History;
const models = (values.model?.length ? values.model : CANDIDATES).filter(
  (m) => !/fable|opus/i.test(m),
);
const baseUrl = values["base-url"] ?? PRSLOY_DEFAULT_BASE_URL;
const maxTokens = Number(values["max-tokens"]);
const budgetTokens = values["budget-tokens"] ? Number(values["budget-tokens"]) : undefined;
const key = process.env.PRSLOY_GATEWAY_KEY;

// Потолок бесплатной части: один вызов на модель, вход — вся история, выход — maxTokens.
const historyChars = historyText(history).length;
const worstInputTokens = Math.ceil(historyChars / 3);
const worstTokens = models.length * (worstInputTokens + maxTokens);

const rows: Array<{
  id: string;
  kind: "local" | "model";
  score: ReturnType<typeof score>;
  seconds: number | null;
  tokens: string;
  cost: string;
  notes: string;
}> = [];

for (const candidate of localCandidates(history)) {
  rows.push({
    id: candidate.id,
    kind: "local",
    score: score(history.facts, candidate.text),
    seconds: 0,
    tokens: "0 / 0",
    cost: "0 (без сети)",
    notes: candidate.notes ?? "",
  });
}

if (values.plan || !values.spend) {
  console.log(`История: ${history.entries.length} записей, ${historyChars} знаков.`);
  console.log(`Модели для платной части: ${models.join(", ")}`);
  for (const model of models) {
    const price = prsloyPriceFor(model);
    console.log(
      price
        ? `  ${model}: ${price.input} ₽/${price.output} ₽ за 1M вход/выход (розница шлюза, #52)`
        : `  ${model}: цена неизвестна — фактическое списание мерить по журналу шлюза, не считать нулём`,
    );
  }
  console.log(
    `Потолок платной части: ${models.length} вызовов, ≤ ${worstTokens} токенов (вход ≈ ${worstInputTokens} + выход ${maxTokens})` +
      (budgetTokens !== undefined ? `, разрешено не больше ${budgetTokens}` : ""),
  );
  if (!values.spend)
    console.log("Платные вызовы не делались: нужен флаг --spend и разрешение владельца.");
}

if (values.spend) {
  if (!key) {
    console.error("Нужен ключ шлюза в PRSLOY_GATEWAY_KEY (или запусти без --spend).");
    process.exit(2);
  }
  if (budgetTokens === undefined) {
    console.error("С --spend обязателен --budget-tokens: без потолка не запускаемся.");
    process.exit(2);
  }
  if (worstTokens > budgetTokens) {
    console.error(
      `Потолок ${worstTokens} токенов больше разрешённого ${budgetTokens}: сократи историю, выход или список моделей.`,
    );
    process.exit(2);
  }
  let spent = 0;
  for (const model of models) {
    const before = await billingUsage(key, baseUrl);
    const result = await askModel(model, history, key, baseUrl, maxTokens);
    const after = await billingUsage(key, baseUrl);
    const used = (result.prompt ?? 0) + (result.completion ?? 0);
    spent += used;
    const estimate = estimateRub(model, result.prompt ?? 0, result.completion ?? 0);
    const billing =
      before !== null && after !== null
        ? `списание шлюза ${(after - before).toFixed(4)} (единицы не подтверждены)`
        : "списание шлюза: неизвестно";
    rows.push({
      id: model,
      kind: "model",
      score: score(history.facts, result.text),
      seconds: result.seconds,
      tokens: `${result.prompt ?? "?"} / ${result.completion ?? "?"}`,
      cost:
        (estimate === null ? "оценка: цена неизвестна" : `оценка $${estimate.toFixed(6)}`) +
        `; ${billing}`,
      notes: [
        result.error ? `ошибка ${result.status}: ${result.error}` : `HTTP ${result.status}`,
        result.requestId ? `x-request-id ${result.requestId}` : "x-request-id нет",
        result.cached !== null ? `кэш ${result.cached}` : "",
        result.reasoning !== null ? `reasoning ${result.reasoning}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    });
    if (spent > budgetTokens) {
      console.error(`Бюджет ${budgetTokens} токенов исчерпан — останавливаюсь.`);
      break;
    }
  }
}

const header = "| вариант | факты | знаков | сек | токены вход/выход | деньги | примечание |";
console.log(`\n${header}\n|---|---|---|---|---|---|---|`);
for (const row of rows) {
  console.log(
    `| ${row.id} | ${row.score.kept}/${row.score.total} | ${row.score.chars} | ${row.seconds ?? "—"} | ${row.tokens} | ${row.cost} | ${row.notes} |`,
  );
}
for (const row of rows)
  if (row.score.missing.length)
    console.log(`\n${row.id}: потеряно — ${row.score.missing.join(", ")}`);
