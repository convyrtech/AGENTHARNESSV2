// Пути от корня в страницах: файл, открытый двойным кликом, ищет их в корне диска (стенд a6).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  absoluteRefs,
  checkPagePaths,
  pagePathsMessage,
  viteBaseRelative,
} from "../src/page-paths.ts";

const root = mkdtempSync(join(tmpdir(), "prsloy-paths-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(root, `p${n++}`);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("page paths", () => {
  it("finds src, <link href> and url() from the root; leaves //cdn, http, ./ and <a href=/> alone", () => {
    const html = `<link rel="stylesheet" href="/style.css"><script src="/assets/index-a1.js"></script>
<img src="./logo.png"><script src="//cdn.example/x.js"></script><script src="https://x.example/y.js"></script>
<a href="/">Домой</a><style>@font-face { src: url('/fonts/a.woff2') }</style>`;
    expect(absoluteRefs(html, false)).toEqual([
      "/assets/index-a1.js",
      "/style.css",
      "/fonts/a.woff2",
    ]);
    expect(
      absoluteRefs("body { background: url(/img/bg.png) } a { background: url(./x.png) }", true),
    ).toEqual(["/img/bg.png"]);
  });

  it("plain site: every page and stylesheet; relative paths — clean", () => {
    const bad = project({
      "index.html": '<link href="/css/main.css" rel="stylesheet">',
      "css/main.css": "@font-face { src: url(/fonts/a.woff2) }",
      "node_modules/x/index.html": '<script src="/ignored.js"></script>',
    });
    expect(checkPagePaths(bad).issues).toEqual([
      { file: "css/main.css", ref: "/fonts/a.woff2" },
      { file: "index.html", ref: "/css/main.css" },
    ]);
    const good = project({ "index.html": '<link href="./css/main.css" rel="stylesheet">' });
    expect(checkPagePaths(good)).toEqual({ issues: [] });
  });

  it("Vite: source index.html with /src/main.js is fine; dist and base are checked", () => {
    const dev = project({
      "vite.config.js": "export default { base: './' }",
      "index.html": '<script type="module" src="/src/main.js"></script>',
    });
    expect(checkPagePaths(dev)).toEqual({ issues: [] });
    const built = project({
      "vite.config.ts": "import { defineConfig } from 'vite'\nexport default defineConfig({})",
      "index.html": '<script type="module" src="/src/main.ts"></script>',
      "dist/index.html": '<script type="module" crossorigin src="/assets/index-Bx1.js"></script>',
    });
    expect(checkPagePaths(built)).toEqual({
      issues: [{ file: "dist/index.html", ref: "/assets/index-Bx1.js" }],
      viteBase: "vite.config.ts",
    });
    expect(viteBaseRelative("defineConfig({ base: './', plugins: [] })")).toBe(true);
    expect(viteBaseRelative('{ base: "" }')).toBe(true);
    expect(viteBaseRelative("{ base: '/' }")).toBe(false);
    expect(viteBaseRelative("{}")).toBe(false);
  });

  it("message: files, Vite base, last attempt", () => {
    const text = pagePathsMessage(
      { issues: [{ file: "dist/index.html", ref: "/assets/a.js" }], viteBase: "vite.config.js" },
      2,
      2,
    );
    expect(text).toContain("- dist/index.html: /assets/a.js");
    expect(text).toContain("В vite.config.js нет `base: './'`");
    expect(text).toContain("Это последняя попытка");
  });
});
