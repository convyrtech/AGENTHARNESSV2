// Бесплатный поиск по умолчанию (issue #23, решение владельца: «по умолчанию поиск бесплатный»). Без ключа:
//   1) официальные источники, когда запрос про них: GitHub (последний релиз, иначе последний коммит; 60 запросов в
//      час без токена — кэш на час и пауза до сброса лимита), реестр npm, PyPI, endoflife.date;
//   2) выдача по вебу: SearXNG по адресу владельца (#31), если он задан, иначе DuckDuckGo HTML — хрупкий запасной
//      путь (идея из пакета ddgs, MIT; код свой);
//   3) Википедия (ru/en), когда выдачи по вебу нет или мало.
// У каждого результата — дата, где источник её даёт. Всё идёт с машины пользователя (системный прокси хоста).
import { clean, dated, SearchError } from "./common.ts";
import { decodeEntities } from "./fetch.ts";
import type { SearchDeps, SearchHit, SearchQuery } from "./search.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
/** Вежливая подпись для API (Википедия просит её в User-Agent). */
const API_UA = "PRSLOY-desktop/1.0 (search; +https://prsloy.online)";
const HOUR = 3_600_000;
export const UNAVAILABLE = "поиск временно недоступен";

export interface FreeDeps extends SearchDeps {
  /** Выдача SearXNG владельца (#31), когда адрес задан; иначе — DuckDuckGo. */
  searxng?: (q: SearchQuery) => Promise<SearchHit[]>;
}

// ---------- сеть и кэш ----------

const cache = new Map<string, { at: number; value: unknown }>();
/** До какого времени GitHub без токена не спрашиваем (лимит 60 в час исчерпан или почти). */
let githubPausedUntil = 0;

/** Для тестов: забыть кэш и паузу GitHub. */
export function resetFreeCache(): void {
  cache.clear();
  githubPausedUntil = 0;
}

async function getJson(
  url: string,
  deps: SearchDeps,
  ttl = HOUR,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < ttl) return hit.value;
  const res = await (deps.fetchImpl ?? fetch)(url, {
    headers: { Accept: "application/json", "User-Agent": API_UA, ...headers },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
  });
  if (url.startsWith("https://api.github.com/")) noteGithubLimit(res);
  // 404 — ответ «нет такого», его тоже кэшируем
  const value = res.ok ? ((await res.json()) as unknown) : res.status === 404 ? null : undefined;
  if (value === undefined) throw new Error(`HTTP ${res.status}`);
  cache.set(url, { at: now, value });
  return value;
}

function noteGithubLimit(res: Response): void {
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
  const limited =
    res.status === 403 || res.status === 429 || (remaining !== null && Number(remaining) <= 2);
  if (limited) githubPausedUntil = Number.isFinite(reset) && reset > 0 ? reset : Date.now() + HOUR;
}

// ---------- что в запросе ----------

const STOP = new Set([
  "npm",
  "pypi",
  "pip",
  "python",
  "package",
  "latest",
  "version",
  "versions",
  "release",
  "releases",
  "changelog",
  "new",
  "current",
  "what",
  "is",
  "the",
  "of",
  "for",
  "in",
  "lts",
  "eol",
  "js",
  "node",
  "github",
]);

function latinTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;:!?()«»"]+/)
    .map((t) => t.replace(/^[.'-]+|[.'-]+$/g, ""))
    .filter((t) => /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(t) && /[a-z]/.test(t));
}

/** `owner/repo` или ссылка на github.com в запросе. */
export function githubRepo(query: string): { owner: string; repo: string } | undefined {
  const m =
    /github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(query) ??
    /(?:^|\s)([a-z0-9][\w.-]*)\/([a-z0-9][\w.-]*)(?=\s|$)/i.exec(query);
  if (!m) return undefined;
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/, "");
  if (!/[a-z]/i.test(owner) || !/[a-z]/i.test(repo) || owner.startsWith("@")) return undefined;
  return { owner, repo };
}

