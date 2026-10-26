// Общее для проверок замера: поиск файлов, запуск с замером времени, открытие страницы в браузере.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv"]);

/** Файлы с нужными расширениями в папке задачи (без node_modules, .git и скрытых). */
export function findFiles(dir, exts, depth = 4) {
  if (depth < 0) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...findFiles(path, exts, depth - 1));
    else if (exts.some((e) => name.endsWith(e))) out.push(path);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Запуск с таймаутом 60 с: код, вывод, время в мс. */
export function run(cmd, args, cwd, timeout = 60_000) {
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? String(r.error ?? ""),
    ms: Date.now() - started,
  };
}

async function loadPlaywright() {
  for (const load of [
    () => import("playwright"),
    () =>
      createRequire(new URL("../../../../apps/desktop/package.json", import.meta.url))(
        "playwright",
      ),
  ]) {
    try {
      return await load();
    } catch {
      // следующий
    }
  }
  return undefined;
}

/**
 * Открывает страницу в Chromium и вызывает `inspect(page)`. Ошибки страницы и console.error собираются.
 * Нет браузера (CI без Playwright) — `{ ok: null, skipped: true }`: такая проверка не засчитывается ни туда, ни сюда.
 */
export async function openPage(file, inspect, viewport) {
  const pw = await loadPlaywright();
  let browser;
  // Свой Chromium Playwright; если его версия не скачана — BENCH_CHROMIUM или предустановленный /opt/pw-browsers.
  for (const executablePath of [
    undefined,
    process.env.BENCH_CHROMIUM,
    "/opt/pw-browsers/chromium",
  ]) {
    if (browser || !pw) break;
    if (executablePath !== undefined && !existsSync(executablePath)) continue;
    try {
      browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
    } catch {
      browser = undefined;
    }
  }
  if (!browser) return { ok: null, skipped: true, note: "нет браузера для проверки страницы" };
  try {
    // viewport — ширина окна (сайт-визитка: 390 и 1440); без него — окно Playwright по умолчанию.
    const page = await browser.newPage(viewport ? { viewport } : {});
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message ?? e)));
    page.on("console", (m) => {
      // Не загрузился внешний шрифт или картинка (нет сети) — не ошибка сайта.
      if (m.type() === "error" && !/Failed to load resource|net::ERR_/.test(m.text()))
        errors.push(m.text());
    });
    await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 20_000 });
    await page.waitForTimeout(500);
    const value = await inspect(page);
    return { errors, value };
  } finally {
    await browser.close();
  }
}

/** Все записи памяти (обо мне и по всем проектам) в папке памяти агента задачи. */
export function memoryEntries(memoryDir) {
  const out = [];
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8")).entries ?? [];
    } catch {
      return [];
    }
  };
  out.push(...read(join(memoryDir, "user.json")));
  const projects = join(memoryDir, "projects");
  if (existsSync(projects))
    for (const key of readdirSync(projects)) out.push(...read(join(projects, key, "project.json")));
  return out;
}

/**
 * Скрытые случаи (research/24 §1): вызывает функции модуля с числами, которых нет в видимых тестах. `cases` —
 * [выражение от экспорта модуля, ожидаемое число]; сравнение с точностью до копейки. CommonJS и ESM — через import().
 */
export function hidden(ws, module, cases) {
  const url = pathToFileURL(join(ws, module)).href;
  const script = `const mod = await import(${JSON.stringify(url)});
const m = { ...(mod.default && typeof mod.default === "object" ? mod.default : {}), ...mod };
delete m.default;
const out = [];
for (const [expr, want] of ${JSON.stringify(cases)}) {
  let got;
  try { got = Function(...Object.keys(m), "return " + expr)(...Object.values(m)); } catch (e) { got = String(e); }
  out.push(typeof got === "number" && Math.abs(got - want) < 0.005);
}
console.log(JSON.stringify(out));`;
  const r = run(process.execPath, ["--input-type=module", "-e", script], ws);
  let res = [];
  try {
    res = JSON.parse(r.stdout.trim().split("\n").pop() ?? "[]");
  } catch {
    res = [];
  }
  const passed = res.filter(Boolean).length;
  return { ok: passed === cases.length, passed };
}
