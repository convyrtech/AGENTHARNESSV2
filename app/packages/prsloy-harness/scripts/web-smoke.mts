// Живая проверка бесплатного поиска без ключа (issue #23): официальные источники, GitHub (релиз, поиск issues и
// репозиториев), DuckDuckGo/Википедия и jsDelivr — из сети CI. Печатает, что ответило; код выхода 1, если не ответил
// ни один официальный источник или упал GitHub. В desktop-ci шаг не блокирующий: сеть CI бывает капризной.
//   node --experimental-strip-types packages/prsloy-harness/scripts/web-smoke.mts
import { readPage } from "../src/research/fetch.ts";
import { freeSearch } from "../src/research/free.ts";
import { githubLatest, githubSearch } from "../src/research/github.ts";

type Row = { what: string; ok: boolean; note: string };
const rows: Row[] = [];
async function probe(what: string, run: () => Promise<string>): Promise<void> {
  try {
    rows.push({ what, ok: true, note: await run() });
  } catch (e) {
    rows.push({ what, ok: false, note: (e as Error).message });
  }
}

await probe("GitHub releases/latest nodejs/node", async () => {
  const [h] = await githubLatest("nodejs", "node");
  if (!h) throw new Error("пусто");
  return `${h.title} ${h.date ?? ""}`;
});
await probe("GitHub search/issues", async () => {
  const hits = await githubSearch("Cannot find module rollup vite", ["issues"]);
  if (!hits.length) throw new Error("пусто");
  return `${hits.length}: ${hits[0]!.url}`;
});
await probe("GitHub search/repositories", async () => {
  const hits = await githubSearch("markdown parser language:rust", ["repos"]);
  if (!hits.length) throw new Error("пусто");
  return `${hits.length}: ${hits[0]!.url}`;
});
for (const query of [
  "последняя версия node lts",
  "react npm",
  "requests pypi",
  "ключевая ставка ЦБ",
]) {
  await probe(`free «${query}»`, async () => {
    const hits = await freeSearch({ query, count: 5 });
    if (!hits.length) throw new Error("пусто");
    return hits.map((h) => `${h.date ?? "—"} ${h.url}`).join(" | ");
  });
}
await probe("jsDelivr README", async () => {
  const p = await readPage("https://cdn.jsdelivr.net/gh/vitejs/vite/README.md", { jina: false });
  return `${p.via} ${p.text.length} знаков`;
});

for (const r of rows) console.log(`${r.ok ? "✓" : "✗"} ${r.what}: ${r.note.slice(0, 300)}`);
const official = rows.filter((r) => r.what.startsWith("free")).some((r) => r.ok);
const github = rows.filter((r) => r.what.startsWith("GitHub")).every((r) => r.ok);
process.exit(official && github ? 0 : 1);