export function npmPackage(query: string): string | undefined {
  const scoped = /(?:^|\s)(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/i.exec(query)?.[1];
  if (scoped) return scoped.toLowerCase();
  if (!/\bnpm\b/i.test(query)) return undefined;
  return latinTokens(query).find((t) => !STOP.has(t));
}

export function pypiPackage(query: string): string | undefined {
  if (!/\b(pypi|pip)\b|python[\s-]+(package|пакет)|пакет[а-я]*\s+python/i.test(query))
    return undefined;
  return latinTokens(query).find((t) => !STOP.has(t) && !t.startsWith("@"));
}

const EOL_WORDS =
  /\b(lts|eol|end[\s-]of[\s-]life|support|supported|latest|version|release)\b|верси|поддержк|релиз|последн|актуальн|lts/i;
const EOL_ALIAS: Record<string, string> = {
  node: "nodejs",
  "node.js": "nodejs",
  postgres: "postgresql",
  k8s: "kubernetes",
  golang: "go",
  dotnet: "dotnet",
  ".net": "dotnet",
  kernel: "linux",
  "linux-kernel": "linux",
  "react-native": "react-native",
  ubuntu: "ubuntu",
};

// ---------- официальные источники ----------

async function github(query: string, deps: SearchDeps): Promise<SearchHit[]> {
  const r = githubRepo(query);
  if (!r || Date.now() < githubPausedUntil) return [];
  const base = `https://api.github.com/repos/${r.owner}/${r.repo}`;
  const gh = { Accept: "application/vnd.github+json" };
  const rel = (await getJson(`${base}/releases/latest`, deps, HOUR, gh)) as {
    html_url?: string;
    tag_name?: string;
    name?: string;
    published_at?: string;
    body?: string;
  } | null;
  if (rel?.html_url) {
    return [
      {
        url: rel.html_url,
        title: `${r.owner}/${r.repo}: последний релиз ${rel.tag_name ?? ""}`.trim(),
        snippet: clean(`${rel.name ?? ""} ${rel.body ?? ""}`, 600),
        ...dated(rel.published_at),
        provider: "free",
      },
    ];
  }
  if (Date.now() < githubPausedUntil) return [];
  const commits = (await getJson(`${base}/commits?per_page=1`, deps, HOUR, gh)) as
    | {
        html_url?: string;
        sha?: string;
        commit?: { message?: string; committer?: { date?: string } };
      }[]
    | null;
  const c = Array.isArray(commits) ? commits[0] : undefined;
  if (!c?.html_url) return [];
  return [
    {
      url: c.html_url,
      title:
        `${r.owner}/${r.repo}: релизов нет, последний коммит ${c.sha?.slice(0, 7) ?? ""}`.trim(),
      snippet: clean(c.commit?.message, 400),
      ...dated(c.commit?.committer?.date),
      provider: "free",
    },
  ];
}

async function npm(query: string, deps: SearchDeps): Promise<SearchHit[]> {
  const name = npmPackage(query);
  if (!name) return [];
  const data = (await getJson(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=3`,
    deps,
  )) as {
    objects?: {
      package?: { name?: string; version?: string; description?: string; date?: string };
    }[];
  } | null;
  const p = data?.objects?.map((o) => o.package).find((x) => x?.name === name);
  if (!p?.version) return [];
  return [
    {
      url: `https://www.npmjs.com/package/${name}`,
      title: `${name} ${p.version} — npm (последняя версия)`,
      snippet: clean(p.description, 400),
      ...dated(p.date),
      provider: "free",
    },
  ];
}

async function pypi(query: string, deps: SearchDeps): Promise<SearchHit[]> {
  const name = pypiPackage(query);
  if (!name) return [];
  const data = (await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, deps)) as {
    info?: { version?: string; summary?: string };
    urls?: { upload_time_iso_8601?: string }[];
  } | null;
  if (!data?.info?.version) return [];
  return [
    {
      url: `https://pypi.org/project/${name}/`,
      title: `${name} ${data.info.version} — PyPI (последняя версия)`,
      snippet: clean(data.info.summary, 400),
      ...dated(data.urls?.[0]?.upload_time_iso_8601),
      provider: "free",
    },
  ];
}

interface EolCycle {
  cycle?: string;
  lts?: string | boolean;
  eol?: string | boolean;
  latest?: string;
  latestReleaseDate?: string;
}

