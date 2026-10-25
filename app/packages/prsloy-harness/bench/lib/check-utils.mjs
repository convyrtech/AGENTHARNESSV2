// Общее для проверок замера: поиск файлов, запуск с замером времени, открытие страницы в браузере.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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
export async function openPage(file, inspect) {
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
    const page = await browser.newPage();
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
