// Ревью #23 перед включением webTools: враждебные страницы, адреса, ключи. Каждый тест падает без своей правки.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { guardQuery } from "../src/research/query-guard.ts";
import { githubSearch } from "../src/research/github.ts";
import {
  freeSearch,
  githubRepo,
  npmPackage,
  pypiPackage,
  resetFreeCache,
  UNAVAILABLE,
} from "../src/research/free.ts";
import { resolveOptions } from "../src/options.ts";
import { search } from "../src/research/search.ts";
import { installResearch } from "../src/research/tools.ts";
import { scrubSecrets } from "../src/secret-scrub.ts";
import { MockPi } from "./mock-pi.ts";
import { isPrivateHost, isPrivateIp, type Resolve } from "../src/research/net-guard.ts";
import { fakeFetch, json } from "./fake-fetch.ts";
import {
  htmlToText,
  isTextType,
  MAX_HTML_CHARS,
  pageDate,
  readPage,
} from "../src/research/fetch.ts";

const fast = (f: () => unknown) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

describe("HTML is parsed in one pass (review #23, item 1)", () => {
  it("hostile markup does not hang the host: 200 KB of «<!--», «<meta», «<article», «<script»", () => {
    for (const piece of [
      "<!--",
      "<meta property='date' ",
      "<article>",
      "<script>",
      "<a ",
      "<time datetime='",
    ]) {
      const html = piece.repeat(Math.ceil(200_000 / piece.length));
      const ms = fast(() => {
        htmlToText(html);
        pageDate(html);
      });
      expect(ms, piece).toBeLessThan(500);
    }
  });

  it("the input is capped before parsing", () => {
    const html = `<p>${"a".repeat(MAX_HTML_CHARS)}</p><p>ХВОСТ</p>`;
    expect(htmlToText(html).text).not.toContain("ХВОСТ");
  });

  it("the same text as before: article preferred, chrome dropped, raw elements skipped", () => {
    const body = "Текст статьи. ".repeat(30);
    const html =
      "<!doctype html><html><head><title>Заголовок &amp; ещё</title>" +
      '<meta property="article:published_time" content="2026-10-01T10:00:00Z">' +
      '<script type="application/ld+json">{"dateModified":"2026-10-20"}</script></head><body>' +
      "<nav>Меню</nav><main><p>Лид</p><article><h1>Статья</h1><p>" +
      body +
      "</p><script>var x = '<p>не текст</p>';</script><!-- комментарий --></article></main>" +
      "<footer>Подвал</footer></body></html>";
    const { title, text } = htmlToText(html);
    expect(title).toBe("Заголовок & ещё");
    expect(text.startsWith("Статья\nТекст статьи.")).toBe(true);
    expect(text).not.toMatch(/Меню|Подвал|не текст|комментарий|Лид/);
    expect(pageDate(html)).toEqual({ date: "2026-10-20", from: "jsonld" });
    // нет article — main; нет main — всё без обвязки
    expect(htmlToText(`<nav>Меню</nav><main><p>${body}</p></main>`).text).not.toContain("Меню");
    expect(htmlToText(`<nav>Меню</nav><p>Коротко</p><footer>Подвал</footer>`).text).toBe("Коротко");
    expect(htmlToText("a < b и c > d").text).toBe("a < b и c > d");
  });
});

describe("the body is streamed up to the cap (review #23, item 2)", () => {
  it("an endless page is cut at the cap, and the rest is not downloaded", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode(`<p>${"x".repeat(65_530)}</p>`);
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += chunk.byteLength;
        c.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () =>
      new Response(endless, { headers: { "content-type": "text/html" } })) as typeof fetch;
    const page = await readPage("https://example.com/huge", {
      fetchImpl,
      maxBytes: 1_000_000,
      jina: false,
    });
    expect(page.text.length).toBeLessThanOrEqual(1_000_000);
    expect(pulled).toBeLessThan(1_000_000 + 4 * chunk.byteLength);
    expect(cancelled).toBe(true);
  }, 5_000);

  it("only text types are read: an allowlist, not a denylist", async () => {
    expect(isTextType("text/html; charset=utf-8")).toBe(true);
    expect(isTextType("application/json")).toBe(true);
    expect(isTextType("application/rss+xml")).toBe(true);
    expect(isTextType("")).toBe(true);
    for (const t of [
      "application/x-msdownload",
      "application/wasm",
      "font/woff2",
      "application/x-7z-compressed",
    ])
      expect(isTextType(t), t).toBe(false);
    const fetchImpl = (async () =>
      new Response("MZ\u0090\u0000", {
        headers: { "content-type": "application/x-msdownload" },
      })) as typeof fetch;
    await expect(
      readPage("https://example.com/setup.exe", { fetchImpl, jina: false }),
    ).rejects.toThrow("не текст");
  });
});

