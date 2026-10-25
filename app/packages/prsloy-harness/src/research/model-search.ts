// Последний запасной путь поиска (issue #23): встроенный поиск модели через шлюз PRSLOY — Chat Completions с
// `web_search_options`. Работает не у всех моделей (замер дирижёра 2026-10-25: на шлюзе владельца — gpt-6.1-sol;
// на a6 — gpt-5.4 и grok-4.20-multi-agent-0309), поэтому список моделей настраивается (по каталогу шлюза) и
// пробуется по порядку. Источники берутся из аннотаций url_citation и строк ответа; код их не проверял — это видно в выдаче («поиск модели, источники не проверены кодом»).
import { clean, dated, netReason, SearchError, timeoutSignal } from "./common.ts";
import type { SearchDeps, SearchHit, SearchQuery } from "./search.ts";

export const MODEL_SEARCH_MODELS: readonly string[] = ["gpt-6.1-sol"];
const MODEL_TIMEOUT_MS = 60_000;
const MODEL_SEARCH_BUDGET_MS = 120_000;
export const MODEL_SEARCH_NOTE = "поиск модели, источники не проверены кодом";

const LINE =
  /(https?:\/\/[^\s)\]>»"']+)\s*[—–-]+\s*(\d{4}-\d{2}-\d{2}|unknown|неизвестно)?\s*[—–-]*\s*(.*)$/;

interface Annotation {
  type?: string;
  url?: string;
  title?: string;
  url_citation?: { url?: string; title?: string };
}

/** Ответ модели → источники: аннотации, затем строки «URL — дата — суть» из текста. */
export function modelHits(text: string, annotations: Annotation[]): SearchHit[] {
  const byUrl = new Map<string, SearchHit>();
  const lines = new Map<string, { date?: string; summary: string }>();
  for (const ln of text.split("\n")) {
    const m = LINE.exec(ln);
    if (!m) continue;
    const url = m[1]!.replace(/[.,;:]+$/, "");
    lines.set(url, { ...(m[2] && /\d/.test(m[2]) ? { date: m[2] } : {}), summary: m[3] ?? "" });
  }
  const add = (url: string | undefined, title = "") => {
    if (!url || !/^https?:\/\//.test(url) || byUrl.has(url)) return;
    const l = lines.get(url);
    byUrl.set(url, {
      url,
      title: clean(title, 200),
      snippet: clean(l?.summary, 400),
      ...dated(l?.date),
      provider: "model",
    });
  };
  for (const a of annotations) add(a.url_citation?.url ?? a.url, a.url_citation?.title ?? a.title);
  for (const url of lines.keys()) add(url);
  return [...byUrl.values()];
}

/**
 * Модели по порядку: неверный ключ — сразу ошибка; у модели ошибка или пустая выдача (поиска у неё нет) —
 * следующая.
 */
export async function modelSearch(
  gateway: { url: string; key: string; models?: readonly string[] },
  q: SearchQuery,
  deps: SearchDeps = {},
): Promise<SearchHit[]> {
  const models = gateway.models?.length ? gateway.models : MODEL_SEARCH_MODELS;
  let last: SearchError | undefined;
  // весь перебор — не дольше MODEL_SEARCH_BUDGET_MS, каждая модель — не дольше MODEL_TIMEOUT_MS; Esc — сразу
  const deadline = Date.now() + MODEL_SEARCH_BUDGET_MS;
  for (const model of models) {
    const left = deadline - Date.now();
    if (deps.signal?.aborted) throw new SearchError("network", "Поиск модели: остановлено");
    if (left <= 1_000) break;
    try {
      const hits = await askModel(model, gateway, q, {
        ...deps,
        timeoutMs: Math.min(deps.timeoutMs ?? MODEL_TIMEOUT_MS, left),
      });
      if (hits.length) return hits;
      last = new SearchError("format", `Поиск модели: ${model} не вернула источников`);
    } catch (e) {
      const err =
        e instanceof SearchError ? e : new SearchError("network", `Поиск модели (${model}): сбой`);
      if (err.code === "auth") throw err;
      last = err;
    }
  }
  throw last ?? new SearchError("network", "Поиск модели: время вышло");
}

async function askModel(
  model: string,
  gateway: { url: string; key: string },
  q: SearchQuery,
  deps: SearchDeps,
): Promise<SearchHit[]> {
  const now = deps.now?.() ?? new Date();
  const count = Math.min(10, Math.max(1, Math.round(q.count ?? 8)));
  const base = gateway.url.replace(/\/+$/, "").replace(/\/v1$/, "");
  const ask = [
    q.query,
    q.site ? `Only pages on ${q.site}.` : "",
    q.freshness ? `Only pages from the last ${q.freshness}.` : "",
    q.lang === "ru" ? "Prefer Russian sources." : "",
  ]
    .filter(Boolean)
    .join(" ");
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gateway.key}` },
      body: JSON.stringify({
        model,
        web_search_options: {},
        messages: [
          {
            role: "system",
            content:
              `Today is ${now.toISOString().slice(0, 10)}. Search the web and list up to ${count} current primary ` +
              "sources for the query, one per line: URL — publication date (YYYY-MM-DD or unknown) — one sentence " +
              "on what the page says. No other text.",
          },
          { role: "user", content: ask },
        ],
      }),
      signal: timeoutSignal(deps.timeoutMs ?? MODEL_TIMEOUT_MS, deps.signal),
    });
  } catch (e) {
    throw new SearchError("network", `Поиск модели (${model}): нет ответа (${netReason(e)})`);
  }
  if (res.status === 401 || res.status === 403)
    throw new SearchError(
      "auth",
      `Поиск модели (${model}): ключ шлюза не принят (HTTP ${res.status})`,
    );
  if (res.status === 402 || res.status === 429)
    throw new SearchError(
      "limit",
      `Поиск модели (${model}): лимит или баланс исчерпан (HTTP ${res.status})`,
    );
  if (!res.ok) throw new SearchError("network", `Поиск модели (${model}): HTTP ${res.status}`);
  const data = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string; annotations?: Annotation[] } }[];
  } | null;
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new SearchError("format", `Поиск модели (${model}): пустой ответ`);
  return modelHits(msg.content ?? "", msg.annotations ?? []).slice(0, count);
}
