// Практика 18 (PLAN-alpha §3; PLAN-v1 §4.1 5c): тул «поиск готового». E3 (research/REPORT-2026-10-22-part2.md §3):
// правило «сначала проверь, нет ли готового» подняло долю проверенных библиотек 67% → 94%; там же — модели
// придумывают несуществующие пакеты (slopsquatting), поэтому каждый кандидат проверяется по реестру.
// Источники без токена пользователя: реестр npm (поиск + пакет) и api.npmjs.org (загрузки), PyPI JSON,
// pypistats.org (загрузки), packages.ecosyste.ms (архив / deprecated; необязательно). GitHub не нужен.
// PyPI поиска без токена не даёт (страница поиска за JS-проверкой), поэтому для PyPI имена предлагает
// модель (`candidates`), а тул их проверяет.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ResolvedOptions } from "./options.ts";

export type Ecosystem = "npm" | "pypi";

export interface Candidate {
  ecosystem: Ecosystem;
  name: string;
  description: string;
  /** Загрузок в неделю (npm, pypistats) или в месяц / 4 (ecosyste.ms). */
  weeklyDownloads?: number;
  version?: string;
  lastRelease?: string;
  license?: string;
  deprecated?: string;
  archived?: boolean;
  /** Известные уязвимости этой версии по OSV.dev: id (CVE, если есть) критических и высоких. */
  vulns?: { critical: string[]; high: string[] };
  install: string;
}

export interface FindReadyResult {
  candidates: Candidate[];
  /** Имена, которых нет в реестре: ставить нельзя. */
  missing: { ecosystem: Ecosystem; name: string }[];
  /** Источники, которые не ответили вовремя. */
  unavailable: string[];
}

export interface FindReadyOptions {
  fetchImpl?: typeof fetch;
  /** Таймаут одного запроса, мс. */
  timeoutMs?: number;
  /** Сколько держать ответы в кэше, мс. */
  cacheMs?: number;
}

interface CacheEntry {
  at: number;
  value: unknown;
}

const NPM = "https://registry.npmjs.org";
const NPM_DOWNLOADS = "https://api.npmjs.org/downloads/point/last-week";
const PYPI = "https://pypi.org/pypi";
const PYPISTATS = "https://pypistats.org/api/packages";
const ECOSYSTEMS = "https://packages.ecosyste.ms/api/v1/registries";
/** OSV.dev: известные уязвимости версии пакета (бесплатно, без ключа; идея — OSV-шаг NVIDIA SkillSpector). */
const OSV = "https://api.osv.dev/v1/query";

class NotFound extends Error {}

