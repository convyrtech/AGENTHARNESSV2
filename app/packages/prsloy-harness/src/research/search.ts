// Поиск в интернете для «Исследовать» (research/26 §3, §4.8; issue #23): один интерфейс над поставщиками, которые
// доступны из России. Поиск PRSLOY — через шлюз (`/v1/tools/search`, формат DeepSeek Search), свой ключ — DeepSeek,
// Яндекс, свой SearXNG, Brave, Exa, Firecrawl, Jina. Tavily нет: условия запрещают пользователей в России (§3.2).
// Ключи сюда приходят из main (safeStorage) через передачу хосту; в окружение агента они не попадают.
// Результаты поиска — данные со сторонних сайтов, а не инструкции.
import { clean, dated, netReason, SearchError, type SearchErrorCode } from "./common.ts";
import { freeSearch, githubRepo } from "./free.ts";
import { ERROR_LIKE, githubLatest, githubSearch } from "./github.ts";
import { modelSearch } from "./model-search.ts";

export { SearchError, type SearchErrorCode } from "./common.ts";

export type SearchProviderId =
  | "free"
  | "model"
  | "prsloy"
  | "deepseek"
  | "yandex"
  | "searxng"
  | "brave"
  | "exa"
  | "firecrawl"
  | "jina"
  | "github";

/** Порядок на экране: бесплатный, свои ключи, PRSLOY (#31), модель. */
export const SEARCH_PROVIDERS: readonly SearchProviderId[] = [
  "free",
  "deepseek",
  "yandex",
  "searxng",
  "brave",
  "exa",
  "firecrawl",
  "jina",
  "github",
  "prsloy",
  "model",
];

export interface SearchConfig {
  provider: SearchProviderId;
  /** Ключ поставщика (для prsloy и model — ключ шлюза PRSLOY). */
  key?: string;
  /** Яндекс: ID каталога. */
  folderId?: string;
  /**
   * SearXNG: адрес своего сервера; prsloy и model: адрес шлюза (`https://…/v1` или без `/v1`); free: SearXNG
   * владельца (#31), если задан, — вместо DuckDuckGo.
   */
  url?: string;
  /** Токен GitHub из настроек: бесплатный поиск ходит в GitHub с ним (лимиты выше). У поставщика github — key. */
  githubToken?: string;
  /** model: модели со встроенным поиском по порядку (по каталогу шлюза); по умолчанию gpt-6.1-sol. */
  models?: string[];
}

export type Freshness = "day" | "week" | "month" | "year";

export interface SearchQuery {
  query: string;
  /** Сколько результатов, 1–20. */
  count?: number;
  /** Только свежее: фильтр поставщика, где он есть. */
  freshness?: Freshness;
  /** Только опубликованное после даты (YYYY-MM-DD), где поставщик умеет. */
  after?: string;
  lang?: "ru" | "en";
  /** Только этот сайт (`site:` у тех, кто умеет). */
  site?: string;
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  /** Дата публикации от поставщика (ISO), если он её знает. */
  date?: string;
  /** Авторитетность 0–4 (DeepSeek), если есть. */
  authority?: number;
  provider: SearchProviderId;
}

export interface SearchDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Сегодня (для фильтров свежести тех, кто принимает дату). */
  now?: () => Date;
  /** Сбой источника внутри поиска, который не сорвал выдачу (лимит GitHub, неверный токен): показать человеку. */
  onIssue?: (provider: SearchProviderId, error: SearchError) => void;
}

const NAME: Record<SearchProviderId, string> = {
  free: "Бесплатный поиск",
  model: "Поиск модели",
  prsloy: "Поиск PRSLOY",
  deepseek: "DeepSeek",
  yandex: "Яндекс",
  searxng: "SearXNG",
  brave: "Brave",
  exa: "Exa",
  firecrawl: "Firecrawl",
  jina: "Jina",
  github: "GitHub",
};

export function providerName(id: SearchProviderId): string {
  return NAME[id];
}

const DAYS: Record<Freshness, number> = { day: 1, week: 7, month: 31, year: 366 };

function since(q: SearchQuery, now: Date): string | undefined {
  if (q.after) return q.after;
  if (!q.freshness) return undefined;
  return new Date(now.getTime() - DAYS[q.freshness] * 86_400_000).toISOString().slice(0, 10);
}

