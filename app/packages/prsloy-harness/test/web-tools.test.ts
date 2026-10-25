import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { readFlags } from "../src/flags.ts";
import { resolveOptions } from "../src/options.ts";
import {
  duckHits,
  freeSearch,
  githubRepo,
  npmPackage,
  pypiPackage,
  resetFreeCache,
  UNAVAILABLE,
} from "../src/research/free.ts";
import { jsdelivrUrl, readPage } from "../src/research/fetch.ts";
import { modelHits, MODEL_SEARCH_NOTE } from "../src/research/model-search.ts";
import { guardQuery } from "../src/research/query-guard.ts";
import { search, SearchError } from "../src/research/search.ts";
import { tierOf } from "../src/research/source-tier.ts";
import { installResearch, WEB_TOOLS_LINE } from "../src/research/tools.ts";
import { fakeFetch, json } from "./fake-fetch.ts";
import { MockPi } from "./mock-pi.ts";

const NOW = () => new Date("2026-10-25T12:00:00Z");
const TODAY = NOW();

/** Выдача html.duckduckgo.com в том виде, в каком её отдаёт сайт (сокращённо): реклама, два результата. */
const DDG = `<html><body>
<div class="result results_links results_links_deep result--ad">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=seo.example&amp;u3=x">Реклама</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%2Fprevious-releases&amp;rut=abc">Node.js &mdash; <b>Releases</b></a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Major Node.js versions enter <b>LTS</b> &amp; stay there.</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <a rel="nofollow" class="result__a" href="https://habr.com/ru/articles/1/">Топ-10 сервисов поиска</a>
  <a class="result__snippet" href="https://habr.com/ru/articles/1/">обзор</a>
</div>
</body></html>`;

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html" } });

describe("year guard in the query (research/26 §4.2, the owner's failure 1)", () => {
  it("past years go, the current and future stay", () => {
    expect(guardQuery("тарифы Brave Search API 2024", TODAY)).toEqual({
      query: "тарифы Brave Search API",
      removed: [2024],
    });
    expect(guardQuery("best laptops 2023, 2025 prices", TODAY)).toEqual({
      query: "best laptops, prices",
      removed: [2023, 2025],
    });
    expect(guardQuery("МРОТ 2026 и 2027", TODAY)).toEqual({
      query: "МРОТ 2026 и 2027",
      removed: [],
    });
    expect(guardQuery("node 22 lts", TODAY).removed).toEqual([]);
  });

  it("a question about the past keeps its year", () => {
    for (const q of [
      "история ключевой ставки 2014",
      "какой был МРОТ в 2020 году",
      "НДС с 2019",
      "inflation 2010-2015",
      "what was the node lts in 2021",
      "архив курсов 2008",
    ])
      expect(guardQuery(q, TODAY).removed, q).toEqual([]);
  });

  it("a query of only a year is left as it is", () => {
    expect(guardQuery("2024", TODAY)).toEqual({ query: "2024", removed: [] });
  });
});

describe("source tier by address and title (research/26 §4.2, the owner's failure 3)", () => {
  it("code, releases, docs, articles, forums, marketing", () => {
    expect(tierOf("https://github.com/nodejs/node")).toBe("code");
    expect(tierOf("https://github.com/nodejs/node/releases/tag/v26.0.0")).toBe("releases");
    expect(tierOf("https://github.com/nodejs/node/issues/1/")).toBe("forums");
    expect(tierOf("https://www.npmjs.com/package/react")).toBe("releases");
    expect(tierOf("https://nodejs.org/en/blog/release/v26.0.0")).toBe("releases");
    expect(tierOf("https://docs.anthropic.com/en/api")).toBe("docs");
    expect(tierOf("https://brave.com/search/api/pricing/")).toBe("docs");
    expect(tierOf("https://www.consultant.ru/document/cons_doc_LAW_1/")).toBe("docs");
    expect(tierOf("https://www.rbc.ru/economics/1")).toBe("articles");
    expect(tierOf("https://habr.com/ru/articles/1/")).toBe("forums");
    expect(tierOf("https://stackoverflow.com/questions/1/x")).toBe("forums");
    expect(tierOf("https://seo.example/blog/x", "Топ-10 лучших сервисов поиска")).toBe("marketing");
    expect(tierOf("https://vendor.example/blog/a", "Vendor vs Brave: alternatives")).toBe(
      "marketing",
    );
    expect(tierOf("not a url")).toBe("articles");
  });
});

