// GitHub для web_search (issue #23): последний релиз репозитория, поиск репозиториев и issues (обсуждения ошибок —
// для «что значит ошибка …»), с токеном — ещё и поиск по коду. Лимиты по docs.github.com/rest (2026-10-25): без
// токена releases/repo — 60 в час, /search/repositories|issues — 10 в минуту, /search/code — только с токеном.
// Лимит каждого ресурса (core, search, code_search) считаем по заголовкам ответа и до сброса не спрашиваем; ответы
// кэшируем. Токен — из настроек приложения (safeStorage → хост), агенту не виден.
import { clean, dated, netReason, SearchError } from "./common.ts";
import type { SearchDeps, SearchHit } from "./search.ts";

const API = "https://api.github.com";
const TTL = { core: 3_600_000, search: 600_000, code_search: 600_000 } as const;
type Resource = keyof typeof TTL;

const cache = new Map<string, { at: number; value: unknown }>();
const pausedUntil: Record<Resource, number> = { core: 0, search: 0, code_search: 0 };

export function resetGithub(): void {
  cache.clear();
  for (const k of Object.keys(pausedUntil) as Resource[]) pausedUntil[k] = 0;
}

function limitError(resource: Resource): SearchError {
  if (resource === "core") {
    const at = new Date(pausedUntil.core).toISOString().slice(11, 16);
    return new SearchError("limit", `лимит GitHub исчерпан до ${at} UTC — добавьте токен GitHub`);
  }
  return new SearchError("limit", "лимит GitHub, подождите минуту");
}

/** null — 404 («нет такого»), тоже кэшируется. */
async function gh(
  path: string,
  resource: Resource,
  deps: SearchDeps & { githubToken?: string },
  accept = "application/vnd.github+json",
): Promise<unknown> {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && now - hit.at < TTL[resource]) return hit.value;
  if (now < pausedUntil[resource]) throw limitError(resource);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${API}${path}`, {
      headers: {
        Accept: accept,
        "User-Agent": "PRSLOY-desktop",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(deps.githubToken ? { Authorization: `Bearer ${deps.githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  } catch (e) {
    throw new SearchError("network", `GitHub: нет ответа (${netReason(e)})`);
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
  // лимит: осталось 0, 429 или «вторичный» лимит (403 с retry-after); иной 403 — запрет, не лимит
  const retryAfter = Number(res.headers.get("retry-after"));
  const spent = remaining !== null && Number(remaining) === 0;
  const limited =
    res.status === 429 || (res.status === 403 && (spent || retryAfter > 0)) || (res.ok && spent);
  if (limited) {
    pausedUntil[resource] =
      retryAfter > 0
        ? now + retryAfter * 1000
        : reset > now
          ? reset
          : now + (resource === "core" ? 3_600_000 : 60_000);
  }
  if (res.status === 401) throw new SearchError("auth", "GitHub: токен не принят (HTTP 401)");
  if (limited && !res.ok) throw limitError(resource);
  if (res.status === 404) {
    cache.set(path, { at: now, value: null });
    return null;
  }
  if (!res.ok) throw new SearchError("network", `GitHub: HTTP ${res.status}`);
  const value = (await res.json()) as unknown;
  cache.set(path, { at: now, value });
  return value;
}

/** Последний релиз репозитория; релизов нет — последний коммит. */
export async function githubLatest(
  owner: string,
  repo: string,
  deps: SearchDeps & { githubToken?: string } = {},
): Promise<SearchHit[]> {
  const base = `/repos/${owner}/${repo}`;
  const rel = (await gh(`${base}/releases/latest`, "core", deps)) as {
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
        title: `${owner}/${repo}: последний релиз ${rel.tag_name ?? ""}`.trim(),
        snippet: clean(`${rel.name ?? ""} ${rel.body ?? ""}`, 600),
        ...dated(rel.published_at),
        provider: "free",
      },
    ];
  }
  const commits = (await gh(`${base}/commits?per_page=1`, "core", deps)) as
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
      title: `${owner}/${repo}: релизов нет, последний коммит ${c.sha?.slice(0, 7) ?? ""}`.trim(),
      snippet: clean(c.commit?.message, 400),
      ...dated(c.commit?.committer?.date),
      provider: "free",
    },
  ];
}

export type GithubKind = "repos" | "issues" | "code";

/** Похоже на текст ошибки: тогда сначала ищем issues. */
export const ERROR_LIKE =
  /\b\w*(Error|Exception)\b|\berror\b|ошибк|traceback|failed|cannot|can't|не работает|\bERR!|\bE[A-Z]{3,}\b|panic|segfault|deprecat/i;

export async function githubSearch(
  query: string,
  kinds: readonly GithubKind[],
  deps: SearchDeps & { githubToken?: string } = {},
  count = 5,
): Promise<SearchHit[]> {
  const q = encodeURIComponent(query.trim());
  const n = Math.min(10, Math.max(1, count));
  const out: SearchHit[] = [];
  let firstError: SearchError | undefined;
  const provider = deps.githubToken ? ("github" as const) : ("free" as const);
  for (const kind of kinds) {
    try {
      if (kind === "repos") {
        const data = (await gh(`/search/repositories?q=${q}&per_page=${n}`, "search", deps)) as {
          items?: {
            html_url?: string;
            full_name?: string;
            description?: string;
            stargazers_count?: number;
            pushed_at?: string;
          }[];
        } | null;
        for (const r of data?.items ?? []) {
          if (!r.html_url) continue;
          out.push({
            url: r.html_url,
            title: `${r.full_name ?? ""} — ★${r.stargazers_count ?? 0}`,
            snippet: clean(r.description, 300),
            // дата последнего пуша
            ...dated(r.pushed_at),
            provider,
          });
        }
      } else if (kind === "issues") {
        const data = (await gh(`/search/issues?q=${q}+is:issue&per_page=${n}`, "search", deps)) as {
          items?: {
            html_url?: string;
            title?: string;
            body?: string;
            state?: string;
            updated_at?: string;
            comments?: number;
          }[];
        } | null;
        for (const i of data?.items ?? []) {
          if (!i.html_url) continue;
          out.push({
            url: i.html_url,
            title: `${i.title ?? ""} (issue, ${i.state === "closed" ? "закрыт" : "открыт"}, ответов ${i.comments ?? 0})`,
            snippet: clean(i.body, 400),
            ...dated(i.updated_at),
            provider,
          });
        }
      } else if (deps.githubToken) {
        const data = (await gh(
          `/search/code?q=${q}&per_page=${n}`,
          "code_search",
          deps,
          "application/vnd.github.text-match+json",
        )) as {
          items?: {
            html_url?: string;
            path?: string;
            repository?: { full_name?: string };
            text_matches?: { fragment?: string }[];
          }[];
        } | null;
        for (const c of data?.items ?? []) {
          if (!c.html_url) continue;
          out.push({
            url: c.html_url,
            title: `${c.repository?.full_name ?? ""}: ${c.path ?? ""}`,
            snippet: clean((c.text_matches ?? []).map((m) => m.fragment).join(" … "), 400),
            provider,
          });
        }
      }
    } catch (e) {
      firstError ??=
        e instanceof SearchError ? e : new SearchError("network", "GitHub: сбой поиска");
    }
  }
  if (!out.length && firstError) throw firstError;
  return out;
}
