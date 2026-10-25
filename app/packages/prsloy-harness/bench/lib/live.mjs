// Эталоны задач набора web (issue #23) — из первоисточника в момент проверки: реестры npm и PyPI, endoflife.date,
// страница релизов GitHub (редирект /releases/latest — без API и его лимита). Сеть — global fetch.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

async function json(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "prsloy-bench" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export const today = () => new Date().toISOString().slice(0, 10);

export async function npmLatest(name) {
  return (await json(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`)).version;
}

export async function pypiLatest(name) {
  return (await json(`https://pypi.org/pypi/${name}/json`)).info.version;
}

/** Ветки продукта с endoflife.date: [{cycle, eol, lts, releaseDate, latest}]. */
export async function eolCycles(product) {
  return json(`https://endoflife.date/api/${product}.json`);
}

/** Поддерживается ли ветка сегодня и до какой даты. */
export async function supported(product, cycle) {
  const c = (await eolCycles(product)).find((x) => String(x.cycle) === String(cycle));
  if (!c) throw new Error(`${product} ${cycle}: нет на endoflife.date`);
  const eol = typeof c.eol === "string" ? c.eol : null;
  return { yes: c.eol === false || (eol !== null && eol >= today()), eol };
}

/** Новейшая LTS-ветка на сегодня (lts — дата начала LTS или true). */
export async function newestLts(product) {
  const t = today();
  const lts = (await eolCycles(product)).filter(
    (c) =>
      (c.lts === true || (typeof c.lts === "string" && c.lts <= t)) &&
      (!c.releaseDate || c.releaseDate <= t) &&
      (c.eol === false || (typeof c.eol === "string" && c.eol > t)),
  );
  if (!lts.length) throw new Error(`${product}: нет LTS`);
  return lts
    .map((c) => String(c.cycle))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
}

/** Тег последнего релиза: github.com/<o>/<r>/releases/latest отвечает редиректом на …/tag/<тег>. */
export async function githubLatestTag(owner, repo) {
  const res = await fetch(`https://github.com/${owner}/${repo}/releases/latest`, {
    redirect: "manual",
    headers: { "User-Agent": "prsloy-bench" },
    signal: AbortSignal.timeout(20_000),
  });
  const loc = res.headers.get("location") ?? "";
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(loc)?.[1];
  if (!tag) throw new Error(`${owner}/${repo}: нет редиректа на тег (HTTP ${res.status})`);
  return decodeURIComponent(tag);
}

export function readJsonFile(ws, file) {
  const path = join(ws, file);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function readText(ws, file) {
  const path = join(ws, file);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export const major = (v) => Number(/(\d+)/.exec(String(v ?? ""))?.[1] ?? NaN);

/** Сравнение версий x.y.z (без пре-релизов): <0, 0, >0. */
export function cmp(a, b) {
  const pa = String(a)
    .replace(/^[^\d]*/, "")
    .split(/[.-]/)
    .map(Number);
  const pb = String(b)
    .replace(/^[^\d]*/, "")
    .split(/[.-]/)
    .map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Зависимость из package.json (dependencies или devDependencies). */
export function dep(pkg, name) {
  return pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name];
}

/** «Поставь последнюю мажорную»: диапазон ^ на последний мажор, не выше последней версии. */
export async function latestMajorRange(ws, name) {
  const want = await npmLatest(name);
  const got = dep(readJsonFile(ws, "package.json"), name);
  if (!got) return { ok: false, note: `${name} нет в package.json (последняя ${want})` };
  const ok = got.startsWith("^") && major(got) === major(want) && cmp(got, want) <= 0;
  return { ok, note: `${name}: ${got}, последняя ${want}` };
}

/** «Точно последнюю»: версия без диапазона, равна последней. */
export async function exactLatest(ws, name) {
  const want = await npmLatest(name);
  const got = dep(readJsonFile(ws, "package.json"), name);
  return { ok: got === want, note: `${name}: ${got ?? "нет"}, последняя ${want}` };
}