describe("local and private addresses are never read or sent out (review #23, item 3)", () => {
  const html = (body: string) =>
    new Response(`<html><body><article>${body}</article></body></html>`, {
      headers: { "content-type": "text/html" },
    });
  const publicDns: Resolve = async () => ["93.184.215.14"];

  it("private IPs and local names", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.9.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "224.0.0.1",
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "100.128.0.1"])
      expect(isPrivateIp(ip), ip).toBe(false);
    for (const h of [
      "localhost",
      "app.localhost",
      "printer.local",
      "nas",
      "router.lan",
      "[::1]",
      "2130706433",
      "0x7f000001",
      "corp.internal",
    ])
      expect(isPrivateHost(h), h).toBe(true);
    for (const h of ["example.com", "cbr.ru", "github.com"])
      expect(isPrivateHost(h), h).toBe(false);
  });

  it("http://localhost:8888/tree?token=SECRET reaches neither the network nor the gateway nor Jina", async () => {
    const f = fakeFetch([]);
    await expect(
      readPage("http://localhost:8888/tree?token=SECRET", {
        fetchImpl: f.impl,
        gateway: { url: "https://gw.example/v1", key: "k" },
      }),
    ).rejects.toThrow("частный адрес");
    expect(f.calls).toEqual([]);
  });

  it("a public page that redirects to 127.0.0.1 is not followed, and no fallback gets the address", async () => {
    const f = fakeFetch([
      [
        "https://evil.example/",
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1:8888/tree?token=SECRET" },
          }),
      ],
      ["https://gw.example/", () => json({ content: "x" })],
      ["https://r.jina.ai/", () => json({ data: { content: "x" } })],
    ]);
    await expect(
      readPage("https://evil.example/go", {
        fetchImpl: f.impl,
        resolve: publicDns,
        gateway: { url: "https://gw.example/v1", key: "k" },
      }),
    ).rejects.toThrow("редирект на частный адрес");
    expect(f.calls.map((c) => c.url)).toEqual(["https://evil.example/go"]);
    expect(JSON.stringify(f.calls)).not.toContain("SECRET");
  });

  it("a name that resolves to a private IP is refused; public redirects are followed hop by hop", async () => {
    const f = fakeFetch([
      // по префиксу: длинный адрес — первым
      ["https://a.example/b", () => html("Текст. ".repeat(60))],
      [
        "https://a.example/",
        () => new Response(null, { status: 301, headers: { location: "/b" } }),
      ],
    ]);
    await expect(
      readPage("https://rebind.example/", { fetchImpl: f.impl, resolve: async () => ["10.0.0.5"] }),
    ).rejects.toThrow("частный адрес");
    expect(f.calls).toEqual([]);
    const page = await readPage("https://a.example/", { fetchImpl: f.impl, resolve: publicDns });
    expect(page.finalUrl).toBe("https://a.example/b");
    expect(f.calls.map((c) => c.url)).toEqual(["https://a.example/", "https://a.example/b"]);
  });

  it("the redirect target is checked through DNS too", async () => {
    const f = fakeFetch([
      [
        "https://a.example/",
        () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://intranet-wiki.example/" },
          }),
      ],
    ]);
    const resolve: Resolve = async (h) =>
      h === "intranet-wiki.example" ? ["192.168.0.10"] : ["93.184.215.14"];
    await expect(
      readPage("https://a.example/", { fetchImpl: f.impl, resolve, jina: true }),
    ).rejects.toThrow("редирект на частный адрес");
    expect(f.calls).toHaveLength(1);
  });
});

