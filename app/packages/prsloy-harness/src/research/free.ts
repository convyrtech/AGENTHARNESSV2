// Бесплатный поиск по умолчанию (issue #23, решение владельца: «по умолчанию поиск бесплатный»). Без ключа:
//   1) официальные источники, когда запрос про них: GitHub (последний релиз, иначе последний коммит; issues, когда
//      запрос похож на ошибку; репозитории и issues при site:github.com — github.ts, с лимитами и кэшем), реестр
//      npm, PyPI, endoflife.date;
//   2) выдача по вебу: SearXNG по адресу владельца (#31), если он задан, иначе DuckDuckGo HTML — хрупкий запасной
//      путь (идея из пакета ddgs, MIT; код свой);
//   3) Википедия (ru/en), когда выдачи по вебу нет или мало.
// У каждого результата — дата, где источник её даёт. Всё идёт с машины пользователя (системный прокси хоста).
import { clean, dated, SearchError, timeoutSignal } from "./common.ts";
import { decodeEntities } from "./fetch.ts";
import { ERROR_LIKE, githubLatest, githubSearch, resetGithub, type GithubKind } from "./github.ts";
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
  /** Токен GitHub из настроек: больше лимит (и поиск по коду у поставщика github). */
  githubToken?: string;
}

// ---------- сеть и кэш ----------

const cache = new Map<string, { at: number; value: unknown }>();

/** Для тестов: забыть кэш и паузы GitHub. */
export function resetFreeCache(): void {
  cache.clear();
  resetGithub();
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
    signal: timeoutSignal(deps.timeoutMs ?? 10_000, deps.signal),
  });
  // 404 — ответ «нет такого», его тоже кэшируем
  const value = res.ok ? ((await res.json()) as unknown) : res.status === 404 ? null : undefined;
  if (value === undefined) throw new Error(`HTTP ${res.status}`);
  cache.set(url, { at: now, value });
  return value;
}

// ---------- что в запросе ----------

/** Слова команд установки и связки — не имена пакетов. */
const COMMAND = new Set([
  "install",
  "i",
  "add",
  "update",
  "upgrade",
  "uninstall",
  "remove",
  "show",
  "view",
  "info",
  "how",
  "to",
  "use",
  "using",
  "with",
  "and",
  "or",
  "a",
  "an",
  "on",
  "at",
  "by",
  "from",
  "my",
  "it",
  "does",
  "do",
  "can",
]);

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
/** Пары через «/», которые пишут в тексте, а не как репозиторий. */
const SLASH_WORDS =
  /^(async\/await|client\/server|input\/output|read\/write|true\/false|yes\/no|and\/or|on\/off|tcp\/ip|i\/o|front\/back|frontend\/backend|get\/set|start\/stop|open\/close|import\/export|dev\/prod|key\/value|request\/response|src\/\w+|\w+\/(src|lib|bin|dist|index))$/i;
/** Без ссылки на github.com «owner/repo» — репозиторий, только если в запросе про него речь. */
const REPO_CONTEXT =
  /github|репозитор|\brepo\b|release|релиз|\btag\b|changelog|верси|version|\blts\b|latest|последн|commit|коммит/i;

export function githubRepo(query: string): { owner: string; repo: string } | undefined {
  const url = /github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(query);
  const bare = url
    ? undefined
    : /(?:^|\s)([a-z0-9][\w.-]*)\/([a-z0-9][\w.-]*)(?=\s|$)/i.exec(query);
  if (bare && (SLASH_WORDS.test(`${bare[1]}/${bare[2]}`) || !REPO_CONTEXT.test(query)))
    return undefined;
  const m = url ?? bare;
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
  // «npm install react», «npm i -D vite»: пакет — после команды
  const after =
    /\bnpm\s+(?:i|install|add|update|upgrade|view|info|show)\s+(?:-[\w-]+\s+)*([a-z0-9][\w.-]*)/i.exec(
      query,
    )?.[1];
  if (after) return after.toLowerCase();
  return latinTokens(query).find((t) => !STOP.has(t) && !COMMAND.has(t));
}