/** Код ответа поставщика → понятная ошибка. */
function httpError(provider: SearchProviderId, status: number): SearchError {
  const who = NAME[provider];
  if (status === 401 || (status === 403 && provider !== "searxng"))
    return new SearchError("auth", `${who}: ключ не принят (HTTP ${status})`);
  if (status === 402 || status === 429)
    return new SearchError("limit", `${who}: лимит или баланс исчерпан (HTTP ${status})`);
  if (provider === "searxng" && status === 403)
    return new SearchError(
      "format",
      "SearXNG: JSON выключен — добавьте json в search.formats в settings.yml",
    );
  if (provider === "prsloy" && (status === 404 || status === 405 || status === 501))
    return new SearchError(
      "no_channel",
      "Поиска через шлюз пока нет: у шлюза нет канала /v1/tools/search",
    );
  // тело ответа не показываем: сервер может повторить в нём ключ
  return new SearchError("network", `${who}: HTTP ${status}`);
}

async function call(
  provider: SearchProviderId,
  url: string,
  init: RequestInit,
  deps: SearchDeps,
): Promise<unknown> {
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new SearchError("network", `${NAME[provider]}: нет ответа (${netReason(e)})`);
  }
  const text = await res.text();
  if (!res.ok) throw httpError(provider, res.status);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SearchError("format", `${NAME[provider]}: ответ не JSON`);
  }
}

function need(cfg: SearchConfig, field: "key" | "folderId" | "url"): string {
  const value = cfg[field]?.trim();
  if (!value) {
    const what = field === "key" ? "ключа" : field === "folderId" ? "ID каталога" : "адреса";
    throw new SearchError("no_key", `${NAME[cfg.provider]}: нет ${what}`);
  }
  return value;
}

/** Запрос с операторами DeepSeek (`lang:`, `after:`): так и шлюз, который проксирует DeepSeek. */
function deepseekQuery(q: SearchQuery, now: Date): string {
  const parts = [withSite(q)];
  if (q.lang) parts.push(`lang:${q.lang}`);
  const after = since(q, now);
  if (after) parts.push(`after:${after}`);
  return parts.join(" ").slice(0, 128);
}

interface DeepSeekResult {
  url?: string;
  title?: string;
  snippet?: string;
  summary?: string;
  date?: string | null;
  authority?: number;
}

function deepseekHits(data: unknown, provider: SearchProviderId): SearchHit[] {
  const results = (data as { results?: DeepSeekResult[] })?.results;
  if (!Array.isArray(results)) throw new SearchError("format", `${NAME[provider]}: нет results`);
  return results
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url!,
      title: clean(r.title, 200),
      snippet: clean(r.summary || r.snippet, 800),
      ...dated(r.date),
      ...(typeof r.authority === "number" && r.authority >= 0 ? { authority: r.authority } : {}),
      provider,
    }));
}