describe("keys never reach text the model sees (review #23, item 4)", () => {
  const KEY = "BSAq7sEcReTkEy1234567890abcdef";
  /** Как Node: значение заголовка целиком в тексте ошибки. */
  const leaky = (async (_url: string, init?: RequestInit) => {
    const auth = Object.values((init?.headers as Record<string, string>) ?? {}).join(" ");
    throw new TypeError(`Headers.append: "${auth}\nX" is an invalid header value.`);
  }) as typeof fetch;

  function tools(research: Parameters<typeof installResearch>[2]) {
    const out = mkdtempSync(join(tmpdir(), "keys-"));
    const mock = new MockPi(out);
    (mock.ctx as unknown as { modelRegistry: unknown }).modelRegistry = {
      getApiKeyForProvider: async () => "sk-gw-0123456789abcdefghij",
    };
    installResearch(mock.api, resolveOptions({ outputDir: out }), { enabled: true, ...research });
    return mock;
  }

  it("a fetch error that quotes the header does not carry the key into the tool's error", async () => {
    const mock = tools({
      search: { provider: "brave", key: KEY },
      gatewayUrl: "https://gw.example/v1",
      fetchImpl: leaky,
    });
    const err = await mock.tools
      .get("web_search")!
      .execute("1", { query: "q" }, undefined, undefined, mock.ctx as never)
      .catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(String((err as Error).message)).not.toContain("sk-gw-0123456789abcdefghij");
    expect(String((err as Error).message)).toContain("Brave: нет ответа (сеть недоступна)");
    const read = await mock.tools
      .get("web_fetch")!
      .execute("2", { source: "https://example.com/" }, undefined, undefined, mock.ctx as never)
      .catch((e: Error) => e);
    expect(String((read as Error).message)).not.toContain("sk-gw-0123456789abcdefghij");
  });

  it("a server body that repeats the key is not shown", async () => {
    const f = fakeFetch([
      ["https://api.search.brave.com/", () => new Response(`bad token ${KEY}`, { status: 500 })],
    ]);
    const err = await search(
      { provider: "brave", key: KEY },
      { query: "q" },
      { fetchImpl: f.impl },
    ).catch((e: Error) => e);
    expect((err as Error).message).toBe("Brave: HTTP 500");
  });

  it("search keys are in the scrubber: verbatim once configured, and by their formats", () => {
    tools({
      search: { provider: "deepseek", key: "plainkey-without-format-42" },
      githubToken: "tok-github-777",
    });
    expect(scrubSecrets("x plainkey-without-format-42 y tok-github-777").text).toBe(
      "x [СКРЫТО: ключ поиска DeepSeek] y [СКРЫТО: ключ GitHub]",
    );
    const formats = [
      KEY,
      "AQVN1a2b3c4d5e6f7g8h9i0jKlMnOpQrStUvWx",
      "jina_0123456789abcdef0123456789abcdef0123",
      "fc-0123456789abcdef0123456789abcdef",
    ];
    for (const k of formats) expect(scrubSecrets(`key: ${k}`).text, k).not.toContain(k);
    expect(
      scrubSecrets('{"x-api-key": "123e4567-e89b-42d3-a456-426614174000"}').text,
    ).not.toContain("123e4567");
    // UUID без exa рядом — обычный id, не трогаем
    expect(scrubSecrets("id 123e4567-e89b-42d3-a456-426614174000").text).toContain("123e4567");
  });
});

