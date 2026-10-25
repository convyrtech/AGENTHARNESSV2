// Страница должна открываться и двойным кликом (file://): абсолютные пути `/assets/…` там ведут в корень диска.
// Стенд a6: `file:///fonts/…` (visit-card), `file:///assets/index-*.js` (Vite с base `/`). Превью сервером это
// прячет, казуал — нет. Проверка для стоп-гейта: код, без LLM.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "coverage"]);
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

function isVite(cwd: string): boolean {
  return VITE_CONFIGS.some((f) => existsSync(join(cwd, f)));
}

/** Страница со скриптом `type="module"`: файлом её не открыть вовсе (CORS у file://), проверяем только через сервер. */
export const MODULE_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']?module\b/i;

export function checkPagePaths(cwd: string): PagePathReport {
  // Vite и другие сборки с type="module" двойным кликом не открываются при любых путях (решение: проверка
  // только через сервер, page-check.ts) — здесь их не трогаем.
  if (isVite(cwd)) return { issues: [] };
  const files: string[] = [];
  walk(cwd, [".html", ".htm", ".css"], 4, files);
  const issues: PathIssue[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!file.endsWith(".css") && MODULE_SCRIPT.test(text)) continue;
    for (const ref of absoluteRefs(text, file.endsWith(".css")))
      issues.push({ file: relative(cwd, file).replace(/\\/g, "/"), ref });
  }
  return { issues };
}

export function pagePathsMessage(report: PagePathReport, attempt: number, max: number): string {
  const lines = report.issues.slice(0, 6).map((i) => `- ${i.file}: ${i.ref}`);
  if (report.issues.length > 6) lines.push(`- … и ещё ${report.issues.length - 6}`);
  const last =
    attempt >= max
      ? " Это последняя попытка: если не выйдет — скажи пользователю, что открывать страницу нужно через превью."
      : "";
  return `Страница не откроется двойным кликом: пути от корня (/…) ведут в корень диска.${lines.length ? `\n${lines.join("\n")}` : ""}\nСделай пути относительными (./style.css, ./assets/…) и проверь снова.${last}`;
}