/** Адрес шлюза без `/v1` на конце. */
function gatewayBase(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Текст запроса с `site:`, если задан сайт. */
function withSite(q: SearchQuery): string {
  return q.site ? `${q.query.trim()} site:${q.site}` : q.query.trim();
}

export async function search(
  cfg: SearchConfig,
  q: SearchQuery,
  deps: SearchDeps = {},
): Promise<SearchHit[]> {
  const now = deps.now?.() ?? new Date();
  const count = Math.min(20, Math.max(1, Math.round(q.count ?? 8)));
  const json = { "Content-Type": "application/json" };
  switch (cfg.provider) {
    case "free": {
      const url = cfg.url?.trim();
      return freeSearch(
        { ...q, count: Math.min(10, count) },
        {
          ...deps,
          ...(url
            ? { searxng: (qq: SearchQuery) => search({ provider: "searxng", url }, qq, deps) }
            : {}),
          ...(cfg.githubToken ? { githubToken: cfg.githubToken } : {}),
        },
      );
    }
    case "model":
      return modelSearch(
        {
          url: need(cfg, "url"),
          key: need(cfg, "key"),
          ...(cfg.models?.length ? { models: cfg.models } : {}),
        },
        { ...q, count },
        deps,
      );
    case "github": {
      // Свой токен: репозитории, issues и код; owner/repo в запросе — ещё и последний релиз.
      const ghDeps = { ...deps, githubToken: need(cfg, "key") };
      const repo = githubRepo(q.query);
      const latest = repo ? await githubLatest(repo.owner, repo.repo, ghDeps).catch(() => []) : [];
      const kinds = ERROR_LIKE.test(q.query)
        ? (["issues", "code", "repos"] as const)
        : (["repos", "code", "issues"] as const);
      const found = await githubSearch(q.query, kinds, ghDeps, Math.min(10, count));
      return [...latest, ...found].slice(0, count);
    }
    case "prsloy":
    case "deepseek": {
      const base =
        cfg.provider === "prsloy" ? gatewayBase(need(cfg, "url")) : "https://api.deepseek.com";
      const data = await call(
        cfg.provider,
        `${base}/v1/tools/search`,
        {
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${need(cfg, "key")}` },
          body: JSON.stringify({ query: deepseekQuery(q, now), count }),
        },
        deps,
      );
      return deepseekHits(data, cfg.provider);
    }
    case "yandex": {
      const data = (await call(
        "yandex",
        "https://searchapi.api.cloud.yandex.net/v2/web/search",
        {
          method: "POST",
          headers: { ...json, Authorization: `Api-Key ${need(cfg, "key")}` },
          body: JSON.stringify({
            query: {
              searchType: q.lang === "en" ? "SEARCH_TYPE_COM" : "SEARCH_TYPE_RU",
              queryText: withSite(q),
            },
            folderId: need(cfg, "folderId"),
            groupSpec: {
              groupMode: "GROUP_MODE_DEEP",
              groupsOnPage: String(count),
              docsInGroup: "1",
            },
            responseFormat: "FORMAT_XML",
          }),
        },
        deps,
      )) as { rawData?: string };
      if (!data?.rawData) throw new SearchError("format", "Яндекс: нет rawData");
      return yandexHits(Buffer.from(data.rawData, "base64").toString("utf8")).slice(0, count);
    }
    case "searxng": {
      const params = new URLSearchParams({ q: withSite(q), format: "json" });
      if (q.lang) params.set("language", q.lang);
      if (q.freshness) params.set("time_range", q.freshness === "week" ? "week" : q.freshness);
      const base = need(cfg, "url").replace(/\/+$/, "");
      const data = (await call("searxng", `${base}/search?${params}`, { method: "GET" }, deps)) as {
        results?: { url?: string; title?: string; content?: string; publishedDate?: string }[];
      };
      if (!Array.isArray(data?.results)) throw new SearchError("format", "SearXNG: нет results");
      return data.results
        .filter((r) => r.url)
        .slice(0, count)
        .map((r) => ({
          url: r.url!,
          title: clean(r.title, 200),
          snippet: clean(r.content, 800),
          ...dated(r.publishedDate),
          provider: "searxng" as const,
        }));
    }
    case "brave": {
      const params = new URLSearchParams({ q: withSite(q), count: String(count) });
      if (q.lang) params.set("search_lang", q.lang);
      const after = q.after;
      if (after) params.set("freshness", `${after}to${now.toISOString().slice(0, 10)}`);
      else if (q.freshness)
        params.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[q.freshness]);
      const data = (await call(
        "brave",
        `https://api.search.brave.com/res/v1/web/search?${params}`,
        {
          method: "GET",
          headers: { Accept: "application/json", "X-Subscription-Token": need(cfg, "key") },
        },
        deps,
      )) as {
        web?: {
          results?: { url?: string; title?: string; description?: string; page_age?: string }[];
        };
      };
      return (data?.web?.results ?? [])
        .filter((r) => r.url)
        .map((r) => ({
          url: r.url!,
          title: clean(r.title, 200),
          snippet: clean(r.description, 800),
          ...dated(r.page_age),
          provider: "brave" as const,
        }));
    }
    case "exa": {
      const after = since(q, now);
      const data = (await call(
        "exa",
        "https://api.exa.ai/search",
        {
          method: "POST",
          headers: { ...json, "x-api-key": need(cfg, "key") },
          body: JSON.stringify({
            query: q.query,
            numResults: count,
            ...(q.site ? { includeDomains: [q.site] } : {}),
            type: "auto",
            contents: { highlights: true },
            ...(after ? { startPublishedDate: `${after}T00:00:00.000Z` } : {}),
          }),
        },
        deps,
      )) as {
        results?: {
          url?: string;
          title?: string;
          publishedDate?: string;
          highlights?: string[];
          text?: string;
        }[];
      };
      if (!Array.isArray(data?.results)) throw new SearchError("format", "Exa: нет results");
      return data.results
        .filter((r) => r.url)
        .map((r) => ({
          url: r.url!,
          title: clean(r.title, 200),
          snippet: clean((r.highlights ?? []).join(" … ") || r.text, 800),
          ...dated(r.publishedDate),
          provider: "exa" as const,
        }));
    }
    case "firecrawl": {
      const tbs = q.freshness
        ? `qdr:${{ day: "d", week: "w", month: "m", year: "y" }[q.freshness]}`
        : undefined;
      const data = (await call(
        "firecrawl",
        "https://api.firecrawl.dev/v2/search",
        {
          method: "POST",
          headers: { ...json, Authorization: `Bearer ${need(cfg, "key")}` },
          body: JSON.stringify({ query: withSite(q), limit: count, ...(tbs ? { tbs } : {}) }),
        },
        deps,
      )) as { data?: unknown };
      // v2: data.web[]; v1: data[]
      const raw = Array.isArray(data?.data) ? data.data : (data?.data as { web?: unknown[] })?.web;
      if (!Array.isArray(raw)) throw new SearchError("format", "Firecrawl: нет data");
      return (raw as { url?: string; title?: string; description?: string }[])
        .filter((r) => r.url)
        .map((r) => ({
          url: r.url!,
          title: clean(r.title, 200),
          snippet: clean(r.description, 800),
          provider: "firecrawl" as const,
        }));
    }
    case "jina": {
      const data = (await call(
        "jina",
        `https://s.jina.ai/?q=${encodeURIComponent(withSite(q))}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${need(cfg, "key")}`,
            "X-Respond-With": "no-content",
          },
        },
        deps,
      )) as { data?: { url?: string; title?: string; description?: string; date?: string }[] };
      if (!Array.isArray(data?.data)) throw new SearchError("format", "Jina: нет data");
      return data.data
        .filter((r) => r.url)
        .slice(0, count)
        .map((r) => ({
          url: r.url!,
          title: clean(r.title, 200),
          snippet: clean(r.description, 800),
          ...dated(r.date),
          provider: "jina" as const,
        }));
    }
  }
}