async function endoflife(query: string, deps: SearchDeps, now: Date): Promise<SearchHit[]> {
  if (!EOL_WORDS.test(query)) return [];
  const all = (await getJson("https://endoflife.date/api/all.json", deps, 24 * HOUR)) as
    | string[]
    | null;
  if (!Array.isArray(all)) return [];
  const known = new Set(all);
  const tokens = query
    .toLowerCase()
    .split(/[\s,;:!?()«»"]+/)
    .filter(Boolean);
  const product = tokens
    .map((t) => EOL_ALIAS[t] ?? t.replace(/\.js$/, "js"))
    .find((t) => known.has(t) && !STOP.has(t));
  if (!product) return [];
  const cycles = (await getJson(`https://endoflife.date/api/${product}.json`, deps)) as
    | EolCycle[]
    | null;
  if (!Array.isArray(cycles) || !cycles.length) return [];
  const today = now.toISOString().slice(0, 10);
  const alive = cycles.filter(
    (c) => c.eol === false || (typeof c.eol === "string" && c.eol > today),
  );
  const shown = (alive.length ? alive : cycles).slice(0, 4);
  const line = (c: EolCycle) =>
    `${c.cycle}${typeof c.lts === "string" && c.lts <= today ? " (LTS)" : c.lts === true ? " (LTS)" : ""}: ` +
    `последняя ${c.latest ?? "?"}${c.latestReleaseDate ? ` от ${c.latestReleaseDate}` : ""}, ` +
    `поддержка ${c.eol === false ? "без даты окончания" : `до ${String(c.eol)}`}`;
  const newest = shown
    .map((c) => c.latestReleaseDate ?? "")
    .filter(Boolean)
    .sort()
    .at(-1);
  return [
    {
      url: `https://endoflife.date/${product}`,
      title: `${product}: поддерживаемые версии — endoflife.date`,
      snippet: shown.map(line).join("; "),
      ...dated(newest),
      provider: "free",
    },
  ];
}

async function wikipedia(q: SearchQuery, deps: SearchDeps, limit: number): Promise<SearchHit[]> {
  const lang = q.lang ?? (/[а-яё]/i.test(q.query) ? "ru" : "en");
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: q.query,
    srlimit: String(limit),
    srprop: "snippet|timestamp",
    format: "json",
    utf8: "1",
  });
  const data = (await getJson(`https://${lang}.wikipedia.org/w/api.php?${params}`, deps)) as {
    query?: { search?: { title?: string; snippet?: string; timestamp?: string }[] };
  } | null;
  return (data?.query?.search ?? [])
    .filter((s) => s.title)
    .map((s) => ({
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(s.title!.replace(/ /g, "_"))}`,
      title: `${s.title} — Википедия`,
      snippet: decodeEntities(clean(s.snippet, 400)),
      // дата последней правки статьи, не публикации
      ...dated(s.timestamp),
      provider: "free" as const,
    }));
}

// ---------- DuckDuckGo HTML ----------

const KL: Record<"ru" | "en", string> = { ru: "ru-ru", en: "us-en" };
const DF = { day: "d", week: "w", month: "m", year: "y" } as const;

/** Выдача html.duckduckgo.com: ссылки result__a (адрес в uddg), отрывки result__snippet; реклама — мимо. */
export function duckHits(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b/).slice(1);
  for (const block of blocks) {
    if (/result--ad\b/.test(block.slice(0, 200))) continue;
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(
      block,
    );
    if (!a) continue;
    let href = decodeEntities(a[1]!);
    if (href.startsWith("//")) href = `https:${href}`;
    try {
      const u = new URL(href);
      if (u.hostname.endsWith("duckduckgo.com")) {
        if (u.pathname.startsWith("/y.js")) continue;
        href = u.searchParams.get("uddg") ?? "";
      }
    } catch {
      continue;
    }
    if (!/^https?:\/\//.test(href)) continue;
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/.exec(
      block,
    )?.[1];
    out.push({
      url: href,
      title: decodeEntities(clean(a[2], 200)),
      snippet: decodeEntities(clean(snippet, 800)),
      provider: "free",
    });
  }
  return out;
}

async function duckduckgo(q: SearchQuery, deps: SearchDeps): Promise<SearchHit[]> {
  const form = new URLSearchParams({ q: q.site ? `${q.query} site:${q.site}` : q.query });
  form.set("kl", q.lang ? KL[q.lang] : "wt-wt");
  if (q.freshness) form.set("df", DF[q.freshness]);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: form.toString(),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 12_000),
    });
  } catch {
    throw new SearchError("network", UNAVAILABLE);
  }
  const html = await res.text();
  // 202 с anomaly.js — проверка «вы робот?»: с этого адреса DuckDuckGo сейчас не отвечает
  if (!res.ok || res.status === 202 || /anomaly\.js|anomaly-modal/.test(html))
    throw new SearchError("network", UNAVAILABLE);
  return duckHits(html);
}

// ---------- сборка ----------

function key(url: string): string {
  return url
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/[/#?]+$/, "")
    .toLowerCase();
}

export async function freeSearch(q: SearchQuery, deps: FreeDeps = {}): Promise<SearchHit[]> {
  const now = deps.now?.() ?? new Date();
  const count = Math.min(10, Math.max(1, Math.round(q.count ?? 8)));
  const quiet = (p: Promise<SearchHit[]>) => p.catch(() => [] as SearchHit[]);
  const site = q.site?.toLowerCase();
  const official = site
    ? site.includes("github.com")
      ? [quiet(github(q.query, deps))]
      : []
    : [
        quiet(github(q.query, deps)),
        quiet(npm(q.query, deps)),
        quiet(pypi(q.query, deps)),
        quiet(endoflife(q.query, deps, now)),
      ];
  let webError: SearchError | undefined;
  const web = (deps.searxng ? deps.searxng(q) : duckduckgo(q, deps)).catch((e: unknown) => {
    webError =
      e instanceof SearchError && !deps.searxng ? e : new SearchError("network", UNAVAILABLE);
    return [] as SearchHit[];
  });
  const [first, webHits] = await Promise.all([Promise.all(official).then((x) => x.flat()), web]);
  let hits = [...first, ...webHits.map((h) => ({ ...h, provider: "free" as const }))];
  if (hits.length < Math.ceil(count / 2) && !site)
    hits = [...hits, ...(await quiet(wikipedia(q, deps, Math.min(3, count))))];
  const seen = new Set<string>();
  const out = hits.filter((h) => {
    const k = key(h.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!out.length && webError) throw webError;
  return out.slice(0, count);
}