describe("free search: official sources, then the web, Wikipedia when the web is empty", () => {
  beforeEach(() => resetFreeCache());

  it("what the query is about: owner/repo, npm and PyPI packages", () => {
    expect(githubRepo("последний релиз nodejs/node")).toEqual({ owner: "nodejs", repo: "node" });
    expect(githubRepo("https://github.com/pi-mono/pi.git releases")).toEqual({
      owner: "pi-mono",
      repo: "pi",
    });
    expect(githubRepo("1/2 стакана")).toBeUndefined();
    expect(npmPackage("последняя версия react npm")).toBe("react");
    expect(npmPackage("@earendil-works/pi-coding-agent changelog")).toBe(
      "@earendil-works/pi-coding-agent",
    );
    expect(npmPackage("react hooks")).toBeUndefined();
    expect(pypiPackage("requests pypi latest version")).toBe("requests");
    expect(pypiPackage("requests library")).toBeUndefined();
  });

  it("DuckDuckGo HTML: links from uddg, entities decoded, ads skipped", () => {
    const hits = duckHits(DDG);
    expect(hits).toEqual([
      {
        url: "https://nodejs.org/en/about/previous-releases",
        title: "Node.js — Releases",
        snippet: "Major Node.js versions enter LTS & stay there.",
        provider: "free",
      },
      {
        url: "https://habr.com/ru/articles/1/",
        title: "Топ-10 сервисов поиска",
        snippet: "обзор",
        provider: "free",
      },
    ]);
  });

  it("GitHub release, endoflife.date and the web together; GitHub answers are cached", async () => {
    const f = fakeFetch([
      [
        "https://api.github.com/repos/nodejs/node/releases/latest",
        () =>
          new Response(
            JSON.stringify({
              html_url: "https://github.com/nodejs/node/releases/tag/v26.12.1",
              tag_name: "v26.12.1",
              name: "2026-10-21, Version 26.12.1",
              published_at: "2026-10-21T10:00:00Z",
              body: "Notable changes",
            }),
            { headers: { "x-ratelimit-remaining": "55", "x-ratelimit-reset": "0" } },
          ),
      ],
      ["https://endoflife.date/api/all.json", () => json(["nodejs", "python", "ubuntu"])],
      [
        "https://endoflife.date/api/nodejs.json",
        () =>
          json([
            {
              cycle: "26",
              lts: "2026-10-28",
              eol: "2029-04-30",
              latest: "26.12.1",
              latestReleaseDate: "2026-10-21",
            },
            {
              cycle: "24",
              lts: "2024-10-29",
              eol: "2028-04-30",
              latest: "24.15.0",
              latestReleaseDate: "2026-09-30",
            },
            { cycle: "20", lts: "2023-10-24", eol: "2026-04-30", latest: "20.20.0" },
          ]),
      ],
      ["https://html.duckduckgo.com/html/", () => html(DDG)],
    ]);
    const deps = { fetchImpl: f.impl, now: NOW };
    const hits = await freeSearch({ query: "node lts nodejs/node", count: 6, lang: "en" }, deps);
    expect(hits.map((h) => h.url)).toEqual([
      "https://github.com/nodejs/node/releases/tag/v26.12.1",
      "https://endoflife.date/nodejs",
      "https://nodejs.org/en/about/previous-releases",
      "https://habr.com/ru/articles/1/",
    ]);
    expect(hits[0]).toMatchObject({
      date: "2026-10-21",
      title: "nodejs/node: последний релиз v26.12.1",
    });
    expect(hits[1]!.snippet).toBe(
      "26: последняя 26.12.1 от 2026-10-21, поддержка до 2029-04-30; " +
        "24 (LTS): последняя 24.15.0 от 2026-09-30, поддержка до 2028-04-30",
    );
    expect(hits[1]!.date).toBe("2026-10-21");
    const form = f.calls.find((c) => c.url.startsWith("https://html.duckduckgo.com"))!;
    expect(form.method).toBe("POST");
    expect(String(form.body)).toBe("q=node+lts+nodejs%2Fnode&kl=us-en");
    await freeSearch({ query: "node lts nodejs/node", lang: "en" }, deps);
    expect(f.calls.filter((c) => c.url.includes("api.github.com"))).toHaveLength(1);
  });

  it("GitHub without a token: a spent limit pauses it until the reset, the rest still answers", async () => {
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const f = fakeFetch([
      [
        "https://api.github.com/",
        () =>
          new Response("{}", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
          }),
      ],
      ["https://html.duckduckgo.com/html/", () => html(DDG)],
    ]);
    const deps = { fetchImpl: f.impl, now: NOW };
    expect(await freeSearch({ query: "a/b releases" }, deps)).toHaveLength(2);
    await freeSearch({ query: "c/d releases" }, deps);
    expect(f.calls.filter((c) => c.url.includes("api.github.com"))).toHaveLength(1);
  });

  it("no releases → the last commit; npm and PyPI with the date of the latest version", async () => {
    const f = fakeFetch([
      ["https://api.github.com/repos/o/r/releases/latest", () => json({}, 404)],
      [
        "https://api.github.com/repos/o/r/commits",
        () =>
          json([
            {
              html_url: "https://github.com/o/r/commit/abcdef1234",
              sha: "abcdef1234",
              commit: { message: "fix: x", committer: { date: "2026-10-20T00:00:00Z" } },
            },
          ]),
      ],
      [
        "https://registry.npmjs.org/react/latest",
        () => json({ name: "react", version: "19.3.1", description: "React" }),
      ],
      [
        "https://registry.npmjs.org/-/v1/search",
        () =>
          json({
            objects: [
              { package: { name: "react-dom", version: "19.3.1" } },
              {
                package: {
                  name: "react",
                  version: "19.3.1",
                  description: "React",
                  date: "2026-10-14T16:47:15Z",
                },
              },
            ],
          }),
      ],
      [
        "https://pypi.org/pypi/requests/json",
        () =>
          json({
            info: { version: "2.34.2", summary: "HTTP for Humans" },
            urls: [{ upload_time_iso_8601: "2026-05-14T19:25:26Z" }],
          }),
      ],
      ["https://html.duckduckgo.com/html/", () => html("<html></html>")],
      ["https://en.wikipedia.org/", () => json({ query: { search: [] } })],
    ]);
    const deps = { fetchImpl: f.impl, now: NOW };
    expect(await freeSearch({ query: "o/r release" }, deps)).toEqual([
      expect.objectContaining({
        url: "https://github.com/o/r/commit/abcdef1234",
        title: "o/r: релизов нет, последний коммит abcdef1",
        date: "2026-10-20",
      }),
    ]);
    expect(await freeSearch({ query: "react npm" }, deps)).toEqual([
      expect.objectContaining({
        url: "https://www.npmjs.com/package/react",
        title: "react 19.3.1 — npm (последняя версия)",
        date: "2026-10-14",
      }),
    ]);
    expect(await freeSearch({ query: "requests pypi" }, deps)).toEqual([
      expect.objectContaining({ url: "https://pypi.org/project/requests/", date: "2026-05-14" }),
    ]);
  });

  it("DuckDuckGo blocked (202 anomaly): Wikipedia answers; nothing at all — «поиск временно недоступен»", async () => {
    const wiki = fakeFetch([
      ["https://html.duckduckgo.com/html/", () => html("<script src=anomaly.js>", 202)],
      [
        "https://ru.wikipedia.org/w/api.php",
        () =>
          json({
            query: {
              search: [
                {
                  title: "Пушкин, Александр Сергеевич",
                  snippet: '<span class="searchmatch">Пушкин</span> &mdash; поэт',
                  timestamp: "2026-10-01T00:00:00Z",
                },
              ],
            },
          }),
      ],
    ]);
    expect(await freeSearch({ query: "Пушкин" }, { fetchImpl: wiki.impl })).toEqual([
      {
        url: "https://ru.wikipedia.org/wiki/%D0%9F%D1%83%D1%88%D0%BA%D0%B8%D0%BD%2C_%D0%90%D0%BB%D0%B5%D0%BA%D1%81%D0%B0%D0%BD%D0%B4%D1%80_%D0%A1%D0%B5%D1%80%D0%B3%D0%B5%D0%B5%D0%B2%D0%B8%D1%87",
        title: "Пушкин, Александр Сергеевич — Википедия",
        snippet: "Пушкин — поэт",
        date: "2026-10-01",
        provider: "free",
      },
    ]);
    const dead = fakeFetch([]);
    await expect(freeSearch({ query: "что угодно" }, { fetchImpl: dead.impl })).rejects.toThrow(
      UNAVAILABLE,
    );
  });

  it("the owner's SearXNG (#31) takes DuckDuckGo's place when its address is set", async () => {
    const f = fakeFetch([
      [
        "https://sx.prsloy.example/search",
        () => json({ results: [{ url: "https://cbr.ru/", title: "ЦБ", content: "ставка" }] }),
      ],
    ]);
    const hits = await search(
      { provider: "free", url: "https://sx.prsloy.example" },
      { query: "ключевая ставка", site: "cbr.ru", freshness: "week" },
      { fetchImpl: f.impl, now: NOW },
    );
    expect(hits).toEqual([expect.objectContaining({ url: "https://cbr.ru/", provider: "free" })]);
    expect(f.calls.some((c) => c.url.includes("duckduckgo"))).toBe(false);
    const sx = new URL(f.calls[0]!.url);
    expect(sx.searchParams.get("q")).toBe("ключевая ставка site:cbr.ru");
    expect(sx.searchParams.get("time_range")).toBe("week");
  });
});