/** Ответ Яндекса (XML yandexsearch): документ → url, заголовок, отрывки. Даты в выдаче нет. */
export function yandexHits(xml: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const doc of xml.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/g)) {
    const body = doc[1]!;
    const url = /<url>([\s\S]*?)<\/url>/.exec(body)?.[1]?.trim();
    if (!url) continue;
    const title = /<title>([\s\S]*?)<\/title>/.exec(body)?.[1] ?? "";
    const passages = [...body.matchAll(/<passage>([\s\S]*?)<\/passage>/g)]
      .map((m) => m[1])
      .join(" … ");
    const headline = /<headline>([\s\S]*?)<\/headline>/.exec(body)?.[1] ?? "";
    out.push({
      url: decodeXml(url),
      title: decodeXml(clean(title, 200)),
      snippet: decodeXml(clean(passages || headline, 800)),
      provider: "yandex",
    });
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** «Проверить» в настройках: один запрос «Пушкин» на 1 результат из сети пользователя (research/26 §3.7). */
export async function checkProvider(
  cfg: SearchConfig,
  deps: SearchDeps = {},
): Promise<
  | { ok: true; latencyMs: number; dated: boolean; firstUrl: string }
  | { ok: false; code: SearchErrorCode; error: string }
> {
  const t0 = Date.now();
  try {
    const hits = await search(cfg, { query: "Пушкин", count: 1, lang: "ru" }, deps);
    if (!hits.length)
      return { ok: false, code: "format", error: `${NAME[cfg.provider]}: пустая выдача` };
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      dated: hits.some((h) => h.date),
      firstUrl: hits[0]!.url,
    };
  } catch (e) {
    const err = e instanceof SearchError ? e : new SearchError("network", "сбой поиска");
    return { ok: false, code: err.code, error: err.message };
  }
}