export class FindReady {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #cacheMs: number;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: FindReadyOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 4_000;
    this.#cacheMs = options.cacheMs ?? 6 * 60 * 60 * 1000;
  }

  /** JSON по адресу с таймаутом и кэшем; 404 → NotFound, прочие сбои → Error. */
  async #json(url: string): Promise<unknown> {
    const hit = this.#cache.get(url);
    if (hit && Date.now() - hit.at < this.#cacheMs) {
      if (hit.value instanceof NotFound) throw hit.value;
      return hit.value;
    }
    const res = await this.#fetch(url, {
      headers: { accept: "application/json", "user-agent": "prsloy-harness (find_ready)" },
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (res.status === 404) {
      const missing = new NotFound(url);
      this.#cache.set(url, { at: Date.now(), value: missing });
      throw missing;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const value = (await res.json()) as unknown;
    this.#cache.set(url, { at: Date.now(), value });
    return value;
  }

  async search(
    query: string,
    ecosystem: Ecosystem | "any",
    names: string[] = [],
  ): Promise<FindReadyResult> {
    const result: FindReadyResult = { candidates: [], missing: [], unavailable: [] };
    const tasks: Promise<void>[] = [];
    if (ecosystem !== "pypi") tasks.push(this.#npm(query, names, result));
    if (ecosystem !== "npm") tasks.push(this.#pypi(query, names, result, ecosystem === "pypi"));
    await Promise.all(tasks);
    result.candidates = pickTop(result.candidates, names);
    await Promise.all(result.candidates.map((c) => this.#osv(c, result)));
    return result;
  }

  /** Уязвимости версии кандидата по OSV.dev; не ответил — без пометки, «Не ответили: OSV». */
  async #osv(c: Candidate, result: FindReadyResult): Promise<void> {
    if (!c.version) return;
    const key = `osv:${c.ecosystem}:${c.name}@${c.version}`;
    try {
      let data = this.#cache.get(key)?.value as OsvResponse | undefined;
      if (!data || Date.now() - (this.#cache.get(key)?.at ?? 0) >= this.#cacheMs) {
        const res = await this.#fetch(OSV, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "prsloy-harness (find_ready)",
          },
          body: JSON.stringify({
            package: { name: c.name, ecosystem: c.ecosystem === "npm" ? "npm" : "PyPI" },
            version: c.version,
          }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
        if (!res.ok) throw new Error(`${res.status} OSV`);
        data = (await res.json()) as OsvResponse;
        this.#cache.set(key, { at: Date.now(), value: data });
      }
      const pick = (level: string) =>
        (data?.vulns ?? [])
          .filter((v) => String(v.database_specific?.severity ?? "").toUpperCase() === level)
          .map((v) => v.aliases?.find((a) => a.startsWith("CVE-")) ?? v.id ?? "?");
      const critical = pick("CRITICAL");
      const high = pick("HIGH");
      if (critical.length || high.length) c.vulns = { critical, high };
    } catch {
      if (!result.unavailable.includes("OSV")) result.unavailable.push("OSV");
    }
  }

  async #npm(query: string, names: string[], result: FindReadyResult): Promise<void> {
    const found = new Map<string, Candidate>();
    try {
      const search = (await this.#json(
        `${NPM}/-/v1/search?text=${encodeURIComponent(query)}&size=15`,
      )) as NpmSearch;
      for (const o of search.objects ?? []) {
        const p = o.package;
        if (!p?.name) continue;
        found.set(p.name, {
          ecosystem: "npm",
          name: p.name,
          description: oneLine(p.description),
          ...(o.downloads?.weekly !== undefined ? { weeklyDownloads: o.downloads.weekly } : {}),
          ...(p.version ? { version: p.version } : {}),
          ...(p.date ? { lastRelease: p.date.slice(0, 10) } : {}),
          ...(p.license ? { license: p.license } : {}),
          install: `npm i ${p.name}`,
        });
      }
    } catch {
      result.unavailable.push("поиск npm");
    }
    // Имена, которые предложила модель: проверяем, что пакет есть, и берём его данные.
    await Promise.all(
      names
        .filter((n) => isNpmName(n) && !found.has(n))
        .map(async (name) => {
          const latest = await this.#npmLatest(name).catch((e: unknown) => e);
          if (latest instanceof NotFound) result.missing.push({ ecosystem: "npm", name });
          else if (latest && !(latest instanceof Error)) found.set(name, latest as Candidate);
        }),
    );
    // Для лучших по загрузкам — deprecated из самого пакета и архив репозитория.
    const top = pickTop([...found.values()], names);
    await Promise.all(top.map((c) => this.#npmEnrich(c)));
    result.candidates.push(...top);
  }

  async #npmLatest(name: string): Promise<Candidate> {
    const p = (await this.#json(`${NPM}/${encodePackage(name)}/latest`)) as NpmLatest;
    const c: Candidate = {
      ecosystem: "npm",
      name,
      description: oneLine(p.description),
      ...(p.version ? { version: p.version } : {}),
      ...(typeof p.license === "string" ? { license: p.license } : {}),
      ...(p.deprecated ? { deprecated: oneLine(p.deprecated) } : {}),
      install: `npm i ${name}`,
    };
    const downloads = (await this.#json(`${NPM_DOWNLOADS}/${encodePackage(name)}`).catch(
      () => undefined,
    )) as { downloads?: number } | undefined;
    if (typeof downloads?.downloads === "number") c.weeklyDownloads = downloads.downloads;
    return c;
  }

  async #npmEnrich(c: Candidate): Promise<void> {
    if (c.deprecated === undefined) {
      const latest = (await this.#json(`${NPM}/${encodePackage(c.name)}/latest`).catch(
        () => undefined,
      )) as NpmLatest | undefined;
      if (latest?.deprecated) c.deprecated = oneLine(latest.deprecated);
      if (!c.license && typeof latest?.license === "string") c.license = latest.license;
    }
    await this.#ecosystems("npmjs.org", c);
  }

  async #pypi(
    query: string,
    names: string[],
    result: FindReadyResult,
    explicit: boolean,
  ): Promise<void> {
    // Без поиска: имена от модели плюс слова запроса как имена (yaml, slugify, …).
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9._-]+/)
      .filter((w) => w.length >= 3);
    const guesses = [
      ...new Set([...names.filter(isPypiName), ...(explicit || names.length === 0 ? words : [])]),
    ].slice(0, 8);
    const fromModel = new Set(names.map((n) => n.toLowerCase()));
    await Promise.all(
      guesses.map(async (name) => {
        try {
          result.candidates.push(await this.#pypiPackage(name));
        } catch (error) {
          if (error instanceof NotFound) {
            if (fromModel.has(name.toLowerCase())) result.missing.push({ ecosystem: "pypi", name });
          } else if (!result.unavailable.includes("PyPI")) result.unavailable.push("PyPI");
        }
      }),
    );
  }

  async #pypiPackage(name: string): Promise<Candidate> {
    const data = (await this.#json(`${PYPI}/${encodeURIComponent(name)}/json`)) as PypiJson;
    const info = data.info ?? {};
    const real = info.name ?? name;
    const classifiers = info.classifiers ?? [];
    const licenseClassifier = classifiers
      .find((c) => c.startsWith("License :: "))
      ?.split(" :: ")
      .pop();
    const license =
      info.license_expression || shortLicense(info.license) || licenseClassifier || undefined;
    const lastRelease = (data.urls ?? [])[0]?.upload_time_iso_8601?.slice(0, 10);
    const c: Candidate = {
      ecosystem: "pypi",
      name: real,
      description: oneLine(info.summary),
      ...(info.version ? { version: info.version } : {}),
      ...(lastRelease ? { lastRelease } : {}),
      ...(license ? { license } : {}),
      ...(classifiers.some((x) => x.includes("Development Status :: 7 - Inactive"))
        ? { deprecated: "Development Status: Inactive" }
        : {}),
      install: `pip install ${real}`,
    };
    const stats = (await this.#json(
      `${PYPISTATS}/${encodeURIComponent(real.toLowerCase())}/recent`,
    ).catch(() => undefined)) as { data?: { last_week?: number } } | undefined;
    if (typeof stats?.data?.last_week === "number") c.weeklyDownloads = stats.data.last_week;
    await this.#ecosystems("pypi.org", c);
    return c;
  }

  /** Архив и deprecated из ecosyste.ms; если не ответил — без этих полей. */
  async #ecosystems(registry: string, c: Candidate): Promise<void> {
    const pkg = (await this.#json(
      `${ECOSYSTEMS}/${registry}/packages/${encodeURIComponent(c.name)}`,
    ).catch(() => undefined)) as EcosystemsPackage | undefined;
    if (!pkg) return;
    if (pkg.repo_metadata?.archived) c.archived = true;
    if (pkg.status === "deprecated" && !c.deprecated) c.deprecated = "deprecated";
    if (c.weeklyDownloads === undefined && typeof pkg.downloads === "number") {
      c.weeklyDownloads = Math.round(
        pkg.downloads / (pkg.downloads_period === "last-month" ? 4.3 : 1),
      );
    }
    if (!c.lastRelease && pkg.latest_release_published_at)
      c.lastRelease = pkg.latest_release_published_at.slice(0, 10);
  }
}