describe("GitHub: repositories, issues, code with a token; limits per resource", () => {
  beforeEach(() => resetFreeCache());
  const limited = (reset: number) =>
    new Response("{}", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
    });

  it("an error in the query → GitHub issues first in the free search", async () => {
    const f = fakeFetch([
      [
        "https://api.github.com/search/issues",
        () =>
          json({
            items: [
              {
                html_url: "https://github.com/vitejs/vite/issues/1",
                title: "Error: Cannot find module 'rollup'",
                body: "fixed by reinstalling",
                state: "closed",
                comments: 12,
                updated_at: "2026-09-01T00:00:00Z",
              },
            ],
          }),
      ],
      ["https://html.duckduckgo.com/html/", () => html(DDG)],
    ]);
    const hits = await freeSearch(
      { query: "vite Error: Cannot find module rollup" },
      { fetchImpl: f.impl },
    );
    expect(hits[0]).toMatchObject({
      url: "https://github.com/vitejs/vite/issues/1",
      title: "Error: Cannot find module 'rollup' (issue, закрыт, ответов 12)",
      date: "2026-09-01",
    });
    const issues = f.calls.find((c) => c.url.includes("/search/issues"))!;
    expect(issues.url).toContain("+is:issue");
    expect(issues.headers.Authorization).toBeUndefined();
  });

  it("site:github.com: repositories; a spent search limit — «лимит GitHub, подождите минуту»", async () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    const f = fakeFetch([
      ["https://api.github.com/search/", () => limited(reset)],
      ["https://html.duckduckgo.com/html/", () => html("anomaly.js", 202)],
    ]);
    await expect(
      freeSearch({ query: "markdown parser", site: "github.com" }, { fetchImpl: f.impl }),
    ).rejects.toThrow("лимит GitHub, подождите минуту");
    const before = f.calls.length;
    await expect(
      freeSearch({ query: "yaml parser", site: "github.com" }, { fetchImpl: f.impl }),
    ).rejects.toThrow("лимит GitHub");
    // paused until the reset: GitHub is not asked again
    expect(f.calls.slice(before).some((c) => c.url.includes("api.github.com"))).toBe(false);
  });

  it("own token: the github provider searches code too, with the token; 401 → auth", async () => {
    const f = fakeFetch([
      [
        "https://api.github.com/search/repositories",
        () =>
          json({
            items: [{ html_url: "https://github.com/a/b", full_name: "a/b", stargazers_count: 5 }],
          }),
      ],
      [
        "https://api.github.com/search/code",
        (c) => {
          expect(c.headers.Accept).toContain("text-match");
          return json({
            items: [
              {
                html_url: "https://github.com/a/b/blob/main/src/x.ts",
                path: "src/x.ts",
                repository: { full_name: "a/b" },
                text_matches: [{ fragment: "defineConfig({" }],
              },
            ],
          });
        },
      ],
      ["https://api.github.com/search/issues", () => json({ items: [] })],
    ]);
    const hits = await search(
      { provider: "github", key: "ghp_t" },
      { query: "defineConfig vite" },
      { fetchImpl: f.impl },
    );
    expect(hits.map((h) => h.title)).toEqual(["a/b — ★5", "a/b: src/x.ts"]);
    expect(f.calls.every((c) => c.headers.Authorization === "Bearer ghp_t")).toBe(true);
    const bad = fakeFetch([["https://api.github.com/", () => json({}, 401)]]);
    const err = await search(
      { provider: "github", key: "x" },
      { query: "q" },
      { fetchImpl: bad.impl },
    ).catch((e: unknown) => e);
    expect((err as SearchError).code).toBe("auth");
    await expect(search({ provider: "github" }, { query: "q" })).rejects.toThrow("нет ключа");
  });

  it("files from GitHub through jsDelivr when GitHub does not open", async () => {
    expect(
      jsdelivrUrl("https://github.com/vitejs/vite/blob/v7.1.0/packages/vite/package.json"),
    ).toBe("https://cdn.jsdelivr.net/gh/vitejs/vite@v7.1.0/packages/vite/package.json");
    expect(jsdelivrUrl("https://raw.githubusercontent.com/o/r/refs/heads/main/a/b.md")).toBe(
      "https://cdn.jsdelivr.net/gh/o/r@main/a/b.md",
    );
    expect(jsdelivrUrl("https://github.com/o/r")).toBe("https://cdn.jsdelivr.net/gh/o/r/README.md");
    expect(jsdelivrUrl("https://github.com/o/r/issues/1")).toBeUndefined();
    expect(jsdelivrUrl("https://example.com/a")).toBeUndefined();
    const text = "# Vite\n\n" + "Next generation frontend tooling. ".repeat(20);
    const f = fakeFetch([
      [
        "https://cdn.jsdelivr.net/gh/o/r/README.md",
        () => new Response(text, { headers: { "content-type": "text/plain" } }),
      ],
    ]);
    const page = await readPage("https://github.com/o/r", { fetchImpl: f.impl, jina: false });
    expect(page).toMatchObject({ url: "https://github.com/o/r", via: "jsdelivr" });
    expect(page.text).toContain("Next generation frontend tooling");
  });
});

