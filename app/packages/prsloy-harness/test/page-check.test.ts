// Страница в браузере (стоп-гейт «Кода»): какую страницу открываем, статика без .env, текст возврата и
// настоящий Chromium (Node-Playwright; нет браузера — тест пропускается, как проверка в приложении).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { CHROMIUM, loadPlaywright } from "./playwright.ts";
import {
  checkPage,
  designPython,
  findPageEntry,
  groupIssues,
  hasBlocking,
  pageCheckMessage,
  type PageIssue,
  serveStatic,
} from "../src/page-check.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-pagecheck-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("page check: which page, static server", () => {
  it("index.html, the only .html, Vite dist; nothing for Vite without a build or several pages", () => {
    expect(findPageEntry(project({ "index.html": "", "about.html": "" }))).toMatch(/index\.html$/);
    expect(findPageEntry(project({ "menu.html": "" }))).toMatch(/menu\.html$/);
    expect(findPageEntry(project({ "a.html": "", "b.html": "" }))).toBeUndefined();
    const vite = project({ "vite.config.js": "", "index.html": "" });
    expect(findPageEntry(vite)).toBeUndefined();
    writeFileSync(join(vite, "index.html"), "");
    mkdirSync(join(vite, "dist"));
    writeFileSync(join(vite, "dist", "index.html"), "");
    expect(findPageEntry(vite)).toBe(join(vite, "dist", "index.html"));
  });

  it("serves the folder on 127.0.0.1, never dot-files (.env) or anything outside", async () => {
    const dir = project({
      "index.html": "<p>Привет</p>",
      ".env": "TOKEN=secret",
      "a/b.css": "p{}",
    });
    const { origin, close } = await serveStatic(dir);
    try {
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const page = await fetch(`${origin}/`);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(await page.text()).toBe("<p>Привет</p>");
      expect((await fetch(`${origin}/a/b.css`)).status).toBe(200);
      expect((await fetch(`${origin}/.env`)).status).toBe(404);
      expect((await fetch(`${origin}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it("no browser python — the check is skipped (undefined), nothing installed", async () => {
    expect(designPython({})).toBeUndefined();
    expect(
      designPython({ PRSLOY_DESIGN_PYTHON: join(root, "nope", "python.exe") }),
    ).toBeUndefined();
    expect(await checkPage(project({ "index.html": "" }), { python: undefined })).toBeUndefined();
  });
});

describe("page check: the message", () => {
  const issue = (i: Partial<PageIssue>): PageIssue => ({
    target: "http",
    width: 390,
    kind: "layout",
    where: "",
    detail: "",
    ...i,
  });

  it("the same problem on both widths and targets is one line; ≤6 lines", () => {
    const lines = groupIssues([
      issue({ target: "file", kind: "pageerror", detail: "x is not defined" }),
      issue({ target: "http", kind: "pageerror", detail: "x is not defined" }),
      issue({ width: 1440, kind: "pageerror", detail: "x is not defined" }),
      issue({ rule: "root-hscroll", where: "html «Блок»", detail: "scrollWidth 608 > 390" }),
    ]);
    expect(lines).toEqual([
      "- (файлом и через сервер, 390 и 1440 px) ошибка: x is not defined",
      "- (через сервер, 390 px) страница шире окна (scrollWidth 608 > 390) — html «Блок»",
    ]);
    const many = Array.from({ length: 9 }, (_, i) => issue({ kind: "console", detail: `e${i}` }));
    const text = pageCheckMessage({ entry: "index.html", issues: many }, 1, 2);
    expect(text).toContain("- … и ещё 3");
    expect(text).not.toContain("последняя попытка");
  });

  it("target-size and small-text are hints: listed last, never a push-back on their own", () => {
    const small = issue({ rule: "small-text", where: "p", detail: "текст 9 px" });
    expect(hasBlocking({ entry: "index.html", issues: [small] })).toBe(false);
    const both = {
      entry: "index.html",
      issues: [small, issue({ rule: "overlap", detail: "кнопки наезжают" })],
    };
    expect(hasBlocking(both)).toBe(true);
    const text = pageCheckMessage(both, 1, 2);
    expect(text.indexOf("кнопки наезжают")).toBeLessThan(
      text.indexOf("текст 9 px — p (подсказка)"),
    );
  });

  it("file-only problems get the double-click hint; the last attempt says so", () => {
    const text = pageCheckMessage(
      {
        entry: "index.html",
        issues: [issue({ target: "file", kind: "request", detail: "/a.js" })],
      },
      2,
      2,
    );
    expect(text).toContain("двойной клик открывает страницу как file://");
    expect(text).toContain("Это последняя попытка");
  });
});

describe("page check in a real Chromium", async () => {
  const pw = await loadPlaywright();
  const executablePath = CHROMIUM;

  it.skipIf(!pw)(
    "errors, missing files, sideways scroll; file-only module script; a clean page is clean",
    async () => {
      const broken = project({
        "index.html": `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body><h1>Меню</h1><div id="wide" style="width:600px">Широкий блок</div>
<script src="./app.js"></script><script src="/missing.js"></script></body></html>`,
        "app.js": "undefinedFn();",
      });
      const r = await checkPage(broken, { playwright: pw!, executablePath });
      const text = pageCheckMessage(r!, 1, 2);
      expect(text).toContain(
        "(файлом и через сервер, 390 и 1440 px) ошибка: undefinedFn is not defined",
      );
      // Правила — lintLayout ci: прокрутка вбок и сам виновник, вылезший за окно.
      expect(text).toMatch(
        /\(файлом и через сервер, 390 px\) страница шире окна \(scrollWidth 6\d\d > 390\)/,
      );
      expect(text).toMatch(/\(файлом и через сервер, 390 px\) за окном: .* — div «Широкий блок»/);
      expect(text).toContain("(файлом, 390 и 1440 px) не загрузился файл: /missing.js");
      expect(text).not.toContain("127.0.0.1");

      // type="module" файлом не открыть вовсе — только сервер, без совета про двойной клик (вариант «а»).
      const module = project({
        "index.html":
          '<!doctype html><meta charset="utf-8"><script type="module" src="./main.js"></script><p>ok</p>',
        "main.js": "document.querySelector('p').textContent = 'да';",
      });
      expect(await checkPage(module, { playwright: pw!, executablePath })).toEqual({
        entry: "index.html",
        issues: [],
        fileSkipped: true,
      });

      // Функция правил получает опции (как lintLayout ci); window-min и focus-hidden для страницы не смотрим.
      const custom = await checkPage(project({ "index.html": "<p>Привет</p>" }), {
        playwright: pw!,
        executablePath,
        lint: String((o: unknown) => [
          { rule: "small-text", selector: "p", text: "", detail: JSON.stringify(o) },
          { rule: "window-min", selector: "html", text: "", detail: "окно" },
        ]),
      });
      expect(custom!.issues.map((i) => [i.rule, i.detail])).toEqual([
        ["small-text", '{"minWidth":0,"minHeight":0,"checkFocus":false,"scrollsY":true}'],
        ["small-text", '{"minWidth":0,"minHeight":0,"checkFocus":false,"scrollsY":true}'],
        ["small-text", '{"minWidth":0,"minHeight":0,"checkFocus":false,"scrollsY":true}'],
        ["small-text", '{"minWidth":0,"minHeight":0,"checkFocus":false,"scrollsY":true}'],
      ]);
      expect(hasBlocking(custom!)).toBe(false);

      const clean = project({
        "index.html": `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="./style.css"></head><body><h1>Пиццерия</h1><script src="./app.js"></script></body></html>`,
        "style.css": "body { margin: 0; font-family: sans-serif }",
        "app.js": "document.title = 'Пиццерия';",
      });
      expect(await checkPage(clean, { playwright: pw!, executablePath })).toEqual({
        entry: "index.html",
        issues: [],
      });
    },
    60_000,
  );
});