describe("free search heuristics (review #23, item 6)", () => {
  beforeEach(() => resetFreeCache());

  it("endoflife.date answers Python (python was a stop word)", async () => {
    const f = fakeFetch([
      ["https://endoflife.date/api/all.json", () => json(["python", "nodejs"])],
      [
        "https://endoflife.date/api/python.json",
        () => json([{ cycle: "3.10", eol: "2026-10-01", latest: "3.10.19" }]),
      ],
      [
        "https://html.duckduckgo.com/",
        () => new Response('<div class="no-results">No results.</div>'),
      ],
      ["https://en.wikipedia.org/", () => json({ query: { search: [] } })],
    ]);
    const hits = await freeSearch(
      { query: "is python 3.10 still supported" },
      { fetchImpl: f.impl },
    );
    expect(hits[0]?.url).toBe("https://endoflife.date/python");
  });

  it("«pip install requests latest» looks up requests, not «install»", () => {
    expect(pypiPackage("pip install requests latest")).toBe("requests");
    expect(pypiPackage("pip install -U pydantic")).toBe("pydantic");
    expect(npmPackage("npm install zod latest version")).toBe("zod");
    expect(npmPackage("npm i -D vite")).toBe("vite");
    expect(npmPackage("how to use npm with react")).toBe("react");
  });

  it("DuckDuckGo with a layout the parser does not know is a failure, so the fallback runs", async () => {
    const f = fakeFetch([
      [
        "https://html.duckduckgo.com/",
        () => new Response("<html><body><div class='new-layout'>…</div></body></html>"),
      ],
      ["https://en.wikipedia.org/", () => json({ query: { search: [] } })],
    ]);
    await expect(freeSearch({ query: "anything" }, { fetchImpl: f.impl })).rejects.toThrow(
      UNAVAILABLE,
    );
    // a real «no results» page is an empty answer, not a failure
    const g = fakeFetch([
      [
        "https://html.duckduckgo.com/",
        () => new Response('<div class="no-results">No results.</div>'),
      ],
      ["https://en.wikipedia.org/", () => json({ query: { search: [] } })],
    ]);
    expect(await freeSearch({ query: "qwzxv" }, { fetchImpl: g.impl })).toEqual([]);
  });

  it("«async/await», «client/server» are words, not repositories: no GitHub call", async () => {
    for (const q of ["async/await in python", "client/server architecture", "read/write lock"])
      expect(githubRepo(q), q).toBeUndefined();
    expect(githubRepo("latest release vitejs/vite")).toEqual({ owner: "vitejs", repo: "vite" });
    expect(githubRepo("https://github.com/a/b")).toEqual({ owner: "a", repo: "b" });
  });
});

describe("the year guard strips only a year that stands alone as a date (review #23, item 7)", () => {
  const TODAY = new Date("2026-10-25T12:00:00Z");
  it("names and codes keep their numbers", () => {
    for (const q of [
      "ERROR 2002 (HY000): Can't connect to local MySQL server",
      "tsconfig target es2020",
      "Windows Server 2019 end of support",
      "Visual Studio 2022 C++ build tools",
      "Office 2016 activation",
      "ошибка 2003 при подключении",
      "ECMAScript2015 modules",
      "iso 9001 2015 checklist",
    ])
      expect(guardQuery(q, TODAY).removed, q).toEqual([]);
  });

  it("Russian past-tense words are understood (\\b after Cyrillic never matched)", () => {
    expect(guardQuery("какой был МРОТ 2020", TODAY).removed).toEqual([]);
    expect(guardQuery("какая была ставка 2019", TODAY).removed).toEqual([]);
    // «вопрос 2019» — не «с 2019»
    expect(guardQuery("вопрос 2019 налоги", TODAY).removed).toEqual([2019]);
  });

  it("a habit year is still removed", () => {
    expect(guardQuery("тарифы Brave Search API 2024", TODAY)).toEqual({
      query: "тарифы Brave Search API",
      removed: [2024],
    });
    expect(guardQuery("лучшие ноутбуки (2023)", TODAY).removed).toEqual([2023]);
  });
});