interface NpmSearch {
  objects?: {
    package?: {
      name?: string;
      description?: string;
      version?: string;
      date?: string;
      license?: string;
    };
    downloads?: { weekly?: number };
  }[];
}
interface NpmLatest {
  description?: string;
  version?: string;
  license?: unknown;
  deprecated?: string;
}
interface PypiJson {
  info?: {
    name?: string;
    summary?: string;
    version?: string;
    license?: string | null;
    license_expression?: string | null;
    classifiers?: string[];
  };
  urls?: { upload_time_iso_8601?: string }[];
}
interface OsvResponse {
  vulns?: { id?: string; aliases?: string[]; database_specific?: { severity?: string } }[];
}
interface EcosystemsPackage {
  status?: string | null;
  downloads?: number | null;
  downloads_period?: string | null;
  latest_release_published_at?: string | null;
  repo_metadata?: { archived?: boolean } | null;
}

function oneLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
}

/** У PyPI в `license` бывает весь текст лицензии — берём только короткое имя. */
function shortLicense(text: string | null | undefined): string | undefined {
  const t = (text ?? "").trim();
  return t && t.length <= 40 && !t.includes("\n") ? t : undefined;
}

function isNpmName(name: string): boolean {
  return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name);
}

function isPypiName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function encodePackage(name: string): string {
  return name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/**
 * До 5 лучших, но пакеты, о которых спросила модель, — всегда: ей надо узнать, что её `request` устарел,
 * а не просто не увидеть его в списке.
 */
export function pickTop(candidates: Candidate[], named: string[]): Candidate[] {
  const wanted = new Set(named.map((n) => n.toLowerCase()));
  const ranked = rank(candidates);
  const asked = ranked.filter((c) => wanted.has(c.name.toLowerCase()));
  const others = ranked.filter((c) => !wanted.has(c.name.toLowerCase()));
  const keep = new Set([...asked, ...others.slice(0, Math.max(0, 5 - asked.length))]);
  return ranked.filter((c) => keep.has(c));
}

/** Живые и популярные — выше; устаревшие и архивные — в конец. */
export function rank(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    const badA = a.deprecated || a.archived ? 1 : 0;
    const badB = b.deprecated || b.archived ? 1 : 0;
    if (badA !== badB) return badA - badB;
    return (b.weeklyDownloads ?? -1) - (a.weeklyDownloads ?? -1);
  });
}