describe("the model's search through the gateway (last fallback)", () => {
  it("models are tried in order: no search (no sources) → the next one", async () => {
    const asked: string[] = [];
    const f = fakeFetch([
      [
        "https://gw/v1/chat/completions",
        (c) => {
          const model = (c.body as { model: string }).model;
          asked.push(model);
          return json({
            choices: [
              {
                message: {
                  content:
                    model === "grok-4.20-multi-agent-0309"
                      ? "https://cbr.ru/ — 2026-10-24 — 14%"
                      : "не знаю",
                },
              },
            ],
          });
        },
      ],
    ]);
    const hits = await search(
      {
        provider: "model",
        url: "https://gw/v1",
        key: "k",
        models: ["gemini-3-pro-preview", "grok-4.20-multi-agent-0309"],
      },
      { query: "ключевая ставка" },
      { fetchImpl: f.impl },
    );
    expect(asked).toEqual(["gemini-3-pro-preview", "grok-4.20-multi-agent-0309"]);
    expect(hits).toEqual([expect.objectContaining({ url: "https://cbr.ru/", date: "2026-10-24" })]);
  });

  it("sources from url_citation annotations and «URL — date — gist» lines", () => {
    const hits = modelHits(
      "https://brave.com/search/api/ — 2026-09-01 — $5 per 1000 requests\nhttps://x.example/a — unknown — y",
      [
        {
          type: "url_citation",
          url_citation: { url: "https://brave.com/search/api/", title: "Brave API" },
        },
      ],
    );
    expect(hits).toEqual([
      {
        url: "https://brave.com/search/api/",
        title: "Brave API",
        snippet: "$5 per 1000 requests",
        date: "2026-09-01",
        provider: "model",
      },
      { url: "https://x.example/a", title: "", snippet: "y", provider: "model" },
    ]);
  });

  it("errors: 401 → auth, 429 → limit", async () => {
    for (const [status, code] of [
      [401, "auth"],
      [429, "limit"],
    ] as const) {
      const f = fakeFetch([["https://gw/v1/chat/completions", () => json({}, status)]]);
      const err = await search(
        { provider: "model", url: "https://gw/v1", key: "k" },
        { query: "q" },
        { fetchImpl: f.impl },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SearchError);
      expect((err as SearchError).code).toBe(code);
    }
  });
});