describe("GitHub limits are shown, npm versions come from the registry (review #23, nits)", () => {
  beforeEach(() => resetFreeCache());

  it("a secondary limit (403, no retry-after) pauses GitHub", async () => {
    const f = fakeFetch([
      [
        "https://api.github.com/",
        () =>
          new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
            status: 403,
            headers: { "x-ratelimit-remaining": "40" },
          }),
      ],
    ]);
    await expect(githubSearch("q", ["repos"], { fetchImpl: f.impl })).rejects.toThrow(
      "лимит GitHub",
    );
    await expect(githubSearch("q2", ["repos"], { fetchImpl: f.impl })).rejects.toThrow(
      "лимит GitHub",
    );
    expect(f.calls).toHaveLength(1);
  });

  it("a GitHub limit or a bad token inside the free search becomes a card, the search goes on", async () => {
    const f = fakeFetch([
      [
        "https://api.github.com/",
        () =>
          new Response("{}", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
          }),
      ],
      [
        "https://html.duckduckgo.com/",
        () => new Response('<div class="no-results">No results.</div>'),
      ],
      ["https://en.wikipedia.org/", () => json({ query: { search: [] } })],
    ]);
    const issues: [string, string][] = [];
    await freeSearch(
      { query: "latest release vitejs/vite" },
      { fetchImpl: f.impl, onIssue: (p, e) => issues.push([p, e.code]) },
    );
    expect(issues).toEqual([["github", "limit"]]);
  });

  it("npm: the version from /<name>/latest even when the search index lags", async () => {
    const f = fakeFetch([
      ["https://registry.npmjs.org/zod/latest", () => json({ version: "4.6.7" })],
      [
        "https://registry.npmjs.org/-/v1/search",
        () =>
          json({ objects: [{ package: { name: "zod", version: "4.6.5", date: "2026-09-01" } }] }),
      ],
      [
        "https://html.duckduckgo.com/",
        () => new Response('<div class="no-results">No results.</div>'),
      ],
      ["https://en.wikipedia.org/", () => json({ query: { search: [] } })],
    ]);
    const [hit] = await freeSearch({ query: "zod npm" }, { fetchImpl: f.impl });
    expect(hit).toMatchObject({ title: "zod 4.6.7 — npm (последняя версия)" });
    // the index's date belongs to another version: not shown
    expect(hit!.date).toBeUndefined();
  });
});

describe("the tool's abort signal is respected (review #23, nits)", () => {
  /** fetch, который висит, пока его не отменят — как медленная модель со встроенным поиском. */
  const hanging = (asked: string[]) =>
    (async (_url: string, init?: RequestInit) => {
      asked.push(
        String(
          (JSON.parse((init?.body as string | undefined) ?? "{}") as { model?: string }).model,
        ),
      );
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as typeof fetch;

  it("Esc stops the model search at once, not after 10 models × 90 s", async () => {
    const asked: string[] = [];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const t0 = Date.now();
    await expect(
      search(
        { provider: "model", url: "https://gw/v1", key: "k", models: ["a", "b", "c"] },
        { query: "q" },
        { fetchImpl: hanging(asked), signal: controller.signal },
      ),
    ).rejects.toThrow("остановлено");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(asked).toEqual(["a"]);
  });

  it("web_search passes the tool's signal down the chain", async () => {
    const asked: string[] = [];
    const mock = new MockPi(mkdtempSync(join(tmpdir(), "abort-")));
    installResearch(
      mock.api,
      resolveOptions({ outputDir: mkdtempSync(join(tmpdir(), "abort-")) }),
      {
        enabled: true,
        search: { provider: "model", url: "https://gw/v1", key: "k", models: ["slow"] },
        fetchImpl: hanging(asked),
      },
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      mock.tools
        .get("web_search")!
        .execute("1", { query: "q" }, controller.signal, undefined, mock.ctx as never),
    ).rejects.toThrow("Поиск остановлен");
  });
});

describe("follow-ups after the merge (review #23, round 2)", () => {
  it("«İ» before a <script> does not shift the scanner: the script stays out of the text", () => {
    const html = `<p>İstanbul İzmir</p><SCRIPT>leak("secret")</ScRiPt><p>after</p>`;
    const { text } = htmlToText(html);
    expect(text).not.toContain("secret");
    expect(text).toContain("İstanbul İzmir");
    expect(text).toContain("after");
    // </scripts is not </script
    expect(htmlToText("<script>a</scripts>b</script><p>ok</p>").text).toBe("ok");
  });
});

describe("the year guard leaves versions and codes alone (review #23, round 2)", () => {
  const TODAY = new Date("2026-10-25T12:00:00Z");
  it("YYYY.N is a version; product and error words keep their numbers", () => {
    for (const q of [
      "IntelliJ IDEA 2024.2 release notes",
      "Unity 2022.3 LTS",
      "PyCharm 2024.3 debugger",
      "mysql 2002 socket",
      "Can't connect, code 2003",
    ])
      expect(guardQuery(q, TODAY), q).toEqual({ query: q, removed: [] });
    expect(guardQuery("лучшие ноутбуки 2024.", TODAY).removed).toEqual([2024]);
  });
});
