// Приёмка чтения R1 (research/26 §4.10): ≥85% из 50 адресов читаются, из них ≥15 российских (.ru, .gov.ru).
// Читает тем же кодом, что инструмент web_fetch (`src/research/fetch.ts`): с этой машины, без шлюза; с --jina —
// с запасным Jina Reader. Гонять на машине пользователя в России: из-за рубежа часть .ru закрыта.
//
//   node --experimental-strip-types experiments/research/read_urls.mts [--jina] [--out read-report.json]
import { writeFileSync } from "node:fs";
import { readPage } from "../../app/packages/prsloy-harness/src/research/fetch.ts";

const RU = [
  "https://www.cbr.ru/hd_base/KeyRate/",
  "https://www.cbr.ru/about_br/",
  "https://www.consultant.ru/law/ref/mrot/2026/",
  "https://www.consultant.ru/law/ref/calendar/proizvodstvennye/2026/",
  "https://www.nalog.gov.ru/rn77/taxation/taxes/ndfl/",
  "http://government.ru/news/",
  "https://minfin.gov.ru/ru/",
  "https://rosstat.gov.ru/",
  "http://pravo.gov.ru/",
  "http://kremlin.ru/events/president/news",
  "https://www.gosuslugi.ru/",
  "https://ru.wikipedia.org/wiki/Пушкин,_Александр_Сергеевич",
  "https://habr.com/ru/news/",
  "https://developers.sber.ru/docs/ru/gigachat/tariffs/legal-tariffs",
  "https://yandex.cloud/ru/docs/search-api/pricing",
  "https://ria.ru/",
  "https://tass.ru/",
  "https://www.rbc.ru/",
  "https://www.kommersant.ru/",
  "https://www.vedomosti.ru/",
];
const WORLD = [
  "https://nodejs.org/en/about/previous-releases",
  "https://www.python.org/downloads/",
  "https://docs.python.org/3/whatsnew/index.html",
  "https://endoflife.date/python",
  "https://www.firecrawl.dev/pricing",
  "https://brave.com/search/api/",
  "https://api-docs.deepseek.com/guides/search",
  "https://docs.exa.ai/reference/search",
  "https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement",
  "https://arxiv.org/abs/2502.00674",
  "https://tavily.com/terms",
  "https://github.com/searxng/searxng",
  "https://raw.githubusercontent.com/searxng/searxng/master/LICENSE",
  "https://en.wikipedia.org/wiki/Large_language_model",
  "https://www.typescriptlang.org/docs/",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
  "https://www.kernel.org/",
  "https://www.anthropic.com/news",
  "https://www.bbc.com/news",
  "https://www.reuters.com/technology/",
  "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array",
  "https://news.ycombinator.com/",
  "https://pypi.org/project/requests/",
  "https://www.npmjs.com/package/typescript",
  "https://go.dev/doc/",
  "https://www.rust-lang.org/",
  "https://docs.github.com/en",
  "https://huggingface.co/docs",
  "https://openai.com/index/",
  "https://www.theverge.com/",
];

const jina = process.argv.includes("--jina");
const outAt = process.argv.indexOf("--out");
const rows = await Promise.all(
  [...RU.map((u) => [u, "ru"] as const), ...WORLD.map((u) => [u, "world"] as const)].map(async ([url, group]) => {
    const t0 = Date.now();
    try {
      const p = await readPage(url, { jina, timeoutMs: 25_000 });
      const ok = p.text.length >= 200;
      return { url, group, ok, via: p.via, chars: p.text.length, date: p.date ?? null, ms: Date.now() - t0 };
    } catch (e) {
      return { url, group, ok: false, error: (e as Error).message.slice(0, 120), ms: Date.now() - t0 };
    }
  }),
);
const share = (xs: typeof rows) => (xs.length ? xs.filter((r) => r.ok).length / xs.length : 0);
const ru = rows.filter((r) => r.group === "ru");
const summary = {
  date: new Date().toISOString(),
  jina,
  read: `${rows.filter((r) => r.ok).length}/${rows.length}`,
  readShare: Math.round(share(rows) * 1000) / 1000,
  ruRead: `${ru.filter((r) => r.ok).length}/${ru.length}`,
  dated: `${rows.filter((r) => r.ok && "date" in r && r.date).length}/${rows.filter((r) => r.ok).length}`,
  pass: share(rows) >= 0.85 && ru.filter((r) => r.ok).length >= 15,
};
for (const r of rows) {
  console.log(`${r.ok ? "ок " : "нет"} ${r.group.padEnd(5)} ${"chars" in r ? String(r.chars).padStart(7) : "      -"} ${"date" in r && r.date ? r.date : "          "} ${r.url}${"error" in r ? `  — ${r.error}` : ""}`);
}
console.log(JSON.stringify(summary, null, 1));
if (outAt > 0) writeFileSync(process.argv[outAt + 1]!, JSON.stringify({ summary, rows }, null, 1));