export function pypiPackage(query: string): string | undefined {
  if (!/\b(pypi|pip)\b|python[\s-]+(package|пакет)|пакет[а-я]*\s+python/i.test(query))
    return undefined;
  const after = /\bpip3?\s+(?:install|show|download)\s+(?:-[\w-]+\s+)*([a-z0-9][\w.-]*)/i.exec(
    query,
  )?.[1];
  if (after) return after.toLowerCase();
  return latinTokens(query).find((t) => !STOP.has(t) && !COMMAND.has(t) && !t.startsWith("@"));
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

async function npm(query: string, deps: SearchDeps): Promise<SearchHit[]> {
  const name = npmPackage(query);
  if (!name) return [];
  // Версия — из самого реестра (/<имя>/latest): поисковый индекс npm отстаёт. Дата — из индекса, только если
  // он знает ту же версию.
  const latest = (await getJson(
    `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`,
    deps,
  )) as { version?: string; description?: string } | null;
  if (!latest?.version) return [];
  const index = (await getJson(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=3`,
    deps,
  ).catch(() => null)) as {
    objects?: { package?: { name?: string; version?: string; date?: string } }[];
  } | null;
  const same = index?.objects
    ?.map((o) => o.package)
    .find((x) => x?.name === name && x.version === latest.version);
  return [
    {
      url: `https://www.npmjs.com/package/${name}`,
      title: `${name} ${latest.version} — npm (последняя версия)`,
      snippet: clean(latest.description, 400),
      ...dated(same?.date),
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
  // STOP здесь не нужен: в нём «python» и «node», а это и есть продукты endoflife.date
  const product = tokens
    .map((t) => EOL_ALIAS[t] ?? t.replace(/\.js$/, "js"))
    .find((t) => known.has(t));
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
      signal: timeoutSignal(deps.timeoutMs ?? 12_000, deps.signal),
    });
  } catch {
    throw new SearchError("network", UNAVAILABLE);
  }
  const html = await res.text();
  // 202 с anomaly.js — проверка «вы робот?»: с этого адреса DuckDuckGo сейчас не отвечает
  if (!res.ok || res.status === 202 || /anomaly\.js|anomaly-modal/.test(html))
    throw new SearchError("network", UNAVAILABLE);
  const hits = duckHits(html);
  // ни результатов, ни «ничего не найдено» — разметка сменилась: это сбой, а не пустая выдача (дальше — запасной)
  if (!hits.length && !/class="[^"]*no-results|No results\./i.test(html))
    throw new SearchError("network", UNAVAILABLE);
  return hits;
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
  // лимит GitHub и неверный токен — не молча: о них скажет карточка (onIssue), поиск идёт дальше
  const noticed = (p: Promise<SearchHit[]>) =>
    p.catch((e: unknown) => {
      if (e instanceof SearchError && (e.code === "limit" || e.code === "auth"))
        deps.onIssue?.("github", e);
      return [] as SearchHit[];
    });
  const site = q.site?.toLowerCase();
  const onGithub = site?.includes("github.com") === true;
  const repo = githubRepo(q.query);
  const errorLike = ERROR_LIKE.test(q.query);
  let githubError: SearchError | undefined;
  const kinds: GithubKind[] = onGithub
    ? errorLike
      ? ["issues", "repos"]
      : ["repos", "issues"]
    : errorLike
      ? ["issues"]
      : [];
  const ghSearch = kinds.length
    ? githubSearch(q.query, kinds, deps, onGithub ? count : 3).catch((e: unknown) => {
        githubError =
          e instanceof SearchError ? e : new SearchError("network", "GitHub: сбой поиска");
        if (githubError.code === "limit" || githubError.code === "auth")
          deps.onIssue?.("github", githubError);
        return [] as SearchHit[];
      })
    : Promise.resolve([] as SearchHit[]);
  const official = [
    ...(repo ? [noticed(githubLatest(repo.owner, repo.repo, deps))] : []),
    ...(site
      ? []
      : [
          quiet(npm(q.query, deps)),
          quiet(pypi(q.query, deps)),
          quiet(endoflife(q.query, deps, now)),
        ]),
    ghSearch,
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
  if (!out.length && onGithub && githubError) throw githubError;
  if (!out.length && webError) throw webError;
  return out.slice(0, count);
}