export function formatDownloads(n: number | undefined): string {
  if (n === undefined) return "загрузки неизвестны";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")} млн/нед`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} тыс./нед`;
  return `${n}/нед`;
}

export function formatResult(query: string, result: FindReadyResult): string {
  const lines: string[] = [];
  if (result.candidates.length === 0) {
    lines.push(`Готового по «${query}» не нашлось.`);
  } else {
    lines.push(`Готовые решения по «${query}»:`);
    result.candidates.forEach((c, i) => {
      const facts = [
        c.ecosystem,
        formatDownloads(c.weeklyDownloads),
        c.lastRelease ? `релиз ${c.lastRelease}` : undefined,
        c.license ?? "лицензия не указана",
      ].filter(Boolean);
      const v = c.vulns;
      const warn = [
        c.deprecated ? `⚠ устарел: ${c.deprecated}` : undefined,
        c.archived ? "⚠ репозиторий в архиве" : undefined,
        v
          ? `⚠ уязвимости версии ${c.version} (OSV): ${[
              v.critical.length
                ? `критических ${v.critical.length} (${v.critical.slice(0, 3).join(", ")})`
                : "",
              v.high.length ? `высоких ${v.high.length}` : "",
            ]
              .filter(Boolean)
              .join(", ")}`
          : undefined,
      ].filter(Boolean);
      lines.push(`${i + 1}. ${c.name} — ${c.description || "без описания"}`);
      lines.push(`   ${facts.join(" · ")}${warn.length ? ` · ${warn.join(" · ")}` : ""}`);
      lines.push(`   ${c.install}`);
    });
  }
  for (const m of result.missing) {
    lines.push(
      `Нет в ${m.ecosystem === "npm" ? "npm" : "PyPI"}: ${m.name} — не ставь, такого пакета нет.`,
    );
  }
  if (result.unavailable.length) lines.push(`Не ответили: ${result.unavailable.join(", ")}.`);
  if (/[а-яё]/i.test(query)) {
    lines.push("Совет: реестры ищут по-английски — повтори запрос английскими словами.");
  }
  lines.push(
    "Бери живой популярный пакет (много загрузок, свежий релиз, понятная лицензия, не устарел). Своё пиши, только если ни один не подходит, и скажи почему.",
    ...(result.candidates.some((c) => c.vulns?.critical.length)
      ? [
          "У версии с критической уязвимостью возьми исправленную версию или другой пакет и скажи пользователю.",
        ]
      : []),
  );
  return lines.join("\n");
}

export function installFindReady(
  pi: ExtensionAPI,
  opts: ResolvedOptions,
  options: FindReadyOptions = {},
): void {
  if (opts.profile !== "code") return;
  const finder = new FindReady(options);
  pi.registerTool({
    name: "find_ready",
    label: "поиск готового",
    description:
      "Before writing a utility from scratch, find a ready, proven package. Searches npm (text search) and checks PyPI/npm package names you suggest: returns up to 5 candidates with description, weekly downloads, last release, license, deprecated/archived flags and the install command. Names that do not exist in the registry are reported — never install them.",
    promptSnippet: "Find a ready, proven npm/PyPI package before writing your own code",
    parameters: Type.Object({
      query: Type.String({
        description: "What the code must do, in short English keywords (e.g. 'slugify cyrillic')",
      }),
      ecosystem: Type.Optional(
        Type.Union([Type.Literal("npm"), Type.Literal("pypi"), Type.Literal("any")], {
          description: "npm for JS/TS, pypi for Python, any (default)",
        }),
      ),
      candidates: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Package names you already think of; each is checked in the registry (required for PyPI: it has no open search)",
        }),
      ),
    }),
    async execute(_id, params) {
      const result = await finder.search(
        params.query,
        params.ecosystem ?? "any",
        params.candidates ?? [],
      );
      return {
        content: [{ type: "text", text: formatResult(params.query, result) }],
        details: result,
      };
    },
  });
}
