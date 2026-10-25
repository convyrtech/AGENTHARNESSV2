// Страница должна открываться и двойным кликом (file://): абсолютные пути `/assets/…` там ведут в корень диска.
// Стенд a6: `file:///fonts/…` (visit-card), `file:///assets/index-*.js` (Vite с base `/`). Превью сервером это
// прячет, казуал — нет. Проверка для стоп-гейта: код, без LLM.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "coverage"]);
const BUILD_DIRS = ["dist", "build", "out"];
const VITE_CONFIGS = [
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.cjs",
];
const MAX_FILES = 200;

export interface PathIssue {
  file: string;
  ref: string;
}

export interface PagePathReport {
  issues: PathIssue[];
  /** vite.config.* без `base: './'`. */
  viteBase?: string;
}

function walk(dir: string, exts: string[], depth: number, out: string[]): void {
  if (depth < 0 || out.length >= MAX_FILES) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(path, exts, depth - 1, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(path);
  }
}

// src у любого тега, href у <link> (стили, шрифты, иконки), url(...) в стилях. `//cdn…` и `/` в ссылках <a> — не трогаем.
const SRC = /\ssrc\s*=\s*["'](\/(?!\/)[^"']*)["']/gi;
const LINK = /<link\b[^>]*\shref\s*=\s*["'](\/(?!\/)[^"']*)["']/gi;
const CSS_URL = /url\(\s*["']?(\/(?!\/)[^"')]*)["']?\s*\)/gi;

export function absoluteRefs(text: string, css: boolean): string[] {
  const refs: string[] = [];
  const patterns = css ? [CSS_URL] : [SRC, LINK, CSS_URL];
  for (const re of patterns) for (const m of text.matchAll(re)) refs.push(m[1]!);
  return [...new Set(refs)];
}

function isVite(cwd: string): string | undefined {
  return VITE_CONFIGS.find((f) => existsSync(join(cwd, f)));
}

/** Относительный base: `base: './'`, `base: ''`, `base: "./"`. */
export function viteBaseRelative(config: string): boolean {
  const m = /\bbase\s*:\s*(["'`])([^"'`]*)\1/.exec(config);
  return m !== null && (m[2] === "" || m[2]!.startsWith("."));
}

export function checkPagePaths(cwd: string): PagePathReport {
  const vite = isVite(cwd);
  // В исходном index.html Vite `/src/main.js` — норма: сборка его переписывает. Смотрим только собранное.
  const roots = vite ? BUILD_DIRS.map((d) => join(cwd, d)).filter((d) => existsSync(d)) : [cwd];
  const files: string[] = [];
  for (const root of roots) walk(root, [".html", ".htm", ".css"], 4, files);
  const issues: PathIssue[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const ref of absoluteRefs(text, file.endsWith(".css")))
      issues.push({ file: relative(cwd, file).replace(/\\/g, "/"), ref });
  }
  const report: PagePathReport = { issues };
  if (vite) {
    let config = "";
    try {
      config = readFileSync(join(cwd, vite), "utf8");
    } catch {
      // нечитаемый конфиг — не наше дело
    }
    if (config && !viteBaseRelative(config)) report.viteBase = vite;
  }
  return report;
}

export function pagePathsMessage(report: PagePathReport, attempt: number, max: number): string {
  const lines = report.issues.slice(0, 6).map((i) => `- ${i.file}: ${i.ref}`);
  if (report.issues.length > 6) lines.push(`- … и ещё ${report.issues.length - 6}`);
  const vite = report.viteBase
    ? `\nВ ${report.viteBase} нет \`base: './'\` — собранная страница будет искать файлы в корне диска. Поставь \`base: './'\` и пересобери.`
    : "";
  const last =
    attempt >= max
      ? " Это последняя попытка: если не выйдет — скажи пользователю, что открывать страницу нужно через превью."
      : "";
  return `Страница не откроется двойным кликом: пути от корня (/…) ведут в корень диска.${lines.length ? `\n${lines.join("\n")}` : ""}${vite}\nСделай пути относительными (./style.css, ./assets/…) и проверь снова.${last}`;
}