describe("web_search: chain, year guard, tiers, site", () => {
  beforeEach(() => resetFreeCache());

  function setup(research: Parameters<typeof installResearch>[2]) {
    const out = mkdtempSync(join(tmpdir(), "web-tools-"));
    const settingsPath = join(out, "prsloy-harness.json");
    writeFileSync(settingsPath, JSON.stringify({ webTools: true }));
    const mock = new MockPi(out);
    (mock.ctx as unknown as { modelRegistry: unknown }).modelRegistry = {
      getApiKeyForProvider: async (p: string) => (p === "prsloy" ? "sk-gateway" : undefined),
    };
    installResearch(mock.api, resolveOptions({ outputDir: out, settingsPath }), research);
    const run = async (params: Record<string, unknown>) => {
      const r = await mock.tools
        .get("web_search")!
        .execute("1", params, undefined, undefined, mock.ctx as never);
      return { text: (r.content[0] as { text: string }).text, details: r.details as never };
    };
    return { mock, run };
  }

  it("the flag lives in flags.ts, off by default; env PRSLOY_WEB_TOOLS overrides", () => {
    expect(readFlags(undefined).webTools).toBe(false);
    process.env.PRSLOY_WEB_TOOLS = "1";
    try {
      expect(readFlags(undefined).webTools).toBe(true);
    } finally {
      delete process.env.PRSLOY_WEB_TOOLS;
    }
  });

  it("short English descriptions and one prompt line", () => {
    const { mock } = setup({ fetchImpl: fakeFetch([]).impl });
    const ws = mock.tools.get("web_search")!;
    expect(ws.description.length).toBeLessThan(200);
    expect(mock.tools.get("web_fetch")!.description.length).toBeLessThan(200);
    expect(ws.promptGuidelines).toEqual([WEB_TOOLS_LINE]);
    expect(mock.tools.get("web_fetch")!.promptGuidelines).toBeUndefined();
  });

  it("free by default: today's date, the old year removed, a tier on each row, site passed on", async () => {
    const f = fakeFetch([["https://html.duckduckgo.com/html/", () => html(DDG)]]);
    const { run } = setup({ fetchImpl: f.impl, now: NOW });
    const { text, details } = await run({
      query: "node releases 2024",
      site: "https://nodejs.org/en",
      count: 25,
    });
    expect(text).toContain("Сегодня 2026-10-25");
    expect(text).toContain("Поиск: Бесплатный поиск · «node releases» · сайт nodejs.org");
    expect(text).toContain("Запрос исправлен: убран 2024 — сегодня 2026 год.");
    expect(text).toContain("[1] Node.js — Releases — nodejs.org — дата неизвестна — статьи");
    expect(text).toContain(
      "[2] Топ-10 сервисов поиска — habr.com — дата неизвестна — маркетинг/SEO",
    );
    const form = String(f.calls[0]!.body);
    expect(decodeURIComponent(form.replace(/\+/g, " "))).toContain(
      "q=node releases site:nodejs.org",
    );
    expect(details).toMatchObject({ provider: "free", hits: 2, removedYears: [2024] });
  });

  it("own key → limit card once → free; all down → the model's search, marked unchecked", async () => {
    const f = fakeFetch([
      ["https://api.search.brave.com/", () => json({}, 429)],
      ["https://html.duckduckgo.com/html/", () => html(DDG)],
    ]);
    const { mock, run } = setup({
      search: { provider: "brave", key: "k" },
      gatewayUrl: "https://gw/v1",
      fetchImpl: f.impl,
      now: NOW,
    });
    const first = await run({ query: "brave api price" });
    expect(first.text).toContain("Поиск: Бесплатный поиск");
    expect(first.text).toContain("Запасной поиск: Brave: лимит или баланс исчерпан (HTTP 429).");
    await run({ query: "brave api price again" });
    expect(mock.sent.filter((m) => m.customType === "prsloy-harness.search-limit")).toEqual([
      {
        customType: "prsloy-harness.search-limit",
        content: "Brave: лимит или баланс исчерпан (HTTP 429)",
        display: true,
        details: { provider: "brave", code: "limit" },
      },
    ]);

    const g = fakeFetch([
      ["https://html.duckduckgo.com/html/", () => html("anomaly.js", 202)],
      ["https://ru.wikipedia.org/", () => json({}, 500)],
      [
        "https://gw/v1/chat/completions",
        (c) => {
          expect(c.headers.Authorization).toBe("Bearer sk-gateway");
          expect(c.body).toMatchObject({ model: "gpt-6.1-sol", web_search_options: {} });
          return json({
            choices: [
              {
                message: {
                  content: "https://cbr.ru/hd_base/KeyRate/ — 2026-10-24 — 14%",
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: { url: "https://cbr.ru/hd_base/KeyRate/", title: "Ставка" },
                    },
                  ],
                },
              },
            ],
          });
        },
      ],
    ]);
    const m = setup({
      gatewayUrl: "https://gw/v1",
      modelSearch: ["gpt-6.1-sol"],
      fetchImpl: g.impl,
      now: NOW,
    });
    const last = await m.run({ query: "ключевая ставка" });
    expect(last.text).toContain(`Поиск: Поиск модели · «ключевая ставка» — ${MODEL_SEARCH_NOTE}`);
    expect(last.text).toContain("[1] Ставка — cbr.ru — 2026-10-24 — доки");
    // no free fallback card: free search is not the user's setting
    expect(m.mock.sent).toEqual([]);
  });
});
